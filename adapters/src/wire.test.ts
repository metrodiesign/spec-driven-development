// Shared wire helpers (REQ-1). REQ-1.2 (anthropic tests stay green) is proven by the
// existing anthropic.test.ts suite running unchanged against the extracted helpers.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProposePrompt, classifyAdapterError, normalizeActions, unfence } from './wire.ts';
import type { AgentRequest } from 'aal';

function req(objective = 'fix impl', agentRole: AgentRequest['agentRole'] = 'implementer'): AgentRequest {
  return {
    requestId: 'r-1',
    agentRole,
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

test('buildProposePrompt: advertises READ_FILE as a proposal type (bugfix-wire-prompt-vocabulary F1)', () => {
  const prompt = buildProposePrompt(req());
  assert.match(prompt, /"type":"READ_FILE"/);
});

test('buildProposePrompt: states the write-provenance rule — new file direct, existing file needs the bundle or an earlier READ_FILE (write-provenance AC-5)', () => {
  const prompt = buildProposePrompt(req());
  assert.match(prompt, /does not exist yet may be proposed directly/);
  // Both roads the gate actually accepts (aal/src/source.ts `allowed`): a stricter
  // sentence would teach a READ_FILE round for a file already in hand.
  assert.match(prompt, /ALREADY exists must either be in your context bundle or have been requested via READ_FILE in an EARLIER round/);
});

test('buildProposePrompt: diagnostician gets a distinct protocol teaching Hypothesis shape, never WRITE_FILE (bugfix-wire-prompt-vocabulary F2)', () => {
  const implementerPrompt = buildProposePrompt(req('fix impl', 'implementer'));
  const diagnosticianPrompt = buildProposePrompt(req('fix impl', 'diagnostician'));

  assert.notEqual(diagnosticianPrompt, implementerPrompt);
  assert.match(diagnosticianPrompt, /hypotheses/);
  assert.match(diagnosticianPrompt, /probes/);
  assert.doesNotMatch(diagnosticianPrompt, /"type":"WRITE_FILE"/);
  // still keeps the shared, role-agnostic escape hatches
  assert.match(diagnosticianPrompt, /"type":"READ_FILE"/);
  assert.match(diagnosticianPrompt, /"type":"REQUEST_TOOL"/);
});

test('buildProposePrompt: serializes acceptance criteria into the prompt when present (bugfix-wire-prompt-vocabulary F3)', () => {
  const prompt = buildProposePrompt(req());
  assert.match(prompt, /AC-1: d/);
});

test('AC-4/AC-5/AC-6: RUN_COMMAND is advertised only to implementer, always with network:none, never allowlist', () => {
  const implementer = buildProposePrompt(req('fix impl', 'implementer'));
  const diagnostician = buildProposePrompt(req('fix impl', 'diagnostician'));

  // AC-4: implementer sees RUN_COMMAND with the literal network value.
  assert.match(implementer, /"type":"RUN_COMMAND"/);
  assert.match(implementer, /"network":"none"/);

  // Row 10: the diagnostician does NOT see RUN_COMMAND (its actions are dropped silently at
  // aal/src/source.ts, so teaching it the type only lures a probe into the wrong slot) but
  // still keeps its full hypothesis paragraph.
  assert.doesNotMatch(diagnostician, /RUN_COMMAND/);
  assert.match(diagnostician, /hypotheses/);
  assert.match(diagnostician, /probes/);

  // AC-5: the four non-implementer roles never see RUN_COMMAND.
  for (const role of ['diagnostician', 'planner', 'test_designer', 'reviewer'] as const) {
    assert.doesNotMatch(buildProposePrompt(req('fix impl', role)), /RUN_COMMAND/, role);
  }

  // AC-6: no role's prompt mentions allowlist (there is no grantable value today).
  for (const role of ['implementer', 'diagnostician', 'planner', 'test_designer', 'reviewer'] as const) {
    assert.doesNotMatch(buildProposePrompt(req('fix impl', role)), /allowlist/, role);
  }
});

test('classifyAdapterError: quota/auth patterns, else transport (REQ-1.5)', () => {
  assert.equal(classifyAdapterError(new Error('429 rate limit exceeded')), 'quota_limited');
  assert.equal(classifyAdapterError('you have hit your usage limit'), 'quota_limited');
  assert.equal(classifyAdapterError(new Error('401 unauthorized: no credential')), 'auth_unavailable');
  assert.equal(classifyAdapterError('not logged in'), 'auth_unavailable');
  assert.equal(classifyAdapterError(new Error('ECONNRESET socket hang up')), 'transport', 'no known pattern -> transport');
  assert.equal(classifyAdapterError('some codex exec exited 1'), 'transport');
});
