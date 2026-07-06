// Ring 0 shared types (unified-platform-spec.md §6). Vendor-neutral by law (INV-7).

/** Roles and their write rights come from policy config (REQ-1.6, spec §6.1). */
export type Role = 'planner' | 'test_designer' | 'implementer';

/** Action DSL (spec §6.1). Content/diff travel as blob refs into the evidence store. */
export type Action =
  | { type: 'WRITE_FILE'; actionId: string; path: string; contentRef: string }
  | { type: 'APPLY_PATCH'; actionId: string; diffRef: string }
  | {
      type: 'RUN_COMMAND';
      actionId: string;
      cmd: string;
      cwd?: string;
      network: 'none' | `allowlist:${string}`;
    }
  | { type: 'READ_FILE'; actionId: string; path: string }
  | { type: 'REQUEST_TOOL'; actionId: string; name: string; args: unknown };

/** Structured rejection — returned to the agent as data, never free text (REQ-1.5). */
export interface ActionRejection {
  actionId: string;
  reason:
    | 'path_outside_allowlist'
    | 'golden_write_denied'
    | 'schema_violation'
    | 'sandbox_unavailable'
    | 'unsupported_action_phase0';
  detail: string;
}

/** Task states (spec §6.3). Post-REVIEWING transitions are phase-gated. */
export type TaskState =
  | 'PROPOSED'
  | 'ANALYZING'
  | 'READY'
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'FAILED'
  | 'DIAGNOSING'
  | 'REPAIRING'
  | 'PASSED'
  | 'REVIEWING'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'MERGE_QUEUED'
  | 'AUDITED'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'ESCALATED'
  | 'CANCELLED'
  | 'ROLLED_BACK'
  | 'QUARANTINED'
  | 'PAUSED';

export type EventType =
  | 'TASK_STATE'
  | 'CLAIM_RECORDED'
  | 'ACTION_INTENT'
  | 'ACTION_APPLIED'
  | 'ACTION_REJECTED'
  | 'GATE_RESULT'
  | 'LEASE_CLAIMED'
  | 'LEASE_RENEWED'
  | 'LEASE_RELEASED'
  | 'BUDGET_EXCEEDED'
  | 'ESCALATED'
  | 'GOVERNANCE_CHANGE'
  | 'ERROR';

/** Append-only event row (INV-10). `seq` is assigned by the log. */
export interface PlatformEvent {
  seq: number;
  ts: string;
  runId: string;
  taskId: string | null;
  type: EventType;
  payload: Record<string, unknown>;
}

export type GateTier = 'T0' | 'T1' | 'T2' | 'T3';

export interface GateCheck {
  name: string;
  pass: boolean;
  flakySuspect?: boolean;
  evidenceRef: string;
}

/** Every report names exactly what was checked, under which config (INV-10). */
export interface GateReport {
  tier: GateTier;
  pass: boolean | 'not_enabled';
  gateConfigHash: string;
  commitHash: string;
  envHash: string;
  checks: GateCheck[];
  /** DoD#4 scope: golden check detects tampering only (REQ-9.3). */
  scopeNote: string;
}

/** Injectable time source — core logic never reads the wall clock directly. */
export interface Clock {
  now(): number;
}

/** Injectable id source — core logic never draws randomness directly. */
export interface IdSource {
  next(prefix: string): string;
}

export interface BudgetLimits {
  maxIterations: number;
  maxCostUnits: number;
  maxWallclockMs: number;
}
