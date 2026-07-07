import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { decideLiveRun, loadGoalContract } from './loop-cli.ts';

test('live guard: default is the CI-safe stub adapter', () => {
  assert.deepEqual(decideLiveRun({ live: false, ciEnv: true, isTTY: false }), { action: 'stub' });
});

test('live guard: --live REFUSES in CI (REQ-11.3, REQ-11.2)', () => {
  const d = decideLiveRun({ live: true, ciEnv: true, isTTY: true });
  assert.equal(d.action, 'refuse');
});

test('live guard: --live REFUSES without a TTY', () => {
  const d = decideLiveRun({ live: true, ciEnv: false, isTTY: false });
  assert.equal(d.action, 'refuse');
});

test('live guard: --live on an interactive TTY requires a typed confirmation phrase', () => {
  const d = decideLiveRun({ live: true, ciEnv: false, isTTY: true });
  assert.equal(d.action, 'confirm');
});

test('goal.yaml parsed at the edge, frozen by raw-byte hash in core (REQ-8.1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-'));
  const p = join(root, 'goal.yaml');
  writeFileSync(
    p,
    [
      'goal: { id: DEMO-1, title: Demo, objective: make it pass }',
      'acceptance_criteria:',
      '  - { id: AC-1, description: impl correct, golden: true }',
      'budget: { max_iterations_per_task: 8, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 }',
      'approval_policy: { require_human_approval: [auth_policy_change] }',
    ].join('\n'),
  );
  try {
    const c = loadGoalContract(p);
    assert.equal(c.goal.id, 'DEMO-1');
    assert.equal(c.budget.maxIterations, 8);
    assert.match(c.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(c.approvalPolicy, ['auth_policy_change']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
