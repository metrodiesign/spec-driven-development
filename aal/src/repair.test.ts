// RED in task 2 (proposeWithRepair/validateAgainstSchema throw NotImplemented);
// GREEN in task 3. Proves the bounded repair loop (REQ-1.4/1.5, REQ-3.3).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proposeWithRepair, validateAgainstSchema } from './repair.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { request, TASK_RESULT_SCHEMA } from '../test/helpers.ts';

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
