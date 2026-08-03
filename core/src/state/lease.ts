// Single-writer lease per task (spec §6.2, REQ-6). A claim is ONE SQLite
// transaction: BEGIN IMMEDIATE -> CAS -> on success INSERT LEASE_CLAIMED event
// -> COMMIT; otherwise ROLLBACK. Log and lease table can never diverge (INV-10).

import type { DatabaseSync } from 'node:sqlite';

import { insertEvent, openDatabase } from './schema.ts';
import type { Clock } from '../types.ts';

export interface LeaseClaim {
  taskId: string;
  ownerId: string;
  fencingToken: number;
  leaseUntil: number;
}

export interface LeaseManager {
  /** True when the claim succeeded; false when another owner holds an unexpired lease. */
  claim(taskId: string, ownerId: string, ttlMs: number): boolean;
  /** Return the authenticated claim, including the monotonically increasing fence. */
  claimLease(taskId: string, ownerId: string, ttlMs: number): LeaseClaim | null;
  renew(taskId: string, ownerId: string, ttlMs: number): boolean;
  renewLease(taskId: string, ownerId: string, fencingToken: number, ttlMs: number): LeaseClaim | null;
  /** Verify that this exact owner generation is still current and unexpired. */
  verify(taskId: string, ownerId: string, fencingToken: number): boolean;
  release(taskId: string, ownerId: string): void;
  releaseLease(taskId: string, ownerId: string, fencingToken: number): void;
  close(): void;
}

/** A fixed margin protects a lease from expiring during one atomic operation. */
export const LEASE_SAFETY_MARGIN_MS = 1_000;

export function isLeaseTtlValid(
  ttlMs: number,
  maxAtomicDurationMs: number,
  safetyMarginMs = LEASE_SAFETY_MARGIN_MS,
): boolean {
  return (
    Number.isFinite(ttlMs) &&
    ttlMs > 0 &&
    Number.isFinite(maxAtomicDurationMs) &&
    maxAtomicDurationMs >= 0 &&
    Number.isFinite(safetyMarginMs) &&
    safetyMarginMs >= 0 &&
    ttlMs > maxAtomicDurationMs + safetyMarginMs
  );
}

export interface TaskLeaseSession {
  readonly claim: LeaseClaim;
  heartbeat(): Promise<boolean>;
  verifyOwnership(): boolean;
  reacquireAfterPause(): Promise<boolean>;
  /** Starts renewal while the loop is awaiting an adapter, executor, or gate. */
  startHeartbeat(): void;
  stopHeartbeat(): void;
  /** Stops old fencing tokens from releasing a replacement owner. */
  release(): void;
  readonly ownershipLost: boolean;
}

/** Error used by composition when a caller configures an unsafe lease lifetime. */
export class LeaseConfigurationError extends Error {
  readonly code = 'invalid_lease_ttl';
  readonly ttlMs: number;
  readonly maxAtomicDurationMs: number;
  readonly safetyMarginMs: number;
  constructor(ttlMs: number, maxAtomicDurationMs: number, safetyMarginMs = LEASE_SAFETY_MARGIN_MS) {
    super(`lease TTL must exceed max atomic duration plus safety margin (${maxAtomicDurationMs + safetyMarginMs}ms)`);
    this.name = 'LeaseConfigurationError';
    this.ttlMs = ttlMs;
    this.maxAtomicDurationMs = maxAtomicDurationMs;
    this.safetyMarginMs = safetyMarginMs;
  }
}

export function createLeaseManager(dbPath: string, clock: Clock, runId: string): LeaseManager {
  const db: DatabaseSync = openDatabase(dbPath);

  function inTx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    claim(taskId, ownerId, ttlMs) {
      return this.claimLease(taskId, ownerId, ttlMs) !== null;
    },

    claimLease(taskId, ownerId, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return null;
      return inTx(() => {
        const now = clock.now();
        const until = now + ttlMs;
        const existing = db
          .prepare('SELECT task_id, owner_id, lease_until, fencing_token FROM leases WHERE task_id = ?')
          .get(taskId) as
          | { task_id: string; owner_id: string; lease_until: number; fencing_token: number }
          | undefined;
        if (existing !== undefined && existing.owner_id !== ownerId && existing.lease_until >= now) return null;

        // Reclaiming an expired row starts a new fencing generation. A live
        // same-owner claim remains idempotent for compatibility with callers
        // that use claim() as a lightweight keep-alive.
        const token =
          existing === undefined
            ? Math.max(
                0,
                Number(
                  (db.prepare('SELECT fencing_token FROM lease_fences WHERE task_id = ?').get(taskId) as { fencing_token: number } | undefined)
                    ?.fencing_token ?? 0,
                ),
              ) + 1
            : existing.owner_id === ownerId && existing.lease_until >= now
              ? Math.max(1, existing.fencing_token)
              : Math.max(0, existing.fencing_token) + 1;
        if (existing === undefined) {
          db.prepare('INSERT INTO leases (task_id, owner_id, lease_until, fencing_token) VALUES (?, ?, ?, ?)').run(
            taskId,
            ownerId,
            until,
            token,
          );
        } else {
          db.prepare('UPDATE leases SET owner_id = ?, lease_until = ?, fencing_token = ? WHERE task_id = ?').run(
            ownerId,
            until,
            token,
            taskId,
          );
        }
        db.prepare(
          'INSERT INTO lease_fences (task_id, fencing_token) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET fencing_token = excluded.fencing_token',
        ).run(taskId, token);
        const claim = { taskId, ownerId, fencingToken: token, leaseUntil: until } satisfies LeaseClaim;
        {
          insertEvent(db, clock, {
            runId,
            taskId,
            type: 'LEASE_CLAIMED',
            payload: { taskId, ownerId, leaseUntil: until, fencingToken: token },
          });
        }
        return claim;
      });
    },

    renew(taskId, ownerId, ttlMs) {
      const existing = db.prepare('SELECT fencing_token FROM leases WHERE task_id = ? AND owner_id = ?').get(taskId, ownerId) as { fencing_token: number } | undefined;
      return existing !== undefined && this.renewLease(taskId, ownerId, existing.fencing_token, ttlMs) !== null;
    },

    renewLease(taskId, ownerId, fencingToken, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(fencingToken)) return null;
      return inTx(() => {
        const now = clock.now();
        const until = now + ttlMs;
        const updated = db
          .prepare(
            'UPDATE leases SET lease_until = ? WHERE task_id = ? AND owner_id = ? AND fencing_token = ? AND lease_until >= ?',
          )
          .run(until, taskId, ownerId, fencingToken, now);
        const ok = updated.changes === 1;
        if (ok) {
          insertEvent(db, clock, {
            runId,
            taskId,
            type: 'LEASE_RENEWED',
            payload: { taskId, ownerId, leaseUntil: until, fencingToken },
          });
        }
        return ok ? { taskId, ownerId, fencingToken, leaseUntil: until } satisfies LeaseClaim : null;
      });
    },

    verify(taskId, ownerId, fencingToken) {
      const now = clock.now();
      const row = db
        .prepare('SELECT owner_id, lease_until, fencing_token FROM leases WHERE task_id = ?')
        .get(taskId) as { owner_id: string; lease_until: number; fencing_token: number } | undefined;
      return row !== undefined && row.owner_id === ownerId && row.fencing_token === fencingToken && row.lease_until >= now;
    },

    release(taskId, ownerId) {
      inTx(() => {
        const deleted = db
          .prepare('DELETE FROM leases WHERE task_id = ? AND owner_id = ?')
          .run(taskId, ownerId);
        if (deleted.changes === 1) {
          insertEvent(db, clock, {
            runId,
            taskId,
            type: 'LEASE_RELEASED',
            payload: { taskId, ownerId },
          });
        }
      });
    },

    releaseLease(taskId, ownerId, fencingToken) {
      inTx(() => {
        const deleted = db
          .prepare('DELETE FROM leases WHERE task_id = ? AND owner_id = ? AND fencing_token = ?')
          .run(taskId, ownerId, fencingToken);
        if (deleted.changes === 1) {
          insertEvent(db, clock, {
            runId,
            taskId,
            type: 'LEASE_RELEASED',
            payload: { taskId, ownerId, fencingToken },
          });
        }
      });
    },

    close() {
      db.close();
    },
  };
}

/**
 * Claim a lease and expose a fenced lifecycle to the task loop. Returning null
 * is intentional: callers must remain non-executing when contention is lost.
 */
export function acquireTaskLease(
  manager: LeaseManager,
  taskId: string,
  ownerId: string,
  ttlMs: number,
  heartbeatIntervalMs = Math.max(1, Math.floor(ttlMs / 3)),
): TaskLeaseSession | null {
  const first = manager.claimLease(taskId, ownerId, ttlMs);
  if (first === null) return null;
  let current = first;
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = true;
  let lost = false;

  const session: TaskLeaseSession = {
    get claim() {
      return current;
    },
    get ownershipLost() {
      return lost;
    },
    async heartbeat() {
      if (!active || lost) return false;
      const renewed = manager.renewLease(taskId, ownerId, current.fencingToken, ttlMs);
      if (renewed === null) {
        lost = true;
        return false;
      }
      current = renewed;
      return true;
    },
    verifyOwnership() {
      if (!active || lost || !manager.verify(taskId, ownerId, current.fencingToken)) {
        lost = true;
        return false;
      }
      return true;
    },
    async reacquireAfterPause() {
      if (!active) return false;
      const reacquired = manager.claimLease(taskId, ownerId, ttlMs);
      if (reacquired === null) {
        lost = true;
        return false;
      }
      current = reacquired;
      lost = false;
      return true;
    },
    startHeartbeat() {
      if (!active || timer !== null) return;
      timer = setInterval(() => {
        void session.heartbeat();
      }, Math.max(1, heartbeatIntervalMs));
      // A background heartbeat must not keep a completed CLI process alive.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
    },
    stopHeartbeat() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    release() {
      if (!active) return;
      active = false;
      session.stopHeartbeat();
      manager.releaseLease(taskId, ownerId, current.fencingToken);
    },
  };
  return session;
}

/** Name aligned with the design contract; kept as an alias for callers. */
export const createTaskLeaseSession = acquireTaskLease;
