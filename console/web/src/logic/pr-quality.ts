export type PrGateState =
  | 'QUEUED' | 'ACQUIRING' | 'CLASSIFYING' | 'SNAPSHOT_ATTESTING' | 'CHECKING' | 'REVIEWING'
  | 'JUDGING' | 'DECIDING' | 'REPORTING' | 'AWAITING_HUMAN' | 'COMPLETED' | 'CANCELLED_STALE'
  | 'CANCELLED' | 'FAILED_INFRASTRUCTURE' | 'REPORTING_FAILED' | 'FAILED_INTERNAL';

export type QualityDecision = 'PASS' | 'PASS_WITH_WARNINGS' | 'HUMAN_REVIEW_REQUIRED' | 'FAIL' | 'INFRASTRUCTURE_FAILURE';
export type Publication = 'NOT_STARTED' | 'IN_PROGRESS' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';

export interface PrGateProjection {
  runId: string;
  repository: string | null;
  pullRequest: number | null;
  headSha: string | null;
  state: PrGateState;
  systemDecision: QualityDecision | null;
  effectiveDecision: QualityDecision | null;
  publication: Publication;
  updatedAt: string | null;
}

export interface PrGateDetail extends PrGateProjection {
  headStatus: { reviewedHeadSha: string; currentHeadSha: string; stale: boolean; publication: Publication } | null;
  systemReport: null | {
    risk: string;
    analysisCoverage: string;
    reviewerCoverage: string;
    costUnits: number;
    deterministicReportRef: string;
    judgedFindingRefs: string[];
    reasons: string[];
  };
  deterministicReport: null | {
    checks: Array<{ id: string; status: string; required: boolean; durationMs: number; evidenceRef: string }>;
  };
  judgedFindings: Array<{
    canonicalFindingKey: string;
    classification: string;
    severity: string;
    evidenceRefs: string[];
  }>;
  reviewerStatuses: Array<{ adapterId: string; status: string; resultRef: string }>;
  overrideHistory: Array<{
    overrideId: string;
    actor: string;
    action: 'APPROVE' | 'REJECT';
    reason: string;
    findingIds: string[];
    createdAt: string;
  }>;
}

const ACTIVE = new Set<PrGateState>([
  'QUEUED', 'ACQUIRING', 'CLASSIFYING', 'SNAPSHOT_ATTESTING', 'CHECKING', 'REVIEWING', 'JUDGING', 'DECIDING', 'REPORTING',
]);

export function canCancel(state: PrGateState): boolean {
  return ACTIVE.has(state);
}

export function canOverride(detail: PrGateDetail | null): boolean {
  return detail !== null && detail.systemReport !== null && detail.headStatus !== null && !detail.headStatus.stale;
}

export function semanticStatus(run: Pick<PrGateProjection, 'state' | 'effectiveDecision'>): string {
  return run.effectiveDecision === null ? run.state : `${run.state}: ${run.effectiveDecision}`;
}

export function decisionTone(decision: QualityDecision | null): 'neutral' | 'success' | 'warning' | 'danger' {
  if (decision === 'PASS') return 'success';
  if (decision === 'PASS_WITH_WARNINGS' || decision === 'HUMAN_REVIEW_REQUIRED') return 'warning';
  if (decision === 'FAIL' || decision === 'INFRASTRUCTURE_FAILURE') return 'danger';
  return 'neutral';
}
