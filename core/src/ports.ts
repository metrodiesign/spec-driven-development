// The ONLY doorway any agent has into Ring 0 (INV-1/8/9, REQ-11.3).
// Fault-injection scenarios implement this port maliciously; the model
// abstraction layer implements it in a later phase — core does not change.

import type {
  Action,
  ActionRejection,
  GateReport,
  GuidanceFeedback,
  Hypothesis,
  RepairGuidance,
  Role,
  TaskState,
} from './types.ts';

export type ProposalClaim = 'WORKING' | 'READY_FOR_VERIFICATION' | 'BLOCKED';

export interface ProposalInput {
  taskId: string;
  state: TaskState;
  role: Role;
  /**
   * Structured feedback from the previous round — rejections, a gate report, a
   * confirmed hypothesis' patch plan (REQ-5.4), or operator guidance injected while
   * paused (REQ-10.5). Never free text.
   */
  feedback: ActionRejection[] | GateReport | RepairGuidance | GuidanceFeedback | null;
}

export interface Proposal {
  claim: ProposalClaim;
  actions: Action[];
  /**
   * A DIAGNOSING round returns testable hypotheses here instead of actions
   * (REQ-5.1); core validates and runs the probes itself. Absent for every other
   * role, so existing sources are unaffected (append-only — INV-8/10).
   */
  hypotheses?: Hypothesis[];
  /** Cost units the source reports for this round (stub-declared in this phase). */
  costUnits?: number;
}

export interface ProposalSource {
  propose(input: ProposalInput): Promise<Proposal>;
}

/**
 * Operator steering signal, polled by the loop at ITERATION boundaries only —
 * after the current atomic action completes, never mid-action (REQ-10.1). The
 * Human Plane drives it (pause/resume/kill); the loop is the sole consumer.
 * `waitResume` blocks a paused loop until the operator resumes or kills (REQ-10.7).
 * Append-only addition — existing sources/callers are unaffected (INV-8).
 */
export interface LoopControl {
  poll(): 'none' | 'pause' | 'kill';
  waitResume(): Promise<'resume' | 'kill'>;
}
