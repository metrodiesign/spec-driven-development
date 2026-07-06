// Single-writer lease per task (spec §6.2, REQ-5). A claim is ONE SQLite
// transaction: BEGIN IMMEDIATE -> CAS -> on success INSERT LEASE_CLAIMED event
// -> COMMIT; otherwise ROLLBACK. Log and lease table can never diverge (INV-10).

import type { DatabaseSync } from 'node:sqlite';

import { insertEvent, openDatabase } from './schema.ts';
import type { Clock } from '../types.ts';

export interface LeaseManager {
  /** True when the claim succeeded; false when another owner holds an unexpired lease. */
  claim(taskId: string, ownerId: string, ttlMs: number): boolean;
  renew(taskId: string, ownerId: string, ttlMs: number): boolean;
  release(taskId: string, ownerId: string): void;
  close(): void;
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
      return inTx(() => {
        const now = clock.now();
        const until = now + ttlMs;
        // CAS: take over only a free, expired, or self-owned lease.
        const updated = db
          .prepare(
            'UPDATE leases SET owner_id = ?, lease_until = ? WHERE task_id = ? AND (lease_until < ? OR owner_id = ?)',
          )
          .run(ownerId, until, taskId, now, ownerId);
        let won = updated.changes === 1;
        if (!won) {
          const existing = db
            .prepare('SELECT task_id FROM leases WHERE task_id = ?')
            .get(taskId) as { task_id: string } | undefined;
          if (existing === undefined) {
            db.prepare('INSERT INTO leases (task_id, owner_id, lease_until) VALUES (?, ?, ?)').run(
              taskId,
              ownerId,
              until,
            );
            won = true;
          }
        }
        if (won) {
          insertEvent(db, clock, {
            runId,
            taskId,
            type: 'LEASE_CLAIMED',
            payload: { taskId, ownerId, leaseUntil: until },
          });
        }
        return won;
      });
    },

    renew(taskId, ownerId, ttlMs) {
      return inTx(() => {
        const now = clock.now();
        const until = now + ttlMs;
        const updated = db
          .prepare(
            'UPDATE leases SET lease_until = ? WHERE task_id = ? AND owner_id = ? AND lease_until >= ?',
          )
          .run(until, taskId, ownerId, now);
        const ok = updated.changes === 1;
        if (ok) {
          insertEvent(db, clock, {
            runId,
            taskId,
            type: 'LEASE_RENEWED',
            payload: { taskId, ownerId, leaseUntil: until },
          });
        }
        return ok;
      });
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

    close() {
      db.close();
    },
  };
}
