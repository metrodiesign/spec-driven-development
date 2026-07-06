import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activityHookEntry, buildSessionSearch, evalAlerts, indexUsage, type UsageRecord } from './observe.ts';

const AGENT_PREFIX = '/home/op/.ai/runs/agent-sessions';

const RECORDS: UsageRecord[] = [
  { ts: '2026-07-01T10:00:00Z', project: 'app', model: 'sonnet', cwd: '/home/op/app' },
  { ts: '2026-07-01T11:00:00Z', project: 'app', model: 'opus', cwd: '/home/op/app' },
  { ts: '2026-07-02T09:00:00Z', project: 'app', model: 'sonnet', cwd: `${AGENT_PREFIX}/x` },
];

test('indexUsage groups by day/project/model and splits by cwd (REQ-18.1/18.2)', () => {
  const idx = indexUsage(RECORDS, AGENT_PREFIX);
  assert.equal(idx.byDay['2026-07-01'], 2);
  assert.equal(idx.byProject['app'], 3);
  assert.equal(idx.byModel['sonnet'], 2);
  assert.equal(idx.interactive, 2);
  assert.equal(idx.autonomous, 1, 'agent-sessions cwd counts as autonomous');
  assert.equal(idx.label, 'estimate');
});

test('evalAlerts fires at threshold with an interactive/non-interactive label (REQ-18.3)', () => {
  const idx = indexUsage(RECORDS, AGENT_PREFIX);
  const alerts = evalAlerts(idx, [
    { name: 'auto-cap', metric: 'autonomous', limit: 1 },
    { name: 'int-cap', metric: 'interactive', limit: 99 },
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.name, 'auto-cap');
  assert.equal(alerts[0]?.kind, 'non-interactive');
});

test('activityHookEntry is fail-open with a bounded timeout (REQ-19.1)', () => {
  const e = activityHookEntry('http://127.0.0.1:9119/api/events/ingest', 'tok', 1500);
  assert.equal(e['failOpen'], true);
  assert.match(String(e['command']), /\|\| true/, 'never blocks Claude Code on failure');
  assert.match(String(e['command']), /x-ingest-token: tok/);
});

test('FTS5 session search finds by content, rebuildable (REQ-20.1)', () => {
  const s = buildSessionSearch([
    { sessionId: 's1', project: 'app', text: 'implement authentication with refresh tokens' },
    { sessionId: 's2', project: 'app', text: 'fix the pagination bug' },
  ]);
  try {
    assert.deepEqual(s.search('authentication').map((r) => r.sessionId), ['s1']);
    assert.deepEqual(s.search('pagination').map((r) => r.sessionId), ['s2']);
    assert.equal(s.search('nonexistentword').length, 0);
  } finally {
    s.close();
  }
});
