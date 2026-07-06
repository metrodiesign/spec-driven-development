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
