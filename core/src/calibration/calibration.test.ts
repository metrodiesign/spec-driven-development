// Proves the calibration harness MATH (REQ-11.2) — computation only; these are
// not §12 metrics.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeCalibration, computeFusionCalibration, computeLessonHitRate } from './calibration.ts';
import type { PlatformEvent } from '../types.ts';

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

test('fusion uplift = fused rate − single rate, reported as an interval band (REQ-11.1)', () => {
  // single: 2/4 pass; fused: 3/4 pass -> uplift +0.25, band = 1/√4 = 0.5.
  const r = computeFusionCalibration({
    single: [true, false, true, false],
    fused: [true, true, true, false],
    panelDisagreements: [0.5, 0.5],
  });
  assert.equal(r.n, 4);
  assert.equal(r.uplift, 0.25);
  assert.ok(r.upliftRange[0] <= 0.25 && r.upliftRange[1] >= 0.25, 'point estimate inside the interval');
  assert.deepEqual(r.upliftRange, [-0.25, 0.75]);
});

test('fusion uplift can be negative (fusion can hurt) and clamps to the valid range', () => {
  // single all pass, fused all fail -> uplift -1; band = 1/√2 -> low clamps at -1.
  const r = computeFusionCalibration({ single: [true, true], fused: [false, false], panelDisagreements: [] });
  assert.equal(r.uplift, -1);
  assert.equal(r.upliftRange[0], -1, 'clamped to the valid uplift floor');
});

test('decorrelation is the mean pairwise panel disagreement — a measurement (REQ-11.2)', () => {
  const r = computeFusionCalibration({ single: [true], fused: [true], panelDisagreements: [0.2, 0.4, 0.6] });
  assert.ok(Math.abs(r.decorrelation - 0.4) < 1e-9, 'mean of [0.2,0.4,0.6]');
});

test('zero tasks -> zero-n result, no divide-by-zero (REQ-11.3)', () => {
  const r = computeFusionCalibration({ single: [], fused: [], panelDisagreements: [] });
  assert.equal(r.n, 0);
  assert.equal(r.uplift, 0);
  assert.deepEqual(r.upliftRange, [0, 0]);
  assert.equal(r.decorrelation, 0);
});

// --- Lesson hit-rate PROXY (REQ-24.1) — same fold convention as aal's
// computeShadowOutcomeStats (aal/src/shadow.test.ts's routeEvent/reviewingEvent). ---

function injectedEvent(seq: number, taskId: string): PlatformEvent {
  return { seq, ts: `t${seq}`, runId: 'RUN-1', taskId, type: 'LESSON_INJECTED', payload: { ids: [`lsn-${seq}`], refs: [] } };
}
function reviewingEvent(seq: number, taskId: string): PlatformEvent {
  return { seq, ts: `t${seq}`, runId: 'RUN-1', taskId, type: 'TASK_STATE', payload: { state: 'REVIEWING' } };
}
function escalatedEvent(seq: number, taskId: string): PlatformEvent {
  return { seq, ts: `t${seq}`, runId: 'RUN-1', taskId, type: 'TASK_STATE', payload: { state: 'ESCALATED' } };
}

test('lesson hit-rate proxy: no injections -> zero, never fabricated', () => {
  assert.deepEqual(computeLessonHitRate([]), { injectionCount: 0, hitRateProxy: 0 });
});

test('lesson hit-rate proxy: one injected task that reached REVIEWING -> 1/1', () => {
  const events = [injectedEvent(1, 'T-1'), reviewingEvent(2, 'T-1')];
  assert.deepEqual(computeLessonHitRate(events), { injectionCount: 1, hitRateProxy: 1 });
});

test('lesson hit-rate proxy: one injected task that never reached REVIEWING -> counted, 0 rate', () => {
  const events = [injectedEvent(1, 'T-1'), escalatedEvent(2, 'T-1')];
  assert.deepEqual(computeLessonHitRate(events), { injectionCount: 1, hitRateProxy: 0 });
});

test('lesson hit-rate proxy: the SAME task injected twice counts as one task, not two', () => {
  const events = [injectedEvent(1, 'T-1'), injectedEvent(2, 'T-1'), reviewingEvent(3, 'T-1')];
  assert.deepEqual(computeLessonHitRate(events), { injectionCount: 1, hitRateProxy: 1 });
});

test('lesson hit-rate proxy: mixed tasks fold to the correct fraction', () => {
  const events = [
    injectedEvent(1, 'T-1'),
    reviewingEvent(2, 'T-1'),
    injectedEvent(3, 'T-2'),
    escalatedEvent(4, 'T-2'),
  ];
  assert.deepEqual(computeLessonHitRate(events), { injectionCount: 2, hitRateProxy: 0.5 });
});
