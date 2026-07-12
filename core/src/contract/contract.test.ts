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
    max_hypotheses_per_failure: 3,
    max_total_tasks: 30,
    max_parallel_agents: 3,
    max_cost_units_per_task: 500,
    max_wallclock_per_task_min: 30,
  },
  approval_policy: { require_human_approval: ['auth_policy_change'] },
  some_future_key: { nested: true },
};

const BUDGET_KEYS = [
  'max_iterations_per_task',
  'max_hypotheses_per_failure',
  'max_total_tasks',
  'max_parallel_agents',
  'max_cost_units_per_task',
  'max_wallclock_per_task_min',
] as const;

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

// ---------------------------------------------------------------------------
// Typed budget — all six keys (phase5-stage2 REQ-3.1/3.2, freeze layer of 6.2).
// ---------------------------------------------------------------------------

test('freeze carries the three previously-dropped budget caps as typed values (REQ-3.1)', () => {
  const c = freezeContract(bytesOf(GOAL), GOAL);
  assert.equal(c.budget.maxHypothesesPerFailure, 3);
  assert.equal(c.budget.maxTotalTasks, 30);
  assert.equal(c.budget.maxParallelAgents, 3);
});

test('freeze rejects each missing budget key, naming it (REQ-3.2)', () => {
  for (const key of BUDGET_KEYS) {
    const budget: Record<string, unknown> = { ...GOAL.budget };
    delete budget[key];
    const goal = { ...GOAL, budget };
    assert.throws(
      () => freezeContract(bytesOf(goal), goal),
      (e: unknown) => e instanceof ContractInvalidError && e.message.includes(key),
      `missing ${key} must name the key`,
    );
  }
});

test('freeze rejects zero / negative / fractional / string budget values (REQ-3.2, freeze layer of 6.2)', () => {
  for (const key of BUDGET_KEYS) {
    for (const bad of [0, -1, 2.5, '8']) {
      const goal = { ...GOAL, budget: { ...GOAL.budget, [key]: bad } };
      assert.throws(
        () => freezeContract(bytesOf(goal), goal),
        (e: unknown) => e instanceof ContractInvalidError && e.message.includes(key),
        `${key}=${JSON.stringify(bad)} must be rejected`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Typed risk (phase5-stage2 REQ-3.3/3.4/3.5, freeze layer of 6.3).
// ---------------------------------------------------------------------------

test('freeze: risk absent -> L2 default (REQ-3.3)', () => {
  const c = freezeContract(bytesOf(GOAL), GOAL);
  assert.equal(c.risk, 'L2');
});

test('freeze: every valid risk level round-trips (REQ-3.5)', () => {
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4'] as const) {
    const goal = { ...GOAL, risk: level };
    assert.equal(freezeContract(bytesOf(goal), goal).risk, level);
  }
});

test('freeze: invalid risk is rejected, never silently downgraded (REQ-3.4)', () => {
  for (const bad of ['l2', 'TODO', 'L5', 2, null]) {
    const goal = { ...GOAL, risk: bad };
    assert.throws(
      () => freezeContract(bytesOf(goal), goal),
      (e: unknown) => e instanceof ContractInvalidError && e.message.includes('risk'),
      `risk=${JSON.stringify(bad)} must be rejected`,
    );
  }
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

test('freeze: deploy rejects a NEGATIVE failure_threshold (PR #50 review — `0 > -1` rolls a healthy deploy back)', () => {
  const neg = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, probes: 3, failure_threshold: -1 } } };
  assert.throws(() => freezeContract(bytesOf(neg), neg), ContractInvalidError);
});

test('freeze: deploy rejects a NON-INTEGER probes / failure_threshold (PR #50 review)', () => {
  const fracProbes = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, probes: 2.5 } } };
  assert.throws(() => freezeContract(bytesOf(fracProbes), fracProbes), ContractInvalidError, 'fractional probes');
  const fracThreshold = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, probes: 5, failure_threshold: 1.5 } } };
  assert.throws(() => freezeContract(bytesOf(fracThreshold), fracThreshold), ContractInvalidError, 'fractional threshold');
});

test('freeze: deploy accepts failure_threshold == 0 (a single failing probe rolls back)', () => {
  const zero = { ...GOAL, deploy: { ...DEPLOY, observe: { ...DEPLOY.observe, probes: 3, failure_threshold: 0 } } };
  const c = freezeContract(bytesOf(zero), zero);
  assert.equal(c.deploy?.observe.failureThreshold, 0);
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

// ---------------------------------------------------------------------------
// Provenance contract section (phase5-stage3 REQ-3).
// ---------------------------------------------------------------------------

const PROVENANCE = {
  spec_path: '.ai/specs/fixture-feat/requirements.md',
  requirements_commit: 'abc1234',
  requirements_sha256: 'deadbeef',
  generated_at: '2026-07-12T00:00:00Z',
};

test('freeze: provenance absent -> undefined, GOAL fixture still freezes unchanged (REQ-3.3)', () => {
  const c = freezeContract(bytesOf(GOAL), GOAL);
  assert.equal(c.provenance, undefined);
});

test('freeze: provenance 4-field -> typed camelCase surface (REQ-3.1/3.2)', () => {
  const withProv = { ...GOAL, provenance: PROVENANCE };
  const c = freezeContract(bytesOf(withProv), withProv);
  assert.deepEqual(c.provenance, {
    specPath: '.ai/specs/fixture-feat/requirements.md',
    requirementsCommit: 'abc1234',
    requirementsSha256: 'deadbeef',
    generatedAt: '2026-07-12T00:00:00Z',
  });
});

test('freeze: provenance 3-field (no requirements_sha256) -> field absent on the typed surface, others still typed (REQ-3.1/3.2)', () => {
  const { requirements_sha256: _drop, ...threeField } = PROVENANCE;
  const withProv = { ...GOAL, provenance: threeField };
  const c = freezeContract(bytesOf(withProv), withProv);
  assert.deepEqual(c.provenance, {
    specPath: '.ai/specs/fixture-feat/requirements.md',
    requirementsCommit: 'abc1234',
    generatedAt: '2026-07-12T00:00:00Z',
  });
  assert.ok(!('requirementsSha256' in (c.provenance ?? {})), 'key absent, not merely undefined (exactOptionalPropertyTypes)');
});

test('freeze: provenance rejects a non-object (REQ-3.4)', () => {
  for (const bad of ['x', 42, [], null]) {
    const withProv = { ...GOAL, provenance: bad };
    assert.throws(
      () => freezeContract(bytesOf(withProv), withProv),
      (e: unknown) => e instanceof ContractInvalidError && e.message.includes('provenance'),
      `provenance=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('freeze: provenance rejects a missing/empty required field, naming the path (REQ-3.4)', () => {
  for (const key of ['spec_path', 'requirements_commit', 'generated_at']) {
    const missing = { ...GOAL, provenance: { ...PROVENANCE, [key]: undefined } };
    assert.throws(
      () => freezeContract(bytesOf(missing), missing),
      (e: unknown) => e instanceof ContractInvalidError && e.message.includes(`provenance.${key}`),
      `missing ${key} must name provenance.${key}`,
    );

    const empty = { ...GOAL, provenance: { ...PROVENANCE, [key]: '   ' } };
    assert.throws(
      () => freezeContract(bytesOf(empty), empty),
      (e: unknown) => e instanceof ContractInvalidError && e.message.includes(`provenance.${key}`),
      `empty ${key} must name provenance.${key}`,
    );
  }
});

test('freeze: provenance rejects a wrong-type requirements_sha256 when present (REQ-3.4)', () => {
  const withBad = { ...GOAL, provenance: { ...PROVENANCE, requirements_sha256: 12345 } };
  assert.throws(
    () => freezeContract(bytesOf(withBad), withBad),
    (e: unknown) => e instanceof ContractInvalidError && e.message.includes('provenance.requirements_sha256'),
  );
});

test('freeze: an unknown provenance key is NOT rejected — that stays at the ajv edge, never freeze (A5, REQ-3.5)', () => {
  const withUnknown = { ...GOAL, provenance: { ...PROVENANCE, extra_field: 'nope' } };
  const c = freezeContract(bytesOf(withUnknown), withUnknown);
  assert.equal(c.provenance?.specPath, PROVENANCE.spec_path);
});

test('freeze: provenance section bytes are covered by the frozen hash', () => {
  const withProv = { ...GOAL, provenance: PROVENANCE };
  const c = freezeContract(bytesOf(withProv), withProv);
  assert.equal(contractChanged(bytesOf(withProv), c.hash), false, 'identical bytes -> unchanged');
  const mutated = { ...withProv, provenance: { ...PROVENANCE, requirements_commit: 'def5678' } };
  assert.equal(
    contractChanged(bytesOf(mutated), c.hash),
    true,
    'a mid-run provenance-section edit is detectable as contract_changed',
  );
});
