// The ONLY doorway any agent has into Ring 0 (INV-1/8/9, REQ-11.3).
// Fault-injection scenarios implement this port maliciously; the model
// abstraction layer implements it in a later phase — core does not change.

import type { Action, ActionRejection, GateReport, Role, TaskState } from './types.ts';

export type ProposalClaim = 'WORKING' | 'READY_FOR_VERIFICATION' | 'BLOCKED';

export interface ProposalInput {
  taskId: string;
  state: TaskState;
  role: Role;
  /** Structured feedback from the previous round — rejections or a gate report. Never free text. */
  feedback: ActionRejection[] | GateReport | null;
}

export interface Proposal {
  claim: ProposalClaim;
  actions: Action[];
  /** Cost units the source reports for this round (stub-declared in this phase). */
  costUnits?: number;
}

export interface ProposalSource {
  propose(input: ProposalInput): Promise<Proposal>;
}
