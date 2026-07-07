// The ONLY doorway any agent has into Ring 0 (INV-1/8/9, REQ-11.3).
// Fault-injection scenarios implement this port maliciously; the model
// abstraction layer implements it in a later phase — core does not change.

import type {
  Action,
  ActionRejection,
  GateReport,
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
   * Structured feedback from the previous round — rejections, a gate report, or a
   * confirmed hypothesis' patch plan (REQ-5.4). Never free text.
   */
  feedback: ActionRejection[] | GateReport | RepairGuidance | null;
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
