import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalEvidenceBytes, openEventLog } from 'core';
import type {
  AnalysisPlan,
  EffectivePolicy,
  HumanOverride,
  PinnedChangeSet,
  PullRequestDescriptor,
  QualityDecisionReport,
  ReviewerResult,
  Sha256Ref,
  SnapshotManifest,
} from 'core';

import type { PrGateArtifactSession } from './artifacts.ts';
import { createPrGateManager, type GitHubReportPort, type PrGateManagerDeps } from './manager.ts';

const NOW = Date.parse('2026-08-10T00:00:00.000Z');
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const DIFF = `sha256:${'d'.repeat(64)}` as Sha256Ref;
const POLICY_REF = `sha256:${'e'.repeat(64)}` as Sha256Ref;

const POLICY: EffectivePolicy = {
  requiredReviewerCount: 4,
  blockingSeverity: 'HIGH',
  secretScanningRequired: true,
  allowStalePass: false,
  network: 'none',
  install: false,
  providerTimeoutMs: 600_000,
  runDeadlineMs: 1_800_000,
  maxCostUnits: 100,
  riskFloor: 'LOW',
  requireHumanApproval: false,
  checks: [],
  profiles: [],
};

function memoryArtifacts(): PrGateManagerDeps['artifacts'] {
  const runs = new Map<string, Map<string, { kind: string; value: unknown }>>();
  return (runId, recovering): PrGateArtifactSession => {
    let store = runs.get(runId);
    if (store === undefined) {
      if (recovering) throw new Error(`missing artifacts ${runId}`);
      store = new Map();
      runs.set(runId, store);
    }
    return {
      put(kind, value) {
        const ref = `sha256:${createHash('sha256').update(canonicalEvidenceBytes({ kind, value })).digest('hex')}` as Sha256Ref;
        store!.set(ref, { kind, value });
        return ref;
      },
      get<T>(ref: Sha256Ref, expectedKind?: string): T {
        const found = store!.get(ref);
        if (found === undefined || (expectedKind !== undefined && found.kind !== expectedKind)) throw new Error('artifact missing');
        return found.value as T;
      },
    };
  };
}

function fixtures(requireHumanApproval = false) {
  const descriptor: PullRequestDescriptor = {
    repository: 'acme/repo', number: 5, title: 'title', description: 'desc', baseRef: 'main', baseSha: BASE, headSha: HEAD, fromFork: false,
  };
  const change: PinnedChangeSet = { descriptor, mergeBaseSha: MERGE, diffRef: DIFF, files: [], trustedRepositoryPolicyRef: POLICY_REF };
  const identity = { repository: descriptor.repository, pullRequest: 5, baseSha: BASE, headSha: HEAD, mergeBaseSha: MERGE, diffRef: DIFF, policyRef: POLICY_REF };
  const plan: AnalysisPlan = {
    snapshot: identity,
    analysis: { technologies: ['typescript'], categories: ['FEATURE'], components: ['backend'], publicContracts: [], impactEdges: [], risk: { level: 'LOW', reasons: [] }, coverage: 'FULL', omittedPaths: [] },
    profiles: [], checks: [], policyRef: POLICY_REF,
  };
  const manifest: SnapshotManifest = {
    schemaVersion: 1, identity, createdAt: new Date(NOW).toISOString(), worktreeRef: `sha256:${'f'.repeat(64)}`, changedFiles: [], configRefs: [], rulesRefs: [], manifestRef: `sha256:${'1'.repeat(64)}`,
  };
  const reviewers: ReviewerResult[] = Array.from({ length: 4 }, (_, index) => ({
    requestId: `request-${index}`,
    adapterId: `adapter-${index}`,
    modelVersion: 'm1',
    snapshot: identity,
    status: 'SUCCEEDED',
    findings: [],
    usage: { costUnits: 1 },
    transcriptRef: null,
    actionRequests: [],
    toolUseCount: 0,
  }));
  return { descriptor, change, plan, manifest, reviewers, policy: { ...POLICY, requireHumanApproval } };
}

function harness(options: {
  requireHumanApproval?: boolean;
  currentHead?: () => string;
  snapshotHook?: () => void;
  reporterCompleteError?: boolean | ((call: number) => boolean);
  reviewers?: ReviewerResult[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pr-manager-'));
  const log = openEventLog(join(root, 'events.db'), { now: () => NOW });
  const fix = fixtures(options.requireHumanApproval);
  const published: Array<{ report: QualityDecisionReport; override?: HumanOverride }> = [];
  let cancelled = 0;
  let completeCalls = 0;
  let runSequence = 0;
  const reporter: GitHubReportPort = {
    start: async () => 'check-1',
    cancel: async () => { cancelled += 1; },
    complete: async (_id, _descriptor, report, publishOptions) => {
      completeCalls += 1;
      const fail = typeof options.reporterCompleteError === 'function'
        ? options.reporterCompleteError(completeCalls)
        : options.reporterCompleteError === true;
      if (fail) throw new Error('reporter down');
      published.push({ report, ...(publishOptions?.override === undefined ? {} : { override: publishOptions.override }) });
    },
  };
  const deps: PrGateManagerDeps = {
    log,
    organizationPolicy: fix.policy,
    read: {
      getPullRequest: async () => ({ ...fix.descriptor, headSha: options.currentHead?.() ?? HEAD }),
      getCurrentHead: async () => options.currentHead?.() ?? HEAD,
    },
    git: { pin: async () => fix.change },
    policy: { load: async () => ({}) },
    classification: { classify: async () => fix.plan },
    snapshot: { materialize: async () => { options.snapshotHook?.(); return { manifest: fix.manifest, worktreeDir: '/snapshot' }; } },
    checks: { run: async () => ({ snapshot: fix.manifest.identity, checks: [], reportRef: `sha256:${'2'.repeat(64)}` }) },
    reviewers: { review: async () => options.reviewers ?? fix.reviewers },
    judge: { judge: async () => ({ status: 'SUCCEEDED', requestId: 'judge-1', costUnits: 1, result: { snapshot: fix.manifest.identity, findings: [], actionRequests: [], toolUseCount: 0 } }) },
    reporter,
    artifacts: memoryArtifacts(),
    now: () => NOW,
    nextRunId: () => `RUN-${String(++runSequence)}`,
    nextOverrideId: () => 'OVERRIDE-1',
  };
  const manager = createPrGateManager(deps);
  return { root, log, fix, manager, published, get cancelled() { return cancelled; }, cleanup() { log.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('manager runs Acquire through Report in allowlisted order and publishes exact-head PASS', async () => {
  const h = harness();
  try {
    const result = await h.manager.run({ repository: 'acme/repo', pullRequest: 5 });
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.systemDecision, 'PASS');
    assert.equal(result.publication, 'PUBLISHED');
    assert.equal(h.published.length, 1);
    const states = h.log.all({ type: 'PR_GATE_STATE' }).map((event) => event.payload['state']);
    assert.deepEqual(states, ['QUEUED', 'ACQUIRING', 'CLASSIFYING', 'SNAPSHOT_ATTESTING', 'CHECKING', 'REVIEWING', 'JUDGING', 'DECIDING', 'REPORTING', 'COMPLETED']);
    assert.ok(h.log.all({ type: 'PR_REVIEW_RESULT' }).every((event) => !JSON.stringify(event.payload).includes('findings')));
  } finally { h.cleanup(); }
});

test('head change after snapshot aborts old run, cancels its Check Run, and enqueues current head', async () => {
  let head = HEAD;
  const h = harness({ currentHead: () => head, snapshotHook: () => { head = '9'.repeat(40); } });
  try {
    const result = await h.manager.run({ repository: 'acme/repo', pullRequest: 5 });
    assert.equal(result.state, 'CANCELLED_STALE');
    assert.equal(result.publication, 'CANCELLED');
    assert.ok(h.cancelled >= 1);
    assert.equal(h.published.length, 0);
    const replacement = h.log.all({ type: 'PR_REPLACEMENT_ENQUEUED' });
    assert.equal(replacement.length, 1);
    assert.equal(replacement[0]?.payload['currentHead'], '9'.repeat(40));
    assert.equal(replacement[0]?.payload['replacementRunId'], 'RUN-2');
    await h.manager.cancel('RUN-2');
  } finally { h.cleanup(); }
});

test('report transport failure preserves decision and enters REPORTING_FAILED', async () => {
  const h = harness({ reporterCompleteError: true });
  try {
    const result = await h.manager.run({ repository: 'acme/repo', pullRequest: 5 });
    assert.equal(result.state, 'REPORTING_FAILED');
    assert.equal(result.systemDecision, 'PASS');
    assert.equal(result.publication, 'FAILED');
  } finally { h.cleanup(); }
});

test('human override keeps system decision, updates effective decision, and is idempotent', async () => {
  const h = harness({ requireHumanApproval: true });
  try {
    const result = await h.manager.run({ repository: 'acme/repo', pullRequest: 5 });
    assert.equal(result.state, 'AWAITING_HUMAN');
    assert.equal(result.systemDecision, 'HUMAN_REVIEW_REQUIRED');
    const input = { runId: 'RUN-1', actor: 'operator', idempotencyKey: 'same-key', headSha: HEAD, action: 'APPROVE' as const, reason: 'Reviewed evidence', findingIds: [] };
    const first = await h.manager.override(input);
    const replay = await h.manager.override(input);
    assert.deepEqual(replay, first);
    const detail = h.manager.detail('RUN-1');
    assert.equal(detail?.systemDecision, 'HUMAN_REVIEW_REQUIRED');
    assert.equal(detail?.effectiveDecision, 'PASS');
    assert.equal(detail?.state, 'COMPLETED');
    assert.equal(detail?.overrideHistory.length, 1);
    assert.equal(h.log.all({ type: 'PR_HUMAN_DECISION' }).length, 1);
    assert.equal(h.published.length, 2, 'original action_required plus one override publication');
  } finally { h.cleanup(); }
});

test('override replay rejects changed input or stale head', async () => {
  let head = HEAD;
  const h = harness({ requireHumanApproval: true, currentHead: () => head });
  try {
    await h.manager.run({ repository: 'acme/repo', pullRequest: 5 });
    const input = { runId: 'RUN-1', actor: 'operator', idempotencyKey: 'same-key', headSha: HEAD, action: 'APPROVE' as const, reason: 'Reviewed evidence', findingIds: [] };
    await h.manager.override(input);
    await assert.rejects(h.manager.override({ ...input, action: 'REJECT' }), /idempotency key reused/u);
    head = '9'.repeat(40);
    await assert.rejects(h.manager.override(input), /head changed/u);
    assert.equal(h.log.all({ type: 'PR_HUMAN_DECISION' }).length, 1);
  } finally { h.cleanup(); }
});

test('failed override publication is durable and same-key retry publishes once', async () => {
  const h = harness({ requireHumanApproval: true, reporterCompleteError: (call) => call === 2 });
  try {
    await h.manager.run({ repository: 'acme/repo', pullRequest: 5 });
    const input = { runId: 'RUN-1', actor: 'operator', idempotencyKey: 'retry-key', headSha: HEAD, action: 'APPROVE' as const, reason: 'Reviewed evidence', findingIds: [] };
    await assert.rejects(h.manager.override(input), /reporter down/u);
    assert.equal(h.manager.detail('RUN-1')?.publication, 'FAILED');
    await h.manager.override(input);
    assert.equal(h.manager.detail('RUN-1')?.publication, 'PUBLISHED');
    assert.equal(h.log.all({ type: 'PR_HUMAN_DECISION' }).length, 1);
    assert.equal(h.published.length, 2, 'initial system report plus one successful override publication');
  } finally { h.cleanup(); }
});

test('verified run rejects deterministic report that omits a trusted planned check', async () => {
  const h = harness();
  try {
    const planned = {
      id: 'required-test', kind: 'test' as const, command: 'pnpm test', required: true, timeoutMs: 1_000,
      network: 'none' as const, install: false as const, profiles: [], components: [],
    };
    const result = await h.manager.runVerified({
      change: h.fix.change,
      plan: { ...h.fix.plan, checks: [planned] },
      manifest: h.fix.manifest,
      deterministic: { snapshot: h.fix.manifest.identity, checks: [], reportRef: `sha256:${'2'.repeat(64)}` },
    });
    assert.equal(result.state, 'FAILED_INFRASTRUCTURE');
    assert.equal(result.systemDecision, 'INFRASTRUCTURE_FAILURE');
  } finally { h.cleanup(); }
});

test('duplicate reviewer request ids cannot inflate reviewer coverage', async () => {
  const fix = fixtures();
  const duplicate = fix.reviewers.map((reviewer) => ({ ...reviewer, requestId: 'same-request' }));
  const h = harness({ reviewers: duplicate });
  try {
    const result = await h.manager.run({ repository: 'acme/repo', pullRequest: 5 });
    assert.equal(result.systemDecision, 'INFRASTRUCTURE_FAILURE');
    assert.deepEqual(result.reviewerStatuses.map((item) => item.status), ['SUCCEEDED', 'INVALID_RESPONSE', 'INVALID_RESPONSE', 'INVALID_RESPONSE']);
  } finally { h.cleanup(); }
});

test('restart recovery moves interrupted projection to typed infrastructure terminal', () => {
  const h = harness();
  try {
    h.log.append({ runId: 'INTERRUPTED', taskId: null, type: 'PR_GATE_STATE', payload: { state: 'QUEUED', repository: 'acme/repo', pullRequest: 8 } });
    h.log.append({ runId: 'INTERRUPTED', taskId: null, type: 'PR_GATE_STATE', payload: { state: 'ACQUIRING' } });
    h.log.append({ runId: 'WAITING', taskId: null, type: 'PR_GATE_STATE', payload: { state: 'QUEUED', repository: 'acme/repo', pullRequest: 9 } });
    h.log.append({ runId: 'WAITING', taskId: null, type: 'PR_GATE_STATE', payload: { state: 'AWAITING_HUMAN' } });
    const recovered = h.manager.recoverInterrupted();
    assert.equal(recovered.find((run) => run.runId === 'INTERRUPTED')?.state, 'FAILED_INFRASTRUCTURE');
    assert.equal(h.manager.detail('WAITING')?.state, 'AWAITING_HUMAN');
  } finally { h.cleanup(); }
});
