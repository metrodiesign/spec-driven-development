// Capstone composition E2E (REQ-11.1) with the FakeAdapter — no quota, CI-safe.
// Proves the full wiring (core + AAL + context + adapter -> runTaskLoop on the
// fixture) reaches REVIEWING and the calibration MATH is computed. The numbers
// here are scripted and are NEVER reported as §12 metrics (REQ-11.2); real
// numbers come from a manual live run (task 11 runbook).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runSupervisedLoop } from './loop-run.ts';
import { FakeAdapter } from 'aal';
import type { TaskContract } from 'core';

const CONTRACT: TaskContract = {
  hash: 'a'.repeat(64),
  goal: { id: 'DEMO-1', title: 'demo', objective: 'edit src/impl.txt so the tests pass' },
  acceptanceCriteria: [{ id: 'AC-1', description: 'src/impl.txt contains correct', golden: true }],
  budget: { maxIterations: 4, maxCostUnits: 500, maxWallclockMs: 60_000 },
  approvalPolicy: [],
  raw: {},
};

test('supervised loop with the FakeAdapter reaches REVIEWING; calibration computed (harness math only)', async () => {
  const out = await runSupervisedLoop({
    contract: CONTRACT,
    adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
    nowMs: 1_000_000,
  });
  assert.equal(out.finalState, 'REVIEWING');
  assert.equal(out.calibration.n, 1);
  assert.equal(out.calibration.heldOutPassRate, 1, 'held-out (golden) passed — SCRIPTED, not a §12 metric');
  assert.equal(out.calibration.reproducibility, 1);
});
