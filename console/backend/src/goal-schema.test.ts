// platform-phase5-stage2 task 1: schema parity (REQ-6.1) + shape cases (REQ-1.x,
// schema layer of REQ-6.2/6.3). Freeze-layer twins live in core contract.test.ts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { GOAL_SCHEMA, validateGoalShape } from './goal-schema.ts';

const BUDGET = {
  max_iterations_per_task: 8,
  max_hypotheses_per_failure: 3,
  max_total_tasks: 30,
  max_parallel_agents: 3,
  max_cost_units_per_task: 500,
  max_wallclock_per_task_min: 30,
};

/** Minimal valid contract (REQ-1.3's required trio only). */
function minimalGoal(): Record<string, unknown> {
  return {
    goal: { id: 'G-001', title: 'T', objective: 'O' },
    acceptance_criteria: [{ id: 'AC-1', description: 'works', verification: 'pnpm test', golden: true }],
    budget: { ...BUDGET },
  };
}

test('parity: GOAL_SCHEMA is deep-equal to the governance copy at .ai/schemas/goal.schema.json (REQ-6.1)', () => {
  const governance = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', '.ai', 'schemas', 'goal.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepStrictEqual(GOAL_SCHEMA, governance);
});

test('minimal contract (goal + acceptance_criteria + budget) passes; full §11.1 contract passes (REQ-1.1/1.3)', () => {
  assert.deepEqual(validateGoalShape(minimalGoal()), []);

  const full = {
    ...minimalGoal(),
    business_outcomes: ['register', 'login'],
    scope: { include: ['API'], exclude: ['MFA'] },
    constraints: { stack: { backend: 'NestJS', language: 'Rust', runtime: 'tokio' }, forbidden: ['secrets in logs'] },
    quality_gates: {
      ladder: '.ai/policies/gate-ladder.yaml',
      mutation: { min_score_on_changed_files: 80, tier: 'T3' },
      security: '.ai/policies/security-plane.yaml',
      fusion: '.ai/policies/fusion-profiles.yaml',
    },
    approval_policy: { require_human_approval: ['production_deployment'] },
    deploy: {
      canary_cmd: './canary.sh',
      observe_cmd: './probe.sh',
      expand_cmd: './expand.sh',
      rollback_cmd: './rollback.sh',
      observe: { probes: 3, failure_threshold: 1, interval_ms: 1000 },
    },
    risk: 'L2',
    provenance: { spec_path: '.ai/specs/x/requirements.md', requirements_commit: 'abc1234', generated_at: '2026-07-12T00:00:00Z' },
  };
  assert.deepEqual(validateGoalShape(full), []);
});

test('unknown keys are rejected with the offending key named, at top level and nested (REQ-1.2/2.6)', () => {
  const typoTop = { ...minimalGoal(), aproval_policy: { require_human_approval: [] } };
  const errs = validateGoalShape(typoTop);
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /aproval_policy/);

  const typoNested = minimalGoal();
  (typoNested['budget'] as Record<string, unknown>)['max_iteration_per_task'] = 8;
  assert.match(validateGoalShape(typoNested).join('\n'), /\/budget.*max_iteration_per_task/);

  const acExtra = minimalGoal();
  ((acExtra['acceptance_criteria'] as Record<string, unknown>[])[0]!)['note'] = 'x';
  assert.match(validateGoalShape(acExtra).join('\n'), /acceptance_criteria\/0.*\(note\)/);
});

test('budget: all six keys required, each an integer >= 1 — missing/zero/negative/fractional/string all rejected with a named path (REQ-1.4, schema layer of REQ-6.2)', () => {
  for (const key of Object.keys(BUDGET)) {
    const missing = minimalGoal();
    delete (missing['budget'] as Record<string, unknown>)[key];
    assert.match(validateGoalShape(missing).join('\n'), /\/budget/, `missing ${key} must fail`);
    assert.match(validateGoalShape(missing).join('\n'), new RegExp(key), `missing ${key} must be named`);

    for (const bad of [0, -1, 2.5, '8']) {
      const wrong = minimalGoal();
      (wrong['budget'] as Record<string, unknown>)[key] = bad;
      const errs = validateGoalShape(wrong);
      assert.match(errs.join('\n'), new RegExp(`/budget/${key}`), `${key}=${JSON.stringify(bad)} must fail at its path`);
    }
  }
});

test('risk: every valid level passes, anything else fails; absent passes (REQ-1.5, schema layer of REQ-6.3)', () => {
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
    assert.deepEqual(validateGoalShape({ ...minimalGoal(), risk: level }), [], `${level} must pass`);
  }
  for (const bad of ['l2', 'TODO', 'L5', 2]) {
    assert.match(validateGoalShape({ ...minimalGoal(), risk: bad }).join('\n'), /\/risk/, `${JSON.stringify(bad)} must fail`);
  }
  assert.deepEqual(validateGoalShape(minimalGoal()), [], 'absent risk is valid — freeze defaults it to L2');
});

test('goal inner shape: id required and non-empty (REQ-1.9)', () => {
  const noId = minimalGoal();
  delete (noId['goal'] as Record<string, unknown>)['id'];
  assert.match(validateGoalShape(noId).join('\n'), /\/goal/);

  const emptyId = minimalGoal();
  (emptyId['goal'] as Record<string, unknown>)['id'] = '';
  assert.match(validateGoalShape(emptyId).join('\n'), /\/goal\/id/);
});

test('acceptance_criteria: empty array rejected (minItems), item shape enforced (REQ-1.7)', () => {
  assert.match(validateGoalShape({ ...minimalGoal(), acceptance_criteria: [] }).join('\n'), /\/acceptance_criteria/);

  const noDesc = { ...minimalGoal(), acceptance_criteria: [{ id: 'AC-1' }] };
  assert.match(validateGoalShape(noDesc).join('\n'), /\/acceptance_criteria\/0/);

  const badGolden = { ...minimalGoal(), acceptance_criteria: [{ id: 'AC-1', description: 'd', golden: 'yes' }] };
  assert.match(validateGoalShape(badGolden).join('\n'), /\/acceptance_criteria\/0\/golden/);
});

test('constraints.stack is the one free-form exception (string map); non-string values fail (REQ-1.2)', () => {
  const ok = { ...minimalGoal(), constraints: { stack: { anything_at_all: 'v', another: 'w' } } };
  assert.deepEqual(validateGoalShape(ok), []);

  const badValue = { ...minimalGoal(), constraints: { stack: { backend: 42 } } };
  assert.match(validateGoalShape(badValue).join('\n'), /\/constraints\/stack\/backend/);

  const badForbidden = { ...minimalGoal(), constraints: { forbidden: [42] } };
  assert.match(validateGoalShape(badForbidden).join('\n'), /\/constraints\/forbidden\/0/);
});

test('scope / approval_policy / quality_gates shapes (REQ-1.9)', () => {
  assert.match(
    validateGoalShape({ ...minimalGoal(), scope: { include: [42] } }).join('\n'),
    /\/scope\/include\/0/,
  );
  assert.match(
    validateGoalShape({ ...minimalGoal(), approval_policy: {} }).join('\n'),
    /\/approval_policy/,
  );
  assert.match(
    validateGoalShape({ ...minimalGoal(), quality_gates: { mutation: { tier: 3 } } }).join('\n'),
    /\/quality_gates\/mutation\/tier/,
  );
});

test('provenance: optional, but when present requires all three string fields (REQ-1.6)', () => {
  const missing = { ...minimalGoal(), provenance: { spec_path: 'x', requirements_commit: 'y' } };
  assert.match(validateGoalShape(missing).join('\n'), /\/provenance/);
});

test('deploy: four command strings (non-empty) + observe required; extra observe key rejected (REQ-1.8)', () => {
  const emptyCmd = {
    ...minimalGoal(),
    deploy: {
      canary_cmd: '',
      observe_cmd: './p.sh',
      expand_cmd: './e.sh',
      rollback_cmd: './r.sh',
      observe: { probes: 3, failure_threshold: 1, interval_ms: 500 },
    },
  };
  assert.match(validateGoalShape(emptyCmd).join('\n'), /\/deploy\/canary_cmd/);

  const noObserve = {
    ...minimalGoal(),
    deploy: { canary_cmd: 'c', observe_cmd: 'o', expand_cmd: 'e', rollback_cmd: 'r' },
  };
  assert.match(validateGoalShape(noObserve).join('\n'), /\/deploy/);

  const observeExtra = {
    ...minimalGoal(),
    deploy: {
      canary_cmd: 'c',
      observe_cmd: 'o',
      expand_cmd: 'e',
      rollback_cmd: 'r',
      observe: { probes: 3, failure_threshold: 1, interval_ms: 500, network: true },
    },
  };
  assert.match(validateGoalShape(observeExtra).join('\n'), /\/deploy\/observe.*\(network\)/);

  // Cross-field rule (failure_threshold < probes) is deliberately NOT here — freeze owns it.
  const crossField = {
    ...minimalGoal(),
    deploy: {
      canary_cmd: 'c',
      observe_cmd: 'o',
      expand_cmd: 'e',
      rollback_cmd: 'r',
      observe: { probes: 1, failure_threshold: 5, interval_ms: 500 },
    },
  };
  assert.deepEqual(validateGoalShape(crossField), []);
});

test('allErrors: multiple independent defects are all reported, not just the first (REQ-2.2 groundwork)', () => {
  const doubly = minimalGoal();
  (doubly['budget'] as Record<string, unknown>)['max_total_tasks'] = 0;
  (doubly as Record<string, unknown>)['risk'] = 'TODO';
  const errs = validateGoalShape(doubly);
  assert.ok(errs.some((e) => e.includes('/budget/max_total_tasks')), 'budget error present');
  assert.ok(errs.some((e) => e.includes('/risk')), 'risk error present');
});

test('non-object roots fail with the root path (REQ-1.1)', () => {
  for (const root of [[], 'goal', null, 42]) {
    assert.match(validateGoalShape(root).join('\n'), /^\/: /);
  }
});
