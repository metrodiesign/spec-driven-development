// RED in task 2 (proposeWithRepair/validateAgainstSchema throw NotImplemented);
// GREEN in task 3. Proves the bounded repair loop (REQ-1.4/1.5, REQ-3.3).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proposeWithRepair, validateAgainstSchema } from './repair.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { request, TASK_RESULT_SCHEMA } from '../test/helpers.ts';
import type { AdapterInterface, AgentResponse } from './protocol.ts';

function usageAdapter(costUnits: number): AdapterInterface {
  const response: AgentResponse = {
    structuredResult: { claim: 'WORKING', actionRequests: [] },
    actionRequests: [],
    usage: { costUnits, raw: {} },
    rawTranscriptRef: null,
    adapterMeta: { adapterId: 'usage-fixture', modelVersion: 'v', interactive: false, toolUseCount: 0 },
  };
  return {
    manifest: () => ({ adapterId: 'usage-fixture', structuredOutput: true, toolCalling: false, contextWindowTokens: 1000, executionBackend: false, determinism: 'none' }),
    async send() { return response; },
  };
}

test('validateAgainstSchema flags a missing required field', () => {
  const bad = validateAgainstSchema({ summary: 'x' }, TASK_RESULT_SCHEMA);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length >= 1);
  const good = validateAgainstSchema(
    { claim: 'WORKING', actionRequests: [] },
    TASK_RESULT_SCHEMA,
  );
  assert.equal(good.valid, true);
});

test('repair loop: compliant adapter validates on round 0 (no repair needed)', async () => {
  const adapter = new FakeAdapter({ behavior: 'compliant' });
  const out = await proposeWithRepair(adapter, request({ objective: '[probe:P2]' }), 2);
  assert.equal(out.valid, true);
  assert.equal(out.repairRounds, 0);
});

test('repair loop: schema_fail_first recovers within the bound', async () => {
  const adapter = new FakeAdapter({ behavior: 'schema_fail_first' });
  const out = await proposeWithRepair(adapter, request({ objective: '[probe:P3]' }), 2);
  assert.equal(out.valid, true);
  assert.ok(out.repairRounds >= 1 && out.repairRounds <= 2);
});

test('repair loop: ignore_schema exhausts the bound and fails structured', async () => {
  const adapter = new FakeAdapter({ behavior: 'ignore_schema' });
  const out = await proposeWithRepair(adapter, request({ objective: '[probe:P3]' }), 2);
  assert.equal(out.valid, false);
  assert.equal(out.repairRounds, 2);
  assert.ok(out.errors.length >= 1);
});

test('totalUsage sums cost across ALL repair rounds, not just the last (backlog #1, REQ-6.1)', async () => {
  const adapter = new FakeAdapter({ behavior: 'schema_fail_first' });
  const out = await proposeWithRepair(adapter, request({ objective: '[probe:P3]' }), 2);
  assert.equal(out.valid, true);
  assert.equal(out.repairRounds, 1);
  assert.equal(out.response.usage.costUnits, 2, 'response.usage is only the final round');
  assert.equal(out.totalUsage.costUnits, 4, 'round-0 (invalid, 2) + round-1 (valid, 2) both charged');
});

test('repair rejects negative and non-finite response usage as invalid_response (REQ-7.1)', async () => {
  for (const costUnits of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assert.rejects(
      proposeWithRepair(usageAdapter(costUnits), request({}), 0),
      (error: unknown) => error instanceof Error && 'kind' in error && error.kind === 'invalid_response',
      `invalid usage ${String(costUnits)} must not enter schema repair`,
    );
  }
});

test('repair rejects usage aggregate overflow without returning a charged total (REQ-7.3/7.5)', async () => {
  let sends = 0;
  const adapter: AdapterInterface = {
    manifest: () => ({ adapterId: 'overflow-fixture', structuredOutput: true, toolCalling: false, contextWindowTokens: 1000, executionBackend: false, determinism: 'none' }),
    async send() {
      sends += 1;
      return {
        structuredResult: { invalid: true },
        actionRequests: [],
        usage: { costUnits: Number.MAX_VALUE, raw: {} },
        rawTranscriptRef: null,
        adapterMeta: { adapterId: 'overflow-fixture', modelVersion: 'v', interactive: false, toolUseCount: 0 },
      } satisfies AgentResponse;
    },
  };
  await assert.rejects(
    proposeWithRepair(adapter, request({}), 1),
    (error: unknown) => error instanceof Error && 'kind' in error && error.kind === 'invalid_response' && /overflow/i.test(error.message),
  );
  assert.equal(sends, 2, 'the second repair response is where aggregate overflow is rejected');
});
