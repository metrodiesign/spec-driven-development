// Append-only event log on SQLite WAL (spec §6.2, INV-10). INSERT-only API:
// this module deliberately exposes no update/delete for events.

import type { DatabaseSync } from 'node:sqlite';

import { insertEvent, openDatabase } from './schema.ts';
import type { Clock, EventType, PlatformEvent } from '../types.ts';

export interface ProjectionState {
  tasks: Record<string, { state: string; lastSeq: number }>;
  eventCount: number;
}

export interface EventLog {
  append(e: {
    runId: string;
    taskId: string | null;
    type: EventType;
    payload: Record<string, unknown>;
  }): PlatformEvent;
  all(filter?: { taskId?: string; type?: EventType }): PlatformEvent[];
  exportJsonl(): string;
  /** Rebuild purely from stored events (REQ-3.2). */
  projection(): ProjectionState;
  close(): void;
}

interface EventRow {
  seq: number;
  ts: string;
  run_id: string;
  task_id: string | null;
  type: string;
  payload: string;
}

function rowToEvent(r: EventRow): PlatformEvent {
  return {
    seq: r.seq,
    ts: r.ts,
    runId: r.run_id,
    taskId: r.task_id,
    type: r.type as EventType,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  };
}

export function openEventLog(dbPath: string, clock: Clock): EventLog {
  const db: DatabaseSync = openDatabase(dbPath);

  return {
    append(e) {
      const { seq, ts } = insertEvent(db, clock, e);
      return { seq, ts, runId: e.runId, taskId: e.taskId, type: e.type, payload: e.payload };
    },

    all(filter) {
      const clauses: string[] = [];
      const params: (string | null)[] = [];
      if (filter?.taskId !== undefined) {
        clauses.push('task_id = ?');
        params.push(filter.taskId);
      }
      if (filter?.type !== undefined) {
        clauses.push('type = ?');
        params.push(filter.type);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT seq, ts, run_id, task_id, type, payload FROM events${where} ORDER BY seq`)
        .all(...params) as unknown as EventRow[];
      return rows.map(rowToEvent);
    },

    exportJsonl() {
      return this.all()
        .map((e) => JSON.stringify(e))
        .join('\n');
    },

    projection() {
      const state: ProjectionState = { tasks: {}, eventCount: 0 };
      for (const e of this.all()) {
        state.eventCount += 1;
        if (e.type === 'TASK_STATE' && e.taskId !== null) {
          state.tasks[e.taskId] = { state: String(e.payload['state']), lastSeq: e.seq };
        }
      }
      return state;
    },

    close() {
      db.close();
    },
  };
}
