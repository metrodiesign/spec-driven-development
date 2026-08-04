// Task loop (spec §9.2 discipline, REQ-7): ask the ProposalSource, execute its
// actions under policy, run gates ITSELF, transition on core-run results only.
// Claims are recorded as data (CLAIM_RECORDED) and never cause transitions.
// REVIEWING is the happy-path terminal in this phase (awaiting_human_phase0).

import { resumeTransition, transition, type Trigger } from './machine.ts';
import { evaluateHypotheses, summarizeHypothesisLog, type HypothesisOutcome } from '../repair/hypothesis.ts';
import { BudgetUsageError, validateCostUnits, type BudgetTracker } from '../budget/budget.ts';
import { LeaseFenceError, type EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { Executor } from '../executor/executor.ts';
import type { GateRunner } from '../gates/runner.ts';
import type { LoopControl, ProposalInput, ProposalSource } from '../ports.ts';
import type {
  ActionRejection,
  Clock,
  GateReport,
  Hypothesis,
  IdSource,
  Role,
  TaskState,
} from '../types.ts';
import type { TaskLeaseSession } from '../state/lease.ts';

export interface LoopResult {
  finalState: TaskState;
  iterations: number;
  terminalMarker?: 'awaiting_human_phase0';
  /**
   * The T1 report the loop produced when it reached REVIEWING — the input the
   * auto-merge audit must reproduce (REQ-8.2/8.6). Present only on the REVIEWING
   * happy path; absent for every other terminal (append-only — INV-8).
   */
  lastGateReport?: GateReport;
}

/** Policy bounds for the hypothesis-driven repair cycle (REQ-5.6/5.7/5.8). */
export interface RepairPolicy {
  maxHypotheses: number;
  maxProbesPerHypothesis: number;
  probeTimeoutMs: number;
}

/** Exported so the composition root can override single fields from the frozen contract (phase5-stage2 REQ-4.1). */
export const DEFAULT_REPAIR_POLICY: RepairPolicy = {
  maxHypotheses: 3,
  maxProbesPerHypothesis: 5,
  probeTimeoutMs: 30_000,
};

export interface LoopOptions {
  runId: string;
  taskId: string;
  role: Role;
  source: ProposalSource;
  executor: Executor;
  gates: GateRunner;
  log: EventLog;
  budget: BudgetTracker;
  clock: Clock;
  /**
   * Repair-engine deps. Present in a real composition; a minimal harness may omit
   * them, in which case a DIAGNOSING round has no engine to run and is vacuously
   * exhausted (append-only — existing callers are unaffected).
   */
  evidence?: EvidenceStore;
  ids?: IdSource;
  repairPolicy?: RepairPolicy;
  /**
   * Operator steering, polled at each iteration boundary (REQ-10.1). Absent → the
   * loop runs unsteerable exactly as before (append-only).
   */
  control?: LoopControl;
  /**
   * Drains guidance injected while paused (REQ-10.5); folded into the next round as
   * marked untrusted data. Absent → no guidance channel.
   */
  takeGuidance?: () => string[];
  /** Every task loop owns an authenticated fenced lease before it requests a proposal. */
  lease: TaskLeaseSession;
  /** Composition may keep the task lease across post-loop approval/merge work. */
  releaseLease?: boolean;
}

export async function runTaskLoop(opts: LoopOptions): Promise<LoopResult> {
  try {
    return await runTaskLoopWithLease(opts);
  } finally {
    // A normal loop releases on every terminal/error path, including exceptions from
    // a proposal source or gate. Composition may explicitly retain the session while
    // it performs post-loop approval/merge work; that owner is then responsible for
    // the final release. The session fences release by token in either case.
    if (opts.releaseLease !== false) {
      opts.lease.stopHeartbeat();
      opts.lease.release();
    }
  }
}

async function runTaskLoopWithLease(opts: LoopOptions): Promise<LoopResult> {
  let state: TaskState = 'PROPOSED';

  opts.lease.startHeartbeat();

  const requireOwnership = (boundary: string): boolean => {
    if (opts.lease.verifyOwnership()) return true;
    // Keep the failure structured and append-only. No proposal, action, or gate
    // event is emitted after the fencing check fails.
    move('escalate');
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ESCALATED',
      payload: { why: 'lease_lost', boundary, fencingToken: opts.lease.claim.fencingToken },
    });
    return false;
  };

  const move = (trigger: Trigger): boolean => {
    const result = transition(state, trigger);
    if (!result.ok) {
      // Structured error event; the loop never crashes on an illegal transition (REQ-7.4).
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

  const policy = opts.repairPolicy ?? DEFAULT_REPAIR_POLICY;

  const escalate = (why: string, extra?: Record<string, unknown>): void => {
    move('escalate');
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ESCALATED',
      payload: { why, ...extra },
    });
  };

  /** Record the exhausted backstop before its structured escalation (REQ-7.7). */
  const emitBudgetExceeded = (limit: 'iterations' | 'costUnits' | 'wallclock'): void => {
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'BUDGET_EXCEEDED',
      payload: { limit, iterations },
    });
  };

  /** Charge only normalized usage; invalid input is a core-owned escalation. */
  const chargeUsage = (cost: unknown, boundary: string): boolean => {
    const checked = validateCostUnits(cost);
    if (!checked.ok) {
      opts.log.append({
        runId: opts.runId,
        taskId: opts.taskId,
        type: 'ERROR',
        payload: { reason: 'invalid_response', boundary, detail: checked.detail, costUnits: cost },
      });
      escalate('invalid_response', { boundary, detail: checked.detail });
      return false;
    }
    try {
      opts.budget.noteIteration(checked.value);
    } catch (error) {
      if (!(error instanceof BudgetUsageError)) throw error;
      opts.log.append({
        runId: opts.runId,
        taskId: opts.taskId,
        type: 'ERROR',
        payload: { reason: 'invalid_response', boundary, detail: error.message },
      });
      escalate('invalid_response', { boundary, detail: error.message });
      return false;
    }
    return true;
  };

  // A DIAGNOSING round evaluates untrusted hypotheses through the repair engine
  // (REQ-5). A minimal harness without engine deps has nothing to run.
  const runDiagnosis = async (hyps: Hypothesis[]): Promise<HypothesisOutcome> => {
    if (opts.evidence === undefined || opts.ids === undefined) {
      opts.log.append({
        runId: opts.runId,
        taskId: opts.taskId,
        type: 'HYPOTHESIS_PROPOSED',
        payload: { count: hyps.length, engine: false },
      });
      return { status: 'exhausted', reason: 'all_refuted', log: [] };
    }
    return evaluateHypotheses(hyps, {
      runId: opts.runId,
      taskId: opts.taskId,
      executor: opts.executor,
      evidence: opts.evidence,
      log: opts.log,
      budget: opts.budget,
      ids: opts.ids,
      maxHypotheses: policy.maxHypotheses,
      maxProbesPerHypothesis: policy.maxProbesPerHypothesis,
      probeTimeoutMs: policy.probeTimeoutMs,
    });
  };

  // Deterministic walk to the working state.
  move('analyze');
  move('ready');
  move('start_implementing');

  let iterations = 0;
  let feedback: ProposalInput['feedback'] = null;

  for (;;) {
    // Steering boundary (REQ-10.1): poll the control port AFTER the previous atomic
    // action, BEFORE starting a new round. Kill terminates cleanly; pause blocks
    // here until resume/kill and does not count against the ACTIVE wallclock (REQ-6.5).
    if (opts.control !== undefined) {
      const signal = opts.control.poll();
      if (signal === 'kill') {
        move('cancel');
        return { finalState: state, iterations };
      }
      if (signal === 'pause') {
        const prePauseState = state;
        move('pause'); // -> PAUSED (universal)
        opts.log.append({
          runId: opts.runId,
          taskId: opts.taskId,
          type: 'PAUSE_REQUESTED',
          payload: { prePauseState },
        });
        const pausedAt = opts.clock.now();
        // Deliberately stop renewal while paused. Resume must reacquire a fresh
        // fencing generation when the TTL elapsed, and must not let an old token
        // continue side effects after another owner replaced it.
        opts.lease.stopHeartbeat();
        const outcome = await opts.control.waitResume();
        opts.budget.noteExcludedMs(opts.clock.now() - pausedAt);
        if (outcome === 'kill') {
          move('cancel'); // legal from PAUSED (REQ-10.7)
          return { finalState: state, iterations };
        }
        if (!(await opts.lease.reacquireAfterPause())) {
          escalate('lease_unavailable_after_pause', { boundary: 'resume' });
          return { finalState: state, iterations };
        }
        opts.lease.startHeartbeat();
        // Restore the recorded pre-pause state (REQ-10.3) — replayable from the log.
        const resumed = resumeTransition(state, prePauseState);
        if (resumed.ok) {
          state = resumed.next;
          opts.log.append({
            runId: opts.runId,
            taskId: opts.taskId,
            type: 'TASK_STATE',
            payload: { state, trigger: 'resume' },
          });
          opts.log.append({
            runId: opts.runId,
            taskId: opts.taskId,
            type: 'RESUMED',
            payload: { resumedTo: state },
          });
        }
      }
    }

    // Fold operator guidance injected while paused into this round as MARKED data (REQ-10.5).
    // ponytail: guidance takes precedence for the round; the pause boundary sits
    // between clean rounds, so pending feedback is normally null here.
    const guidance = opts.takeGuidance?.() ?? [];
    if (guidance.length > 0) feedback = { kind: 'guidance', guidance: guidance.join('\n---\n') };

    const over = opts.budget.exceeded();
    if (over !== false) {
      emitBudgetExceeded(over.limit);
      move('escalate');
      opts.log.append({
        runId: opts.runId,
        taskId: opts.taskId,
        type: 'ESCALATED',
        payload: { why: `budget:${over.limit}` },
      });
      return { finalState: state, iterations };
    }

    // REQ-6.7: a spent budget (remaining at or below zero — the exact-zero boundary
    // that `exceeded()`'s strict `>` misses) escalates BEFORE building any further
    // AgentRequest; a zero/negative budget is never sent to an adapter.
    if (opts.budget.remaining() <= 0) {
      emitBudgetExceeded('costUnits');
      escalate('budget_exhausted');
      return { finalState: state, iterations };
    }

    if (!requireOwnership('proposal')) return { finalState: state, iterations };

    const proposal = await opts.source.propose({
      taskId: opts.taskId,
      state,
      role: opts.role,
      feedback,
    });
    iterations += 1;
    if (!requireOwnership('proposal_result')) return { finalState: state, iterations };
    if (proposal.error?.reason === 'invalid_response') {
      opts.log.append({
        runId: opts.runId,
        taskId: opts.taskId,
        type: 'ERROR',
        payload: { reason: 'invalid_response', boundary: 'proposal_source', detail: proposal.error.detail },
      });
      escalate('invalid_response', { boundary: 'proposal_source', detail: proposal.error.detail });
      return { finalState: state, iterations };
    }
    if (!chargeUsage(proposal.costUnits, 'proposal_usage')) return { finalState: state, iterations };
    feedback = null;

    // The claim is DATA (INV-1/2) — recorded, never trusted.
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'CLAIM_RECORDED',
      payload: { claim: proposal.claim, actionCount: proposal.actions.length },
    });

    // Source-side rejections (e.g. AAL context_violation, REQ-5.4) merge in FIRST,
    // ahead of any executor rejection this same round produces — one array, one
    // roundtrip mechanism regardless of where a rejection originated.
    const rejections: ActionRejection[] = [...(proposal.rejections ?? [])];
    for (const action of proposal.actions) {
      if (!requireOwnership('action')) return { finalState: state, iterations };
      const outcome = await opts.executor.execute(action, opts.role);
      if (!requireOwnership('action_result')) return { finalState: state, iterations };
      if (outcome.status === 'rejected') rejections.push(outcome.rejection);
    }
    if (rejections.length > 0) feedback = rejections;

    // REQ-5.1/5.2: an implementation or repair iteration is the complete action
    // batch, not the agent's claim.  Run exactly one authenticated T0 after every
    // such batch, including zero actions.  The diagnostician path below never
    // enters this block, and hypothesis probes are executor-owned read-only work.
    const implementationRound = opts.role === 'implementer';
    let t0: GateReport | null = null;
    let gateFailure: GateReport | null = null;
    if (implementationRound) {
      if (!requireOwnership('gate:T0')) return { finalState: state, iterations };
      try {
        t0 = opts.gates.verify(await opts.gates.run('T0'));
      } catch (error) {
        if (error instanceof LeaseFenceError) {
          escalate('lease_lost', { boundary: 'gate:T0', code: error.code, detail: error.message });
          return { finalState: state, iterations };
        }
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
        escalate(why, { boundary: 'state_advancement', code, detail });
        return { finalState: state, iterations };
      }
      if (t0.pass !== true) gateFailure = t0;
    }

    if (gateFailure === null && proposal.claim === 'READY_FOR_VERIFICATION') {
      // T1 is only legal after the same iteration's authenticated, passing T0.
      // Freeze identity is checked before any state advancement so a gate runner
      // cannot silently test a different artifact between tiers.
      if (t0 === null) {
        escalate('gate_ordering_violation', { boundary: 'state_advancement', detail: 'READY_FOR_VERIFICATION without T0' });
        return { finalState: state, iterations };
      }
      move('verify');
      let t1: GateReport;
      if (!requireOwnership('gate:T1')) return { finalState: state, iterations };
      try {
        t1 = opts.gates.verify(await opts.gates.run('T1'));
      } catch (error) {
        if (error instanceof LeaseFenceError) {
          escalate('lease_lost', { boundary: 'gate:T1', code: error.code, detail: error.message });
          return { finalState: state, iterations };
        }
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
        escalate(why, { boundary: 'state_advancement', code, detail });
        return { finalState: state, iterations };
      }
      if (t1.worktreeHash !== t0.worktreeHash) {
        escalate('artifact_identity_mismatch', {
          boundary: 'state_advancement',
          t0WorktreeHash: t0.worktreeHash,
          t1WorktreeHash: t1.worktreeHash,
        });
        return { finalState: state, iterations };
      }
      if (t1.pass === true) {
        move('gate_passed');
        move('review');
        // Happy-path terminal for this phase (REQ-7.6): a human takes it from here.
        opts.log.append({
          runId: opts.runId,
          taskId: opts.taskId,
          type: 'TASK_STATE',
          payload: { state, marker: 'awaiting_human_phase0' },
        });
        return { finalState: state, iterations, terminalMarker: 'awaiting_human_phase0', lastGateReport: t1 };
      }
      gateFailure = t1;
    }

    if (gateFailure !== null) {
      // A failed T0 can happen while IMPLEMENTING/REPAIRING; T1 failures are
      // already in VERIFYING.  Both enter the same deterministic diagnosis path.
      if (state === 'IMPLEMENTING' || state === 'REPAIRING') move('verify');
      move('gate_failed');
      move('diagnose'); // FAILED -> DIAGNOSING

      // REQ-6.7 again at the diagnose boundary: never build the diagnostician
      // AgentRequest on a spent budget.
      if (opts.budget.remaining() <= 0) {
        emitBudgetExceeded('costUnits');
        escalate('budget_exhausted');
        return { finalState: state, iterations };
      }
      if (!requireOwnership('diagnosis_proposal')) return { finalState: state, iterations };

      // A diagnostician round returns testable hypotheses (REQ-5.1); the claim/
      // actions of this round are irrelevant — core runs the probes itself.
      const diag = await opts.source.propose({
        taskId: opts.taskId,
        state,
        role: 'diagnostician',
        // REQ-5.4: the diagnostician sees this round's action rejections alongside
        // the gate failure, not gateFailure alone (backlog: rejected-feedback).
        feedback: rejections.length > 0 ? { ...gateFailure, rejections } : gateFailure,
      });
      iterations += 1;
      if (!requireOwnership('diagnosis_result')) return { finalState: state, iterations };
      if (!chargeUsage(diag.costUnits, 'diagnosis_usage')) return { finalState: state, iterations };

      const outcome = await runDiagnosis(diag.hypotheses ?? []);
      if (outcome.status === 'confirmed') {
        move('repair'); // DIAGNOSING -> REPAIRING
        // Fold the patch plan into the next implementer round as MARKED data
        // (REQ-5.4) — alongside this round's rejections, never overwriting them
        // (backlog: rejected-feedback).
        feedback = {
          kind: 'patch_plan',
          patchPlan: outcome.hypothesis.ifConfirmed.patchPlan,
          estimatedBlastRadius: outcome.hypothesis.ifConfirmed.estimatedBlastRadius,
          ...(rejections.length > 0 ? { rejections } : {}),
        };
        // Loop continues: the implementer round now attempts the confirmed fix.
      } else {
        // All refuted / over the per-failure cap -> hypotheses_exhausted; a budget
        // or wallclock trip between probes escalates as that (REQ-5.6, REQ-6).
        if (outcome.reason === 'budget' || outcome.reason === 'wallclock') {
          const exhausted = opts.budget.exceeded();
          emitBudgetExceeded(
            exhausted === false
              ? outcome.reason === 'wallclock' ? 'wallclock' : 'costUnits'
              : exhausted.limit,
          );
        }
        const why =
          outcome.reason === 'budget' || outcome.reason === 'wallclock'
            ? `${outcome.reason}_exhausted`
            : 'hypotheses_exhausted';
        escalate(why, { reason: outcome.reason, hypotheses: summarizeHypothesisLog(outcome.log) });
        return { finalState: state, iterations };
      }
    } else if (proposal.claim === 'BLOCKED') {
      // A core-run T0 pass does not override an explicit BLOCKED claim.
      move('block');
      return { finalState: state, iterations };
    }
    // claim WORKING: keep iterating.
  }
}
