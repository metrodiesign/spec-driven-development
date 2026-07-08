// Ring 0 shared types (unified-platform-spec.md §6). Vendor-neutral by law (INV-7).

/** Roles and their write rights come from policy config (REQ-1.6, spec §6.1). */
// `diagnostician` (Phase 2, REQ-4) drives a DIAGNOSING round: reasoning + probe
// RUN_COMMANDs only, empty write-prefix list (see executor/path-policy).
// `reviewer` (Phase 3, REQ-4.2) is reasoning-only like diagnostician — the fusion
// blind judge routes as this role; it proposes nothing to execute.
export type Role = 'planner' | 'test_designer' | 'implementer' | 'diagnostician' | 'reviewer';

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
      /** Policy-pinned wall-time bound for this command (ms). Hypothesis probes set it (REQ-5.8). */
      timeoutMs?: number;
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
    | 'unsupported_action_phase0'
    // A governed network grant (package_install) that failed the security-plane
    // policy: pattern near-miss or missing lockfile (REQ-11.2, append-only).
    | 'network_policy_denied';
  detail: string;
}

/**
 * Hypothesis-driven repair (spec §9.3, REQ-5). A DIAGNOSING round returns these
 * as UNTRUSTED data (INV-3); core validates the shape, caps probes, and runs each
 * probe ITSELF through the executor (the agent never executes — INV-1).
 */
export interface HypothesisProbe {
  /** Shell command run as RUN_COMMAND, network:'none', diagnostician role. */
  cmd: string;
  cwd?: string;
  /** Substring the probe's captured output must contain to CONFIRM (REQ-5.4). */
  expected: string;
}

export interface Hypothesis {
  statement: string;
  /** Cheapest-first (array order); core stops at the first confirming probe (REQ-5.3). */
  probes: HypothesisProbe[];
  ifConfirmed: { patchPlan: string; estimatedBlastRadius: string };
}

export interface HypothesisVerdict {
  hypothesis: Hypothesis;
  /** `undecided` = a probe errored/timed out (REQ-5.8): counts toward the cap, never a refutation. */
  verdict: 'confirmed' | 'refuted' | 'undecided';
  /** Captured probe output text, in probe order (the confirming/last probe last). */
  probeOutputs: string[];
  /** Content-addressed evidence ref per probe run — carried in escalation instead of a raw dump (REQ-5.6). */
  probeRefs: string[];
}

/**
 * A confirmed hypothesis' patch plan, folded into the next implementer round as
 * MARKED untrusted data (REQ-5.4) — travels as structured feedback, never free text.
 */
export interface RepairGuidance {
  kind: 'patch_plan';
  patchPlan: string;
  estimatedBlastRadius: string;
}

/**
 * Operator guidance injected while PAUSED (REQ-10.5), folded into the next round as
 * MARKED untrusted data (INV-3) — exactly like gate feedback. Guidance is advisory:
 * it never alters the frozen contract (an AC/scope change needs a goal.yaml
 * amendment, which the frozen-contract hash check escalates as `contract_changed`,
 * REQ-10.6).
 */
export interface GuidanceFeedback {
  kind: 'guidance';
  guidance: string;
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
  | 'ERROR'
  // Phase 1 additions (append-only; no existing type changes meaning — INV-10).
  | 'PROPOSAL_INTENT'
  | 'APPROVAL_RECORDED'
  | 'KILL_REQUESTED'
  | 'CONTEXT_BUILT'
  | 'CONFORMANCE_RECORDED'
  // Phase 2 additions (append-only, INV-10). GOVERNANCE_CHANGE (above) gains its
  // first producers; governance events live in the durable .ai/governance log.
  | 'BREAKER_STATE_CHANGED'
  | 'QUOTA_PROBE'
  | 'HYPOTHESIS_PROPOSED'
  | 'PROBE_RUN'
  | 'HYPOTHESIS_CONFIRMED'
  | 'HYPOTHESIS_REFUTED'
  | 'PAUSE_REQUESTED'
  | 'GUIDANCE_INJECTED'
  | 'RESUMED'
  | 'AUTO_APPROVED'
  | 'AUDIT_SAMPLED'
  | 'AUDIT_RESULT'
  | 'CANARY_TRIPPED'
  | 'DATA_POLICY_VIOLATION'
  | 'AUTOMATION_DEFERRED'
  | 'AUTOMATION_OVERRIDE'
  | 'GOVERNANCE_PROPOSED';

/**
 * Shared context contracts (spec §9.4). Core owns these because core/context
 * PRODUCES them; Ring 1 imports them upward (INV-8) to place a bundle in an
 * AgentRequest. Every piece is untrusted data (INV-3) and marked as such when
 * serialized.
 */
export interface ContextPiece {
  id: string;
  kind: 'file' | 'excerpt' | 'feedback' | 'contract';
  path?: string;
  content: string;
  /** WHY this piece was included (the inclusion-rule id) — recorded in the manifest. */
  reason: string;
}

export interface ContextBundle {
  pieces: ContextPiece[];
  /** Per-request random token planted in the data-marker preamble (injection canary). */
  canaryToken: string;
  stats: { bytes: number; pieceCount: number };
}

/** The slice of the frozen goal contract a model is allowed to see (never the whole repo). */
export interface TaskContractExcerpt {
  goalId: string;
  title: string;
  objective: string;
  acceptanceCriteria: { id: string; description: string }[];
}

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
  detail?: string;
}

/** Every report names exactly what was checked, under which config (INV-10). */
export interface GateReport {
  tier: GateTier;
  pass: boolean | 'not_enabled';
  gateConfigHash: string;
  commitHash: string;
  /**
   * Git tree hash of the exact (possibly dirty) tracked+untracked content the
   * gate ran on (REQ-4.2). Gates run mid-loop against uncommitted writes, so
   * commitHash (HEAD) alone would name a tree that cannot reproduce the pass.
   */
  worktreeHash: string;
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
