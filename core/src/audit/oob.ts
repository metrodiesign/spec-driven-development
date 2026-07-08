// Out-of-band auditor (spec §6.5, REQ-14). Runs as a SEPARATE process, holding
// its own EventLog handle over the shared SQLite (WAL) — independent of, and
// uncorrelated with, the in-band sampled audit (§6.5, AZ-9): the salt on the
// fold means this never retraces the in-band sampled set, and `alreadyAudited`
// means it never reselects the same target forever. Detection-only — it never
// reverts a merge or mutates task state (REQ-14.6); a divergence only ever
// escalates for a human to look at.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGateRunner } from '../gates/runner.ts';
import { auditSampleValue, reproduces } from '../merge/auto-merge.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import { openEventLog } from '../state/event-log.ts';
import type { EventLog } from '../state/event-log.ts';
import type { Clock, GateReport, PlatformEvent } from '../types.ts';

export interface OobAuditorOptions {
  dbPath: string;
  repoDir: string;
  gateConfigRelPath: string;
  /** Percent of eligible COMPLETED tasks to audit; independent stream from the in-band rate. */
  sampleRate: number;
  evidenceDir: string;
  clock: Clock;
}

export interface OobVerdict {
  taskId: string;
  mergeCommit: string;
  verdict: 'reproduced' | 'non_repro' | 'flaky_suspect';
  originalRef: string;
  rerunRef: string;
}

/** Pure target selection (REQ-14.1/14.2) — no I/O, replayable straight from the log. */
export function selectAuditTargets(
  events: PlatformEvent[],
  sampleRate: number,
  alreadyAudited: Set<string>,
): { taskId: string; mergeCommit: string }[] {
  const completedTaskIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'TASK_STATE' && e.taskId !== null && e.payload['state'] === 'COMPLETED') {
      completedTaskIds.add(e.taskId);
    }
  }
  // Every auto-merged task carries exactly one AUDIT_RESULT naming its mergeCommit
  // (in-band sampled or not, queue-routed or not) — the one reliable taskId->commit source.
  const mergeInfoByTask = new Map<string, { mergeCommit: string; runId: string }>();
  for (const e of events) {
    if (e.type === 'AUDIT_RESULT' && e.taskId !== null) {
      const mergeCommit = e.payload['mergeCommit'];
      if (typeof mergeCommit === 'string') mergeInfoByTask.set(e.taskId, { mergeCommit, runId: e.runId });
    }
  }

  const targets: { taskId: string; mergeCommit: string }[] = [];
  for (const taskId of completedTaskIds) {
    if (alreadyAudited.has(taskId)) continue;
    const info = mergeInfoByTask.get(taskId);
    if (info === undefined) continue;
    // Salted fold — the SAME hash math as the in-band sample, salted with 'oob'
    // so the two streams are independent (REQ-14.1, design "INDEPENDENT stream").
    if (auditSampleValue(info.runId, `${taskId}oob`) < sampleRate) {
      targets.push({ taskId, mergeCommit: info.mergeCommit });
    }
  }
  return targets;
}

/** Targets excluded as already covered (REQ-14.2): idempotent across cycles. */
function computeAlreadyAudited(events: PlatformEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of events) {
    if (e.taskId === null) continue;
    if (e.type === 'AUDIT_RESULT' && e.payload['sampled'] === true) s.add(e.taskId);
    if (e.type === 'OOB_AUDIT_RESULT') s.add(e.taskId);
  }
  return s;
}

/** The last T1 GATE_RESULT recorded for a task — the report that gated its merge. */
function lastT1ReportByTask(events: PlatformEvent[]): Map<string, GateReport> {
  const m = new Map<string, GateReport>();
  for (const e of events) {
    if (e.type === 'GATE_RESULT' && e.taskId !== null) {
      const report = e.payload as unknown as GateReport;
      if (report.tier === 'T1') m.set(e.taskId, report);
    }
  }
  return m;
}

/** Clone `repoDir` into a fresh private temp dir and check out `mergeCommit` — never a worktree on the live repo (REQ-14.3). */
function cloneAtCommit(repoDir: string, mergeCommit: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oob-audit-'));
  execFileSync('git', ['clone', '--quiet', '--no-single-branch', repoDir, dir]);
  execFileSync('git', ['checkout', '--quiet', mergeCommit], { cwd: dir });
  return dir;
}

/** Retry once on a transient clone failure (e.g. a lock), else give up on this target (REQ-14.8). */
function cloneWithRetry(repoDir: string, mergeCommit: string, log: EventLog, runId: string, taskId: string): string | null {
  try {
    return cloneAtCommit(repoDir, mergeCommit);
  } catch {
    try {
      return cloneAtCommit(repoDir, mergeCommit);
    } catch (err) {
      log.append({
        runId,
        taskId,
        type: 'ERROR',
        payload: { reason: 'oob_clone_failed', detail: (err as Error).message },
      });
      return null;
    }
  }
}

export async function runOobAudit(opts: OobAuditorOptions): Promise<OobVerdict[]> {
  const log = openEventLog(opts.dbPath, opts.clock);
  try {
    const events = log.all();
    const originalByTask = lastT1ReportByTask(events);
    const targets = selectAuditTargets(events, opts.sampleRate, computeAlreadyAudited(events));
    const runIdByTask = new Map<string, string>();
    for (const e of events) {
      if (e.type === 'AUDIT_RESULT' && e.taskId !== null) runIdByTask.set(e.taskId, e.runId);
    }

    const evidence = createEvidenceStore(opts.evidenceDir);
    const verdicts: OobVerdict[] = [];

    for (const target of targets) {
      const original = originalByTask.get(target.taskId);
      if (original === undefined) continue; // nothing recorded to compare against
      const runId = runIdByTask.get(target.taskId) ?? 'unknown';

      const cloneDir = cloneWithRetry(opts.repoDir, target.mergeCommit, log, runId, target.taskId);
      if (cloneDir === null) continue; // ERROR already logged — next cycle retries (REQ-14.8)

      try {
        const gates = createGateRunner({
          worktreeDir: cloneDir,
          configPath: join(cloneDir, opts.gateConfigRelPath),
          runId,
          taskId: target.taskId,
          log,
          evidence,
          clock: opts.clock,
        });

        const rerun1 = await gates.run('T1');
        let finalRerun: GateReport = rerun1;
        let verdict: OobVerdict['verdict'];
        if (reproduces(original, rerun1)) {
          verdict = 'reproduced';
        } else {
          // Exactly one retry (REQ-14.4/14.5): persists = non_repro, pass-after-fail = flaky_suspect.
          const rerun2 = await gates.run('T1');
          finalRerun = rerun2;
          verdict = reproduces(original, rerun2) ? 'flaky_suspect' : 'non_repro';
        }

        const originalRef = evidence.put(JSON.stringify(original.checks));
        const rerunRef = evidence.put(JSON.stringify(finalRerun.checks));
        log.append({
          runId,
          taskId: target.taskId,
          type: 'OOB_AUDIT_RESULT',
          payload: { reproduced: verdict === 'reproduced', verdict, mergeCommit: target.mergeCommit },
        });
        // Detection only — never reverts or mutates task state (REQ-14.6).
        if (verdict === 'non_repro') {
          log.append({
            runId,
            taskId: target.taskId,
            type: 'ESCALATED',
            payload: { why: 'oob_audit_mismatch', mergeCommit: target.mergeCommit },
          });
        }
        verdicts.push({ taskId: target.taskId, mergeCommit: target.mergeCommit, verdict, originalRef, rerunRef });
      } finally {
        rmSync(cloneDir, { recursive: true, force: true });
      }
    }

    return verdicts;
  } finally {
    log.close();
  }
}
