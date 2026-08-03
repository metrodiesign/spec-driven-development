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
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { transition, type Trigger } from '../orchestrator/machine.ts';
import { createGateRunner } from '../gates/runner.ts';
import { ReportIntegrityError, type ReportIntegrity } from '../gates/report-integrity.ts';
import {
  bindGateReportToMerge,
  bindGateReportToTaskArtifact,
  verifyMergedArtifactBinding,
  verifyTaskArtifactBinding,
} from './artifact-binding.ts';
import type { MergeQueue } from './queue.ts';
import type { EventLog } from '../state/event-log.ts';
import { LeaseFenceError, type FencedEventClaim } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { RiskClass } from '../human/approval.ts';
import type { SandboxWrap } from '../security/sandbox.ts';
import type { AuthenticatedGateReport, Clock, GateReport, TaskState } from '../types.ts';

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
  | 'dep_touching_diff'
  | 'evidence_auth_failed';

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

export interface ApprovedMergeOptions {
  runId: string;
  taskId: string;
  /** State on entry: REVIEWING for `runAutoMerge` (asserted); APPROVED for
   * `runApprovedMerge` (post `auto_approved` or `human_approved` — REQ-1.1). */
  state: TaskState;
  /** Which basis got this call here (REQ-1.2/1.3) — recorded on the queue's
   * MERGE_ENQUEUED audit trail when `queue` is supplied; irrelevant otherwise. */
  approvalBasis: 'auto_approved' | 'human_approved';
  /** The fixture/target repo root (its .git holds both branches). */
  repoDir: string;
  /** Branch carrying the task's work, e.g. `task/<taskId>`. */
  taskBranch: string;
  /** The branch to merge into, e.g. `main`. */
  mainBranch: string;
  /** The T1 report the loop produced before the merge — the audit must reproduce it (REQ-8.2/8.6). */
  originalReport: GateReport;
  /** Gate-ladder config path RELATIVE to the repo tree (present in the clean checkout). */
  gateConfigRelPath: string;
  /** Versioned convention policy path RELATIVE to every clean checkout. */
  conventionPolicyRelPath?: string;
  /** Percent of merged tasks to audit; deterministic threshold (REQ-8.1). */
  auditSampleRate: number;
  log: EventLog;
  evidence: EvidenceStore;
  reportIntegrity: ReportIntegrity;
  clock: Clock;
  /** Test/composition seam; production defaults to the fail-closed platform backend. */
  sandbox?: SandboxWrap;
  /** When supplied, route the merge through the T2-gated queue (REQ-13.6) instead of a direct merge; the in-band sampling audit and revert below stay unchanged either way. */
  queue?: MergeQueue;
  /** Composition-owned fenced check immediately before each merge/audit side effect. */
  assertOwnership?: (boundary: string) => void;
  /** Fence the post-merge audit gate's GATE_RESULT event as well. */
  fence?: () => FencedEventClaim;
}

// approvalBasis is omitted here: runAutoMerge decides it (always 'auto_approved') when
// it calls runApprovedMerge internally — a caller of runAutoMerge never chooses it.
export interface RunAutoMergeOptions extends Omit<ApprovedMergeOptions, 'approvalBasis'> {
  /** Inputs for the auto-approve gate (riskClass/acceptanceCriteria from the frozen contract). */
  decision: Omit<AutoApproveInput, 'diffPaths' | 'gatesGreen'> & { gatesGreen: boolean };
}

/** Shared merge/audit continuation result — same shape whichever approval basis produced it. */
export interface ApprovedMergeOutcome {
  finalState: TaskState;
  mergeCommit: string | null;
  /** Latest signed report, including task/merge OID bindings as far as this path reached. */
  authorizedReport: GateReport | null;
  sampled: boolean;
  /** null when not auto-merged or not sampled. */
  reproduced: boolean | null;
}

export interface AutoMergeOutcome extends ApprovedMergeOutcome {
  decision: 'auto_approve' | 'approval_package' | 'evidence_invalid';
  reason: AutoApproveReason;
  /** Risk after the dependency-manifest floor (REQ-7.6) — carried on the approval_package
   * path too (REQ-2.1), so the composition root can build the package without recomputing it. */
  effectiveRisk: RiskClass;
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

type DetachedMergePreparation =
  | { outcome: 'prepared'; mergeCommit: string }
  | { outcome: 'merge_conflict'; mergeCommit: null };

function prepareDetachedMerge(
  repoDir: string,
  baseCommit: string,
  artifactCommit: string,
): DetachedMergePreparation {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'core-direct-merge-'));
  const worktreeDir = join(temporaryRoot, 'worktree');
  let worktreeAdded = false;
  try {
    const added = git(repoDir, 'worktree', 'add', '--detach', worktreeDir, baseCommit);
    if (added.code !== 0) {
      throw new Error(`cannot prepare detached merge worktree from signed base ${baseCommit}: ${added.stderr}`);
    }
    worktreeAdded = true;
    const merge = git(worktreeDir, 'merge', '--no-ff', '--no-edit', artifactCommit);
    if (merge.code !== 0) {
      git(worktreeDir, 'merge', '--abort');
      return { outcome: 'merge_conflict', mergeCommit: null };
    }
    return { outcome: 'prepared', mergeCommit: gitOut(worktreeDir, 'rev-parse', 'HEAD') };
  } finally {
    if (worktreeAdded) {
      const removed = git(repoDir, 'worktree', 'remove', '--force', worktreeDir);
      if (removed.code !== 0) {
        throw new Error(`cannot remove detached merge worktree ${worktreeDir}: ${removed.stderr}`);
      }
    }
    rmdirSync(temporaryRoot);
  }
}

function evidenceAuthFailure(error: unknown, boundary: string): Record<string, unknown> {
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
  return { why, boundary, code, detail };
}

/**
 * "Reproduce" (REQ-8.6, AZ-9): ordered gate verdicts equal AND evidence content
 * hashes equal. evidenceRef is `blob://<sha256(content)>`, so comparing refs IS
 * comparing content hashes. Timing and host metadata (commit/worktree/env hashes,
 * ts) are excluded — they vary by construction between the original run and a
 * clean-checkout re-run.
 */
export function reproduces(original: GateReport, audit: GateReport): boolean {
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
  let authorizedReport: AuthenticatedGateReport;

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

  try {
    authorizedReport = bindGateReportToTaskArtifact(opts.originalReport, opts.reportIntegrity, {
      runId: opts.runId,
      taskId: opts.taskId,
      repoDir: opts.repoDir,
      taskBranch: opts.taskBranch,
      mainBranch: opts.mainBranch,
    });
  } catch (error) {
    move('escalate');
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ESCALATED',
      payload: evidenceAuthFailure(error, 'auto_approval'),
    });
    return {
      decision: 'evidence_invalid',
      reason: 'evidence_auth_failed',
      effectiveRisk: opts.decision.riskClass ?? 'L2',
      finalState: state,
      mergeCommit: null,
      authorizedReport: null,
      sampled: false,
      reproduced: null,
    };
  }

  // Diff the task introduced against main (three-dot: merge-base..task), for the
  // dependency-manifest floor (REQ-7.6).
  const diffPaths = gitOut(opts.repoDir, 'diff', '--name-only', `${authorizedReport.baseCommitHash as string}...${authorizedReport.artifactCommitHash as string}`)
    .split('\n')
    .filter(Boolean);

  const decision = decideAutoApprove({ ...opts.decision, diffPaths });
  if (!decision.autoApprove) {
    // The human approval package (REQ-2/3). Left to the composition root; core
    // records nothing here (no state change) — the loop routes to the package.
    return {
      decision: 'approval_package',
      reason: decision.reason,
      effectiveRisk: decision.effectiveRisk,
      finalState: state,
      mergeCommit: null,
      authorizedReport,
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

  // Shared merge/audit engine (REQ-1.1) — identical continuation whether this state
  // came from an auto-approval (here) or a human approval (runApprovedMerge called
  // directly by the composition root).
  const merged = await runApprovedMerge({
    runId: opts.runId,
    taskId: opts.taskId,
    state,
    approvalBasis: 'auto_approved',
    repoDir: opts.repoDir,
    taskBranch: opts.taskBranch,
    mainBranch: opts.mainBranch,
    originalReport: authorizedReport,
    gateConfigRelPath: opts.gateConfigRelPath,
    ...(opts.conventionPolicyRelPath === undefined
      ? {}
      : { conventionPolicyRelPath: opts.conventionPolicyRelPath }),
    auditSampleRate: opts.auditSampleRate,
    log: opts.log,
    evidence: opts.evidence,
    reportIntegrity: opts.reportIntegrity,
    clock: opts.clock,
    ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
    ...(opts.queue !== undefined ? { queue: opts.queue } : {}),
    ...(opts.assertOwnership === undefined ? {} : { assertOwnership: opts.assertOwnership }),
    ...(opts.fence === undefined ? {} : { fence: opts.fence }),
  });

  return { decision: 'auto_approve', reason: decision.reason, effectiveRisk: decision.effectiveRisk, ...merged };
}

/**
 * Merge continuation from state APPROVED (REQ-1.1): merge_queued -> merge (direct or
 * T2-gated queue) -> deterministic sampling -> clean-checkout audit -> audited ->
 * completed, or escalate on any failure. Shared by both approval bases (REQ-1.2/1.3) —
 * this function never fires AUTO_APPROVED and never knows which basis got it here.
 */
export async function runApprovedMerge(opts: ApprovedMergeOptions): Promise<ApprovedMergeOutcome> {
  let state: TaskState = opts.state;
  let authorizedReport: AuthenticatedGateReport;

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

  const assertOwnership = (boundary: string): void => {
    try {
      opts.assertOwnership?.(boundary);
    } catch (error) {
      if (error instanceof LeaseFenceError) throw error;
      throw new LeaseFenceError(error instanceof Error ? error.message : String(error));
    }
  };

  try {
    authorizedReport = verifyTaskArtifactBinding(opts.originalReport, opts.reportIntegrity, {
      runId: opts.runId,
      taskId: opts.taskId,
      repoDir: opts.repoDir,
      taskBranch: opts.taskBranch,
      mainBranch: opts.mainBranch,
    });
  } catch (error) {
    const failure = evidenceAuthFailure(error, 'merge_queue_entry');
    escalate(String(failure['why']), failure);
    return { finalState: state, mergeCommit: null, authorizedReport: null, sampled: false, reproduced: null };
  }

  move('merge_queued');

  let mergeCommit: string;
  let mergedReport: AuthenticatedGateReport | undefined;
  if (opts.queue) {
    assertOwnership('merge_queue');
    // T2-gated path (REQ-13.6) — the queue owns the merge + T2 run; the
    // sampled-audit flow below is unchanged either way.
    const result = await opts.queue.process({
      taskId: opts.taskId,
      taskBranch: opts.taskBranch,
      approvalBasis: opts.approvalBasis,
      originalReport: authorizedReport,
    });
    if (result.outcome === 'merge_conflict') {
      escalate('merge_conflict', { taskBranch: opts.taskBranch });
      return { finalState: state, mergeCommit: null, authorizedReport, sampled: false, reproduced: null };
    }
    if (result.outcome === 'rejected_t2') {
      escalate('t2_failed', { taskBranch: opts.taskBranch, attribution: result.attribution });
      return { finalState: state, mergeCommit: null, authorizedReport, sampled: false, reproduced: null };
    }
    if (result.outcome === 'evidence_invalid') {
      // The queue already emitted the structured evidence-auth ESCALATED event;
      // this layer owns only the task-state transition, avoiding a duplicate event.
      move('escalate');
      return { finalState: state, mergeCommit: null, authorizedReport, sampled: false, reproduced: null };
    }
    mergeCommit = result.mergeCommit as string;
  } else {
    assertOwnership('direct_merge_prepare');
    let prepared: DetachedMergePreparation;
    try {
      prepared = prepareDetachedMerge(
        opts.repoDir,
        authorizedReport.baseCommitHash as string,
        authorizedReport.artifactCommitHash as string,
      );
    } catch (error) {
      escalate('merge_preparation_failed', {
        boundary: 'direct_merge_prepare',
        detail: error instanceof Error ? error.message : String(error),
      });
      return { finalState: state, mergeCommit: null, authorizedReport, sampled: false, reproduced: null };
    }
    if (prepared.outcome === 'merge_conflict') {
      escalate('merge_conflict', { taskBranch: opts.taskBranch });
      return { finalState: state, mergeCommit: null, authorizedReport, sampled: false, reproduced: null };
    }
    mergeCommit = prepared.mergeCommit;

    try {
      mergedReport = bindGateReportToMerge(authorizedReport, mergeCommit, opts.reportIntegrity, {
        runId: opts.runId,
        taskId: opts.taskId,
        repoDir: opts.repoDir,
        taskBranch: opts.taskBranch,
        mainBranch: opts.mainBranch,
      });
    } catch (error) {
      const failure = evidenceAuthFailure(error, 'direct_merge_prepare');
      escalate(String(failure['why']), failure);
      return { finalState: state, mergeCommit: null, authorizedReport, sampled: false, reproduced: null };
    }

    assertOwnership('direct_merge_update');
    const advanced = git(
      opts.repoDir,
      'update-ref',
      `refs/heads/${opts.mainBranch}`,
      mergeCommit,
      authorizedReport.baseCommitHash as string,
    );
    if (advanced.code !== 0) {
      const failure = evidenceAuthFailure(
        new ReportIntegrityError(
          'artifact_identity_mismatch',
          `current ${opts.mainBranch} changed after authorization; refusing to overwrite it`,
        ),
        'direct_merge_update',
      );
      escalate(String(failure['why']), failure);
      return { finalState: state, mergeCommit: null, authorizedReport, sampled: false, reproduced: null };
    }
  }

  try {
    mergedReport ??= bindGateReportToMerge(authorizedReport, mergeCommit, opts.reportIntegrity, {
      runId: opts.runId,
      taskId: opts.taskId,
      repoDir: opts.repoDir,
      taskBranch: opts.taskBranch,
      mainBranch: opts.mainBranch,
    });
    verifyMergedArtifactBinding(mergedReport, opts.reportIntegrity, {
      runId: opts.runId,
      taskId: opts.taskId,
      repoDir: opts.repoDir,
      taskBranch: opts.taskBranch,
      mainBranch: opts.mainBranch,
    }, mergeCommit, opts.mainBranch);
  } catch (error) {
    const failure = evidenceAuthFailure(error, 'merge_result');
    escalate(String(failure['why']), failure);
    return { finalState: state, mergeCommit, authorizedReport: null, sampled: false, reproduced: null };
  }
  authorizedReport = mergedReport;
  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'EVIDENCE_AUTHORIZED',
    payload: { ...authorizedReport } as unknown as Record<string, unknown>,
  });

  // Deterministic sampling (REQ-8.1).
  const sampled = auditSampleValue(opts.runId, opts.taskId) < opts.auditSampleRate;
  if (!sampled) {
    try {
      verifyMergedArtifactBinding(authorizedReport, opts.reportIntegrity, {
        runId: opts.runId,
        taskId: opts.taskId,
        repoDir: opts.repoDir,
        taskBranch: opts.taskBranch,
        mainBranch: opts.mainBranch,
      }, mergeCommit, opts.mainBranch);
    } catch (error) {
      const failure = evidenceAuthFailure(error, 'completion');
      escalate(String(failure['why']), failure);
      return { finalState: state, mergeCommit, authorizedReport, sampled: false, reproduced: null };
    }
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'AUDIT_RESULT',
      payload: { sampled: false, mergeCommit },
    });
    move('audited');
    move('completed');
    return { finalState: state, mergeCommit, authorizedReport, sampled: false, reproduced: null };
  }

  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'AUDIT_SAMPLED',
    payload: { mergeCommit, rate: opts.auditSampleRate },
  });

  // Re-run T1 from a CLEAN checkout of the merged tree (REQ-8.2).
  assertOwnership('audit_gate');
  const auditDir = `${opts.repoDir}-audit-${mergeCommit.slice(0, 12)}`;
  git(opts.repoDir, 'worktree', 'add', '--detach', auditDir, mergeCommit);
  let auditReport: GateReport;
  try {
    const auditGates = createGateRunner({
      worktreeDir: auditDir,
      configPath: `${auditDir}/${opts.gateConfigRelPath}`,
      ...(opts.conventionPolicyRelPath === undefined
        ? {}
        : { conventionPolicyPath: `${auditDir}/${opts.conventionPolicyRelPath}` }),
      runId: opts.runId,
      taskId: opts.taskId,
      log: opts.log,
      evidence: opts.evidence,
      reportIntegrity: opts.reportIntegrity,
      clock: opts.clock,
      ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
      ...(opts.fence === undefined ? {} : { fence: opts.fence }),
    });
    auditReport = auditGates.verify(await auditGates.run('T1'));
  } finally {
    git(opts.repoDir, 'worktree', 'remove', '--force', auditDir);
  }

  try {
    verifyMergedArtifactBinding(authorizedReport, opts.reportIntegrity, {
      runId: opts.runId,
      taskId: opts.taskId,
      repoDir: opts.repoDir,
      taskBranch: opts.taskBranch,
      mainBranch: opts.mainBranch,
    }, mergeCommit, opts.mainBranch);
  } catch (error) {
    const failure = evidenceAuthFailure(error, 'audit_comparison');
    escalate(String(failure['why']), failure);
    return { finalState: state, mergeCommit, authorizedReport, sampled: true, reproduced: null };
  }
  const reproduced = reproduces(authorizedReport, auditReport);
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
    // Both merge paths prepare outside opts.repoDir and advance main with `update-ref`,
    // so its working tree may still be sitting on the task branch. Check out main first
    // so the revert always lands on the branch that was actually advanced (PR #50 review).
    assertOwnership('audit_revert');
    git(opts.repoDir, 'checkout', '-q', opts.mainBranch);
    git(opts.repoDir, 'revert', '-m', '1', '--no-edit', mergeCommit);
    escalate('audit_mismatch', { mergeCommit });
    return { finalState: state, mergeCommit, authorizedReport, sampled: true, reproduced: false };
  }

  try {
    verifyMergedArtifactBinding(authorizedReport, opts.reportIntegrity, {
      runId: opts.runId,
      taskId: opts.taskId,
      repoDir: opts.repoDir,
      taskBranch: opts.taskBranch,
      mainBranch: opts.mainBranch,
    }, mergeCommit, opts.mainBranch);
  } catch (error) {
    const failure = evidenceAuthFailure(error, 'completion');
    escalate(String(failure['why']), failure);
    return { finalState: state, mergeCommit, authorizedReport, sampled: true, reproduced: null };
  }
  move('audited');
  move('completed');
  return { finalState: state, mergeCommit, authorizedReport, sampled: true, reproduced: true };
}
