// L0–L1 auto-merge + sampling audit (spec §6.6/§6.5, REQ-7/8). Core-only: the
// `auto_approved` trigger has no ports.ts doorway (REQ-7.3, INV-2), so nothing an
// agent claims can reach it. The auto-approve decision is computed ENTIRELY from
// core-run facts (gate greenness, contract ACs, the task diff, the governed risk
// class) — the agent's claim is not an input.
//
// Merge topology (design "Merge topology"): each task runs on a `task/<taskId>`
// branch; auto-merge merges it into main with --no-ff so the revert target is a
// single merge commit. A sampled audit re-runs T1 from a CLEAN checkout of the
// merged tree and compares core-produced evidence; a non-reproduction reverts the
// merge and escalates (REQ-8.3). Composition (runSupervisedLoop branch creation +
// wiring this after REVIEWING) lands in a later task per the Phase-2 plan.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { transition, type Trigger } from '../orchestrator/machine.ts';
import { createGateRunner } from '../gates/runner.ts';
import type { EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { RiskClass } from '../human/approval.ts';
import type { Clock, GateReport, TaskState } from '../types.ts';

const RISK_RANK: Record<RiskClass, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

/** Mapped acceptance criterion — the frozen contract's `acceptance_criteria` entry (REQ-7.2). */
export interface MappedAc {
  id: string;
  golden?: boolean;
}

export interface AutoApproveInput {
  /** Per-task risk from the goal contract; absent (null) → treated as L2 (REQ-7.6). */
  riskClass: RiskClass | null;
  /** T0 AND T1 both green, core-run (never the agent's claim). */
  gatesGreen: boolean;
  /** The mapped ACs — the single-task loop maps ALL of the contract's ACs (REQ-7.2/7.9). */
  acceptanceCriteria: MappedAc[];
  /** Paths the task diff touches (main...task), for the dependency-manifest floor (REQ-7.6). */
  diffPaths: string[];
  /** The governance-pinned manifest/lockfile pattern list (.ai/policies/security-plane.json). */
  depManifestPatterns: string[];
}

export type AutoApproveReason =
  | 'auto_approved'
  | 'gates_not_green'
  | 'zero_acceptance_criteria'
  | 'non_golden_ac'
  | 'risk_above_l1'
  | 'dep_touching_diff';

export interface AutoApproveDecision {
  autoApprove: boolean;
  /** Risk after the dependency-manifest floor is applied (REQ-7.6). */
  effectiveRisk: RiskClass;
  reason: AutoApproveReason;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * A path touches a dependency manifest/lockfile iff it matches the governed
 * pattern list — a bare pattern matches by basename (that file in any dir), a
 * pattern with '/' matches by path suffix.
 */
export function matchesDepManifest(path: string, patterns: string[]): boolean {
  const b = basename(path);
  return patterns.some((pat) =>
    pat.includes('/') ? path === pat || path.endsWith('/' + pat) : b === pat,
  );
}

/**
 * Pure auto-approve gate (REQ-7.2/7.6/7.7/7.9). Auto-approve ONLY when the
 * effective risk is L0/L1, gates are green, there is at least one mapped AC, every
 * mapped AC is golden-backed, and no dependency-manifest diff floored the risk.
 * Any other case routes to the human approval package.
 */
export function decideAutoApprove(input: AutoApproveInput): AutoApproveDecision {
  let effectiveRisk: RiskClass = input.riskClass ?? 'L2';
  const depTouch = input.diffPaths.some((p) => matchesDepManifest(p, input.depManifestPatterns));
  // A dependency-touching diff floors the effective risk to at least L2 (REQ-7.6).
  if (depTouch && RISK_RANK[effectiveRisk] < RISK_RANK.L2) effectiveRisk = 'L2';

  const decide = (autoApprove: boolean, reason: AutoApproveReason): AutoApproveDecision => ({
    autoApprove,
    effectiveRisk,
    reason,
  });

  if (!input.gatesGreen) return decide(false, 'gates_not_green');
  // A vacuous golden check never rides auto-merge (REQ-7.9).
  if (input.acceptanceCriteria.length === 0) return decide(false, 'zero_acceptance_criteria');
  // Any non-golden-backed mapped AC forces the approval package (REQ-7.7).
  if (!input.acceptanceCriteria.every((ac) => ac.golden === true)) return decide(false, 'non_golden_ac');
  if (RISK_RANK[effectiveRisk] > RISK_RANK.L1) {
    return decide(false, depTouch ? 'dep_touching_diff' : 'risk_above_l1');
  }
  return decide(true, 'auto_approved');
}

export interface RunAutoMergeOptions {
  runId: string;
  taskId: string;
  /** State on entry — REVIEWING in a real run (asserted). */
  state: TaskState;
  /** The fixture/target repo root (its .git holds both branches). */
  repoDir: string;
  /** Branch carrying the task's work, e.g. `task/<taskId>`. */
  taskBranch: string;
  /** The branch to merge into, e.g. `main`. */
  mainBranch: string;
  /** Inputs for the auto-approve gate (riskClass/acceptanceCriteria from the frozen contract). */
  decision: Omit<AutoApproveInput, 'diffPaths' | 'gatesGreen'> & { gatesGreen: boolean };
  /** The T1 report the loop produced before the merge — the audit must reproduce it (REQ-8.2/8.6). */
  originalReport: GateReport;
  /** Gate-ladder config path RELATIVE to the repo tree (present in the clean checkout). */
  gateConfigRelPath: string;
  /** Percent of merged tasks to audit; deterministic threshold (REQ-8.1). */
  auditSampleRate: number;
  log: EventLog;
  evidence: EvidenceStore;
  clock: Clock;
}

export interface AutoMergeOutcome {
  decision: 'auto_approve' | 'approval_package';
  reason: AutoApproveReason;
  finalState: TaskState;
  mergeCommit: string | null;
  sampled: boolean;
  /** null when not auto-merged or not sampled. */
  reproduced: boolean | null;
}

function git(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * "Reproduce" (REQ-8.6, AZ-9): ordered gate verdicts equal AND evidence content
 * hashes equal. evidenceRef is `blob://<sha256(content)>`, so comparing refs IS
 * comparing content hashes. Timing and host metadata (commit/worktree/env hashes,
 * ts) are excluded — they vary by construction between the original run and a
 * clean-checkout re-run.
 */
function reproduces(original: GateReport, audit: GateReport): boolean {
  const norm = (r: GateReport): string =>
    JSON.stringify(r.checks.map((c) => ({ name: c.name, pass: c.pass, evidenceRef: c.evidenceRef })));
  return norm(original) === norm(audit);
}

/** Deterministic sampling: sha256(runId+taskId) mod 100 < rate — no RNG (REQ-8.1). */
export function auditSampleValue(runId: string, taskId: string): number {
  // Local sha256 keeps this replayable from the event log without a store dep.
  const hex = createHash('sha256').update(runId + taskId).digest('hex');
  // Fold the full digest into a non-negative integer, then mod 100.
  let acc = 0;
  for (const ch of hex) acc = (acc * 16 + parseInt(ch, 16)) % 100;
  return acc;
}

export async function runAutoMerge(opts: RunAutoMergeOptions): Promise<AutoMergeOutcome> {
  let state: TaskState = opts.state;

  const move = (trigger: Trigger): boolean => {
    const result = transition(state, trigger);
    if (!result.ok) {
      opts.log.append({
        runId: opts.runId,
        taskId: opts.taskId,
        type: 'ERROR',
        payload: { reason: result.reason, detail: result.detail, from: state, trigger },
      });
      return false;
    }
    state = result.next;
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'TASK_STATE',
      payload: { state, trigger },
    });
    return true;
  };

  const escalate = (why: string, extra?: Record<string, unknown>): void => {
    move('escalate');
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ESCALATED',
      payload: { why, ...extra },
    });
  };

  // Diff the task introduced against main (three-dot: merge-base..task), for the
  // dependency-manifest floor (REQ-7.6).
  const diffPaths = gitOut(opts.repoDir, 'diff', '--name-only', `${opts.mainBranch}...${opts.taskBranch}`)
    .split('\n')
    .filter(Boolean);

  const decision = decideAutoApprove({ ...opts.decision, diffPaths });
  if (!decision.autoApprove) {
    // Phase-1 path: the human approval package. Left to the composition root; core
    // records nothing here (no state change) — the loop routes to the package.
    return {
      decision: 'approval_package',
      reason: decision.reason,
      finalState: state,
      mergeCommit: null,
      sampled: false,
      reproduced: null,
    };
  }

  // Policy decision, recorded AS a policy decision — never a human approval (REQ-7.2).
  move('auto_approved');
  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'AUTO_APPROVED',
    payload: { by: 'auto_merge_policy', riskClass: decision.effectiveRisk, reason: decision.reason },
  });
  move('merge_queued');

  // Merge task/<taskId> -> main, --no-ff (single merge commit = single revert target).
  git(opts.repoDir, 'checkout', '-q', opts.mainBranch);
  const merge = git(opts.repoDir, 'merge', '--no-ff', '--no-edit', opts.taskBranch);
  if (merge.code !== 0) {
    git(opts.repoDir, 'merge', '--abort'); // no automatic resolution (REQ-7.5)
    escalate('merge_conflict', { taskBranch: opts.taskBranch });
    return {
      decision: 'auto_approve',
      reason: decision.reason,
      finalState: state,
      mergeCommit: null,
      sampled: false,
      reproduced: null,
    };
  }
  const mergeCommit = gitOut(opts.repoDir, 'rev-parse', 'HEAD');

  // Deterministic sampling (REQ-8.1).
  const sampled = auditSampleValue(opts.runId, opts.taskId) < opts.auditSampleRate;
  if (!sampled) {
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'AUDIT_RESULT',
      payload: { sampled: false, mergeCommit },
    });
    move('audited');
    move('completed');
    return {
      decision: 'auto_approve',
      reason: decision.reason,
      finalState: state,
      mergeCommit,
      sampled: false,
      reproduced: null,
    };
  }

  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'AUDIT_SAMPLED',
    payload: { mergeCommit, rate: opts.auditSampleRate },
  });

  // Re-run T1 from a CLEAN checkout of the merged tree (REQ-8.2).
  const auditDir = `${opts.repoDir}-audit-${mergeCommit.slice(0, 12)}`;
  git(opts.repoDir, 'worktree', 'add', '--detach', auditDir, mergeCommit);
  let auditReport: GateReport;
  try {
    const auditGates = createGateRunner({
      worktreeDir: auditDir,
      configPath: `${auditDir}/${opts.gateConfigRelPath}`,
      runId: opts.runId,
      taskId: opts.taskId,
      log: opts.log,
      evidence: opts.evidence,
      clock: opts.clock,
    });
    auditReport = await auditGates.run('T1');
  } finally {
    git(opts.repoDir, 'worktree', 'remove', '--force', auditDir);
  }

  const reproduced = reproduces(opts.originalReport, auditReport);
  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'AUDIT_RESULT',
    payload: {
      sampled: true,
      reproduced,
      mergeCommit,
      auditRef: opts.evidence.put(JSON.stringify(auditReport.checks)),
    },
  });

  if (!reproduced) {
    // Single escalate(audit_mismatch) whose handling reverts the merge commit as a
    // side effect — no separate roll_back transition on this path (REQ-8.3, AZ-5).
    git(opts.repoDir, 'revert', '-m', '1', '--no-edit', mergeCommit);
    escalate('audit_mismatch', { mergeCommit });
    return {
      decision: 'auto_approve',
      reason: decision.reason,
      finalState: state,
      mergeCommit,
      sampled: true,
      reproduced: false,
    };
  }

  move('audited');
  move('completed');
  return {
    decision: 'auto_approve',
    reason: decision.reason,
    finalState: state,
    mergeCommit,
    sampled: true,
    reproduced: true,
  };
}
