// Circuit breaker (REQ-1). Pure state machine over an INJECTED clock (no wall-clock
// reads), so the whole closed->open->half_open->closed cycle is deterministic and
// replayable. Transitions must fire through the sink; steady-state sends must not.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBreaker, type BreakerTransition } from './breaker.ts';

function make(opts?: { windowSize?: number; failureThreshold?: number; openMs?: number }) {
  let t = 0;
  const events: BreakerTransition[] = [];
  const b = createBreaker(
    { windowSize: opts?.windowSize ?? 3, failureThreshold: opts?.failureThreshold ?? 1, openMs: opts?.openMs ?? 1000 },
    () => t,
    (e) => events.push(e),
  );
  return { b, events, tick: (to: number) => { t = to; }, hops: () => events.map((e) => `${e.from}->${e.to}`) };
}

test('window math: closed -> open (failure rate) -> half_open (openMs) -> closed (probe ok) (REQ-1.2/1.4/1.5)', () => {
  const { b, tick, hops } = make({ windowSize: 3, failureThreshold: 1, openMs: 1000 });
  const k = 'a@1';
  assert.equal(b.state(k), 'closed');
  b.recordFailure(k, 'transport');
  assert.equal(b.state(k), 'closed', 'one failure below the window is not enough');
  b.recordFailure(k, 'transport');
  b.recordFailure(k, 'transport'); // 3/3 failures -> trip
  assert.equal(b.state(k), 'open');

  tick(999);
  assert.equal(b.state(k), 'open', 'still cooling before openMs');
  tick(1000);
  assert.equal(b.state(k), 'half_open', 'openMs elapsed -> admit a probe');

  b.recordSuccess(k); // probe succeeds
  assert.equal(b.state(k), 'closed');
  assert.deepEqual(hops(), ['closed->open', 'open->half_open', 'half_open->closed']);
});

test('half-open probe FAILURE re-opens for another cooldown (REQ-1.5)', () => {
  const { b, tick, hops } = make({ windowSize: 2, failureThreshold: 1, openMs: 500 });
  const k = 'a@1';
  b.recordFailure(k, 'transport');
  b.recordFailure(k, 'transport'); // open at t=0
  tick(500);
  assert.equal(b.state(k), 'half_open');
  b.recordFailure(k, 'quota_limited'); // probe fails
  assert.equal(b.state(k), 'open', 're-opened');
  assert.deepEqual(hops(), ['closed->open', 'open->half_open', 'half_open->open']);
});

test('half-open is single-flight: exactly one probe admitted per open window (REQ-1.4)', () => {
  const { b, tick } = make({ windowSize: 1, failureThreshold: 1, openMs: 100 });
  const k = 'a@1';
  b.recordFailure(k, 'transport'); // open at t=0
  assert.equal(b.allowProbe(k), false, 'no probe while open');
  tick(100);
  assert.equal(b.allowProbe(k), true, 'first probe admitted');
  assert.equal(b.allowProbe(k), false, 'second concurrent probe denied');
});

test('per-key isolation: one key opening leaves another untouched (REQ-1.1)', () => {
  const { b } = make({ windowSize: 2, failureThreshold: 1, openMs: 1000 });
  b.recordFailure('a@1', 'transport');
  b.recordFailure('a@1', 'transport'); // a opens
  assert.equal(b.state('a@1'), 'open');
  assert.equal(b.state('b@1'), 'closed', 'b is independent');
});

test('sink fires on transitions ONLY, never on steady-state sends (REQ-1.6)', () => {
  const { b, events } = make({ windowSize: 3, failureThreshold: 1, openMs: 1000 });
  const k = 'a@1';
  b.recordSuccess(k);
  b.recordSuccess(k);
  b.recordFailure(k, 'transport'); // below threshold, still closed
  assert.equal(events.length, 0, 'no transition -> no event');
  assert.equal(b.state(k), 'closed');
});
