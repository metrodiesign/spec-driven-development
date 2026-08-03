import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openEventLog } from './event-log.ts';
import type { Clock } from '../types.ts';

function tempDb(): { dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'event-log-'));
  return { dbPath: join(dir, 'events.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fixedClock: Clock = { now: () => 1_000_000 };

test('append assigns increasing seq and preserves payload (REQ-3.1)', () => {
  const t = tempDb();
  try {
    const log = openEventLog(t.dbPath, fixedClock);
    const a = log.append({ runId: 'R', taskId: 'T', type: 'TASK_STATE', payload: { state: 'READY' } });
    const b = log.append({ runId: 'R', taskId: 'T', type: 'TASK_STATE', payload: { state: 'IMPLEMENTING' } });
    assert.ok(b.seq > a.seq);
    const all = log.all();
    assert.equal(all.length, 2);
    assert.deepEqual(all[0]?.payload, { state: 'READY' });
    log.close();
  } finally {
    t.cleanup();
  }
});

test('log API is INSERT-only — no update/delete surface (REQ-3.1)', () => {
  const t = tempDb();
  try {
    const log = openEventLog(t.dbPath, fixedClock);
    const surface = Object.keys(log).sort();
    assert.deepEqual(surface, ['all', 'append', 'appendFenced', 'close', 'exportJsonl', 'projection']);
    log.close();
  } finally {
    t.cleanup();
  }
});

test('projection rebuilds purely from events and matches a fold of all() (REQ-3.2)', () => {
  const t = tempDb();
  try {
    const log = openEventLog(t.dbPath, fixedClock);
    log.append({ runId: 'R', taskId: 'T1', type: 'TASK_STATE', payload: { state: 'READY' } });
    log.append({ runId: 'R', taskId: 'T1', type: 'TASK_STATE', payload: { state: 'VERIFYING' } });
    log.append({ runId: 'R', taskId: 'T2', type: 'TASK_STATE', payload: { state: 'PROPOSED' } });
    log.append({ runId: 'R', taskId: null, type: 'GOVERNANCE_CHANGE', payload: { k: 'v' } });

    const proj = log.projection();
    assert.equal(proj.eventCount, 4);
    assert.equal(proj.tasks['T1']?.state, 'VERIFYING');
    assert.equal(proj.tasks['T2']?.state, 'PROPOSED');

    // Independent fold over all() must agree (rebuild-equality).
    const fold: Record<string, string> = {};
    for (const e of log.all()) {
      if (e.type === 'TASK_STATE' && e.taskId !== null) fold[e.taskId] = String(e.payload['state']);
    }
    assert.deepEqual(
      Object.fromEntries(Object.entries(proj.tasks).map(([k, v]) => [k, v.state])),
      fold,
    );
    log.close();
  } finally {
    t.cleanup();
  }
});

test('exportJsonl emits one parseable event per line (REQ-3.3)', () => {
  const t = tempDb();
  try {
    const log = openEventLog(t.dbPath, fixedClock);
    log.append({ runId: 'R', taskId: 'T', type: 'ESCALATED', payload: { why: 'budget' } });
    log.append({ runId: 'R', taskId: 'T', type: 'BUDGET_EXCEEDED', payload: { limit: 'iterations' } });
    const lines = log.exportJsonl().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { type: string };
      assert.ok(['ESCALATED', 'BUDGET_EXCEEDED'].includes(parsed.type));
    }
    log.close();
  } finally {
    t.cleanup();
  }
});
