// Shared SQLite schema (WAL). The events table is the append-only source of
// truth (INV-10); the leases table is a projection maintained under the same
// transaction as its LEASE_* events, so log and table can never diverge.

import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leases (
      task_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      lease_until INTEGER NOT NULL,
      fencing_token INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS lease_fences (
      task_id TEXT PRIMARY KEY,
      fencing_token INTEGER NOT NULL
    );
  `);
  // Existing Phase-0 databases predate fencing tokens.  Migrate in place and
  // keep the migration deliberately additive so recovery never has to discard
  // an event database merely because a newer loop implementation opened it.
  try {
    db.exec('ALTER TABLE leases ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0');
  } catch (error) {
    // SQLite raises "duplicate column name" when the column already exists;
    // every other migration error must fail closed rather than silently using an
    // unfenced lease table.
    if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
  }
  return db;
}

export function insertEvent(
  db: DatabaseSync,
  clock: { now(): number },
  e: { runId: string; taskId: string | null; type: string; payload: Record<string, unknown> },
): { seq: number; ts: string } {
  const ts = new Date(clock.now()).toISOString();
  const res = db
    .prepare('INSERT INTO events (ts, run_id, task_id, type, payload) VALUES (?, ?, ?, ?, ?)')
    .run(ts, e.runId, e.taskId, e.type, JSON.stringify(e.payload));
  return { seq: Number(res.lastInsertRowid), ts };
}
