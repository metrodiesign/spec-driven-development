import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReviewerFinding, ReviewerResult, Sha256Ref, SnapshotIdentity } from 'core';

import { AdapterError } from '../protocol.ts';
import type { AdapterInterface, AgentRequest, AgentResponse, CapabilityManifest } from '../protocol.ts';
import { runBlindReviewPanel, runEvidenceJudge } from './panel.ts';

const SNAPSHOT: SnapshotIdentity = {
  repository: 'acme/repo',
  pullRequest: 7,
  baseSha: 'base',
  headSha: 'head',
  mergeBaseSha: 'merge',
  diffRef: 'sha256:diff',
  policyRef: 'sha256:policy',
};
const EXCERPT = 'sha256:excerpt' as Sha256Ref;
const FINDING: ReviewerFinding = {
  id: 'f-1',
  category: 'correctness',
  severity: 'HIGH',
  title: 'Wrong branch',
  finding: 'Branch accepts stale state',
  rootCause: 'Identity check missing',
  evidence: [{ path: 'src/a.ts', startLine: 2, endLine: 2, excerptHash: EXCERPT }],
  trigger: 'Head changes',
  impact: 'Old result can pass',
  suggestedFix: 'Compare exact SHA',
  confidence: 0.9,
};

function manifest(id: string): CapabilityManifest {
  return {
    adapterId: id,
    structuredOutput: true,
    toolCalling: false,
    contextWindowTokens: 1000,
    executionBackend: false,
    determinism: 'none',
  };
}

function response(id: string, overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    structuredResult: { snapshot: SNAPSHOT, findings: [FINDING], actionRequests: [] },
    actionRequests: [],
    usage: { costUnits: 1, raw: {} },
    rawTranscriptRef: 'sha256:transcript',
    adapterMeta: { adapterId: id, modelVersion: 'm1', interactive: false, toolUseCount: 0 },
    ...overrides,
  };
}

function baseRequest(): Omit<AgentRequest, 'requestId'> {
  return {
    agentRole: 'reviewer',
    taskContract: { goalId: 'G', title: 'Review', objective: 'Review immutable diff', acceptanceCriteria: [] },
    contextBundle: {
      pieces: [{ id: 'diff', kind: 'file', path: 'src/a.ts', content: 'x\ny\n', reason: 'changed' }],
      canaryToken: 'CANARY',
      stats: { bytes: 4, pieceCount: 1 },
    },
    manifestRef: 'sha256:manifest',
    outputSchema: {},
    toolDefs: [{ name: 'must-be-stripped' }],
    budget: { costUnits: 10 },
  };
}

test('REQ-5 dispatches four blind slots in parallel with one model-visible envelope', async () => {
  let started = 0;
  let release!: () => void;
  let allStarted!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { allStarted = resolve; });
  const captured: AgentRequest[] = [];
  const adapters = Array.from({ length: 4 }, (_, index): AdapterInterface => ({
    manifest: () => manifest(`private-provider-${index}`),
    async send(request) {
      captured.push(request);
      started += 1;
      if (started === 4) allStarted();
      await hold;
      return response(`private-provider-${index}`);
    },
  }));
  const controller = new AbortController();
  const running = runBlindReviewPanel({
    slots: adapters.map((adapter, index) => ({ adapter, requestId: `r-${index}`, reasoningOnlyConformant: true })),
    request: baseRequest(),
    snapshot: SNAPSHOT,
    evidence: { 'src/a.ts': { lineCount: 2, excerptHashes: { '2:2': EXCERPT } } },
    control: { signal: controller.signal, timeoutMs: 1000 },
  });
  await ready;
  assert.equal(started, 4, 'all calls started before any completed');
  release();
  const results = await running;
  assert.ok(results.every((result) => result.status === 'SUCCEEDED'));
  const visible = captured.map(({ requestId: _requestId, ...request }) => request);
  assert.ok(visible.every((request) => JSON.stringify(request) === JSON.stringify(visible[0])));
  assert.ok(captured.every((request) => request.agentRole === 'reviewer' && request.toolDefs.length === 0));
});

test('REQ-5 maps typed provider failures and rejects action/tool output', async () => {
  const timedOut: AdapterInterface = {
    manifest: () => manifest('timeout'),
    send: () => Promise.reject(new AdapterError('timed_out', 'deadline')),
  };
  const action: AdapterInterface = {
    manifest: () => manifest('action'),
    send: () => Promise.resolve(response('action', { actionRequests: [{ type: 'READ_FILE', actionId: 'a', path: 'x' }] })),
  };
  const unconformant: AdapterInterface = { manifest: () => manifest('unsafe'), send: () => Promise.resolve(response('unsafe')) };
  const controller = new AbortController();
  const results = await runBlindReviewPanel({
    slots: [
      { adapter: timedOut, requestId: 'r0', reasoningOnlyConformant: true },
      { adapter: action, requestId: 'r1', reasoningOnlyConformant: true },
      { adapter: unconformant, requestId: 'r2', reasoningOnlyConformant: false },
    ],
    request: baseRequest(),
    snapshot: SNAPSHOT,
    evidence: { 'src/a.ts': { lineCount: 2, excerptHashes: { '2:2': EXCERPT } } },
    control: { signal: controller.signal, timeoutMs: 1000 },
  });
  assert.deepEqual(results.map((result) => result.status), ['TIMED_OUT', 'INVALID_RESPONSE', 'UNAVAILABLE']);
});

test('REQ-11 prompt-injection canary echoed by reviewer is invalid', async () => {
  const injected: AdapterInterface = {
    manifest: () => manifest('injected'),
    send: () => Promise.resolve(response('injected', {
      structuredResult: { snapshot: SNAPSHOT, findings: [{ ...FINDING, finding: 'CANARY' }], actionRequests: [] },
    })),
  };
  const result = await runBlindReviewPanel({
    slots: [{ adapter: injected, requestId: 'r-canary', reasoningOnlyConformant: true }],
    request: baseRequest(), snapshot: SNAPSHOT,
    evidence: { 'src/a.ts': { lineCount: 2, excerptHashes: { '2:2': EXCERPT } } },
    control: { signal: new AbortController().signal, timeoutMs: 1000 },
  });
  assert.equal(result[0]?.status, 'INVALID_RESPONSE');
});

test('REQ-5 malformed reviewer finding is INVALID_RESPONSE, not transport failure', async () => {
  const malformed: AdapterInterface = {
    manifest: () => manifest('malformed'),
    send: () => Promise.resolve(response('malformed', {
      structuredResult: { snapshot: SNAPSHOT, findings: [null], actionRequests: [] },
    })),
  };
  const result = await runBlindReviewPanel({
    slots: [{ adapter: malformed, requestId: 'r-malformed', reasoningOnlyConformant: true }],
    request: baseRequest(), snapshot: SNAPSHOT,
    evidence: { 'src/a.ts': { lineCount: 2, excerptHashes: { '2:2': EXCERPT } } },
    control: { signal: new AbortController().signal, timeoutMs: 1000 },
  });
  assert.equal(result[0]?.status, 'INVALID_RESPONSE');
});

test('REQ-6 Judge sees only C-labels and returns Ring-0-validated evidence refs', async () => {
  let captured: AgentRequest | undefined;
  const judge: AdapterInterface = {
    manifest: () => manifest('private-judge-provider'),
    send(request) {
      captured = request;
      return Promise.resolve(response('private-judge-provider', {
        structuredResult: {
          snapshot: SNAPSHOT,
          findings: [{
            canonicalFindingKey: 'stale-head-identity',
            sourceFindingIds: ['C0:f-1'],
            classification: 'VERIFIED',
            severity: 'HIGH',
            evidenceRefs: [EXCERPT],
            rationale: 'Exact cited line lacks head identity comparison.',
          }],
          actionRequests: [],
        },
      }));
    },
  };
  const reviewer: ReviewerResult = {
    requestId: 'review-0',
    adapterId: 'private-review-provider',
    modelVersion: 'secret-model',
    snapshot: SNAPSHOT,
    status: 'SUCCEEDED',
    findings: [FINDING],
    usage: { costUnits: 1 },
    transcriptRef: null,
    actionRequests: [],
    toolUseCount: 0,
  };
  let refs = 0;
  const controller = new AbortController();
  const outcome = await runEvidenceJudge({
    adapter: judge,
    requestId: 'judge-1',
    reasoningOnlyConformant: true,
    snapshot: SNAPSHOT,
    reviewerResults: [reviewer],
    evidenceContext: baseRequest().contextBundle,
    manifestRef: 'sha256:manifest',
    budget: { costUnits: 10 },
    control: { signal: controller.signal, timeoutMs: 1000 },
    putEvidence: () => `sha256:rationale-${refs++}`,
  });
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(outcome.result?.findings[0]?.canonicalFindingKey, 'stale-head-identity');
  const visible = JSON.stringify(captured);
  assert.match(visible, /C0:f-1/);
  assert.doesNotMatch(visible, /private-review-provider|secret-model|private-judge-provider/);
});

test('REQ-6 invalid Judge references fail closed', async () => {
  const judge: AdapterInterface = {
    manifest: () => manifest('judge'),
    send: () => Promise.resolve(response('judge', {
      structuredResult: {
        snapshot: SNAPSHOT,
        findings: [{
          canonicalFindingKey: 'bad-ref',
          sourceFindingIds: ['C9:missing'],
          classification: 'VERIFIED',
          severity: 'HIGH',
          evidenceRefs: ['sha256:not-in-snapshot'],
          rationale: 'No evidence.',
        }],
        actionRequests: [],
      },
    })),
  };
  const controller = new AbortController();
  const outcome = await runEvidenceJudge({
    adapter: judge,
    requestId: 'judge-bad',
    reasoningOnlyConformant: true,
    snapshot: SNAPSHOT,
    reviewerResults: [],
    evidenceContext: baseRequest().contextBundle,
    manifestRef: 'sha256:manifest',
    budget: { costUnits: 10 },
    control: { signal: controller.signal, timeoutMs: 1000 },
    putEvidence: () => 'sha256:rationale',
  });
  assert.equal(outcome.status, 'INVALID_RESPONSE');
  assert.equal(outcome.result, null);
});

test('REQ-11 Judge canary echo and invalid cost fail closed before evidence is stored', async () => {
  let stored = 0;
  const judge: AdapterInterface = {
    manifest: () => manifest('judge'),
    send: () => Promise.resolve(response('judge', {
      structuredResult: {
        snapshot: SNAPSHOT,
        findings: [{
          canonicalFindingKey: 'canary-echo', sourceFindingIds: [], classification: 'UNVERIFIED', severity: 'LOW',
          evidenceRefs: [], rationale: 'CANARY',
        }],
        actionRequests: [],
      },
      usage: { costUnits: Number.NaN, raw: {} },
    })),
  };
  const outcome = await runEvidenceJudge({
    adapter: judge, requestId: 'judge-canary', reasoningOnlyConformant: true, snapshot: SNAPSHOT,
    reviewerResults: [], evidenceContext: baseRequest().contextBundle, manifestRef: 'sha256:manifest',
    budget: { costUnits: 10 }, control: { signal: new AbortController().signal, timeoutMs: 1000 },
    putEvidence: () => { stored += 1; return 'sha256:rationale'; },
  });
  assert.equal(outcome.status, 'INVALID_RESPONSE');
  assert.equal(outcome.costUnits, 10);
  assert.equal(stored, 0);
});
