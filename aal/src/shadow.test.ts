// Outcome-routing shadow (REQ-7): shadowWouldChoose determinism, frozen-on-stale
// (drift canary), and compareShadow agreement math. All pure — no EventLog/I-O.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeAdapter } from './fake-adapter.ts';
import { createRegistry } from './registry.ts';
import { compareShadow, computeShadowOutcomeStats, shadowFrozen, shadowProven, shadowWouldChoose } from './shadow.ts';
import { PASS_FAIL_PROBES, type ConformanceRecord } from './protocol.ts';
import type { PlatformEvent } from 'core/types';

function passing(id: string): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'fake-1.0',
    ranAt: '2026-07-06T00:00:00Z',
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: `blob://${p}` })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

// --- shadowWouldChoose (REQ-7.2) ---

test('no adapter has attempts yet -> live choice stands, basis insufficient_data (REQ-7.2)', () => {
  const out = shadowWouldChoose({
    role: 'implementer',
    liveChoice: 'a@v1',
    eligible: ['a@v1', 'b@v1'],
    outcomeStats: {},
  });
  assert.deepEqual(out, { wouldChoose: 'a@v1', basis: 'insufficient_data' });
});

test('the eligible adapter with the highest reviewing-reached rate wins (REQ-7.2)', () => {
  const out = shadowWouldChoose({
    role: 'implementer',
    liveChoice: 'a@v1',
    eligible: ['a@v1', 'b@v1'],
    outcomeStats: {
      'a@v1': { attempts: 10, reviewingReached: 5 }, // 0.5
      'b@v1': { attempts: 10, reviewingReached: 8 }, // 0.8
    },
  });
  assert.deepEqual(out, { wouldChoose: 'b@v1', basis: 'highest_reviewing_rate' });
});

test('a tied rate keeps the first eligible entry — deterministic, never randomized (REQ-7.2)', () => {
  const input = {
    role: 'implementer' as const,
    liveChoice: 'a@v1',
    eligible: ['a@v1', 'b@v1'],
    outcomeStats: {
      'a@v1': { attempts: 4, reviewingReached: 2 }, // 0.5
      'b@v1': { attempts: 8, reviewingReached: 4 }, // 0.5
    },
  };
  const first = shadowWouldChoose(input);
  const second = shadowWouldChoose(input);
  assert.deepEqual(first, { wouldChoose: 'a@v1', basis: 'highest_reviewing_rate' });
  assert.deepEqual(second, first, 'same input -> same output, every time');
});

test('an adapter with zero attempts never outranks one with data (REQ-7.2)', () => {
  const out = shadowWouldChoose({
    role: 'implementer',
    liveChoice: 'a@v1',
    eligible: ['a@v1', 'b@v1'],
    outcomeStats: {
      'a@v1': { attempts: 3, reviewingReached: 1 }, // 0.33
      // b@v1 absent -> no data, excluded from ranking entirely
    },
  });
  assert.deepEqual(out, { wouldChoose: 'a@v1', basis: 'highest_reviewing_rate' });
});

test('an explicit zero-attempts stats entry is treated the same as no entry at all (REQ-7.2)', () => {
  const out = shadowWouldChoose({
    role: 'implementer',
    liveChoice: 'b@v1',
    eligible: ['a@v1', 'b@v1'],
    outcomeStats: {
      'a@v1': { attempts: 0, reviewingReached: 0 },
      'b@v1': { attempts: 2, reviewingReached: 1 },
    },
  });
  assert.deepEqual(out, { wouldChoose: 'b@v1', basis: 'highest_reviewing_rate' });
});

// --- shadowFrozen (REQ-7.3) ---

test('no adapter stale -> not frozen; any stale adapter -> frozen (REQ-7.3)', () => {
  const reg = createRegistry();
  reg.register(new FakeAdapter({ id: 'ok-1' }), passing('ok-1'));
  reg.register(new FakeAdapter({ id: 'ok-2' }), passing('ok-2'));
  assert.equal(shadowFrozen(reg.all()), false);

  reg.recordConformance('ok-2', { ...passing('ok-2'), probes: [] }); // regress -> stale
  assert.equal(shadowFrozen(reg.all()), true, 'one stale adapter freezes the whole set');
});

test('shadowFrozen sees stale entries that eligible() already hides (REQ-7.3)', () => {
  const reg = createRegistry();
  reg.register(new FakeAdapter({ id: 'only' }), passing('only'));
  reg.recordConformance('only', { ...passing('only'), probes: [] });
  assert.equal(reg.eligible('implementer').length, 0, 'eligible() hides the stale adapter');
  assert.equal(shadowFrozen(reg.all()), true, 'all() still surfaces it to the canary');
});

// --- compareShadow (REQ-7.6) ---

function shadowRouteEvent(seq: number, live: string, wouldChoose: string): PlatformEvent {
  return {
    seq,
    ts: `2026-07-08T00:00:0${seq}.000Z`,
    runId: 'RUN-1',
    taskId: 'T-1',
    type: 'SHADOW_ROUTE',
    payload: { role: 'implementer', live, wouldChoose, basis: 'highest_reviewing_rate', frozen: false },
  };
}

test('no recorded routes -> n 0, agreementRate 1 (vacuous), no divergences (REQ-7.6)', () => {
  assert.deepEqual(compareShadow([]), { n: 0, agreementRate: 1, divergences: [] });
});

test('agreement rate + divergence detail over a mix of matching and diverging routes (REQ-7.6)', () => {
  const events = [
    shadowRouteEvent(1, 'a@v1', 'a@v1'),
    shadowRouteEvent(2, 'a@v1', 'b@v1'),
    shadowRouteEvent(3, 'a@v1', 'a@v1'),
    shadowRouteEvent(4, 'a@v1', 'b@v1'),
  ];
  const out = compareShadow(events);
  assert.equal(out.n, 4);
  assert.equal(out.agreementRate, 0.5);
  assert.deepEqual(out.divergences, [
    { at: events[1]?.ts, live: 'a@v1', shadow: 'b@v1' },
    { at: events[3]?.ts, live: 'a@v1', shadow: 'b@v1' },
  ]);
});

test('non-SHADOW_ROUTE events in the array are ignored (REQ-7.6)', () => {
  const events: PlatformEvent[] = [
    { seq: 1, ts: 't1', runId: 'RUN-1', taskId: 'T-1', type: 'TASK_STATE', payload: { state: 'REVIEWING' } },
    shadowRouteEvent(2, 'a@v1', 'a@v1'),
  ];
  const out = compareShadow(events);
  assert.equal(out.n, 1);
  assert.equal(out.agreementRate, 1);
});

// --- computeShadowOutcomeStats (REQ-13.2) — relocated from loop-run.ts verbatim ---

function routeEvent(seq: number, taskId: string, live: string): PlatformEvent {
  return {
    seq,
    ts: `t${seq}`,
    runId: 'RUN-1',
    taskId,
    type: 'SHADOW_ROUTE',
    payload: { role: 'implementer', live, wouldChoose: live, basis: 'insufficient_data', frozen: false },
  };
}

function reviewingEvent(seq: number, taskId: string): PlatformEvent {
  return { seq, ts: `t${seq}`, runId: 'RUN-1', taskId, type: 'TASK_STATE', payload: { state: 'REVIEWING' } };
}

test('no SHADOW_ROUTE events -> empty stats (REQ-13.2)', () => {
  assert.deepEqual(computeShadowOutcomeStats([]), {});
});

test('attempts count every live pick; reviewingReached counts only tasks that actually reached REVIEWING (REQ-13.2)', () => {
  const events = [
    routeEvent(1, 'T-a', 'a@v1'),
    reviewingEvent(2, 'T-a'),
    routeEvent(3, 'T-b', 'a@v1'), // T-b never reaches REVIEWING
    routeEvent(4, 'T-c', 'b@v1'),
    reviewingEvent(5, 'T-c'),
  ];
  assert.deepEqual(computeShadowOutcomeStats(events), {
    'a@v1': { attempts: 2, reviewingReached: 1 },
    'b@v1': { attempts: 1, reviewingReached: 1 },
  });
});

test('a task still in flight (no REVIEWING yet) contributes 0 so far, not an error (REQ-13.2)', () => {
  const events = [routeEvent(1, 'T-live', 'a@v1')];
  assert.deepEqual(computeShadowOutcomeStats(events), { 'a@v1': { attempts: 1, reviewingReached: 0 } });
});

test('counts per TASK, not per SHADOW_ROUTE round — a multi-round task is never inflated (PR #50 review)', () => {
  // T-multi routes to a@v1 across 3 rounds and reaches REVIEWING; T-single routes once
  // and does not. Per task: attempts=2 (distinct tasks), reviewingReached=1. The old
  // per-event fold said attempts=4 / reviewingReached=3 (crediting every round of the
  // REVIEWING task) — a 3-round success outweighing a 1-round one, flipping rankings.
  const events = [
    routeEvent(1, 'T-multi', 'a@v1'),
    routeEvent(2, 'T-multi', 'a@v1'),
    routeEvent(3, 'T-multi', 'a@v1'),
    reviewingEvent(4, 'T-multi'),
    routeEvent(5, 'T-single', 'a@v1'),
  ];
  assert.deepEqual(computeShadowOutcomeStats(events), { 'a@v1': { attempts: 2, reviewingReached: 1 } });
});

// --- shadowProven (REQ-13.1/13.3) ---

test('proven requires BOTH n >= minSamples AND divergences >= minDivergences (REQ-13.3)', () => {
  const events = [shadowRouteEvent(1, 'a@v1', 'b@v1'), shadowRouteEvent(2, 'a@v1', 'a@v1')];
  assert.equal(shadowProven(events, { minSamples: 5, minDivergences: 1 }).proven, false, 'n=2 < minSamples 5, despite a real divergence');
  assert.equal(shadowProven(events, { minSamples: 2, minDivergences: 1 }).proven, true);
});

test('minDivergences defaults to 1 when omitted (AZ-10)', () => {
  const agreeing = [shadowRouteEvent(1, 'a@v1', 'a@v1'), shadowRouteEvent(2, 'a@v1', 'a@v1')];
  assert.equal(shadowProven(agreeing, { minSamples: 2 }).proven, false, 'n met but zero divergences -> not proven under the default-1 floor');
  const withOneDivergence = [shadowRouteEvent(1, 'a@v1', 'b@v1'), shadowRouteEvent(2, 'a@v1', 'a@v1')];
  assert.equal(shadowProven(withOneDivergence, { minSamples: 2 }).proven, true);
});

test('shadowProven is built on compareShadow + computeShadowOutcomeStats verbatim — no duplicate fold (REQ-13.2)', () => {
  const events = [routeEvent(1, 'T-a', 'a@v1'), reviewingEvent(2, 'T-a'), shadowRouteEvent(3, 'a@v1', 'b@v1')];
  const report = shadowProven(events, { minSamples: 1, minDivergences: 1 });
  const expectedCompare = compareShadow(events);
  assert.equal(report.n, expectedCompare.n);
  assert.equal(report.agreementRate, expectedCompare.agreementRate);
  assert.deepEqual(report.divergences, expectedCompare.divergences);
  assert.deepEqual(report.perAdapter, computeShadowOutcomeStats(events));
});
