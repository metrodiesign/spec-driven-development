// Single-writer lease per task (spec §6.2, REQ-5). A claim is ONE SQLite
// transaction: CAS UPDATE -> changes()===1 -> INSERT LEASE_CLAIMED event ->
// COMMIT; otherwise ROLLBACK. Log and lease table can never diverge (INV-10).

import type { Clock } from '../types.ts';

export interface LeaseManager {
  /** True when the claim succeeded; false when another owner holds an unexpired lease. */
  claim(taskId: string, ownerId: string, ttlMs: number): boolean;
  renew(taskId: string, ownerId: string, ttlMs: number): boolean;
  release(taskId: string, ownerId: string): void;
  close(): void;
}

export function createLeaseManager(_dbPath: string, _clock: Clock, _runId: string): LeaseManager {
  throw new Error('NotImplemented: createLeaseManager');
}
