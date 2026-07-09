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

// ---------------------------------------------------------------------------
// Deploy contract section (REQ-4).
// ---------------------------------------------------------------------------

const DEPLOY = {
  canary_cmd: 'sh deploy/canary.sh',
  observe_cmd: 'sh deploy/health.sh',
  expand_cmd: 'sh deploy/expand.sh',
  rollback_cmd: 'sh deploy/rollback.sh',
  observe: { probes: 5, failure_threshold: 1, interval_ms: 1000 },
};

test('freeze: deploy absent -> unchanged, backward compatible (REQ-4.3)', () => {
  const c = freezeContract(bytesOf(GOAL), GOAL);
  assert.equal(c.deploy, undefined);
});

test('freeze: deploy present -> parsed into camelCase shape (REQ-4.1)', () => {
  const withDeploy = { ...GOAL, deploy: DEPLOY };
  const c = freezeContract(bytesOf(withDeploy), withDeploy);
  assert.deepEqual(c.deploy, {
    canaryCmd: 'sh deploy/canary.sh',
    observeCmd: 'sh deploy/health.sh',
    expandCmd: 'sh deploy/expand.sh',
    rollbackCmd: 'sh deploy/rollback.sh',
    observe: { probes: 5, failureThreshold: 1, intervalMs: 1000 },
  });
});

test('freeze: deploy rejects a missing/empty command (REQ-4.2)', () => {
  for (const key of ['canary_cmd', 'observe_cmd', 'expand_cmd', 'rollback_cmd']) {
    const missing = { ...GOAL, deploy: { ...DEPLOY, [key]: undefined } };
    assert.throws(() => freezeContract(bytesOf(missing), missing), ContractInvalidError, `missing ${key}`);
    const empty = { ...GOAL, deploy: { ...DEPLOY, [key]: '  ' } };
    assert.throws(() => freezeContract(bytesOf(empty), empty), ContractInvalidError, `empty ${key}`);
  }
});

test('freeze: deploy rejects a non-numeric observe field (REQ-4.2)', () => {
  for (const key of ['probes', 'failure_threshold', 'interval_ms']) {
    const bad = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, [key]: '5' } } };
    assert.throws(() => freezeContract(bytesOf(bad), bad), ContractInvalidError, `non-numeric ${key}`);
  }
});

test('freeze: deploy rejects probes < 1 (REQ-4.2, AZ-3)', () => {
  const bad = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, probes: 0 } } };
  assert.throws(() => freezeContract(bytesOf(bad), bad), ContractInvalidError);
});

test('freeze: deploy rejects failure_threshold >= probes (REQ-4.2, AZ-3)', () => {
  const atBound = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, probes: 3, failure_threshold: 3 } } };
  assert.throws(() => freezeContract(bytesOf(atBound), atBound), ContractInvalidError, 'threshold == probes');
  const above = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, probes: 3, failure_threshold: 4 } } };
  assert.throws(() => freezeContract(bytesOf(above), above), ContractInvalidError, 'threshold > probes');
});

test('freeze: deploy accepts the boundary failure_threshold == probes - 1', () => {
  const ok = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, probes: 3, failure_threshold: 2 } } };
  const c = freezeContract(bytesOf(ok), ok);
  assert.equal(c.deploy?.observe.failureThreshold, 2);
});

test('freeze: no network-enabling knob is ever read (REQ-4.5)', () => {
  const withKnob = { ...GOAL, deploy: { ...DEPLOY, allow_network: true } };
  const c = freezeContract(bytesOf(withKnob), withKnob);
  assert.ok(c.deploy !== undefined);
  assert.deepEqual(Object.keys(c.deploy), ['canaryCmd', 'observeCmd', 'expandCmd', 'rollbackCmd', 'observe']);
});

test('freeze: deploy section bytes are covered by the frozen hash (REQ-4.4)', () => {
  const withDeploy = { ...GOAL, deploy: DEPLOY };
  const c = freezeContract(bytesOf(withDeploy), withDeploy);
  assert.equal(contractChanged(bytesOf(withDeploy), c.hash), false, 'identical bytes -> unchanged');
  const mutated = { ...withDeploy, deploy: { ...DEPLOY, canary_cmd: 'sh deploy/other.sh' } };
  assert.equal(
    contractChanged(bytesOf(mutated), c.hash),
    true,
    'a mid-run deploy-section edit is detectable as contract_changed',
  );
});
