import { addCostUnits, validateCostUnits } from '../budget/budget.ts';
import { MAX_COMMAND_TIMEOUT_MS } from '../security/command-runner.ts';
import type {
  AnalysisCoverage,
  ChangeAnalysis,
  ChangeCategory,
  DeterministicCheckSpec,
  DeterministicReport,
  EffectivePolicy,
  FindingSeverity,
  JudgeResult,
  JudgedFinding,
  PolicyLayer,
  PrGateRunState,
  QualityDecision,
  QualityProfile,
  ReviewerCoverage,
  ReviewerFinding,
  ReviewerResult,
  RiskLevel,
  Sha256Ref,
  SnapshotIdentity,
  UsageProjection,
  VerificationClass,
} from './types.ts';

const RISK_ORDER: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const SEVERITY_ORDER: FindingSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const COVERAGE_ORDER: AnalysisCoverage[] = ['FULL', 'PARTIAL', 'LIMITED'];

export class PrGatePolicyError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(detail);
    this.name = 'PrGatePolicyError';
    this.code = code;
  }
}

function stricterRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))]!;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function validateCheck(check: DeterministicCheckSpec): void {
  if (check === null || typeof check !== 'object' || Array.isArray(check) || typeof check.id !== 'string' || typeof check.command !== 'string' || check.id.trim() === '' || check.command.trim() === '') {
    throw new PrGatePolicyError('invalid_check', 'check id and command must be non-empty');
  }
  if (!['build', 'test', 'security', 'contract', 'lint', 'custom'].includes(check.kind) || typeof check.required !== 'boolean') {
    throw new PrGatePolicyError('invalid_check', `check ${check.id} kind and required flag are invalid`);
  }
  if (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0 || check.timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new PrGatePolicyError('invalid_check_timeout', `check ${check.id} timeout must be a positive integer no greater than ${MAX_COMMAND_TIMEOUT_MS}`);
  }
  if (check.network !== 'none' || check.install !== false) {
    throw new PrGatePolicyError('isolation_loosened', `check ${check.id} must deny network and installation`);
  }
  if (!Array.isArray(check.profiles) || !check.profiles.every(nonEmpty) || !Array.isArray(check.components) || !check.components.every(nonEmpty)) {
    throw new PrGatePolicyError('invalid_check', `check ${check.id} profiles and components must be string arrays`);
  }
  if (check.cwd !== undefined && !nonEmpty(check.cwd)) throw new PrGatePolicyError('invalid_check', `check ${check.id} cwd is invalid`);
}

function validateProfile(profile: QualityProfile): void {
  if (
    profile === null || typeof profile !== 'object' || Array.isArray(profile) || !nonEmpty(profile.id) ||
    profile.activation === null || typeof profile.activation !== 'object' || Array.isArray(profile.activation) ||
    !Array.isArray(profile.checks) || !Array.isArray(profile.reviewDimensions) || !profile.reviewDimensions.every(nonEmpty)
  ) throw new PrGatePolicyError('invalid_profile', 'quality profile shape is invalid');
  const dimensions = [profile.activation.technologies, profile.activation.categories, profile.activation.components, profile.activation.publicContracts];
  if (dimensions.some((values) => values !== undefined && (!Array.isArray(values) || !values.every(nonEmpty)))) {
    throw new PrGatePolicyError('invalid_profile', `profile ${profile.id} activation is invalid`);
  }
  if (profile.activation.minimumRisk !== undefined && !RISK_ORDER.includes(profile.activation.minimumRisk)) {
    throw new PrGatePolicyError('invalid_profile', `profile ${profile.id} minimum risk is invalid`);
  }
  if (profile.riskFloor !== undefined && !RISK_ORDER.includes(profile.riskFloor)) {
    throw new PrGatePolicyError('invalid_profile', `profile ${profile.id} risk floor is invalid`);
  }
  profile.checks.forEach(validateCheck);
}

function mergeChecks(base: readonly DeterministicCheckSpec[], additions: readonly DeterministicCheckSpec[]): DeterministicCheckSpec[] {
  const merged = new Map<string, DeterministicCheckSpec>();
  for (const check of base) {
    validateCheck(check);
    merged.set(check.id, { ...check, profiles: uniqueSorted(check.profiles), components: uniqueSorted(check.components) });
  }
  for (const proposed of additions) {
    validateCheck(proposed);
    const current = merged.get(proposed.id);
    if (current === undefined) {
      merged.set(proposed.id, {
        ...proposed,
        profiles: uniqueSorted(proposed.profiles),
        components: uniqueSorted(proposed.components),
      });
      continue;
    }
    if (proposed.command !== current.command || proposed.cwd !== current.cwd || proposed.kind !== current.kind) {
      throw new PrGatePolicyError('check_redefined', `repository policy cannot redefine check ${proposed.id}`);
    }
    if (current.required && !proposed.required) {
      throw new PrGatePolicyError('required_check_disabled', `repository policy cannot make check ${proposed.id} optional`);
    }
    if (proposed.timeoutMs > current.timeoutMs) {
      throw new PrGatePolicyError('timeout_loosened', `repository policy cannot lengthen check ${proposed.id} timeout`);
    }
    merged.set(proposed.id, {
      ...current,
      required: current.required || proposed.required,
      timeoutMs: Math.min(current.timeoutMs, proposed.timeoutMs),
      profiles: uniqueSorted([...current.profiles, ...proposed.profiles]),
      components: uniqueSorted([...current.components, ...proposed.components]),
    });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function validateHardPolicy(policy: EffectivePolicy): void {
  if (policy.network !== 'none' || policy.install !== false) {
    throw new PrGatePolicyError('isolation_loosened', 'effective policy must deny network and installation');
  }
  if (!policy.secretScanningRequired) {
    throw new PrGatePolicyError('secret_scan_disabled', 'secret scanning is mandatory');
  }
  if (policy.allowStalePass) {
    throw new PrGatePolicyError('stale_pass_enabled', 'stale snapshots cannot pass');
  }
  if (!Number.isInteger(policy.requiredReviewerCount) || policy.requiredReviewerCount < 1 || policy.requiredReviewerCount > 4) {
    throw new PrGatePolicyError('invalid_reviewer_count', 'required reviewer count must be between 1 and 4');
  }
  if (!SEVERITY_ORDER.includes(policy.blockingSeverity)) {
    throw new PrGatePolicyError('invalid_blocking_severity', 'blocking severity must be LOW, MEDIUM, HIGH, or CRITICAL');
  }
  if (!RISK_ORDER.includes(policy.riskFloor)) {
    throw new PrGatePolicyError('invalid_risk_floor', 'risk floor must be LOW, MEDIUM, HIGH, or CRITICAL');
  }
  if (!Number.isFinite(policy.maxCostUnits) || policy.maxCostUnits < 0) {
    throw new PrGatePolicyError('invalid_cost_cap', 'maxCostUnits must be finite and non-negative');
  }
  if (policy.providerTimeoutMs <= 0 || policy.providerTimeoutMs > 600_000) {
    throw new PrGatePolicyError('provider_timeout_ceiling', 'provider timeout must be within 1..600000 ms');
  }
  if (policy.runDeadlineMs <= 0 || policy.runDeadlineMs > 1_800_000) {
    throw new PrGatePolicyError('run_deadline_ceiling', 'run deadline must be within 1..1800000 ms');
  }
  if (!Array.isArray(policy.checks) || !Array.isArray(policy.profiles)) {
    throw new PrGatePolicyError('invalid_policy_collections', 'checks and profiles must be arrays');
  }
  policy.checks.forEach(validateCheck);
  policy.profiles.forEach(validateProfile);
}

export function mergeEffectivePolicy(organization: EffectivePolicy, repository: PolicyLayer = {}): EffectivePolicy {
  validateHardPolicy(organization);
  if (repository.secretScanningRequired !== undefined && typeof repository.secretScanningRequired !== 'boolean') {
    throw new PrGatePolicyError('invalid_secret_scan_policy', 'repository secret scan flag must be boolean');
  }
  if (repository.allowStalePass !== undefined && typeof repository.allowStalePass !== 'boolean') {
    throw new PrGatePolicyError('invalid_stale_policy', 'repository stale-pass flag must be boolean');
  }
  if (repository.blockingSeverity !== undefined && !SEVERITY_ORDER.includes(repository.blockingSeverity)) {
    throw new PrGatePolicyError('invalid_blocking_severity', 'repository blocking severity is invalid');
  }
  if (repository.riskFloor !== undefined && !RISK_ORDER.includes(repository.riskFloor)) {
    throw new PrGatePolicyError('invalid_risk_floor', 'repository risk floor is invalid');
  }
  if (repository.requiredReviewerCount !== undefined && !Number.isInteger(repository.requiredReviewerCount)) {
    throw new PrGatePolicyError('invalid_reviewer_count', 'repository reviewer count must be an integer');
  }
  if (repository.providerTimeoutMs !== undefined && (!Number.isInteger(repository.providerTimeoutMs) || repository.providerTimeoutMs <= 0)) {
    throw new PrGatePolicyError('invalid_provider_timeout', 'repository provider timeout must be a positive integer');
  }
  if (repository.runDeadlineMs !== undefined && (!Number.isInteger(repository.runDeadlineMs) || repository.runDeadlineMs <= 0)) {
    throw new PrGatePolicyError('invalid_run_deadline', 'repository run deadline must be a positive integer');
  }
  if (repository.maxCostUnits !== undefined && (!Number.isFinite(repository.maxCostUnits) || repository.maxCostUnits < 0)) {
    throw new PrGatePolicyError('invalid_cost_cap', 'repository cost cap must be finite and non-negative');
  }
  if (repository.requireHumanApproval !== undefined && typeof repository.requireHumanApproval !== 'boolean') {
    throw new PrGatePolicyError('invalid_human_approval', 'repository human approval flag must be boolean');
  }
  if (repository.checks !== undefined && !Array.isArray(repository.checks)) {
    throw new PrGatePolicyError('invalid_checks', 'repository checks must be an array');
  }
  if (repository.profiles !== undefined && !Array.isArray(repository.profiles)) {
    throw new PrGatePolicyError('invalid_profiles', 'repository profiles must be an array');
  }
  repository.checks?.forEach(validateCheck);
  repository.profiles?.forEach(validateProfile);
  if (repository.network !== undefined && repository.network !== 'none') {
    throw new PrGatePolicyError('network_enabled', 'repository policy cannot enable network');
  }
  if (repository.install !== undefined && repository.install !== false) {
    throw new PrGatePolicyError('install_enabled', 'repository policy cannot enable package installation');
  }
  if (repository.secretScanningRequired === false) {
    throw new PrGatePolicyError('secret_scan_disabled', 'repository policy cannot disable secret scanning');
  }
  if (repository.allowStalePass === true) {
    throw new PrGatePolicyError('stale_pass_enabled', 'repository policy cannot allow stale pass');
  }
  if (repository.requiredReviewerCount !== undefined && repository.requiredReviewerCount < organization.requiredReviewerCount) {
    throw new PrGatePolicyError('reviewer_floor_lowered', 'repository policy cannot lower required reviewer count');
  }
  if (
    repository.blockingSeverity !== undefined &&
    SEVERITY_ORDER.indexOf(repository.blockingSeverity) > SEVERITY_ORDER.indexOf(organization.blockingSeverity)
  ) {
    throw new PrGatePolicyError('blocking_threshold_lowered', 'repository policy cannot weaken blocking severity');
  }
  if (repository.riskFloor !== undefined && RISK_ORDER.indexOf(repository.riskFloor) < RISK_ORDER.indexOf(organization.riskFloor)) {
    throw new PrGatePolicyError('risk_floor_lowered', 'repository policy cannot lower risk');
  }
  if (repository.providerTimeoutMs !== undefined && repository.providerTimeoutMs > organization.providerTimeoutMs) {
    throw new PrGatePolicyError('timeout_loosened', 'repository policy cannot lengthen provider timeout');
  }
  if (repository.runDeadlineMs !== undefined && repository.runDeadlineMs > organization.runDeadlineMs) {
    throw new PrGatePolicyError('deadline_loosened', 'repository policy cannot lengthen run deadline');
  }
  if (repository.maxCostUnits !== undefined && repository.maxCostUnits > organization.maxCostUnits) {
    throw new PrGatePolicyError('cost_cap_loosened', 'repository policy cannot increase cost cap');
  }
  if (organization.requireHumanApproval && repository.requireHumanApproval === false) {
    throw new PrGatePolicyError('human_approval_disabled', 'repository policy cannot disable required human approval');
  }

  const profileIds = new Set(organization.profiles.map((profile) => profile.id));
  for (const profile of repository.profiles ?? []) {
    if (profileIds.has(profile.id)) {
      throw new PrGatePolicyError('profile_redefined', `repository policy cannot redefine profile ${profile.id}`);
    }
    profileIds.add(profile.id);
  }

  const effective: EffectivePolicy = {
    ...organization,
    requiredReviewerCount: repository.requiredReviewerCount ?? organization.requiredReviewerCount,
    blockingSeverity:
      repository.blockingSeverity === undefined ||
      SEVERITY_ORDER.indexOf(repository.blockingSeverity) > SEVERITY_ORDER.indexOf(organization.blockingSeverity)
        ? organization.blockingSeverity
        : repository.blockingSeverity,
    secretScanningRequired: true,
    allowStalePass: false,
    network: 'none',
    install: false,
    providerTimeoutMs: Math.min(repository.providerTimeoutMs ?? organization.providerTimeoutMs, organization.providerTimeoutMs),
    runDeadlineMs: Math.min(repository.runDeadlineMs ?? organization.runDeadlineMs, organization.runDeadlineMs),
    maxCostUnits: Math.min(repository.maxCostUnits ?? organization.maxCostUnits, organization.maxCostUnits),
    riskFloor: stricterRisk(organization.riskFloor, repository.riskFloor ?? organization.riskFloor),
    requireHumanApproval: organization.requireHumanApproval || (repository.requireHumanApproval ?? false),
    checks: mergeChecks(organization.checks, repository.checks ?? []),
    profiles: [...organization.profiles, ...(repository.profiles ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  };
  validateHardPolicy(effective);
  return effective;
}

export type AnalysisFragment = Partial<Omit<ChangeAnalysis, 'risk'>> & {
  risk?: Partial<ChangeAnalysis['risk']>;
};

export function mergeChangeAnalysis(fragments: readonly AnalysisFragment[], riskFloor: RiskLevel): ChangeAnalysis {
  const impact = new Map<string, { from: string; to: string; reason: string }>();
  const omitted = new Map<string, { path: string; reason: string }>();
  let risk = riskFloor;
  let coverage: AnalysisCoverage = 'FULL';
  const reasons: string[] = [];
  for (const fragment of fragments) {
    for (const edge of fragment.impactEdges ?? []) impact.set(`${edge.from}\0${edge.to}\0${edge.reason}`, edge);
    for (const item of fragment.omittedPaths ?? []) omitted.set(`${item.path}\0${item.reason}`, item);
    if (fragment.risk?.level !== undefined) risk = stricterRisk(risk, fragment.risk.level);
    reasons.push(...(fragment.risk?.reasons ?? []));
    if (fragment.coverage !== undefined && COVERAGE_ORDER.indexOf(fragment.coverage) > COVERAGE_ORDER.indexOf(coverage)) {
      coverage = fragment.coverage;
    }
  }
  return {
    technologies: uniqueSorted(fragments.flatMap((fragment) => fragment.technologies ?? [])),
    categories: uniqueSorted(fragments.flatMap((fragment) => fragment.categories ?? [])) as ChangeCategory[],
    components: uniqueSorted(fragments.flatMap((fragment) => fragment.components ?? [])),
    publicContracts: uniqueSorted(fragments.flatMap((fragment) => fragment.publicContracts ?? [])),
    impactEdges: [...impact.values()].sort((a, b) => `${a.from}\0${a.to}\0${a.reason}`.localeCompare(`${b.from}\0${b.to}\0${b.reason}`)),
    risk: { level: risk, reasons: uniqueSorted(reasons) },
    coverage,
    omittedPaths: [...omitted.values()].sort((a, b) => `${a.path}\0${a.reason}`.localeCompare(`${b.path}\0${b.reason}`)),
  };
}

function profileMatches(profile: QualityProfile, analysis: ChangeAnalysis): boolean {
  const { activation } = profile;
  const dimensions: Array<[readonly string[] | undefined, readonly string[]]> = [
    [activation.technologies, analysis.technologies],
    [activation.categories, analysis.categories],
    [activation.components, analysis.components],
    [activation.publicContracts, analysis.publicContracts],
  ];
  if (dimensions.some(([wanted, actual]) => wanted !== undefined && !wanted.some((value) => actual.includes(value)))) return false;
  return activation.minimumRisk === undefined || RISK_ORDER.indexOf(analysis.risk.level) >= RISK_ORDER.indexOf(activation.minimumRisk);
}

export function resolveProfiles(policy: EffectivePolicy, analysis: ChangeAnalysis): { profiles: QualityProfile[]; checks: DeterministicCheckSpec[] } {
  const profiles = policy.profiles.filter((profile) => profileMatches(profile, analysis));
  const docsOnly =
    analysis.categories.length > 0 &&
    analysis.categories.every((category) => category === 'DOCUMENTATION' || category === 'CONFIGURATION');
  const checks = mergeChecks(
    policy.checks.filter((check) => !docsOnly || check.kind !== 'build'),
    profiles.flatMap((profile) => profile.checks).filter((check) => {
      if (docsOnly && check.kind === 'build') return false;
      return check.components.length === 0 || check.components.some((component) => analysis.components.includes(component));
    }),
  );
  return { profiles, checks };
}

export interface SnapshotEvidenceIndex {
  [path: string]: { lineCount: number; excerptHashes: Record<string, Sha256Ref> };
}

function sameSnapshot(a: SnapshotIdentity, b: SnapshotIdentity): boolean {
  return (
    a.repository === b.repository &&
    a.pullRequest === b.pullRequest &&
    a.baseSha === b.baseSha &&
    a.headSha === b.headSha &&
    a.mergeBaseSha === b.mergeBaseSha &&
    a.diffRef === b.diffRef &&
    a.policyRef === b.policyRef
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateReviewerFinding(finding: ReviewerFinding, evidence: SnapshotEvidenceIndex): string[] {
  const errors: string[] = [];
  const fields = [finding.id, finding.category, finding.title, finding.finding, finding.rootCause, finding.trigger, finding.impact, finding.suggestedFix];
  if (fields.some((value) => !nonEmpty(value))) errors.push('required_string');
  if (!SEVERITY_ORDER.includes(finding.severity)) errors.push('severity');
  if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) errors.push('confidence');
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    errors.push('evidence');
    return uniqueSorted(errors);
  }
  for (const citation of finding.evidence) {
    if (citation === null || typeof citation !== 'object' || !nonEmpty(citation.path)) {
      errors.push('evidence');
      continue;
    }
    const file = evidence[citation.path];
    if (file === undefined) {
      errors.push(`path:${citation.path}`);
      continue;
    }
    if (
      !Number.isInteger(citation.startLine) ||
      !Number.isInteger(citation.endLine) ||
      citation.startLine < 1 ||
      citation.endLine < citation.startLine ||
      citation.endLine > file.lineCount
    ) {
      errors.push(`range:${citation.path}`);
      continue;
    }
    if (file.excerptHashes[`${citation.startLine}:${citation.endLine}`] !== citation.excerptHash) {
      errors.push(`hash:${citation.path}`);
    }
  }
  return uniqueSorted(errors);
}

export function normalizeReviewerResult(
  result: ReviewerResult,
  snapshot: SnapshotIdentity,
  evidence: SnapshotEvidenceIndex,
): ReviewerResult {
  const cost = validateCostUnits(result.usage.costUnits);
  const invalid =
    !sameSnapshot(result.snapshot, snapshot) ||
    result.actionRequests.length !== 0 ||
    result.toolUseCount !== 0 ||
    !cost.ok ||
    (result.status === 'SUCCEEDED' && result.findings.some((finding) => validateReviewerFinding(finding, evidence).length > 0));
  if (invalid) return { ...result, status: 'INVALID_RESPONSE', findings: [] };
  if (result.status !== 'SUCCEEDED') return { ...result, findings: [] };
  return result;
}

export function validateJudgeResult(
  result: JudgeResult,
  snapshot: SnapshotIdentity,
  sourceFindingIds: ReadonlySet<string>,
  evidenceRefs: ReadonlySet<Sha256Ref>,
): { ok: true; findings: JudgedFinding[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!sameSnapshot(result.snapshot, snapshot)) errors.push('snapshot');
  if (result.actionRequests.length !== 0) errors.push('action_requests');
  if (result.toolUseCount !== 0) errors.push('tool_use');
  for (const finding of result.findings) {
    if (typeof finding.canonicalFindingKey !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{2,127}$/i.test(finding.canonicalFindingKey)) {
      errors.push('canonical_key');
    }
    if (!Array.isArray(finding.sourceFindingIds) || !finding.sourceFindingIds.every((id) => typeof id === 'string' && sourceFindingIds.has(id))) {
      errors.push('source_finding');
    }
    if (!Array.isArray(finding.evidenceRefs) || !finding.evidenceRefs.every((ref) => typeof ref === 'string' && evidenceRefs.has(ref as Sha256Ref))) {
      errors.push('evidence_ref');
    }
    if (typeof finding.rationaleRef !== 'string' || !evidenceRefs.has(finding.rationaleRef as Sha256Ref)) errors.push('rationale_ref');
    if (!['VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'FALSE_POSITIVE'].includes(finding.classification)) errors.push('classification');
    if (!SEVERITY_ORDER.includes(finding.severity)) errors.push('severity');
  }
  return errors.length > 0 ? { ok: false, errors: uniqueSorted(errors) } : { ok: true, findings: result.findings };
}

export function groupJudgedFindings(findings: readonly JudgedFinding[]): Map<string, JudgedFinding[]> {
  const groups = new Map<string, JudgedFinding[]>();
  for (const finding of findings) groups.set(finding.canonicalFindingKey, [...(groups.get(finding.canonicalFindingKey) ?? []), finding]);
  return groups;
}

export function classifyReviewerCoverage(results: readonly ReviewerResult[]): { coverage: ReviewerCoverage; available: number } {
  const available = results.filter((result) => result.status === 'SUCCEEDED').length;
  if (available >= 4) return { coverage: 'FULL', available };
  if (available === 3) return { coverage: 'DEGRADED', available };
  if (available === 2) return { coverage: 'INSUFFICIENT', available };
  return { coverage: 'INFRASTRUCTURE_FAILURE', available };
}

function hasFinding(findings: readonly JudgedFinding[], classes: readonly VerificationClass[], severities: readonly FindingSeverity[]): boolean {
  return findings.some((finding) => classes.includes(finding.classification) && severities.includes(finding.severity));
}

export interface DecisionInput {
  deterministic: DeterministicReport;
  risk: RiskLevel;
  analysisCoverage: AnalysisCoverage;
  reviewerResults: ReviewerResult[];
  judgedFindings: JudgedFinding[];
  judgeAvailable: boolean;
  requireHumanApproval?: boolean;
  blockingSeverity?: FindingSeverity;
}

export function decideQuality(input: DecisionInput): { decision: QualityDecision; reasons: string[]; reviewerCoverage: ReviewerCoverage } {
  const reasons: string[] = [];
  const { coverage: reviewerCoverage } = classifyReviewerCoverage(input.reviewerResults);
  const required = input.deterministic.checks.filter((check) => check.required);
  const deterministicBlocker = required.some((check) => check.status === 'FAILED' || check.status === 'TIMED_OUT');
  const deterministicInfrastructure = required.some((check) => check.status === 'INFRASTRUCTURE_FAILURE');
  const blockingIndex = SEVERITY_ORDER.indexOf(input.blockingSeverity ?? 'HIGH');
  const blockingSeverities = SEVERITY_ORDER.slice(blockingIndex);
  const warningSeverities = SEVERITY_ORDER.slice(0, blockingIndex);
  const verifiedBlocker = hasFinding(input.judgedFindings, ['VERIFIED'], blockingSeverities);

  if (deterministicBlocker || verifiedBlocker) {
    if (deterministicBlocker) reasons.push('deterministic_blocker');
    if (verifiedBlocker) reasons.push('verified_blocking_finding');
    return { decision: 'FAIL', reasons, reviewerCoverage };
  }
  if (deterministicInfrastructure || reviewerCoverage === 'INFRASTRUCTURE_FAILURE') {
    if (deterministicInfrastructure) reasons.push('deterministic_infrastructure_failure');
    if (reviewerCoverage === 'INFRASTRUCTURE_FAILURE') reasons.push('reviewer_infrastructure_failure');
    return { decision: 'INFRASTRUCTURE_FAILURE', reasons, reviewerCoverage };
  }
  if (!input.judgeAvailable) reasons.push('judge_unavailable');
  if (reviewerCoverage === 'INSUFFICIENT') reasons.push('insufficient_reviewers');
  if (input.risk === 'CRITICAL') reasons.push('critical_risk');
  if (input.analysisCoverage === 'LIMITED') reasons.push('limited_analysis');
  if (input.requireHumanApproval) reasons.push('policy_requires_human');
  if (hasFinding(input.judgedFindings, ['PARTIALLY_VERIFIED', 'UNVERIFIED'], blockingSeverities)) {
    reasons.push('unresolved_blocking_finding');
  }
  if (reasons.length > 0) return { decision: 'HUMAN_REVIEW_REQUIRED', reasons: uniqueSorted(reasons), reviewerCoverage };

  if (reviewerCoverage === 'DEGRADED') reasons.push('degraded_reviewers');
  if (input.analysisCoverage === 'PARTIAL') reasons.push('partial_analysis');
  if (hasFinding(input.judgedFindings, ['VERIFIED'], warningSeverities)) reasons.push('verified_warning');
  return {
    decision: reasons.length > 0 ? 'PASS_WITH_WARNINGS' : 'PASS',
    reasons: uniqueSorted(reasons),
    reviewerCoverage,
  };
}

const NORMAL_NEXT: Partial<Record<PrGateRunState, PrGateRunState>> = {
  QUEUED: 'ACQUIRING',
  ACQUIRING: 'CLASSIFYING',
  CLASSIFYING: 'SNAPSHOT_ATTESTING',
  SNAPSHOT_ATTESTING: 'CHECKING',
  CHECKING: 'REVIEWING',
  REVIEWING: 'JUDGING',
  JUDGING: 'DECIDING',
  DECIDING: 'REPORTING',
  REPORTING: 'COMPLETED',
  AWAITING_HUMAN: 'REPORTING',
};

const ACTIVE_STATES = new Set<PrGateRunState>([
  'QUEUED',
  'ACQUIRING',
  'CLASSIFYING',
  'SNAPSHOT_ATTESTING',
  'CHECKING',
  'REVIEWING',
  'JUDGING',
  'DECIDING',
  'REPORTING',
  'AWAITING_HUMAN',
]);

export function transitionPrGateState(
  current: PrGateRunState,
  next: PrGateRunState,
  decision?: QualityDecision,
): { ok: true; state: PrGateRunState } | { ok: false; state: PrGateRunState; reason: 'invalid_transition' } {
  const terminalFromActive = new Set<PrGateRunState>(['CANCELLED_STALE', 'CANCELLED', 'FAILED_INFRASTRUCTURE', 'FAILED_INTERNAL']);
  const valid =
    (NORMAL_NEXT[current] === next && !(current === 'REPORTING' && decision === 'HUMAN_REVIEW_REQUIRED')) ||
    (current === 'REPORTING' && next === 'AWAITING_HUMAN' && decision === 'HUMAN_REVIEW_REQUIRED') ||
    (current === 'REPORTING' && next === 'REPORTING_FAILED') ||
    (ACTIVE_STATES.has(current) && terminalFromActive.has(next));
  return valid ? { ok: true, state: next } : { ok: false, state: current, reason: 'invalid_transition' };
}

export function applyUsage(
  projection: UsageProjection,
  request: { runId: string; headSha: string; requestId: string; costUnits: unknown },
):
  | { ok: true; projection: UsageProjection; replay: boolean }
  | { ok: false; projection: UsageProjection; reason: 'identity_mismatch' | 'invalid_cost' } {
  if (request.runId !== projection.runId || request.headSha !== projection.headSha) {
    return { ok: false, projection, reason: 'identity_mismatch' };
  }
  const existing = projection.requestCosts[request.requestId];
  if (existing !== undefined) return { ok: true, projection, replay: true };
  const cost = validateCostUnits(request.costUnits);
  if (!cost.ok) return { ok: false, projection, reason: 'invalid_cost' };
  const total = addCostUnits(projection.costUnits, cost.value);
  if (!total.ok) return { ok: false, projection, reason: 'invalid_cost' };
  return {
    ok: true,
    replay: false,
    projection: {
      ...projection,
      costUnits: total.value,
      requestCosts: { ...projection.requestCosts, [request.requestId]: cost.value },
    },
  };
}
