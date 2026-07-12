// Pure display logic for F-Loop (REQ-15.7): task-state badge projection from
// events, approval-package rendering incl. attestation checklist, and steering
// control state. Testable without a DOM — the view (Loop.tsx) stays thin.

export interface LoopEvent {
  seq: number;
  type: string;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export interface LoopApprovalPackage {
  id: string;
  taskId: string;
  goalExcerpt: string;
  acIds: string[];
  diffRef: string;
  attestations: string[];
  riskClass: string;
  assumptions: string[];
  unresolvedRisks: string[];
  // Duplicated from core's ApprovalPackage by convention — web has no dependency on
  // core (phase5-stage3 REQ-6.3).
  provenance?: { specPath: string; requirementsCommit: string; requirementsSha256?: string; generatedAt: string };
}

/** Governance proposals share the /approvals list but carry `kind`; task packages never do (core's own discriminator, REQ-9.4). */
export function isGovernanceProposal(item: object): boolean {
  return 'kind' in item;
}

/** Just the task approval packages REQ-15.7 renders — governance proposals are a separate, already-shipped CLI flow. */
export function taskApprovalPackages(items: object[]): LoopApprovalPackage[] {
  return items.filter((i) => !isGovernanceProposal(i)) as LoopApprovalPackage[];
}

/** The next `since` watermark for event polling (REQ-15.8) — the highest seq seen so far. */
export function nextSince(current: number, fresh: LoopEvent[]): number {
  return fresh.reduce((max, e) => Math.max(max, e.seq), current);
}

/** The badge for a run's header: last known TASK_STATE, or "ended" once the discovery file is gone/tombstoned. */
export function latestTaskState(events: LoopEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e !== undefined && e.type === 'TASK_STATE') return String(e.payload['state']);
  }
  return null;
}

export function stateBadge(ended: boolean, state: string | null): string {
  if (ended) return 'ended';
  return state ?? 'unknown';
}

export interface AttestationRow {
  text: string;
  checked: boolean;
}

/** Checklist rows for the approval package's attestations against what the operator has ticked so far. */
export function attestationChecklist(pkg: LoopApprovalPackage, checkedIds: readonly string[]): AttestationRow[] {
  const checked = new Set(checkedIds);
  return pkg.attestations.map((text) => ({ text, checked: checked.has(text) }));
}

/** Mirrors the backend's own attestations_incomplete gate (advisory client-side — the server re-validates). */
export function canApprove(pkg: LoopApprovalPackage, checkedIds: readonly string[]): boolean {
  const checked = new Set(checkedIds);
  return pkg.attestations.every((a) => checked.has(a));
}

/** Display line for a package's provenance, or null when absent (REQ-6.3/6.4). Values verbatim — audit data, never through t(). */
export function goalProvenanceLine(pkg: LoopApprovalPackage): string | null {
  const p = pkg.provenance;
  if (p === undefined) return null;
  return `${p.specPath} @ ${p.requirementsCommit} · ${p.generatedAt}`;
}

// Mirrors core/src/human/api.ts's STEERABLE set (the pre-merge working states +
// PAUSED that still have an iteration boundary). web has no dependency on `core`
// (like every other logic/*.ts here), so the list is duplicated, not imported.
const STEERABLE = new Set([
  'PROPOSED', 'ANALYZING', 'READY', 'IMPLEMENTING', 'VERIFYING', 'FAILED',
  'DIAGNOSING', 'REPAIRING', 'PASSED', 'REVIEWING', 'CHANGES_REQUESTED', 'PAUSED',
]);

export interface SteeringControls {
  canPause: boolean;
  canResume: boolean;
  canInject: boolean;
  /** true = queue at the next boundary (REQ-17.1, non-PAUSED); false = immediate (state already PAUSED). */
  injectAtNextBoundary: boolean;
}

const NONE: SteeringControls = { canPause: false, canResume: false, canInject: false, injectAtNextBoundary: false };

/** Which steering controls make sense for the run's current projected state — the server is the actual authority (409 otherwise). */
export function steeringControls(ended: boolean, state: string | null): SteeringControls {
  if (ended || state === null || !STEERABLE.has(state)) return NONE;
  const paused = state === 'PAUSED';
  return { canPause: !paused, canResume: paused, canInject: true, injectAtNextBoundary: !paused };
}

// --- Deploy plane (REQ-6/7): GET /deploy's shape — the deploy package reuses
// LoopApprovalPackage as-is (same fields), so attestationChecklist/canApprove above
// already work for it unchanged. ---

export interface DeployStatus {
  state: string | null;
  approval: LoopApprovalPackage | null;
}

/** Hidden while no deploy is configured or composed (REQ-7.4) — a fetch failure and the
 * idle {state:null, approval:null} shape (no `deploy:` in this task's contract) both hide it. */
export function deployCardVisible(status: DeployStatus | null): boolean {
  return status !== null && (status.state !== null || status.approval !== null);
}

/** WHEN DEPLOY_STATE is EXPANDED, F-Loop shows the manual-rollback control (REQ-7.2). */
export function canRollbackDeploy(state: string | null): boolean {
  return state === 'EXPANDED';
}

/**
 * Probe results summary (REQ-7.1) from PROBE_RUN events after the stage's own CANARY
 * start. PROBE_RUN is shared with the hypothesis engine's repair probes (same payload
 * shape, core/src/repair/hypothesis.ts) — scoping to events after CANARY is safe because
 * deploy only ever starts once the task is already COMPLETED, strictly after any repair
 * round's own probes (REQ-6.1). null while the stage hasn't started yet.
 */
export function deployProbeSummary(events: readonly LoopEvent[]): { pass: number; fail: number } | null {
  const canaryStart = events.find((e) => e.type === 'DEPLOY_STATE' && e.payload['state'] === 'CANARY');
  if (canaryStart === undefined) return null;
  const probes = events.filter((e) => e.type === 'PROBE_RUN' && e.seq > canaryStart.seq);
  if (probes.length === 0) return null;
  return {
    pass: probes.filter((p) => p.payload['exit'] === 0).length,
    fail: probes.filter((p) => p.payload['exit'] !== 0).length,
  };
}
