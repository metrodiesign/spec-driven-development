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
    | 'sandbox_violation'
    | 'network_grant_unavailable'
    // A RUN_COMMAND proposed by a role with no command grant (only implementer and
    // diagnostician may run commands, spec §6.1) — rejected BEFORE spawn, no process
    // is created (append-only). Mirrors golden_write_denied's role-gate shape.
    | 'command_role_denied'
    | 'offline_dependency_unavailable'
    | 'package_install_denied'
    | 'command_artifact_unavailable'
    | 'command_diff_rejected'
    | 'red_artifact_frozen'
    | 'command_failed'
    | 'evidence_invalid'
    | 'patch_malformed'
    | 'patch_unsupported'
    | 'patch_conflict'
    | 'patch_noop'
    | 'invalid_request'
    | 'timed_out'
    | 'cancelled'
    | 'output_limit'
    | 'unsupported_action_phase0'
    // A governed network grant (package_install) that failed the security-plane
    // policy: pattern near-miss or missing lockfile (REQ-11.2, append-only).
    | 'network_policy_denied'
    // A fusion.deliberate REQUEST_TOOL arriving after the task already consumed its
    // single fusion activation (REQ-10.9, append-only) — structured feedback, mirrors
    // the out-of-authority rejection pattern; never a crash.
    | 'depth_exceeded'
    // A WRITE to a path neither in the context bundle nor previously READ, rejected
    // by the proposal source itself before any executor call (REQ-5.4, append-only)
    // — roundtrips into Proposal.rejections like every other rejection reason
    // instead of a silent log-only drop (backlog: rejected-feedback).
    | 'context_violation';
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
  | 'EVIDENCE_AUTHORIZED'
  | 'LEASE_CLAIMED'
  | 'LEASE_RENEWED'
  | 'LEASE_RELEASED'
  | 'BUDGET_EXCEEDED'
  | 'ESCALATED'
  | 'GOVERNANCE_CHANGE'
  | 'ERROR'
  // P0-09 core-observed RED provenance (append-only; REQ-9.6-9.9).
  | 'RED_ARTIFACT_FROZEN'
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
  | 'GOVERNANCE_PROPOSED'
  // Phase 3 fusion additions (append-only, INV-10). Emitted by aal/fusion; core
  // only owns the type union (Ring 0 executes nothing for fusion — the evidence
  // port keeps core the sole measurer). FUSION_DISSENT captures a finding not
  // raised by every panel candidate (REQ-10.6).
  | 'FUSION_PANEL'
  | 'FUSION_CANDIDATE'
  | 'FUSION_RESOLVED'
  | 'FUSION_DISSENT'
  // Phase 3 merge-queue additions (append-only, INV-10).
  | 'MERGE_ENQUEUED'
  | 'MERGE_RESULT'
  // Phase 3 out-of-band auditor addition (append-only, INV-10).
  | 'OOB_AUDIT_RESULT'
  // Phase 3 outcome-routing shadow addition (append-only, INV-10; REQ-7).
  | 'SHADOW_ROUTE'
  // Phase 4 approval-pipeline production wiring (append-only, INV-10; REQ-2.2).
  | 'APPROVAL_PACKAGE_CREATED'
  // Phase 4 deploy stage addition (append-only, INV-10; REQ-5.1).
  | 'DEPLOY_STATE'
  // Phase 4 deploy approval + Human Plane surface (append-only, INV-10; REQ-6.7/6.11/6.12).
  | 'DEPLOY_DECISION'
  | 'DEPLOY_WINDOW_CLOSED'
  // Phase 4 lessons pipeline addition (append-only, INV-10; REQ-10.1/11.2/12.5).
  | 'LESSON_PROPOSED'
  | 'LESSON_APPROVED'
  | 'LESSON_INJECTED'
  // Phase 4 outcome-routing ACTIVE addition (append-only, INV-10; REQ-15.4/15.5).
  | 'OUTCOME_ROUTE'
  | 'ROUTING_FROZEN'
  // Phase 4 planner-role fusion auto-routing addition (append-only, INV-10; REQ-16.5).
  | 'PLAN_RESOLVED'
  // Phase 5 stage-4 task-graph planning gate (append-only, INV-10; REQ-4.8). Both
  // outcomes live on the production path: the run appends exactly one of them
  // right after the event log opens and before any adapter is built.
  | 'TASK_GRAPH_FROZEN'
  | 'TASK_GRAPH_REJECTED'
  // P0-08 operator golden provenance (append-only; REQ-8.11).
  | 'GOLDEN_FIXTURE_PROVISIONED'
  // PR quality gate additions (append-only; event payloads contain refs/hashes only).
  | 'PR_GATE_STATE'
  | 'PR_SOURCE_PINNED'
  | 'PR_SNAPSHOT_ATTESTED'
  | 'PR_CLASSIFIED'
  | 'PR_CHECK_RESULT'
  | 'PR_REVIEW_RESULT'
  | 'PR_JUDGE_RESULT'
  | 'PR_GATE_DECIDED'
  | 'PR_HUMAN_DECISION'
  | 'PR_GATE_REPORTED'
  | 'PR_REPLACEMENT_ENQUEUED'
  | 'PR_RUN_CANCELLED';

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

/**
 * A confirmed repair hypothesis on its way to becoming reusable diagnostic
 * knowledge (spec §10.4, REQ-10/11/12). `id` is content-addressed
 * (`lsn-<sha256(statement+evidenceRefs)>`) so re-proposing the same lesson is
 * idempotent. Lives as a JSON file under `.ai/lessons/{pending,approved}/`;
 * `approvedAt` is set only once a human approves the paired `lesson_promote`
 * governance proposal (INV-16 — the system cannot teach itself).
 */
export interface LessonRecord {
  id: string;
  statement: string;
  sourceRunId: string;
  sourceTaskId: string;
  evidenceRefs: string[];
  proposedAt: string;
  approvedAt?: string;
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
  /** Resolved command this check ran (e.g. after fallback resolution), not the retry wrapper. */
  command?: string;
  /** Bounded tail (<=4096 bytes) of the captured stdout/stderr, wrapper header stripped. */
  outputTail?: string;
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
  /** Immutable task commit whose Git tree is exactly `worktreeHash`. */
  artifactCommitHash?: string;
  /** Immutable target-base commit used to derive the reviewed task diff. */
  baseCommitHash?: string;
  /** Immutable merge commit produced from `artifactCommitHash`. */
  mergedCommitHash?: string;
  envHash: string;
  checks: GateCheck[];
  /** DoD#4 scope: golden check detects tampering only (REQ-9.3). */
  scopeNote: string;
}

export interface GateReportEvidenceHash {
  evidenceRef: string;
  sha256: string;
}

export interface GateReportAuth {
  version: 'gate-report-v1';
  algorithm: 'Ed25519';
  keyFingerprint: string;
  evidence: GateReportEvidenceHash[];
  signatureBase64: string;
}

export interface AuthenticatedGateReport extends GateReport {
  runId: string;
  taskId: string;
  auth: GateReportAuth;
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
