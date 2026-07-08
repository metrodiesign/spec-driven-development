// Token bucket (REQ-6.1): tryTake/available with an INJECTED clock — refill math is
// deterministic and replayable, never reads the wall clock.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTokenBucket } from './ratelimit.ts';

test('tryTake drains to empty then refuses; nothing consumed on refusal (REQ-6.1)', () => {
  const t = 0;
  const b = createTokenBucket({ capacity: 2, refillPerSec: 1 }, () => t);
  assert.equal(b.tryTake(), true, 'full bucket -> take');
  assert.equal(b.tryTake(), true);
  assert.equal(b.available(), 0);
  assert.equal(b.tryTake(), false, 'empty -> refuse');
  assert.equal(b.available(), 0, 'a refused take consumes nothing');
});

test('refill is proportional to injected elapsed time, capped at capacity (REQ-6.1)', () => {
  let t = 0;
  const b = createTokenBucket({ capacity: 2, refillPerSec: 1 }, () => t);
  b.tryTake();
  b.tryTake(); // empty at t=0
  t = 1000; // +1s -> +1 token
  assert.equal(b.available(), 1);
  assert.equal(b.tryTake(), true);
  t = 100_000; // long idle -> saturates, never exceeds capacity
  assert.equal(b.available(), 2, 'capped at capacity');
});

test('tryTake(n) takes n atomically; refillPerSec 0 never refills', () => {
  let t = 0;
  const b = createTokenBucket({ capacity: 5, refillPerSec: 0 }, () => t);
  assert.equal(b.tryTake(3), true);
  assert.equal(b.available(), 2);
  assert.equal(b.tryTake(3), false, 'not enough for 3 -> refuse, no partial take');
  assert.equal(b.available(), 2);
  t = 10_000;
  assert.equal(b.available(), 2, 'refillPerSec 0 -> static');
});
