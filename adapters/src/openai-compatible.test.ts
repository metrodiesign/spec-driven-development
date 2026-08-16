// GLM adapter core (REQ-1..REQ-4). Injected FAKE transport -> CI spends zero
// quota. The live fetch path (openai-compatible-live.ts) is NEVER imported by
// this file (REQ-2.7): every behavior it composes is covered here through the
// pure helpers — buildGlmRequestBody, parseGlmHttpBody, resolveGlmEndpointConfig.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createOpenAICompatibleAdapter,
  buildGlmRequestBody,
  parseGlmHttpBody,
  resolveGlmEndpointConfig,
  GLM_CONTEXT_WINDOW_TOKENS,
  GLM_DEFAULT_BASE_URL,
  type GlmTransport,
  type GlmTransportResult,
} from './openai-compatible.ts';
import { AdapterError } from 'aal';
import type { AgentCallControl, AgentRequest } from 'aal';

const COMPLIANT_TEXT = JSON.stringify({
  claim: 'READY_FOR_VERIFICATION',
  actionRequests: [{ type: 'WRITE_FILE', path: 'src/impl.txt', content: 'correct\n' }],
});

function fakeTransport(
  opts: {
    text?: string;
    usage?: { promptTokens: number; completionTokens: number };
    rawUsage?: Record<string, unknown>;
    onCall?: (prompt: string, control?: AgentCallControl) => void;
    throwErr?: Error;
  } = {},
): GlmTransport {
  return (prompt, control) => {
    opts.onCall?.(prompt, control);
    if (opts.throwErr !== undefined) return Promise.reject(opts.throwErr);
    const result: GlmTransportResult = {
      text: opts.text ?? COMPLIANT_TEXT,
      usage: opts.usage ?? { promptTokens: 100, completionTokens: 50 },
      rawUsage: opts.rawUsage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      rawBody: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: opts.text ?? COMPLIANT_TEXT } }],
        usage: opts.rawUsage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    };
    return Promise.resolve(result);
  };
}

function req(id = 'req-1'): AgentRequest {
  return {
    requestId: id,
    agentRole: 'implementer',
    taskContract: { goalId: 'G', title: 't', objective: 'fix impl', acceptanceCriteria: [{ id: 'AC-1', description: 'd' }] },
    contextBundle: { pieces: [], canaryToken: 'CANARY', stats: { bytes: 0, pieceCount: 0 } },
    manifestRef: 'blob://m',
    outputSchema: { type: 'object', required: ['claim', 'actionRequests'] },
    toolDefs: [],
    budget: { costUnits: 500 },
  };
}

function harness(transport: GlmTransport, model: string | undefined = 'glm-5.3') {
  const root = mkdtempSync(join(tmpdir(), 'glm-'));
  const blobs = new Map<string, string>();
  const adapter = createOpenAICompatibleAdapter({
    ...(model !== undefined ? { model } : {}),
    transport,
    replayDir: join(root, 'replay'),
    putEvidence: (c) => { const ref = `blob://${blobs.size}`; blobs.set(ref, c); return ref; },
    costUnitsPer1k: 1,
  });
  return { adapter, blobs, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('createOpenAICompatibleAdapter implements AdapterInterface with an injected transport seam (REQ-1.1)', () => {
  const h = harness(fakeTransport());
  try {
    assert.equal(typeof h.adapter.manifest, 'function');
    assert.equal(typeof h.adapter.send, 'function');
  } finally { h.cleanup(); }
});

test('manifest: glm/zai identity, 1M window, propose-only flags (REQ-1.2)', () => {
  const h = harness(fakeTransport());
  try {
    const m = h.adapter.manifest();
    assert.equal(m.adapterId, 'glm');
    assert.equal(m.structuredOutput, true);
    assert.equal(m.toolCalling, false);
    assert.equal(m.contextWindowTokens, GLM_CONTEXT_WINDOW_TOKENS);
    assert.equal(m.contextWindowTokens, 1_000_000);
    assert.equal(m.executionBackend, false);
    assert.equal(m.determinism, 'none');
    assert.equal(m.lineage, 'zai');
  } finally { h.cleanup(); }
});

test('prompt built with fenceGuard: raw-JSON clause + action vocabulary present (REQ-1.3)', async () => {
  let seen = '';
  const h = harness(fakeTransport({ onCall: (p) => { seen = p; } }));
  try {
    await h.adapter.send(req());
    assert.match(seen, /no markdown fences/, 'fence-guard clause is ON (no --output-schema equivalent on this wire)');
    assert.match(seen, /Protocol: you have NO tools/);
    assert.match(seen, /fix impl/, 'objective embedded');
    assert.match(seen, /UNTRUSTED DATA/);
  } finally { h.cleanup(); }
});

test('reply -> structuredResult + normalized actions; inline WRITE_FILE content minted to contentRef (REQ-1.3/5.4)', async () => {
  const h = harness(fakeTransport());
  try {
    const resp = await h.adapter.send(req());
    assert.equal((resp.structuredResult as { claim?: string }).claim, 'READY_FOR_VERIFICATION');
    assert.equal(resp.actionRequests.length, 1);
    assert.equal(resp.actionRequests[0]?.type, 'WRITE_FILE');
    assert.ok((resp.actionRequests[0] as { contentRef?: string }).contentRef?.startsWith('blob://'));
    assert.equal(resp.adapterMeta.modelVersion, 'glm-5.3');
    assert.equal(resp.adapterMeta.toolUseCount, 0, 'propose-only: no tool_use on this wire (P6)');
    assert.notEqual(resp.rawTranscriptRef, null, 'raw body persisted as transcript');
  } finally { h.cleanup(); }
});

test('usage math + unknown fields passed through raw (REQ-1.9)', async () => {
  const h = harness(fakeTransport({
    usage: { promptTokens: 100, completionTokens: 50 },
    rawUsage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 30 },
  }));
  try {
    const resp = await h.adapter.send(req());
    assert.equal(resp.usage.costUnits, 0.15); // (100+50)/1000 * 1
    assert.equal(resp.usage.raw['reasoning_tokens'], 30, 'unknown usage fields survive in usage.raw');
  } finally { h.cleanup(); }
});

test('durable replay: same requestId served from disk, transport called once (REQ-1.4/P8)', async () => {
  let calls = 0;
  const h = harness(fakeTransport({ onCall: () => { calls += 1; } }));
  try {
    const r1 = await h.adapter.send(req('same'));
    const r2 = await h.adapter.send(req('same'));
    assert.equal(calls, 1, 'second send served from durable replay — transport not re-invoked');
    assert.deepEqual(r1, r2);
  } finally { h.cleanup(); }
});

test('non-finite usage -> AdapterError invalid_response (REQ-1.8)', async () => {
  const h = harness(fakeTransport({ usage: { promptTokens: Number.NaN, completionTokens: 50 } }));
  try {
    await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && e.kind === 'invalid_response');
  } finally { h.cleanup(); }
});

test('reply text that is not fenceable JSON -> { raw } with zero actions, no throw (REQ-1.7)', async () => {
  const h = harness(fakeTransport({ text: 'I would do X, Y, Z — in prose.' }));
  try {
    const resp = await h.adapter.send(req());
    assert.deepEqual(resp.structuredResult, { raw: 'I would do X, Y, Z — in prose.' });
    assert.equal(resp.actionRequests.length, 0);
  } finally { h.cleanup(); }
});

test('already-typed AdapterError from the seam passes through unchanged (REQ-1.5/2.6)', async () => {
  const h = harness(fakeTransport({ throwErr: new AdapterError('invalid_response', 'no usable choice') }));
  try {
    await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && e.kind === 'invalid_response');
  } finally { h.cleanup(); }
});

test('error classify matrix: 429 -> quota_limited, 401/403 -> auth_unavailable, context -> context_limited, unmatched -> transport (REQ-1.5/2.4)', async () => {
  const cases: Array<[Error, AdapterError['kind']]> = [
    [new Error('HTTP 429: {"error":{"message":"rate limit exceeded"}}'), 'quota_limited'],
    [new Error('HTTP 401: {"error":{"message":"invalid api key"}}'), 'auth_unavailable'],
    [new Error('HTTP 403: forbidden'), 'auth_unavailable'],
    [new Error('HTTP 400: {"error":{"message":"prompt too long: input exceeds context window"}}'), 'context_limited'],
    [new Error('HTTP 500: internal'), 'transport'],
    [new Error('ECONNRESET'), 'transport'],
  ];
  for (const [err, kind] of cases) {
    const h = harness(fakeTransport({ throwErr: err }));
    try {
      await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && e.kind === kind, `${err.message} -> ${kind}`);
    } finally { h.cleanup(); }
  }
});

test('no self-retry: transport invoked exactly once even when it throws (REQ-1.5/INV-5)', async () => {
  let calls = 0;
  const h = harness(fakeTransport({ throwErr: new Error('HTTP 429: rate limit'), onCall: () => { calls += 1; } }));
  try {
    await assert.rejects(h.adapter.send(req()));
    assert.equal(calls, 1);
  } finally { h.cleanup(); }
});

test('pre-aborted control -> cancelled, transport never invoked (REQ-1.6)', async () => {
  let calls = 0;
  const h = harness(fakeTransport({ onCall: () => { calls += 1; } }));
  try {
    const control: AgentCallControl = { signal: AbortSignal.abort(), timeoutMs: 1_000 };
    await assert.rejects(h.adapter.send(req(), control), (e: unknown) => e instanceof AdapterError && e.kind === 'cancelled');
    assert.equal(calls, 0);
  } finally { h.cleanup(); }
});

test('timeout text from the seam classifies timed_out (REQ-1.6)', async () => {
  const h = harness(fakeTransport({ throwErr: new Error('provider timeout after 600000ms') }));
  try {
    await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && e.kind === 'timed_out');
  } finally { h.cleanup(); }
});

test('control is forwarded to the transport seam verbatim (REQ-2.5 core half)', async () => {
  let seen: AgentCallControl | undefined;
  const h = harness(fakeTransport({ onCall: (_p, c) => { seen = c; } }));
  const controller = new AbortController();
  const control: AgentCallControl = { signal: controller.signal, timeoutMs: 456 };
  try {
    await h.adapter.send(req('controlled'), control);
    assert.equal(seen, control, 'same control object, signal + timeoutMs intact');
  } finally { h.cleanup(); }
});

test('no healthProbe — breaker is error-rate only (parity with codex)', () => {
  const h = harness(fakeTransport());
  try {
    assert.equal((h.adapter as { healthProbe?: unknown }).healthProbe, undefined);
  } finally { h.cleanup(); }
});

// --- Pure helpers (REQ-2.1/2.2/2.3/2.4/2.6) ---

test('buildGlmRequestBody: thinking always on + reasoning_effort mandatory + model echoed + stream off (REQ-2.3)', () => {
  const body = buildGlmRequestBody('THE PROMPT', { model: 'glm-5.3', reasoningEffort: 'high' });
  assert.deepEqual(body, {
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'THE PROMPT' }],
    thinking: { type: 'enabled' }, // 'disabled' is REMOVED in GLM-5.3
    reasoning_effort: 'high',
    stream: false,
  });
  // The type has no room for a disabled thinking mode — this is the wire contract.
  assert.notDeepEqual(body.thinking, { type: 'disabled' });
});

test('parseGlmHttpBody: 2xx happy path reads choices[0].message.content + usage, unknown fields raw (REQ-2.6)', () => {
  const bodyText = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'REPLY' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 99 },
  });
  const out = parseGlmHttpBody(200, bodyText);
  assert.equal(out.text, 'REPLY');
  assert.deepEqual(out.usage, { promptTokens: 10, completionTokens: 5 });
  assert.equal(out.rawUsage['reasoning_tokens'], 99);
  assert.equal(out.rawBody, bodyText);
});

test('parseGlmHttpBody: 2xx with empty choices / missing usage -> invalid_response (REQ-2.6)', () => {
  const empty = JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert.throws(() => parseGlmHttpBody(200, empty), (e: unknown) => e instanceof AdapterError && e.kind === 'invalid_response');
  const noUsage = JSON.stringify({ choices: [{ message: { content: 'x' } }] });
  assert.throws(() => parseGlmHttpBody(200, noUsage), (e: unknown) => e instanceof AdapterError && e.kind === 'invalid_response');
  const nonJson = '<html>gateway error</html>';
  assert.throws(() => parseGlmHttpBody(200, nonJson), (e: unknown) => e instanceof AdapterError && e.kind === 'invalid_response');
});

test('parseGlmHttpBody: non-2xx throws with HTTP status + body in the message so classify maps it (REQ-2.4)', () => {
  assert.throws(
    () => parseGlmHttpBody(429, '{"error":{"message":"rate limited"}}'),
    (e: unknown) => e instanceof Error && e.message.includes('HTTP 429') && e.message.includes('rate limited'),
  );
});

test('resolveGlmEndpointConfig: missing/empty key -> auth_unavailable BEFORE any network call (REQ-2.2)', () => {
  assert.throws(() => resolveGlmEndpointConfig({}), (e: unknown) => e instanceof AdapterError && e.kind === 'auth_unavailable');
  assert.throws(() => resolveGlmEndpointConfig({ ZAI_API_KEY: '' }), (e: unknown) => e instanceof AdapterError && e.kind === 'auth_unavailable');
  assert.throws(() => resolveGlmEndpointConfig({ ZAI_API_KEY: '   ' }), (e: unknown) => e instanceof AdapterError && e.kind === 'auth_unavailable');
});

test('resolveGlmEndpointConfig: ZAI_BASE_URL override honored; Z.ai default when unset (REQ-2.1)', () => {
  const cfg = resolveGlmEndpointConfig({ ZAI_API_KEY: 'sk-test' });
  assert.equal(cfg.baseUrl, GLM_DEFAULT_BASE_URL);
  assert.equal(cfg.baseUrl, 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(cfg.apiKey, 'sk-test');
  const overridden = resolveGlmEndpointConfig({ ZAI_API_KEY: 'sk-test', ZAI_BASE_URL: 'https://elsewhere/v1/chat/completions' });
  assert.equal(overridden.baseUrl, 'https://elsewhere/v1/chat/completions');
});

test('credential hygiene: no artifact contains the key or a Bearer header (REQ-3.1)', async () => {
  const h = harness(fakeTransport());
  try {
    const resp = await h.adapter.send(req('hygiene'));
    const artifacts = [JSON.stringify(resp), [...h.blobs.values()].join('\n')];
    // The core path is type-blind to credentials — this pins that no future change
    // starts threading transport-layer secrets into durable artifacts.
    for (const a of artifacts) {
      assert.doesNotMatch(a, /Bearer\s/, 'no Authorization header materialized');
      assert.doesNotMatch(a, /sk-[A-Za-z0-9]+/, 'no key-shaped secret');
    }
  } finally { h.cleanup(); }
});
