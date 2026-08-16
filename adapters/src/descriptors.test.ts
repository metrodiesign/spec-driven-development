import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeAnthropicAdapter, describeCodexAdapter, describeReasoningCliAdapter } from './descriptors.ts';
import { createAnthropicAdapter } from './anthropic.ts';
import { createCodexAdapter } from './codex.ts';
import { createReasoningCliAdapter } from './reasoning-cli.ts';

const common = { cwd: '/tmp', replayDir: '/tmp/replay', putEvidence: () => 'blob://x' };

test('pure descriptors are the same manifest source used by live adapter factories', () => {
  const anthropic = createAnthropicAdapter({
    ...common,
    id: 'claude-test',
    systemPrompt: 'system',
    query: async function* () {},
  });
  assert.deepEqual(anthropic.manifest(), describeAnthropicAdapter('claude-test').manifest);

  const codex = createCodexAdapter({ ...common, id: 'codex-test', exec: async () => ({ exitCode: 0, lastMessage: '{}', events: [], stderr: '' }) });
  assert.deepEqual(codex.manifest(), describeCodexAdapter('codex-test').manifest);

  const reasoningInput = { id: 'reasoning', lineage: 'family', contextWindowTokens: 123_456 };
  const reasoning = createReasoningCliAdapter({
    ...common,
    ...reasoningInput,
    exec: async () => ({ exitCode: 0, responseText: '{}', transcript: '', stderr: '', usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, toolUseCount: 0 }),
  });
  assert.deepEqual(reasoning.manifest(), describeReasoningCliAdapter(reasoningInput).manifest);
});
