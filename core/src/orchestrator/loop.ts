// Task loop (spec §9.2 discipline, REQ-7): ask the ProposalSource, execute its
// actions under policy, run gates ITSELF, transition on core-run results only.
// Claims are recorded as data (CLAIM_RECORDED) and never cause transitions.
// REVIEWING is the happy-path terminal in this phase (awaiting_human_phase0).

import { transition, type Trigger } from './machine.ts';
import type { BudgetTracker } from '../budget/budget.ts';
import type { EventLog } from '../state/event-log.ts';
import type { Executor } from '../executor/executor.ts';
import type { GateRunner } from '../gates/runner.ts';
import type { ProposalSource } from '../ports.ts';
import type { ActionRejection, Clock, GateReport, Role, TaskState } from '../types.ts';

export interface LoopResult {
  finalState: TaskState;
  iterations: number;
  terminalMarker?: 'awaiting_human_phase0';
}

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

  // Deterministic walk to the working state.
  move('analyze');
  move('ready');
  move('start_implementing');

  let iterations = 0;
  let feedback: ActionRejection[] | GateReport | null = null;

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
      feedback = t1 ?? t0;
      // Phase 0 repair path is structural: FAILED -> DIAGNOSING -> REPAIRING,
      // then the next proposal round attempts the fix.
      move('diagnose');
      move('repair');
    }
    // claim WORKING: keep iterating.
  }
}
