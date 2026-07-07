// Proves the calibration harness MATH (REQ-11.2) — computation only; these are
// not §12 metrics.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeCalibration } from './calibration.ts';

test('held-out pass rate + range + reproducibility', () => {
  const r = computeCalibration({ heldOut: [true, true, false, true], reruns: [true, true] });
  assert.equal(r.n, 4);
  assert.equal(r.heldOutPassRate, 0.75);
  assert.ok(r.range[0] <= 0.75 && r.range[1] >= 0.75, 'point estimate inside the range');
  assert.equal(r.reproducibility, 1);
});

test('empty inputs are safe (no runs yet)', () => {
  const r = computeCalibration({ heldOut: [], reruns: [] });
  assert.equal(r.heldOutPassRate, 0);
  assert.equal(r.reproducibility, 1);
});
