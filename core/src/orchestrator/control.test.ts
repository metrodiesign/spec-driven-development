// The driving side of the LoopControl port (REQ-10.1/10.7). Single-threaded model:
// the loop polls at a boundary, then (if pausing) awaits waitResume; the Human
// Plane callback can only fire while the loop is yielded at that await, so there is
// no poll/signal race to defend against here.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLoopController } from './control.ts';

test('idle controller polls none', () => {
  const c = createLoopController();
  assert.equal(c.port.poll(), 'none');
});

test('requestPause surfaces at the next poll; resume unblocks waitResume (REQ-10.1/10.3)', async () => {
  const c = createLoopController();
  c.requestPause();
  assert.equal(c.port.poll(), 'pause');
  const wait = c.port.waitResume();
  c.requestResume();
  assert.equal(await wait, 'resume');
  // After resume the signal clears — the loop is running again.
  assert.equal(c.port.poll(), 'none');
});

test('requestKill wins over a pending pause and resolves a paused waitResume with kill (REQ-10.7)', async () => {
  const c = createLoopController();
  c.requestPause();
  const wait = c.port.waitResume();
  c.requestKill();
  assert.equal(await wait, 'kill');
  assert.equal(c.port.poll(), 'kill');
  // Kill is terminal: a later pause cannot override it.
  c.requestPause();
  assert.equal(c.port.poll(), 'kill');
});

test('kill signaled before waitResume resolves immediately (REQ-10.7)', async () => {
  const c = createLoopController();
  c.requestKill();
  assert.equal(await c.port.waitResume(), 'kill');
});
