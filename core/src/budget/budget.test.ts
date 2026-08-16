import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBudget } from './budget.ts';

function makeClock(start = 0): { now(): number; tick(ms: number): void } {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

test('iteration limit trips at the boundary (REQ-10.1/10.2)', () => {
  const b = createBudget({ maxIterations: 2, maxCostUnits: 100, maxWallclockMs: 1000 }, makeClock());
  assert.equal(b.exceeded(), false);
  b.noteIteration(1);
  assert.equal(b.exceeded(), false);
  b.noteIteration(1);
  assert.deepEqual(b.exceeded(), { limit: 'iterations' });
});

test('cost limit trips when spent past the cap (REQ-10.1)', () => {
  const b = createBudget({ maxIterations: 10, maxCostUnits: 5, maxWallclockMs: 1000 }, makeClock());
  b.noteIteration(5);
  assert.equal(b.exceeded(), false, 'exactly at cap is still inside');
  b.noteIteration(1);
  assert.deepEqual(b.exceeded(), { limit: 'costUnits' });
});

test('wallclock limit uses the injected clock (REQ-10.1, determinism)', () => {
  const clock = makeClock();
  const b = createBudget({ maxIterations: 10, maxCostUnits: 100, maxWallclockMs: 500 }, clock);
  clock.tick(500);
  assert.equal(b.exceeded(), false, 'exactly at cap is still inside');
  clock.tick(1);
  assert.deepEqual(b.exceeded(), { limit: 'wallclock' });
});

test('wallclock counts ACTIVE time only — excluded intervals never trip it (REQ-6.5)', () => {
  const clock = makeClock();
  const b = createBudget({ maxIterations: 10, maxCostUnits: 100, maxWallclockMs: 500 }, clock);
  // The clock advances 900ms, but 600ms of it was a pause/approval-wait window —
  // active time is 300ms, still inside the 500ms cap.
  clock.tick(900);
  b.noteExcludedMs(600);
  assert.equal(b.exceeded(), false, 'paused/waiting time does not count toward the wallclock budget');
  // Another 300ms of ACTIVE time pushes active total to 600ms > 500ms -> trips.
  clock.tick(300);
  assert.deepEqual(b.exceeded(), { limit: 'wallclock' });
});

test('rejects negative and non-finite usage without crediting cost (REQ-7.1/7.5)', () => {
  const b = createBudget({ maxIterations: 10, maxCostUnits: 100, maxWallclockMs: 1000 }, makeClock());
  b.noteIteration(3);
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => b.noteIteration(invalid), /costUnits/i, `rejects ${String(invalid)}`);
  }
  assert.equal(b.remaining(), 97, 'invalid usage leaves prior accumulated cost unchanged');
  assert.equal(b.exceeded(), false, 'invalid usage does not exhaust a backstop');
});

test('rejects usage aggregate overflow before crediting it (REQ-7.3/7.5)', () => {
  const b = createBudget({ maxIterations: 10, maxCostUnits: Number.MAX_VALUE, maxWallclockMs: 1000 }, makeClock());
  b.noteIteration(Number.MAX_VALUE);
  const remainingAfterFirst = b.remaining();
  assert.throws(() => b.noteIteration(Number.MAX_VALUE), /overflow/i);
  assert.equal(b.remaining(), remainingAfterFirst, 'overflow attempt does not alter prior cost');
});

test('accepts zero usage as a valid charge (REQ-7.6)', () => {
  const b = createBudget({ maxIterations: 2, maxCostUnits: 10, maxWallclockMs: 1000 }, makeClock());
  assert.doesNotThrow(() => b.noteIteration(0));
  assert.equal(b.remaining(), 10);
});

test('snapshot and observer expose exact counters without changing budget decisions', () => {
  const clock = makeClock(100);
  const observed: { phase: string; snapshot: ReturnType<ReturnType<typeof createBudget>['snapshot']> }[] = [];
  const b = createBudget(
    { maxIterations: 3, maxCostUnits: 10, maxWallclockMs: 1_000 },
    clock,
    (phase, snapshot) => observed.push({ phase, snapshot }),
  );
  clock.tick(250);
  b.noteIteration(4);
  clock.tick(100);
  b.noteExcludedMs(100);

  assert.deepEqual(observed.map((entry) => entry.phase), ['init', 'charge', 'excluded-time']);
  assert.deepEqual(b.snapshot(), {
    used: { iterations: 1, costUnits: 4, activeWallclockMs: 250 },
    cap: { iterations: 3, costUnits: 10, wallclockMs: 1_000 },
  });
  assert.equal(b.remaining(), 6);
  assert.equal(b.exceeded(), false);
});

test('a throwing budget observer never changes usage, exceptions, or return values', () => {
  const b = createBudget(
    { maxIterations: 2, maxCostUnits: 10, maxWallclockMs: 1_000 },
    makeClock(),
    () => { throw new Error('observer failed'); },
  );
  assert.doesNotThrow(() => b.noteIteration(3));
  assert.doesNotThrow(() => b.noteExcludedMs(5));
  assert.deepEqual(b.snapshot().used, { iterations: 1, costUnits: 3, activeWallclockMs: 0 });
  assert.equal(b.remaining(), 7);
});
