import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  beginRead,
  boundedPageLimit,
  cancelRead,
  completeRead,
  createReadModel,
  failRead,
  mergeBySequence,
  shouldPoll,
} from './readState.ts';

test('new selection gets a new generation; stale response cannot replace current data (REQ-8.21)', () => {
  const first = beginRead(createReadModel<string>(), 'core/run-1');
  assert.notEqual(first.identity, null);
  const second = beginRead(first.model, 'core/run-2');
  assert.notEqual(second.identity, null);
  if (first.identity === null || second.identity === null) return;
  const ignored = completeRead(second.model, first.identity, 'old', '2026-08-12T00:00:00.000Z');
  assert.equal(ignored, second.model);
  assert.deepEqual(completeRead(ignored, second.identity, 'new', '2026-08-12T00:00:01.000Z').state, {
    kind: 'data',
    value: 'new',
    readAt: '2026-08-12T00:00:01.000Z',
    stale: false,
  });
});

test('one source allows at most one in-flight read', () => {
  const first = beginRead(createReadModel<string>(), 'source');
  const duplicate = beginRead(first.model, 'source');
  assert.equal(duplicate.identity, null);
  assert.equal(duplicate.model, first.model);
});

test('failed retry preserves last-good data, timestamp, and stale label (REQ-8.23)', () => {
  const started = beginRead(createReadModel<string>(), 'source');
  if (started.identity === null) return;
  const good = completeRead(started.model, started.identity, 'last good', '2026-08-12T00:00:00.000Z');
  const retry = beginRead(good, 'source');
  if (retry.identity === null) return;
  assert.deepEqual(failRead(retry.model, retry.identity, 'network error').state, {
    kind: 'error',
    previous: 'last good',
    readAt: '2026-08-12T00:00:00.000Z',
    stale: true,
    reason: 'network error',
  });
});

test('abort restores last-good data and does not create an error', () => {
  const first = beginRead(createReadModel<number>(), 'source');
  if (first.identity === null) return;
  const good = completeRead(first.model, first.identity, 1, '2026-08-12T00:00:00.000Z');
  const retry = beginRead(good, 'source');
  if (retry.identity === null) return;
  assert.deepEqual(cancelRead(retry.model, retry.identity).state, {
    kind: 'data',
    value: 1,
    readAt: '2026-08-12T00:00:00.000Z',
    stale: false,
  });
});

test('polling stops while hidden/unmounted/in-flight; page limit is 1..100', () => {
  assert.equal(shouldPoll(true, true, false), true);
  assert.equal(shouldPoll(false, true, false), false);
  assert.equal(shouldPoll(true, false, false), false);
  assert.equal(shouldPoll(true, true, true), false);
  assert.equal(boundedPageLimit(Number.NaN), 50);
  assert.equal(boundedPageLimit(0), 1);
  assert.equal(boundedPageLimit(101), 100);
});

test('authoritative sequence merge deduplicates and ignores browser arrival order', () => {
  assert.deepEqual(
    mergeBySequence(
      [{ seq: 2, value: 'old' }],
      [
        { seq: 3, value: 'third' },
        { seq: 1, value: 'first' },
        { seq: 2, value: 'authoritative replacement' },
      ],
    ),
    [
      { seq: 1, value: 'first' },
      { seq: 2, value: 'authoritative replacement' },
      { seq: 3, value: 'third' },
    ],
  );
});
