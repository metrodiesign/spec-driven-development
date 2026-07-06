// Task loop (spec §9.2 discipline, REQ-7): ask the ProposalSource, execute its
// actions under policy, run gates ITSELF, transition on core-run results only.
// Claims are recorded as data (CLAIM_RECORDED) and never cause transitions.
// REVIEWING is the happy-path terminal in this phase (awaiting_human_phase0).

import type { BudgetTracker } from '../budget/budget.ts';
import type { EventLog } from '../state/event-log.ts';
import type { Executor } from '../executor/executor.ts';
import type { GateRunner } from '../gates/runner.ts';
import type { ProposalSource } from '../ports.ts';
import type { Clock, Role, TaskState } from '../types.ts';

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

export function runTaskLoop(_opts: LoopOptions): Promise<LoopResult> {
  throw new Error('NotImplemented: runTaskLoop');
}
