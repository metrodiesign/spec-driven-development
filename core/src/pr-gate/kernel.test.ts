import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyUsage,
  classifyReviewerCoverage,
  decideQuality,
  groupJudgedFindings,
  mergeChangeAnalysis,
  mergeEffectivePolicy,
  normalizeReviewerResult,
  PrGatePolicyError,
  resolveProfiles,
  transitionPrGateState,
  validateJudgeResult,
  validateReviewerFinding,
} from './kernel.ts';
import type {
  DeterministicCheckSpec,
  DeterministicReport,
  EffectivePolicy,
  JudgeResult,
  JudgedFinding,
  ReviewerFinding,
  ReviewerResult,
  Sha256Ref,
  SnapshotIdentity,
} from './types.ts';

const REF = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Sha256Ref;
const OTHER_REF = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Sha256Ref;

const snapshot: SnapshotIdentity = {
  repository: 'owner/repo',
  pullRequest: 7,
  baseSha: 'base',
  headSha: 'head',
  mergeBaseSha: 'merge',
  diffRef: REF,
  policyRef: OTHER_REF,
};

const baseCheck: DeterministicCheckSpec = {
  id: 'secret-scan',
  kind: 'security',
  command: 'pnpm scan',
  required: true,
  timeoutMs: 60_000,
  network: 'none',
  install: false,
  profiles: [],
  components: [],
};

function organizationPolicy(): EffectivePolicy {
  return {
    requiredReviewerCount: 3,
    blockingSeverity: 'HIGH',
    secretScanningRequired: true,
    allowStalePass: false,
    network: 'none',
    install: false,
    providerTimeoutMs: 600_000,
    runDeadlineMs: 1_800_000,
    maxCostUnits: 100,
    riskFloor: 'MEDIUM',
    requireHumanApproval: false,
    checks: [baseCheck],
    profiles: [
      {
        id: 'node',
        activation: { technologies: ['node'] },
        checks: [{ ...baseCheck, id: 'build', kind: 'build', command: 'pnpm build' }],
        reviewDimensions: ['correctness'],
      },
      {
        id: 'openapi',
        activation: { publicContracts: ['openapi'] },
        checks: [{ ...baseCheck, id: 'contract', kind: 'contract', command: 'pnpm contract' }],
        reviewDimensions: ['compatibility'],
      },
    ],
  };
}

function finding(overrides: Partial<ReviewerFinding> = {}): ReviewerFinding {
  return {
    id: 'f-1',
    category: 'correctness',
    severity: 'HIGH',
    title: 'Incorrect branch',
    finding: 'Wrong outcome is returned.',
    rootCause: 'Condition is inverted.',
    evidence: [{ path: 'src/a.ts', startLine: 2, endLine: 3, excerptHash: REF }],
    trigger: 'Call with false.',
    impact: 'Request fails.',
    suggestedFix: 'Invert condition.',
    confidence: 0.9,
    ...overrides,
  };
}

function reviewer(status: ReviewerResult['status'] = 'SUCCEEDED', overrides: Partial<ReviewerResult> = {}): ReviewerResult {
  return {
    requestId: 'req-1',
    adapterId: 'slot-a',
    modelVersion: 'v1',
    snapshot,
    status,
    findings: [],
    usage: { costUnits: 1 },
    transcriptRef: REF,
    actionRequests: [],
    toolUseCount: 0,
    ...overrides,
  };
}

function deterministic(status: DeterministicReport['checks'][number]['status'] = 'PASSED'): DeterministicReport {
  return {
    snapshot,
    checks: [{ id: 'test', status, required: true, durationMs: 10, evidenceRef: REF }],
    reportRef: OTHER_REF,
  };
}

function judged(classification: JudgedFinding['classification'], severity: JudgedFinding['severity']): JudgedFinding {
  return {
    canonicalFindingKey: 'src/a.ts:branch',
    sourceFindingIds: ['f-1'],
    classification,
    severity,
    evidenceRefs: [REF],
    rationaleRef: OTHER_REF,
  };
}

describe('PR gate policy and classification', () => {
  it('REQ-2/REQ-3 keeps stricter policy values and rejects repository loosening', () => {
    const effective = mergeEffectivePolicy(organizationPolicy(), {
      providerTimeoutMs: 300_000,
      riskFloor: 'HIGH',
      requireHumanApproval: true,
      checks: [{ ...baseCheck, timeoutMs: 30_000 }],
    });
    assert.equal(effective.providerTimeoutMs, 300_000);
    assert.equal(effective.riskFloor, 'HIGH');
    assert.equal(effective.requireHumanApproval, true);
    assert.equal(effective.checks[0]?.timeoutMs, 30_000);

    assert.throws(
      () => mergeEffectivePolicy(organizationPolicy(), { requiredReviewerCount: 2 }),
      (error: unknown) => error instanceof PrGatePolicyError && error.code === 'reviewer_floor_lowered',
    );
    assert.throws(
      () =>
        mergeEffectivePolicy(organizationPolicy(), { network: 'allow' }),
      (error: unknown) => error instanceof PrGatePolicyError && error.code === 'network_enabled',
    );
    assert.throws(
      () => mergeEffectivePolicy(organizationPolicy(), { secretScanningRequired: false }),
      (error: unknown) => error instanceof PrGatePolicyError && error.code === 'secret_scan_disabled',
    );
    assert.throws(
      () => mergeEffectivePolicy(organizationPolicy(), { providerTimeoutMs: '300000' as unknown as number }),
      (error: unknown) => error instanceof PrGatePolicyError && error.code === 'invalid_provider_timeout',
    );
    assert.throws(
      () => mergeEffectivePolicy(organizationPolicy(), { profiles: [{ id: 'bad', activation: {}, checks: [], reviewDimensions: [], riskFloor: 'UNKNOWN' as never }] }),
      (error: unknown) => error instanceof PrGatePolicyError && error.code === 'invalid_profile',
    );
    assert.throws(
      () => mergeEffectivePolicy(organizationPolicy(), { checks: [{ ...baseCheck, id: 'too-slow', timeoutMs: 300_001 }] }),
      (error: unknown) => error instanceof PrGatePolicyError && error.code === 'invalid_check_timeout',
    );
  });

  it('REQ-2 normalizes analyzer order, retains risk floor, and exposes omissions', () => {
    const first = mergeChangeAnalysis(
      [
        { technologies: ['typescript', 'node'], categories: ['API'], risk: { level: 'LOW', reasons: ['api'] } },
        {
          technologies: ['node'],
          categories: ['DOCUMENTATION'],
          impactEdges: [{ from: 'api', to: 'client', reason: 'contract' }],
          coverage: 'LIMITED',
          omittedPaths: [{ path: 'mobile/app.kt', reason: 'unsupported' }],
        },
      ],
      'MEDIUM',
    );
    const second = mergeChangeAnalysis(
      [
        {
          omittedPaths: [{ reason: 'unsupported', path: 'mobile/app.kt' }],
          coverage: 'LIMITED',
          impactEdges: [{ reason: 'contract', to: 'client', from: 'api' }],
          categories: ['DOCUMENTATION'],
          technologies: ['node'],
        },
        { risk: { reasons: ['api'], level: 'LOW' }, categories: ['API'], technologies: ['node', 'typescript'] },
      ],
      'MEDIUM',
    );
    assert.deepEqual(first, second);
    assert.equal(first.risk.level, 'MEDIUM');
    assert.equal(first.coverage, 'LIMITED');
    assert.deepEqual(first.technologies, ['node', 'typescript']);
  });

  it('REQ-2 activates applicable profiles and omits build checks for docs-only changes', () => {
    const policy = organizationPolicy();
    const docs = mergeChangeAnalysis([{ technologies: ['node'], categories: ['DOCUMENTATION'] }], 'LOW');
    assert.equal(resolveProfiles(policy, docs).checks.some((check) => check.kind === 'build'), false);

    const api = mergeChangeAnalysis(
      [{ technologies: ['node'], categories: ['API'], publicContracts: ['openapi'] }],
      'LOW',
    );
    assert.deepEqual(resolveProfiles(policy, api).profiles.map((profile) => profile.id), ['node', 'openapi']);
    assert.equal(resolveProfiles(policy, api).checks.some((check) => check.kind === 'contract'), true);
  });
});

describe('PR finding integrity', () => {
  const evidence = { 'src/a.ts': { lineCount: 5, excerptHashes: { '2:3': REF } } };

  it('REQ-6 validates fields, location, range, hash, and confidence', () => {
    assert.deepEqual(validateReviewerFinding(finding(), evidence), []);
    assert.deepEqual(validateReviewerFinding(finding({ confidence: 2 }), evidence), ['confidence']);
    assert.deepEqual(validateReviewerFinding(finding({ evidence: [{ path: 'src/a.ts', startLine: 2, endLine: 4, excerptHash: REF }] }), evidence), ['hash:src/a.ts']);
    assert.deepEqual(validateReviewerFinding(finding({ evidence: [{ path: 'missing.ts', startLine: 1, endLine: 1, excerptHash: REF }] }), evidence), ['path:missing.ts']);
  });

  it('REQ-5/REQ-6 marks tool use, action requests, invalid cost, or bad findings invalid', () => {
    assert.equal(normalizeReviewerResult(reviewer('SUCCEEDED', { findings: [finding()] }), snapshot, evidence).status, 'SUCCEEDED');
    assert.equal(normalizeReviewerResult(reviewer('SUCCEEDED', { toolUseCount: 1 }), snapshot, evidence).status, 'INVALID_RESPONSE');
    assert.equal(normalizeReviewerResult(reviewer('SUCCEEDED', { actionRequests: [{}] }), snapshot, evidence).status, 'INVALID_RESPONSE');
    assert.equal(normalizeReviewerResult(reviewer('SUCCEEDED', { usage: { costUnits: -1 } }), snapshot, evidence).status, 'INVALID_RESPONSE');
    assert.equal(normalizeReviewerResult(reviewer('SUCCEEDED', { findings: [finding({ confidence: 2 })] }), snapshot, evidence).status, 'INVALID_RESPONSE');
  });

  it('REQ-6 validates anonymous Judge output and groups only by canonical key', () => {
    const result: JudgeResult = {
      snapshot,
      findings: [judged('VERIFIED', 'HIGH')],
      actionRequests: [],
      toolUseCount: 0,
    };
    assert.equal(validateJudgeResult(result, snapshot, new Set(['f-1']), new Set([REF, OTHER_REF])).ok, true);
    assert.equal(validateJudgeResult({ ...result, toolUseCount: 1 }, snapshot, new Set(['f-1']), new Set([REF, OTHER_REF])).ok, false);
    assert.equal(groupJudgedFindings([judged('VERIFIED', 'HIGH'), judged('UNVERIFIED', 'LOW')]).size, 1);
    assert.equal(
      groupJudgedFindings([
        judged('VERIFIED', 'HIGH'),
        { ...judged('UNVERIFIED', 'LOW'), canonicalFindingKey: 'src/b.ts:other' },
      ]).size,
      2,
    );
  });
});

describe('PR gate decision, lifecycle, and usage', () => {
  const four = [reviewer(), reviewer('SUCCEEDED', { requestId: '2' }), reviewer('SUCCEEDED', { requestId: '3' }), reviewer('SUCCEEDED', { requestId: '4' })];

  it('REQ-7 maps reviewer availability without treating failures as empty success', () => {
    assert.deepEqual(classifyReviewerCoverage(four), { coverage: 'FULL', available: 4 });
    assert.equal(classifyReviewerCoverage(four.slice(0, 3)).coverage, 'DEGRADED');
    assert.equal(classifyReviewerCoverage(four.slice(0, 2)).coverage, 'INSUFFICIENT');
    assert.equal(classifyReviewerCoverage([reviewer('TIMED_OUT')]).coverage, 'INFRASTRUCTURE_FAILURE');
  });

  it('REQ-4/REQ-7 applies blocker, evidence, and coverage precedence', () => {
    const base = {
      deterministic: deterministic(),
      risk: 'LOW' as const,
      analysisCoverage: 'FULL' as const,
      reviewerResults: four,
      judgedFindings: [] as JudgedFinding[],
      judgeAvailable: true,
    };
    assert.equal(decideQuality(base).decision, 'PASS');
    assert.equal(decideQuality({ ...base, reviewerResults: four.slice(0, 3) }).decision, 'PASS_WITH_WARNINGS');
    assert.equal(decideQuality({ ...base, reviewerResults: four.slice(0, 2) }).decision, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(decideQuality({ ...base, reviewerResults: four.slice(0, 1) }).decision, 'INFRASTRUCTURE_FAILURE');
    assert.equal(
      decideQuality({ ...base, reviewerResults: four.slice(0, 1), judgedFindings: [judged('VERIFIED', 'HIGH')] }).decision,
      'FAIL',
    );
    assert.equal(decideQuality({ ...base, deterministic: deterministic('FAILED') }).decision, 'FAIL');
    assert.equal(decideQuality({ ...base, deterministic: deterministic('TIMED_OUT') }).decision, 'FAIL');
    assert.equal(decideQuality({ ...base, deterministic: deterministic('INFRASTRUCTURE_FAILURE') }).decision, 'INFRASTRUCTURE_FAILURE');
    assert.equal(decideQuality({ ...base, analysisCoverage: 'PARTIAL' }).decision, 'PASS_WITH_WARNINGS');
    assert.equal(decideQuality({ ...base, analysisCoverage: 'LIMITED' }).decision, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(decideQuality({ ...base, risk: 'CRITICAL' }).decision, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(decideQuality({ ...base, judgedFindings: [judged('UNVERIFIED', 'HIGH')] }).decision, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(decideQuality({ ...base, judgedFindings: [judged('VERIFIED', 'MEDIUM')] }).decision, 'PASS_WITH_WARNINGS');
    assert.equal(decideQuality({ ...base, blockingSeverity: 'MEDIUM', judgedFindings: [judged('VERIFIED', 'MEDIUM')] }).decision, 'FAIL');
  });

  it('REQ-8 rejects invalid transitions without mutating state', () => {
    assert.deepEqual(transitionPrGateState('QUEUED', 'ACQUIRING'), { ok: true, state: 'ACQUIRING' });
    assert.deepEqual(transitionPrGateState('QUEUED', 'COMPLETED'), {
      ok: false,
      state: 'QUEUED',
      reason: 'invalid_transition',
    });
    assert.deepEqual(transitionPrGateState('REPORTING', 'AWAITING_HUMAN', 'HUMAN_REVIEW_REQUIRED'), {
      ok: true,
      state: 'AWAITING_HUMAN',
    });
    assert.deepEqual(transitionPrGateState('REVIEWING', 'CANCELLED'), { ok: true, state: 'CANCELLED' });
  });

  it('REQ-8 validates cost and deduplicates replay per run and head', () => {
    const initial = { runId: 'run-1', headSha: 'head', costUnits: 0, requestCosts: {} };
    const first = applyUsage(initial, { runId: 'run-1', headSha: 'head', requestId: 'req-1', costUnits: 3 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.projection.costUnits, 3);
    const replay = applyUsage(first.projection, { runId: 'run-1', headSha: 'head', requestId: 'req-1', costUnits: 99 });
    assert.equal(replay.ok && replay.replay, true);
    assert.equal(replay.projection.costUnits, 3);
    assert.equal(applyUsage(initial, { runId: 'run-2', headSha: 'head', requestId: 'req-1', costUnits: 1 }).ok, false);
    assert.equal(applyUsage(initial, { runId: 'run-1', headSha: 'head', requestId: 'req-1', costUnits: Number.NaN }).ok, false);
  });
});
