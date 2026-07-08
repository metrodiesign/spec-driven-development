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
