// Shared wire helpers (REQ-1). REQ-1.2 (anthropic tests stay green) is proven by the
// existing anthropic.test.ts suite running unchanged against the extracted helpers.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProposePrompt, classifyAdapterError, normalizeActions, unfence } from './wire.ts';
import type { AgentRequest } from 'aal';

function req(objective = 'fix impl'): AgentRequest {
  return {
    requestId: 'r-1',
    agentRole: 'implementer',
    taskContract: { goalId: 'G', title: 't', objective, acceptanceCriteria: [{ id: 'AC-1', description: 'd' }] },
    contextBundle: { pieces: [{ id: 'p-0', kind: 'file', path: 'src/impl.txt', content: 'wrong', reason: 'seed' }], canaryToken: 'CANARY', stats: { bytes: 5, pieceCount: 1 } },
    manifestRef: 'blob://m',
    outputSchema: { type: 'object', required: ['claim', 'actionRequests'] },
    toolDefs: [],
    budget: { costUnits: 500 },
  };
}

test('exports unfence, normalizeActions, buildProposePrompt, classifyAdapterError as functions (REQ-1.1)', () => {
  for (const fn of [unfence, normalizeActions, buildProposePrompt, classifyAdapterError]) {
    assert.equal(typeof fn, 'function');
  }
});

test('normalizeActions mints a contentRef for inline WRITE_FILE content (REQ-1.4)', () => {
  const blobs: string[] = [];
  const put = (c: string): string => { blobs.push(c); return `blob://${blobs.length - 1}`; };
  const out = normalizeActions(
    [{ type: 'WRITE_FILE', path: 'src/impl.txt', content: 'correct\n' }, { type: 'REQUEST_TOOL', name: 'fusion.deliberate' }],
    put,
  );
  assert.deepEqual(out[0], { actionId: 'a-0', type: 'WRITE_FILE', path: 'src/impl.txt', contentRef: 'blob://0' });
  assert.equal(blobs[0], 'correct\n');
  assert.deepEqual(out[1], { actionId: 'a-1', type: 'REQUEST_TOOL', name: 'fusion.deliberate' });
  assert.deepEqual(normalizeActions('not-an-array', put), []);
});

test('unfence unwraps only a whole-message code fence', () => {
  assert.equal(unfence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('{"a":1}'), '{"a":1}');
  assert.equal(unfence('prose ```json\n{}\n```'), 'prose ```json\n{}\n```');
});

test('buildProposePrompt: fenceGuard false drops the no-fences clause but keeps the vocabulary (REQ-1.3)', () => {
  const guarded = buildProposePrompt(req(), { fenceGuard: true });
  const codex = buildProposePrompt(req(), { fenceGuard: false });

  // fenceGuard true (Claude) states the no-fences / raw-JSON rule.
  assert.match(guarded, /no markdown fences/);
  assert.match(guarded, /raw JSON object/);

  // fenceGuard false (Codex) drops that clause — --output-schema already constrains it.
  assert.doesNotMatch(codex, /no markdown fences/);
  assert.doesNotMatch(codex, /raw JSON object/);

  // BOTH keep the marking, the no-execution statement, the action vocabulary, and the schema.
  for (const p of [guarded, codex]) {
    assert.match(p, /UNTRUSTED DATA/);
    assert.match(p, /NO tools and cannot execute anything/);
    assert.match(p, /"type":"WRITE_FILE"/);
    assert.match(p, /"type":"REQUEST_TOOL"/);
    assert.match(p, /conforming to this schema/);
  }
  // Default (no opts) behaves as fenceGuard true.
  assert.match(buildProposePrompt(req()), /no markdown fences/);
});

test('classifyAdapterError: quota/auth patterns, else transport (REQ-1.5)', () => {
  assert.equal(classifyAdapterError(new Error('429 rate limit exceeded')), 'quota_limited');
  assert.equal(classifyAdapterError('you have hit your usage limit'), 'quota_limited');
  assert.equal(classifyAdapterError(new Error('401 unauthorized: no credential')), 'auth_unavailable');
  assert.equal(classifyAdapterError('not logged in'), 'auth_unavailable');
  assert.equal(classifyAdapterError(new Error('ECONNRESET socket hang up')), 'transport', 'no known pattern -> transport');
  assert.equal(classifyAdapterError('some codex exec exited 1'), 'transport');
});
