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
import { dirname, join } from 'node:path';

import { createGateRunner } from '../gates/runner.ts';
import { auditSampleValue, reproduces } from '../merge/auto-merge.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import { openEvidenceAuthenticator } from '../evidence/auth.ts';
import { createReportIntegrity, type ReportIntegrity } from '../gates/report-integrity.ts';
import { ReportIntegrityError } from '../gates/report-integrity.ts';
import { verifyMergedArtifactBinding } from '../merge/artifact-binding.ts';
import { openEventLog } from '../state/event-log.ts';
import type { EventLog } from '../state/event-log.ts';
import type { SandboxWrap } from '../security/sandbox.ts';
import type { Clock, GateReport, PlatformEvent } from '../types.ts';

export interface OobAuditorOptions {
  dbPath: string;
  repoDir: string;
  gateConfigRelPath: string;
  /** Optional versioned convention policy path relative to each clean checkout. */
  conventionPolicyRelPath?: string;
  /** Percent of eligible COMPLETED tasks to audit; independent stream from the in-band rate. */
  sampleRate: number;
  clock: Clock;
  /** Test/composition seam; production defaults to the fail-closed platform backend. */
  sandbox?: SandboxWrap;
}

export interface OobVerdict {
  taskId: string;
  mergeCommit: string;
  verdict: 'reproduced' | 'non_repro' | 'flaky_suspect';
  originalRef: string;
  rerunRef: string;
}

export interface OobAuditFailure {
  taskId: string;
  boundary: 'oob_audit';
  why: 'evidence_auth_unavailable' | 'evidence_auth_mismatch';
  code: string;
  detail: string;
}

export type OobAuditResults = OobVerdict[] & { failures: OobAuditFailure[] };

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
  const gateReports = new Map<string, GateReport>();
  const authorized = new Map<string, GateReport>();
  for (const e of events) {
    if (e.type === 'GATE_RESULT' && e.taskId !== null) {
      const report = e.payload as unknown as GateReport;
      if (report.tier === 'T1') gateReports.set(e.taskId, report);
    }
    if (e.type === 'EVIDENCE_AUTHORIZED' && e.taskId !== null) {
      const report = e.payload as unknown as GateReport;
      if (report.tier === 'T1') authorized.set(e.taskId, report);
    }
  }
  return new Map([...gateReports, ...authorized]);
}

/** Hard deterministic failures take precedence over flake-only handling. */
export function classifyOobChecks(
  report: GateReport,
): 'hard_failure' | 'flaky_suspect' | 'clean' {
  if (report.checks.some((check) => check.pass === false && check.flakySuspect !== true)) {
    return 'hard_failure';
  }
  if (report.checks.some((check) => check.flakySuspect === true)) {
    return 'flaky_suspect';
  }
  return 'clean';
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

export async function runOobAudit(opts: OobAuditorOptions): Promise<OobAuditResults> {
  const log = openEventLog(opts.dbPath, opts.clock);
  try {
    const events = log.all();
    const originalByTask = lastT1ReportByTask(events);
    const targets = selectAuditTargets(events, opts.sampleRate, computeAlreadyAudited(events));
    const runIdByTask = new Map<string, string>();
    for (const e of events) {
      if (e.type === 'AUDIT_RESULT' && e.taskId !== null) runIdByTask.set(e.taskId, e.runId);
    }

    const evidence = createEvidenceStore(join(dirname(opts.dbPath), 'evidence'));
    const verdicts = [] as unknown as OobAuditResults;
    Object.defineProperty(verdicts, 'failures', {
      value: [] as OobAuditFailure[],
      enumerable: false,
      writable: false,
    });

    for (const target of targets) {
      const original = originalByTask.get(target.taskId);
      const runId = runIdByTask.get(target.taskId) ?? 'unknown';
      if (original === undefined) {
        const failure: OobAuditFailure = {
          taskId: target.taskId,
          boundary: 'oob_audit',
          why: 'evidence_auth_unavailable',
          code: 'gate_report_missing',
          detail: `COMPLETED task ${target.taskId} has no authenticated T1 gate report`,
        };
        log.append({ runId, taskId: target.taskId, type: 'ESCALATED', payload: { ...failure } });
        verdicts.failures.push(failure);
        continue;
      }

      let reportIntegrity: ReportIntegrity;
      try {
        reportIntegrity = createReportIntegrity({
          evidence,
          authenticator: openEvidenceAuthenticator({
            runStateDir: dirname(opts.dbPath),
            runId,
            recovering: true,
            worktreeDirs: [opts.repoDir],
          }),
        });
        const verified = reportIntegrity.verifyGateReport(original, { runId, taskId: target.taskId });
        if (verified.mergedCommitHash !== undefined) {
          verifyMergedArtifactBinding(verified, reportIntegrity, {
            runId,
            taskId: target.taskId,
            repoDir: opts.repoDir,
            taskBranch: `task/${target.taskId}`,
            mainBranch: 'main',
          }, target.mergeCommit);
        } else {
          if (verified.commitHash !== target.mergeCommit) {
            throw new ReportIntegrityError(
              'artifact_identity_mismatch',
              `signed gate commit ${verified.commitHash} does not match audited merge commit ${target.mergeCommit}`,
            );
          }
          const mergeTree = execFileSync(
            'git',
            ['rev-parse', `${target.mergeCommit}^{tree}`],
            { cwd: opts.repoDir, encoding: 'utf8' },
          ).trim();
          if (verified.worktreeHash !== mergeTree) {
            throw new ReportIntegrityError(
              'artifact_identity_mismatch',
              `signed worktree ${verified.worktreeHash} does not match audited merge tree ${mergeTree}`,
            );
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'evidence_auth_failed';
        const why =
          typeof error === 'object' && error !== null && 'reason' in error &&
          (error.reason === 'evidence_auth_unavailable' || error.reason === 'evidence_auth_mismatch')
            ? error.reason
            : 'evidence_auth_mismatch';
        const failure: OobAuditFailure = {
          taskId: target.taskId,
          boundary: 'oob_audit',
          why,
          code,
          detail,
        };
        log.append({
          runId,
          taskId: target.taskId,
          type: 'ESCALATED',
          payload: { ...failure },
        });
        verdicts.failures.push(failure);
        continue;
      }

      const cloneDir = cloneWithRetry(opts.repoDir, target.mergeCommit, log, runId, target.taskId);
      if (cloneDir === null) continue; // ERROR already logged — next cycle retries (REQ-14.8)

      try {
        const gates = createGateRunner({
          worktreeDir: cloneDir,
          configPath: join(cloneDir, opts.gateConfigRelPath),
          ...(opts.conventionPolicyRelPath === undefined
            ? {}
            : { conventionPolicyPath: join(cloneDir, opts.conventionPolicyRelPath) }),
          runId,
          taskId: target.taskId,
          log,
          evidence,
          reportIntegrity,
          clock: opts.clock,
          ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
        });

        const rerun1 = gates.verify(await gates.run('T1'));
        let finalRerun: GateReport = rerun1;
        let verdict: OobVerdict['verdict'];
        if (classifyOobChecks(rerun1) === 'flaky_suspect') {
          // GateRunner already performed the one retry inside one disposable
          // frozen-artifact checkout. Re-running the whole gate from a fresh
          // checkout would recreate the same one-time flake forever.
          verdict = 'flaky_suspect';
        } else if (reproduces(original, rerun1)) {
          verdict = 'reproduced';
        } else {
          // Exactly one retry (REQ-14.4/14.5): persists = non_repro, pass-after-fail = flaky_suspect.
          const rerun2 = gates.verify(await gates.run('T1'));
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
