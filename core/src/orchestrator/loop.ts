// Task loop (spec §9.2 discipline, REQ-7): ask the ProposalSource, execute its
// actions under policy, run gates ITSELF, transition on core-run results only.
// Claims are recorded as data (CLAIM_RECORDED) and never cause transitions.
// REVIEWING is the happy-path terminal in this phase (awaiting_human_phase0).

import { transition, type Trigger } from './machine.ts';
import { evaluateHypotheses, summarizeHypothesisLog, type HypothesisOutcome } from '../repair/hypothesis.ts';
import type { BudgetTracker } from '../budget/budget.ts';
import type { EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { Executor } from '../executor/executor.ts';
import type { GateRunner } from '../gates/runner.ts';
import type { ProposalSource } from '../ports.ts';
import type {
  ActionRejection,
  Clock,
  GateReport,
  Hypothesis,
  IdSource,
  RepairGuidance,
  Role,
  TaskState,
} from '../types.ts';

export interface LoopResult {
  finalState: TaskState;
  iterations: number;
  terminalMarker?: 'awaiting_human_phase0';
}

/** Policy bounds for the hypothesis-driven repair cycle (REQ-5.6/5.7/5.8). */
export interface RepairPolicy {
  maxHypotheses: number;
  maxProbesPerHypothesis: number;
  probeTimeoutMs: number;
}

const DEFAULT_REPAIR_POLICY: RepairPolicy = {
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
}

export async function runTaskLoop(opts: LoopOptions): Promise<LoopResult> {
  let state: TaskState = 'PROPOSED';

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
  let feedback: ActionRejection[] | GateReport | RepairGuidance | null = null;

  for (;;) {
    const over = opts.budget.exceeded();
    if (over !== false) {
      opts.log.append({
        runId: opts.runId,
        taskId: opts.taskId,
        type: 'BUDGET_EXCEEDED',
        payload: { limit: over.limit, iterations },
      });
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
      escalate('budget_exhausted');
      return { finalState: state, iterations };
    }

    const proposal = await opts.source.propose({
      taskId: opts.taskId,
      state,
      role: opts.role,
      feedback,
    });
    iterations += 1;
    opts.budget.noteIteration(proposal.costUnits ?? 0);
    feedback = null;

    // The claim is DATA (INV-1/2) — recorded, never trusted.
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'CLAIM_RECORDED',
      payload: { claim: proposal.claim, actionCount: proposal.actions.length },
    });

    const rejections: ActionRejection[] = [];
    for (const action of proposal.actions) {
      const outcome = await opts.executor.execute(action, opts.role);
      if (outcome.status === 'rejected') rejections.push(outcome.rejection);
    }
    if (rejections.length > 0) feedback = rejections;

    if (proposal.claim === 'BLOCKED') {
      move('block');
      return { finalState: state, iterations };
    }

    if (proposal.claim === 'READY_FOR_VERIFICATION') {
      // Core verifies REGARDLESS of the claim: T0 fast-fail, then T1 (REQ-8.2).
      move('verify');
      const t0 = await opts.gates.run('T0');
      const t1 = t0.pass === true ? await opts.gates.run('T1') : null;

      if (t0.pass === true && t1 !== null && t1.pass === true) {
        move('gate_passed');
        move('review');
        // Happy-path terminal for this phase (REQ-7.6): a human takes it from here.
        opts.log.append({
          runId: opts.runId,
          taskId: opts.taskId,
          type: 'TASK_STATE',
          payload: { state, marker: 'awaiting_human_phase0' },
        });
        return { finalState: state, iterations, terminalMarker: 'awaiting_human_phase0' };
      }

      move('gate_failed');
      const gateReport = t1 ?? t0;
      move('diagnose'); // FAILED -> DIAGNOSING

      // REQ-6.7 again at the diagnose boundary: never build the diagnostician
      // AgentRequest on a spent budget.
      if (opts.budget.remaining() <= 0) {
        escalate('budget_exhausted');
        return { finalState: state, iterations };
      }

      // A diagnostician round returns testable hypotheses (REQ-5.1); the claim/
      // actions of this round are irrelevant — core runs the probes itself.
      const diag = await opts.source.propose({
        taskId: opts.taskId,
        state,
        role: 'diagnostician',
        feedback: gateReport,
      });
      iterations += 1;
      opts.budget.noteIteration(diag.costUnits ?? 0);

      const outcome = await runDiagnosis(diag.hypotheses ?? []);
      if (outcome.status === 'confirmed') {
        move('repair'); // DIAGNOSING -> REPAIRING
        // Fold the patch plan into the next implementer round as MARKED data (REQ-5.4).
        feedback = {
          kind: 'patch_plan',
          patchPlan: outcome.hypothesis.ifConfirmed.patchPlan,
          estimatedBlastRadius: outcome.hypothesis.ifConfirmed.estimatedBlastRadius,
        };
        // Loop continues: the implementer round now attempts the confirmed fix.
      } else {
        // All refuted / over the per-failure cap -> hypotheses_exhausted; a budget
        // or wallclock trip between probes escalates as that (REQ-5.6, REQ-6).
        const why =
          outcome.reason === 'budget' || outcome.reason === 'wallclock'
            ? `${outcome.reason}_exhausted`
            : 'hypotheses_exhausted';
        escalate(why, { reason: outcome.reason, hypotheses: summarizeHypothesisLog(outcome.log) });
        return { finalState: state, iterations };
      }
    }
    // claim WORKING: keep iterating.
  }
}
