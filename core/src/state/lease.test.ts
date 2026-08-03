import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { acquireTaskLease, createLeaseManager, isLeaseTtlValid } from './lease.ts';
import { openEventLog } from './event-log.ts';

function tempDb(): { dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'lease-'));
  return { dbPath: join(dir, 'events.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeClock(start = 1_000_000): { now(): number; tick(ms: number): void } {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

test('renew extends only the holder; expiry ends renewability (REQ-5.3)', () => {
  const t = tempDb();
  try {
    const clock = makeClock();
    const lm = createLeaseManager(t.dbPath, clock, 'RUN');
    assert.equal(lm.claim('T', 'a', 1_000), true);
    assert.equal(lm.renew('T', 'b', 1_000), false, 'non-holder cannot renew');
    assert.equal(lm.renew('T', 'a', 2_000), true, 'holder renews');
    clock.tick(3_000); // past renewed TTL
    assert.equal(lm.renew('T', 'a', 1_000), false, 'expired lease not renewable');
    lm.close();
  } finally {
    t.cleanup();
  }
});

test('release frees the lease and logs LEASE_RELEASED (REQ-5.1 event pairing)', () => {
  const t = tempDb();
  try {
    const clock = makeClock();
    const lm = createLeaseManager(t.dbPath, clock, 'RUN');
    const log = openEventLog(t.dbPath, clock);
    assert.equal(lm.claim('T', 'a', 60_000), true);
    lm.release('T', 'a');
    assert.equal(lm.claim('T', 'b', 60_000), true, 'released lease immediately claimable');
    assert.equal(log.all({ type: 'LEASE_RELEASED' }).length, 1);
    assert.equal(log.all({ type: 'LEASE_CLAIMED' }).length, 2);
    lm.close();
    log.close();
  } finally {
    t.cleanup();
  }
});

test('same-owner re-claim is idempotent, not a takeover (REQ-5.2 boundary)', () => {
  const t = tempDb();
  try {
    const clock = makeClock();
    const lm = createLeaseManager(t.dbPath, clock, 'RUN');
    assert.equal(lm.claim('T', 'a', 60_000), true);
    assert.equal(lm.claim('T', 'a', 60_000), true, 'self re-claim allowed');
    assert.equal(lm.claim('T', 'b', 60_000), false, 'other owner still denied');
    lm.close();
  } finally {
    t.cleanup();
  }
});

test('P0-06 fencing: expiry replacement increments the token and old owner cannot renew, verify, or release', () => {
  const t = tempDb();
  try {
    const clock = makeClock();
    const lm = createLeaseManager(t.dbPath, clock, 'RUN');
    const first = lm.claimLease('T', 'a', 1_000);
    assert.ok(first);
    clock.tick(1_001);
    const second = lm.claimLease('T', 'b', 1_000);
    assert.ok(second);
    assert.equal(second.fencingToken, first.fencingToken + 1);
    assert.equal(lm.verify('T', 'a', first.fencingToken), false);
    assert.equal(lm.renewLease('T', 'a', first.fencingToken, 1_000), null);
    lm.releaseLease('T', 'a', first.fencingToken);
    assert.equal(lm.verify('T', 'b', second.fencingToken), true, 'stale release cannot free replacement');
    lm.close();
  } finally {
    t.cleanup();
  }
});

test('P0-06 session reacquires after expiry with a fresh fencing token', async () => {
  const t = tempDb();
  try {
    const clock = makeClock();
    const lm = createLeaseManager(t.dbPath, clock, 'RUN');
    const session = acquireTaskLease(lm, 'T', 'a', 1_000, 10);
    assert.ok(session);
    const token = session.claim.fencingToken;
    clock.tick(1_001);
    assert.equal(session.verifyOwnership(), false);
    assert.equal(await session.reacquireAfterPause(), true);
    assert.ok(session.claim.fencingToken > token);
    session.release();
    lm.close();
  } finally {
    t.cleanup();
  }
});

test('P0-06 rejects TTL at or below atomic duration plus safety margin', () => {
  assert.equal(isLeaseTtlValid(1_001, 1), false);
  assert.equal(isLeaseTtlValid(1_002, 1), true);
  assert.equal(isLeaseTtlValid(Number.NaN, 1), false);
});

test('P0-06 fencing generation remains monotonic across explicit release and reclaim', () => {
  const t = tempDb();
  try {
    const clock = makeClock();
    const lm = createLeaseManager(t.dbPath, clock, 'RUN');
    const first = lm.claimLease('T', 'a', 1_000);
    assert.ok(first);
    lm.releaseLease('T', 'a', first.fencingToken);
    const second = lm.claimLease('T', 'b', 1_000);
    assert.ok(second);
    assert.ok(second.fencingToken > first.fencingToken);
    lm.close();
  } finally {
    t.cleanup();
  }
});

test('P0-06 heartbeat renews across an asynchronous wait so a live owner is not reclaimed', async () => {
  const t = tempDb();
  const lm = createLeaseManager(t.dbPath, { now: () => Date.now() }, 'RUN');
  try {
    const session = acquireTaskLease(lm, 'T', 'a', 150, 20);
    assert.ok(session);
    session.startHeartbeat();
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    assert.equal(session.verifyOwnership(), true, 'heartbeat kept the lease alive during async wait');
    session.release();
  } finally {
    lm.close();
    t.cleanup();
  }
});

test('P0-06 failed pause reacquire remains non-executing after a replacement owner claims', async () => {
  const t = tempDb();
  try {
    const clock = makeClock();
    const oldManager = createLeaseManager(t.dbPath, clock, 'RUN-A');
    const newManager = createLeaseManager(t.dbPath, clock, 'RUN-B');
    const session = acquireTaskLease(oldManager, 'T', 'a', 1_000);
    assert.ok(session);
    clock.tick(1_001);
    assert.ok(newManager.claimLease('T', 'b', 1_000));
    assert.equal(await session.reacquireAfterPause(), false);
    assert.equal(session.verifyOwnership(), false);
    assert.equal(newManager.verify('T', 'b', 2), true);
    oldManager.close();
    newManager.close();
  } finally {
    t.cleanup();
  }
});

test('P0-06 atomic fenced append rejects a stale token after replacement', () => {
  const t = tempDb();
  try {
    const clock = makeClock();
    const oldManager = createLeaseManager(t.dbPath, clock, 'RUN-A');
    const newManager = createLeaseManager(t.dbPath, clock, 'RUN-B');
    const log = openEventLog(t.dbPath, clock);
    const first = oldManager.claimLease('T', 'a', 1_000);
    assert.ok(first);
    clock.tick(1_001);
    assert.ok(newManager.claimLease('T', 'b', 1_000));
    const stale = log.appendFenced({ runId: 'RUN-A', taskId: 'T', type: 'ACTION_APPLIED', payload: { actionId: 'stale' } }, first, clock.now());
    assert.equal(stale, null);
    assert.equal(log.all({ type: 'ACTION_APPLIED' }).length, 0);
    log.close();
    oldManager.close();
    newManager.close();
  } finally {
    t.cleanup();
  }
});
