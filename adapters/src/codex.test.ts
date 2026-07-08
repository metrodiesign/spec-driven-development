// Codex adapter (REQ-2). Injected FAKE ExecFn -> CI spends zero quota. The live
// spawn path (real codex exec) is verified in the LIVE task; here the argv builder is
// snapshot-tested with no real spawn.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createCodexAdapter,
  parseCodexEvents,
  sumCodexUsage,
  DEFAULT_KILL_TIMEOUT_MS,
  type CodexEvent,
  type ExecFn,
} from './codex.ts';
import { buildCodexArgv, CODEX_STDIO } from './codex-live.ts';
import { AdapterError } from 'aal';
import type { AgentRequest } from 'aal';

const COMPLIANT_MSG = JSON.stringify({
  claim: 'READY_FOR_VERIFICATION',
  actionRequests: [{ type: 'WRITE_FILE', path: 'src/impl.txt', content: 'correct\n' }],
});

const COMPLIANT_EVENTS: CodexEvent[] = [
  { type: 'thread.started' },
  { type: 'turn.started' },
  { type: 'item.completed' },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 30 } },
];

function fakeExec(opts: { lastMessage?: string; events?: CodexEvent[]; exitCode?: number; stderr?: string; onCall?: () => void; throwErr?: Error } = {}): ExecFn {
  return () => {
    opts.onCall?.();
    if (opts.throwErr) return Promise.reject(opts.throwErr);
    return Promise.resolve({
      exitCode: opts.exitCode ?? 0,
      lastMessage: opts.lastMessage ?? COMPLIANT_MSG,
      events: opts.events ?? COMPLIANT_EVENTS,
      stderr: opts.stderr ?? '',
    });
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

function harness(exec: ExecFn, model: string | undefined = 'gpt-x') {
  const root = mkdtempSync(join(tmpdir(), 'codex-'));
  const blobs = new Map<string, string>();
  const adapter = createCodexAdapter({
    id: 'codex',
    ...(model !== undefined ? { model } : {}),
    exec,
    cwd: root,
    replayDir: join(root, 'replay'),
    putEvidence: (c) => { const ref = `blob://${blobs.size}`; blobs.set(ref, c); return ref; },
    costUnitsPer1k: 1,
  });
  return { adapter, blobs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('createCodexAdapter implements AdapterInterface with an injectable ExecFn (REQ-2.1)', () => {
  const h = harness(fakeExec());
  try {
    assert.equal(typeof h.adapter.manifest, 'function');
    assert.equal(typeof h.adapter.send, 'function');
  } finally { h.cleanup(); }
});

test('manifest: structuredOutput true, toolCalling false, executionBackend false, determinism none, lineage openai (REQ-2.2)', () => {
  const h = harness(fakeExec());
  try {
    const m = h.adapter.manifest();
    assert.equal(m.structuredOutput, true);
    assert.equal(m.toolCalling, false);
    assert.equal(m.executionBackend, false);
    assert.equal(m.determinism, 'none');
    assert.equal(m.lineage, 'openai');
  } finally { h.cleanup(); }
});

test('maps last message -> structuredResult + normalized actions; usage summation excludes cached (REQ-2.3/2.5/2.6)', async () => {
  const h = harness(fakeExec());
  try {
    const resp = await h.adapter.send(req());
    assert.equal((resp.structuredResult as { claim?: string }).claim, 'READY_FOR_VERIFICATION');
    assert.equal(resp.actionRequests.length, 1);
    assert.equal(resp.actionRequests[0]?.type, 'WRITE_FILE');
    // inline content minted to a contentRef (REQ-1.4 through the codex path)
    assert.ok((resp.actionRequests[0] as { contentRef?: string }).contentRef?.startsWith('blob://'));
    // (100 + 50 + 30)/1000 = 0.18 ; cached (20) is NOT billed (REQ-2.3)
    assert.equal(resp.usage.costUnits, 0.18);
    assert.equal(resp.usage.raw['cached_input_tokens'], 20);
    assert.equal(resp.adapterMeta.modelVersion, 'gpt-x', 'requested model recorded (REQ-2.6)');
    assert.equal(resp.adapterMeta.toolUseCount, 0, 'propose-only: no tool_use on the wire (P6)');
    // The JSONL events ARE the transcript (REQ-2.5).
    assert.notEqual(resp.rawTranscriptRef, null);
    assert.equal(h.blobs.get(String(resp.rawTranscriptRef)), COMPLIANT_EVENTS.map((e) => JSON.stringify(e)).join('\n'));
  } finally { h.cleanup(); }
});

test('durable replay: same requestId served from disk, ExecFn called once (REQ-2.4/P8)', async () => {
  let calls = 0;
  const h = harness(fakeExec({ onCall: () => { calls += 1; } }));
  try {
    const r1 = await h.adapter.send(req('same'));
    const r2 = await h.adapter.send(req('same'));
    assert.equal(calls, 1, 'second send served from durable replay — ExecFn not re-invoked');
    assert.deepEqual(r1, r2);
  } finally { h.cleanup(); }
});

test('non-zero exit with rate-limit stderr -> AdapterError quota_limited, no self-retry (REQ-2.7)', async () => {
  let calls = 0;
  const h = harness(fakeExec({ exitCode: 1, stderr: 'error: 429 rate limit exceeded', onCall: () => { calls += 1; } }));
  try {
    await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'quota_limited');
    assert.equal(calls, 1, 'never self-retries');
  } finally { h.cleanup(); }
});

test('non-zero exit with a generic stderr but a quota-shaped --json error event -> classifies quota_limited, not transport (Codex review, PR #47)', async () => {
  const h = harness(fakeExec({
    exitCode: 1,
    stderr: 'Reading additional input from stdin...', // codex-cli's generic startup chatter, no quota signal
    events: [
      { type: 'thread.started' },
      { type: 'turn.started' },
      { type: 'error', message: '429 rate limit exceeded' },
    ],
  }));
  try {
    await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'quota_limited');
  } finally { h.cleanup(); }
});

test('non-zero exit with a GENERIC --json error event but a quota/auth-shaped stderr -> classifies quota_limited/auth_unavailable, not transport (Codex review, PR #48)', async () => {
  const quota = harness(fakeExec({
    exitCode: 1,
    stderr: 'error: 429 rate limit exceeded', // the ONLY place the real signal lives
    events: [
      { type: 'thread.started' },
      { type: 'turn.started' },
      { type: 'error', message: 'internal error' }, // present, but says nothing quota/auth-shaped
    ],
  }));
  try {
    await assert.rejects(quota.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'quota_limited');
  } finally { quota.cleanup(); }

  const auth = harness(fakeExec({
    exitCode: 1,
    stderr: 'not logged in: run codex login',
    events: [{ type: 'error', message: 'internal error' }],
  }));
  try {
    await assert.rejects(auth.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'auth_unavailable');
  } finally { auth.cleanup(); }
});

test('non-zero exit with auth stderr -> auth_unavailable; unmatched stderr -> transport (REQ-2.7/1.5)', async () => {
  const auth = harness(fakeExec({ exitCode: 1, stderr: 'not logged in: run codex login' }));
  try {
    await assert.rejects(auth.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'auth_unavailable');
  } finally { auth.cleanup(); }

  const other = harness(fakeExec({ exitCode: 2, stderr: 'segfault' }));
  try {
    await assert.rejects(other.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'transport');
  } finally { other.cleanup(); }
});

test('an ExecFn that throws is classified into a typed AdapterError (REQ-2.7)', async () => {
  const h = harness(fakeExec({ throwErr: new Error('ECONNRESET') }));
  try {
    await assert.rejects(h.adapter.send(req()), (e: unknown) => e instanceof AdapterError && (e as AdapterError).kind === 'transport');
  } finally { h.cleanup(); }
});

test('codex adapter exposes no healthProbe — breaker is error-rate only (REQ-2.10)', () => {
  const h = harness(fakeExec());
  try {
    assert.equal((h.adapter as { healthProbe?: unknown }).healthProbe, undefined);
  } finally { h.cleanup(); }
});

// --- Pure helpers backing the parsing (REQ-2.3) ---

test('parseCodexEvents parses JSONL and skips blank/garbage lines', () => {
  const stdout = `${JSON.stringify({ type: 'turn.started' })}\n\nnot json\n${JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 5 } })}\n`;
  const events = parseCodexEvents(stdout);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, 'turn.completed');
});

test('sumCodexUsage sums input/output/reasoning across events; cached tracked separately', () => {
  const u = sumCodexUsage(COMPLIANT_EVENTS);
  assert.deepEqual(u, { input: 100, cached: 20, output: 50, reasoning: 30 });
});

// --- Live argv builder (REQ-2.8) — snapshot, NO real spawn ---

test('buildCodexArgv emits the SPIKE-6 flags with the prompt last; stdin is ignored (REQ-2.8)', () => {
  const argv = buildCodexArgv('THE PROMPT', { model: 'gpt-x', schemaPath: '/tmp/s.json', outPath: '/tmp/o.json' });
  assert.deepEqual(argv, [
    'exec',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--output-schema', '/tmp/s.json',
    '-o', '/tmp/o.json',
    '--json',
    '-m', 'gpt-x',
    'THE PROMPT',
  ]);
  // No model -> no -m flag.
  const noModel = buildCodexArgv('P', { schemaPath: '/s', outPath: '/o' });
  assert.equal(noModel.includes('-m'), false);
  assert.equal(noModel.at(-1), 'P', 'prompt is the final positional');
  // stdin ignored (SPIKE-6 #1: an open stdin hangs forever).
  assert.deepEqual([...CODEX_STDIO], ['ignore', 'pipe', 'pipe']);
});

test('kill timeout default is the recorded 600000ms calibration knob (REQ-2.9)', () => {
  assert.equal(DEFAULT_KILL_TIMEOUT_MS, 600_000);
});
