export type RepositoryId = `${string}/${string}`;
export type Sha256Ref = `sha256:${string}`;

export interface PullRequestDescriptor {
  repository: RepositoryId;
  number: number;
  title: string;
  description: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  fromFork: boolean;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface PinnedChangeSet {
  descriptor: PullRequestDescriptor;
  mergeBaseSha: string;
  diffRef: Sha256Ref;
  files: ChangedFile[];
  trustedRepositoryPolicyRef: Sha256Ref;
}

export interface SnapshotIdentity {
  repository: RepositoryId;
  pullRequest: number;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  diffRef: Sha256Ref;
  policyRef: Sha256Ref;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  identity: SnapshotIdentity;
  createdAt: string;
  worktreeRef: Sha256Ref;
  changedFiles: Array<ChangedFile & { beforeRef?: Sha256Ref; afterRef?: Sha256Ref }>;
  configRefs: Sha256Ref[];
  rulesRefs: Sha256Ref[];
  manifestRef: Sha256Ref;
}

export type ChangeCategory =
  | 'BUG_FIX'
  | 'FEATURE'
  | 'REFACTOR'
  | 'SECURITY'
  | 'PERFORMANCE'
  | 'DEPENDENCY'
  | 'DATABASE'
  | 'API'
  | 'FRONTEND'
  | 'MOBILE'
  | 'INFRASTRUCTURE'
  | 'CI_CD'
  | 'CONFIGURATION'
  | 'DOCUMENTATION'
  | 'TEST'
  | 'ARCHITECTURE'
  | 'MIGRATION';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AnalysisCoverage = 'FULL' | 'PARTIAL' | 'LIMITED';

export interface ChangeAnalysis {
  technologies: string[];
  categories: ChangeCategory[];
  components: string[];
  publicContracts: string[];
  impactEdges: Array<{ from: string; to: string; reason: string }>;
  risk: { level: RiskLevel; reasons: string[] };
  coverage: AnalysisCoverage;
  omittedPaths: Array<{ path: string; reason: string }>;
}

export type DeterministicCheckKind = 'build' | 'test' | 'security' | 'contract' | 'lint' | 'custom';

export interface DeterministicCheckSpec {
  id: string;
  kind: DeterministicCheckKind;
  command: string;
  cwd?: string;
  required: boolean;
  timeoutMs: number;
  network: 'none';
  install: false;
  profiles: string[];
  components: string[];
}

export interface QualityProfile {
  id: string;
  activation: {
    technologies?: string[];
    categories?: ChangeCategory[];
    components?: string[];
    publicContracts?: string[];
    minimumRisk?: RiskLevel;
  };
  checks: DeterministicCheckSpec[];
  reviewDimensions: string[];
  riskFloor?: RiskLevel;
}

export interface EffectivePolicy {
  requiredReviewerCount: number;
  blockingSeverity: FindingSeverity;
  secretScanningRequired: true;
  allowStalePass: false;
  network: 'none';
  install: false;
  providerTimeoutMs: number;
  runDeadlineMs: number;
  maxCostUnits: number;
  riskFloor: RiskLevel;
  requireHumanApproval: boolean;
  checks: DeterministicCheckSpec[];
  profiles: QualityProfile[];
}

export type PolicyLayer = Partial<
  Omit<EffectivePolicy, 'checks' | 'profiles' | 'secretScanningRequired' | 'allowStalePass' | 'network' | 'install'>
> & {
  secretScanningRequired?: boolean;
  allowStalePass?: boolean;
  network?: string;
  install?: boolean;
  checks?: DeterministicCheckSpec[];
  profiles?: QualityProfile[];
};

export interface AnalysisPlan {
  snapshot: SnapshotIdentity;
  analysis: ChangeAnalysis;
  profiles: QualityProfile[];
  checks: DeterministicCheckSpec[];
  policyRef: Sha256Ref;
}

export interface DeterministicReport {
  snapshot: SnapshotIdentity;
  checks: Array<{
    id: string;
    status: 'PASSED' | 'FAILED' | 'TIMED_OUT' | 'INFRASTRUCTURE_FAILURE';
    required: boolean;
    durationMs: number;
    evidenceRef: Sha256Ref;
  }>;
  reportRef: Sha256Ref;
}

export type FindingSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ReviewerFinding {
  id: string;
  category: string;
  severity: FindingSeverity;
  title: string;
  finding: string;
  rootCause: string;
  evidence: Array<{
    path: string;
    startLine: number;
    endLine: number;
    excerptHash: Sha256Ref;
  }>;
  trigger: string;
  impact: string;
  suggestedFix: string;
  confidence: number;
}

export type ReviewerStatus =
  | 'SUCCEEDED'
  | 'TIMED_OUT'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'FAILED'
  | 'INVALID_RESPONSE'
  | 'CONTEXT_LIMITED'
  | 'UNAVAILABLE'
  | 'CANCELLED';

export interface ReviewerResult {
  requestId: string;
  adapterId: string;
  modelVersion: string;
  snapshot: SnapshotIdentity;
  status: ReviewerStatus;
  findings: ReviewerFinding[];
  usage: { costUnits: number; rawRef?: Sha256Ref };
  transcriptRef: Sha256Ref | null;
  actionRequests: unknown[];
  toolUseCount: number;
  cancellationLatencyMs?: number;
}

export type VerificationClass = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'FALSE_POSITIVE';

export interface JudgedFinding {
  canonicalFindingKey: string;
  sourceFindingIds: string[];
  classification: VerificationClass;
  severity: FindingSeverity;
  evidenceRefs: Sha256Ref[];
  rationaleRef: Sha256Ref;
}

export interface JudgeResult {
  snapshot: SnapshotIdentity;
  findings: JudgedFinding[];
  actionRequests: unknown[];
  toolUseCount: number;
}

export type ReviewerCoverage = 'FULL' | 'DEGRADED' | 'INSUFFICIENT' | 'INFRASTRUCTURE_FAILURE';
export type QualityDecision = 'PASS' | 'PASS_WITH_WARNINGS' | 'HUMAN_REVIEW_REQUIRED' | 'FAIL' | 'INFRASTRUCTURE_FAILURE';

export interface ConsensusSummary {
  reviewerCoverage: ReviewerCoverage;
  availableReviewers: number;
  findingsByClass: Record<VerificationClass, number>;
  uniqueDiscoveriesByReviewer: Record<string, number>;
  dissentRefs: Sha256Ref[];
}

export interface QualityDecisionReport {
  runId: string;
  snapshot: SnapshotIdentity;
  decision: QualityDecision;
  reasons: string[];
  profiles: string[];
  risk: RiskLevel;
  analysisCoverage: AnalysisCoverage;
  reviewerCoverage: ReviewerCoverage;
  deterministicReportRef: Sha256Ref;
  judgedFindingRefs: Sha256Ref[];
  consensusRef: Sha256Ref;
  policyRef: Sha256Ref;
  costUnits: number;
  durationMs: number;
  reportRef: Sha256Ref;
}

export type PrGateRunState =
  | 'QUEUED'
  | 'ACQUIRING'
  | 'CLASSIFYING'
  | 'SNAPSHOT_ATTESTING'
  | 'CHECKING'
  | 'REVIEWING'
  | 'JUDGING'
  | 'DECIDING'
  | 'REPORTING'
  | 'AWAITING_HUMAN'
  | 'COMPLETED'
  | 'CANCELLED_STALE'
  | 'CANCELLED'
  | 'FAILED_INFRASTRUCTURE'
  | 'REPORTING_FAILED'
  | 'FAILED_INTERNAL';

export interface HumanOverride {
  overrideId: string;
  idempotencyKey: string;
  runId: string;
  actor: string;
  headSha: string;
  action: 'APPROVE' | 'REJECT';
  reason: string;
  findingIds: string[];
  createdAt: string;
}

export interface UsageProjection {
  runId: string;
  headSha: string;
  costUnits: number;
  requestCosts: Record<string, number>;
}

export type PrGateEventType =
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
