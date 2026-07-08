// Fusion composition root (§7.5; REQ-9.2, REQ-10.9, REQ-10.10). aal/fusion is pure
// orchestration and executes nothing (INV-1/2); THIS layer supplies the two things
// that must touch the machine: the CandidateEvidenceRunner (core-run gates in an
// ISOLATED git worktree per candidate) and the fusion.deliberate REQUEST_TOOL handler
// (the per-task depth<=1 counter). Core cannot import aal/runFusion (INV-8), so the
// depth counter + the fusion trigger live here and are injected into the executor
// through its toolHandlers seam.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createGateRunner, type Clock, type EventLog, type EvidenceStore, type ExecuteOutcome, type GateReport, type ToolHandler } from 'core';
import type { CandidateEvidenceRunner, FusionOutcome } from 'aal';
import type { LiveGuardDecision } from './loop-cli.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

export interface CandidateRunnerOptions {
  /** The live repo (a git worktree) fusion candidates are measured against. */
  repoDir: string;
  /** Ladder policy path RELATIVE to the repo root (present in every checkout). */
  configRelPath: string;
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  clock: Clock;
  /** Which tier to prove per candidate (default T1 — the fixture's meaningful gate). */
  tier?: GateReport['tier'];
}

/**
 * REQ-9.2: measure each candidate in a SEPARATE worktree so panel candidates never
 * see each other's writes and the live repo is never mutated. Adds a detached
 * worktree at HEAD, applies the candidate's WRITE_FILEs, runs core's gate runner,
 * then removes the worktree. The GateReport is CORE-produced — the judge never
 * touches it (INV-1/2, REQ-10.1).
 */
export function createCandidateEvidenceRunner(opts: CandidateRunnerOptions): CandidateEvidenceRunner {
  const tier = opts.tier ?? 'T1';
  return {
    async run({ actions }) {
      const wt = mkdtempSync(join(tmpdir(), 'fusion-cand-'));
      try {
        git(opts.repoDir, 'worktree', 'add', '--detach', '-q', wt, 'HEAD');
        for (const a of actions) {
          if (a.type !== 'WRITE_FILE') continue;
          const abs = join(wt, a.path);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, opts.evidence.get(a.contentRef));
        }
        const gates = createGateRunner({
          worktreeDir: wt,
          configPath: join(wt, opts.configRelPath),
          runId: opts.runId,
          taskId: opts.taskId,
          log: opts.log,
          evidence: opts.evidence,
          clock: opts.clock,
        });
        return await gates.run(tier);
      } finally {
        // --force: the worktree has uncommitted candidate writes we intentionally discard.
        try { git(opts.repoDir, 'worktree', 'remove', '--force', wt); } catch { /* best-effort cleanup */ }
      }
    },
  };
}

export interface FusionToolHandlerOptions {
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  /** Runs the actual fusion activation (composition supplies profile + deps + request). */
  activate: () => Promise<FusionOutcome>;
}

/**
 * REQ-10.9: the fusion.deliberate REQUEST_TOOL handler with a per-task depth<=1
 * counter. The FIRST activation runs fusion and records its outcome ref; a SECOND
 * fusion.deliberate for the same task is rejected as structured feedback
 * (`depth_exceeded`) — mirrors the executor's out-of-authority rejection pattern,
 * never a crash. One handler instance is created per task at the composition root,
 * so the counter is genuinely per-task.
 */
export function createFusionToolHandler(opts: FusionToolHandlerOptions): ToolHandler {
  let consumed = false;
  return async (action): Promise<ExecuteOutcome> => {
    if (consumed) {
      const rejection = { actionId: action.actionId, reason: 'depth_exceeded' as const, detail: 'task already consumed its single fusion activation (depth <= 1)' };
      opts.log.append({ runId: opts.runId, taskId: opts.taskId, type: 'ACTION_REJECTED', payload: { ...rejection } });
      return { status: 'rejected', rejection };
    }
    consumed = true;
    const outcome = await opts.activate();
    const ref = opts.evidence.put(JSON.stringify({
      resolved: outcome.resolved,
      winner: outcome.winner !== null,
      escalateReason: outcome.escalateReason ?? null,
      deliberationRef: outcome.deliberationRef,
      dissentRefs: outcome.dissentRefs,
      usage: outcome.usage,
    }));
    opts.log.append({ runId: opts.runId, taskId: opts.taskId, type: 'ACTION_APPLIED', payload: { actionId: action.actionId, resultHash: ref, outputRef: ref, duplicate: false } });
    return { status: 'applied', actionId: action.actionId, resultHash: ref, outputRef: ref };
  };
}

/**
 * REQ-10.10: fusion (4-5x quota per activation) activates ONLY on a confirmed live
 * run — never on the CI-safe stub path and never on a --live refusal (which fires in
 * CI). So `decideLiveRun` structurally keeps fusion off under CI: no confirm, no
 * fusion handler installed.
 */
export function fusionActive(decision: LiveGuardDecision): boolean {
  return decision.action === 'confirm';
}
