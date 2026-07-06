import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLeaseManager } from './lease.ts';
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
