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
