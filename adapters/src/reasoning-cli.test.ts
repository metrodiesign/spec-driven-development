import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { AgentRequest } from 'aal';

import { providerEnvironment, terminateChild } from './control.ts';
import { createReasoningCliAdapter, type ReasoningCliExec } from './reasoning-cli.ts';
import { buildGeminiReviewArgv, buildOpenCodeReviewArgv } from './reasoning-cli-live.ts';

function request(): AgentRequest {
  return {
    requestId: 'r1',
    agentRole: 'reviewer',
    taskContract: { goalId: 'g', title: 'review', objective: 'review', acceptanceCriteria: [] },
    contextBundle: { pieces: [], canaryToken: 'C', stats: { bytes: 0, pieceCount: 0 } },
    manifestRef: 'sha256:m',
    outputSchema: { type: 'object' },
    toolDefs: [],
    budget: { costUnits: 10 },
  };
}

test('reasoning CLI adapter forwards cancellation control, records usage, and replays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reasoning-cli-'));
  let calls = 0;
  let seenSignal: AbortSignal | undefined;
  let seenTimeout: number | undefined;
  const exec: ReasoningCliExec = (input) => {
    calls += 1;
    seenSignal = input.signal;
    seenTimeout = input.timeoutMs;
    return Promise.resolve({
      exitCode: 0,
      responseText: JSON.stringify({ snapshot: {}, findings: [], actionRequests: [] }),
      transcript: '{"event":"done"}',
      stderr: '',
      usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 10 },
      toolUseCount: 0,
    });
  };
  const adapter = createReasoningCliAdapter({
    id: 'gemini-cli',
    lineage: 'google',
    contextWindowTokens: 1000,
    exec,
    cwd: root,
    replayDir: join(root, 'replay'),
    putEvidence: () => 'sha256:evidence',
  });
  const controller = new AbortController();
  try {
    const first = await adapter.send(request(), { signal: controller.signal, timeoutMs: 321 });
    const replay = await adapter.send(request(), { signal: controller.signal, timeoutMs: 321 });
    assert.equal(calls, 1);
    assert.equal(seenSignal, controller.signal);
    assert.equal(seenTimeout, 321);
    assert.equal(first.usage.costUnits, 0.15);
    assert.deepEqual(replay, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider child environment is explicit and never forwards GitHub reporter credentials', () => {
  const env = providerEnvironment({
    PATH: '/bin',
    OPENAI_API_KEY: 'provider-key',
    ANTHROPIC_API_KEY: 'other-provider-key',
    GITHUB_TOKEN: 'reporter-token',
    GH_TOKEN: 'reporter-token-2',
    RANDOM_UNTRUSTED: 'x',
  }, ['OPENAI_API_KEY']);
  assert.deepEqual(env, { PATH: '/bin', OPENAI_API_KEY: 'provider-key' });
});

test('provider child cancellation escalates from SIGTERM to SIGKILL', async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const timer = terminateChild({ kill: (signal) => { signals.push(signal); return true; } }, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearTimeout(timer);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('Gemini and OpenCode argv enforce headless reasoning-only modes', () => {
  const gemini = buildGeminiReviewArgv('PROMPT', 'gemini-x', '/tmp/deny.toml');
  assert.deepEqual(gemini, [
    '--prompt', 'PROMPT',
    '--output-format', 'json',
    '--approval-mode', 'plan',
    '--extensions', 'none',
    '--policy', '/tmp/deny.toml',
    '--model', 'gemini-x',
  ]);
  const opencode = buildOpenCodeReviewArgv('PROMPT', 'deepseek/model');
  assert.deepEqual(opencode, ['run', '--pure', '--format', 'json', '--model', 'deepseek/model', 'PROMPT']);
});
