// Append-only event log on SQLite WAL (spec §6.2, INV-10). INSERT-only API:
// this module deliberately exposes no update/delete for events.

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

export function openEventLog(_dbPath: string, _clock: Clock): EventLog {
  throw new Error('NotImplemented: openEventLog');
}
