// Proves the calibration harness MATH (REQ-11.2) — computation only; these are
// not §12 metrics.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeCalibration, computeFusionCalibration, computeGoldenCoverage, computeLessonHitRate } from './calibration.ts';
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

test('golden coverage deduplicates unique in-scope IDs and pairs with held-out rate (REQ-8.7/8.8/8.9)', () => {
  const r = computeCalibration({
    heldOut: [true, false],
    reruns: [true],
    inScopeAcIds: ['AC-1', 'AC-1', 'AC-2', 'AC-3'],
    goldenAcIds: ['AC-1', 'AC-1', 'AC-9'],
  });
  assert.deepEqual(r.goldenCoverage, { goldenAcCount: 1, inScopeAcCount: 3, rate: 1 / 3 });
  assert.equal(r.heldOutPassRate, 0.5);
});

test('zero in-scope IDs reports explicit zero coverage (REQ-8.8)', () => {
  assert.deepEqual(computeGoldenCoverage({ inScopeAcIds: [], goldenAcIds: ['AC-1'] }), {
    goldenAcCount: 0,
    inScopeAcCount: 0,
    rate: 0,
  });
});

test('frozen-contract acceptance criteria can supply coverage directly', () => {
  const r = computeCalibration({ heldOut: [], reruns: [], acceptanceCriteria: [
    { id: 'AC-1', golden: true },
    { id: 'AC-1', golden: false },
  ] });
  assert.deepEqual(r.goldenCoverage, { goldenAcCount: 1, inScopeAcCount: 1, rate: 1 });
});

test('all unique in-scope IDs golden-backed reports full coverage', () => {
  assert.deepEqual(computeGoldenCoverage({ inScopeAcIds: ['AC-1', 'AC-2'], goldenAcIds: ['AC-1', 'AC-2'] }), {
    goldenAcCount: 2,
    inScopeAcCount: 2,
    rate: 1,
  });
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
