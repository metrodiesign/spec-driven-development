// RED (createAnthropicAdapter throws NotImplemented) -> GREEN same task. REQ-4.
// Uses a MOCK QueryFn — CI never spends quota. The live success path (real
// transcript capture) is verified in task 11.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAnthropicAdapter, normalizeActions, unfence, type QueryFn, type SdkMessage } from './anthropic.ts';
import { AdapterError } from 'aal';
import type { AgentRequest } from 'aal';

const SYS = 'You are the platform core agent. Propose structured actions only.';

function req(id = 'req-1'): AgentRequest {
  return {
    requestId: id,
    agentRole: 'implementer',
    taskContract: { goalId: 'G', title: 't', objective: 'fix impl', acceptanceCriteria: [{ id: 'AC-1', description: 'd' }] },
    contextBundle: { pieces: [{ id: 'p-0', kind: 'file', path: 'src/impl.txt', content: 'wrong', reason: 'seed' }], canaryToken: 'CANARY', stats: { bytes: 5, pieceCount: 1 } },
    manifestRef: 'blob://m',
    outputSchema: { type: 'object', required: ['claim', 'actionRequests'] },
    toolDefs: [],
    budget: { costUnits: 500 },
  };
}

const ASSISTANT_JSON = JSON.stringify({
  claim: 'READY_FOR_VERIFICATION',
  actionRequests: [{ type: 'WRITE_FILE', actionId: 'a1', path: 'src/impl.txt', contentRef: 'blob://c' }],
});

function mockQuery(opts: { messages?: SdkMessage[]; throwErr?: Error; toolUse?: boolean; capture?: { args?: unknown } }): QueryFn {
  return (args) => {
    if (opts.capture) opts.capture.args = args;
    async function* gen(): AsyncGenerator<SdkMessage> {
      if (opts.throwErr) throw opts.throwErr;
      yield { type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] };
      const content: { type?: string; text?: string }[] = [{ type: 'text', text: ASSISTANT_JSON }];
      if (opts.toolUse) content.push({ type: 'tool_use', text: '' });
      yield { type: 'assistant', message: { content } };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1', usage: { input_tokens: 1200, output_tokens: 800 } };
    }
    return opts.messages ? (async function* () { yield* opts.messages!; })() : gen();
  };
}

function harness(query: QueryFn) {
  const root = mkdtempSync(join(tmpdir(), 'anth-'));
  const blobs = new Map<string, string>();
  const adapter = createAnthropicAdapter({
    id: 'claude',
    model: 'sonnet',
    query,
    systemPrompt: SYS,
    cwd: root,
    replayDir: join(root, 'replay'),
    putEvidence: (c) => { const ref = `blob://${blobs.size}`; blobs.set(ref, c); return ref; },
    costUnitsPer1k: 1,
    pollAttempts: 2,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  return { adapter, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('model-inline WRITE_FILE content is mapped to a minted contentRef (wire->core translation, observed live)', () => {
  const blobs: string[] = [];
  const put = (c: string): string => { blobs.push(c); return `blob://${blobs.length - 1}`; };
  const out = normalizeActions(
    [
      { type: 'WRITE_FILE', path: 'src/impl.txt', content: 'correct\n' },
      { type: 'REQUEST_TOOL', name: 'fusion.deliberate' },
    ],
    put,
  );
  assert.deepEqual(out[0], { actionId: 'a-0', type: 'WRITE_FILE', path: 'src/impl.txt', contentRef: 'blob://0' });
  assert.equal(blobs[0], 'correct\n');
  assert.deepEqual(out[1], { actionId: 'a-1', type: 'REQUEST_TOOL', name: 'fusion.deliberate' });
  assert.deepEqual(normalizeActions('not-an-array', put), [], 'non-array degrades to empty');
});

test('a markdown-fenced JSON reply is unwrapped before parsing (wire normalization, observed live P2)', async () => {
  assert.equal(unfence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('{"a":1}'), '{"a":1}', 'raw JSON passes through');
  assert.equal(unfence('prose ```json\n{}\n```'), 'prose ```json\n{}\n```', 'only a whole-message fence unwraps');
  const fenced: SdkMessage[] = [
    { type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] },
    { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n' + ASSISTANT_JSON + '\n```' }] } },
    { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } },
  ];
  const h = harness(mockQuery({ messages: fenced }));
  try {
    const resp = await h.adapter.send(req('req-fence'));
    assert.equal((resp.structuredResult as { claim?: string }).claim, 'READY_FOR_VERIFICATION');
    assert.equal(resp.actionRequests.length, 1);
  } finally { h.cleanup(); }
});

test('sends the D-004 isolation flags + core system prompt (REQ-4.1)', async () => {
  const capture: { args?: unknown } = {};
  const h = harness(mockQuery({ capture }));
  try {
    await h.adapter.send(req());
    const a = capture.args as { options: { tools: string[]; settingSources: string[]; systemPrompt: string } };
    assert.deepEqual(a.options.tools, [], 'tools: [] strips execution');
    assert.deepEqual(a.options.settingSources, [], 'settingSources: [] isolates machine config');
    assert.equal(a.options.systemPrompt, SYS, 'core-owned system prompt');
  } finally { h.cleanup(); }
});

test('maps assistant JSON -> structuredResult + actionRequests; usage -> costUnits; toolUseCount', async () => {
  const h = harness(mockQuery({}));
  try {
    const resp = await h.adapter.send(req());
    assert.equal((resp.structuredResult as { claim?: string }).claim, 'READY_FOR_VERIFICATION');
    assert.equal(resp.actionRequests.length, 1);
    assert.equal(resp.actionRequests[0]?.type, 'WRITE_FILE');
    assert.equal(resp.usage.costUnits, 2, '(1200+800)/1000 = 2 costUnits');
    assert.equal(resp.adapterMeta.toolUseCount, 0);
    assert.equal(resp.adapterMeta.interactive, false);
  } finally { h.cleanup(); }
});

test('manifest: propose-only, execution backend false, determinism none (REQ-4.7)', () => {
  const h = harness(mockQuery({}));
  try {
    const m = h.adapter.manifest();
    assert.equal(m.executionBackend, false);
    assert.equal(m.determinism, 'none');
  } finally { h.cleanup(); }
});

test('a tool_use block in the stream is counted (P6 signal)', async () => {
  const h = harness(mockQuery({ toolUse: true }));
  try {
    const resp = await h.adapter.send(req());
    assert.equal(resp.adapterMeta.toolUseCount, 1);
  } finally { h.cleanup(); }
});

test('absent transcript -> rawTranscriptRef null + reason, no crash (REQ-4.6)', async () => {
  const h = harness(mockQuery({})); // no transcriptDir file written
  try {
    const resp = await h.adapter.send(req());
    assert.equal(resp.rawTranscriptRef, null);
  } finally { h.cleanup(); }
});

test('rate/limit error -> AdapterError quota_limited, no self-retry (REQ-4.4)', async () => {
  const h = harness(mockQuery({ throwErr: new Error('429 rate limit exceeded') }));
  try {
    await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'quota_limited');
  } finally { h.cleanup(); }
});

test('auth error -> AdapterError auth_unavailable (REQ-4.8)', async () => {
  const h = harness(mockQuery({ throwErr: new Error('401 unauthorized: no credential') }));
  try {
    await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'auth_unavailable');
  } finally { h.cleanup(); }
});

test('durable replay: same requestId served from disk, query called once (REQ-4.9/P8)', async () => {
  let calls = 0;
  const counting: QueryFn = (args) => { calls += 1; return mockQuery({})(args); };
  const h = harness(counting);
  try {
    const r1 = await h.adapter.send(req('same'));
    const r2 = await h.adapter.send(req('same'));
    assert.equal(calls, 1, 'second send served from durable replay');
    assert.deepEqual(r1, r2);
  } finally { h.cleanup(); }
});
