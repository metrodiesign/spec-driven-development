// RED in task 4 (contract fns throw NotImplemented) -> GREEN same task.
// Proves REQ-8: validate pre-parsed object, freeze by raw-byte hash, mid-run
// mutation detection, unknown-key preservation, budget mapping.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contractChanged, ContractInvalidError, freezeContract } from './contract.ts';

const GOAL = {
  goal: { id: 'AUTH-001', title: 'Auth', objective: 'email/password auth' },
  acceptance_criteria: [
    { id: 'AC-001', description: 'valid users log in', verification: 'pnpm test', golden: true },
  ],
  budget: {
    max_iterations_per_task: 8,
    max_cost_units_per_task: 500,
    max_wallclock_per_task_min: 30,
  },
  approval_policy: { require_human_approval: ['auth_policy_change'] },
  some_future_key: { nested: true },
};

function bytesOf(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

test('freeze parses the object, maps budget, preserves unknown keys', () => {
  const raw = bytesOf(GOAL);
  const c = freezeContract(raw, GOAL);
  assert.equal(c.goal.id, 'AUTH-001');
  assert.equal(c.acceptanceCriteria[0]?.id, 'AC-001');
  assert.equal(c.budget.maxIterations, 8);
  assert.equal(c.budget.maxCostUnits, 500);
  assert.equal(c.budget.maxWallclockMs, 30 * 60_000);
  assert.deepEqual(c.approvalPolicy, ['auth_policy_change']);
  assert.deepEqual(c.raw['some_future_key'], { nested: true });
  assert.match(c.hash, /^[0-9a-f]{64}$/);
});

test('freeze rejects a contract missing required fields', () => {
  assert.throws(() => freezeContract(bytesOf({ goal: {} }), { goal: {} }), ContractInvalidError);
});

test('contractChanged detects a mid-run byte mutation', () => {
  const c = freezeContract(bytesOf(GOAL), GOAL);
  assert.equal(contractChanged(bytesOf(GOAL), c.hash), false, 'identical bytes -> unchanged');
  const mutated = { ...GOAL, goal: { ...GOAL.goal, objective: 'changed' } };
  assert.equal(contractChanged(bytesOf(mutated), c.hash), true, 'mutation detected');
});
