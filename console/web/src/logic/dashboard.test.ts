import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dashboardRoute, latestPrQuality, usageEstimateLines, type UsageEstimateView } from './dashboard.ts';
import type { PrGateProjection } from './pr-quality.ts';

test('Dashboard summaries route to owning Console views and preserve project context', () => {
  const current = { area: 'dashboard' as const, view: null, project: 'project-1', item: 'ignored' };
  assert.deepEqual(dashboardRoute(current, 'system'), { area: 'console', view: 'system', project: 'project-1', item: null });
  assert.deepEqual(dashboardRoute(current, 'usage'), { area: 'console', view: 'usage', project: 'project-1', item: null });
  assert.deepEqual(dashboardRoute(current, 'runs'), { area: 'console', view: 'runs', project: 'project-1', item: null });
  assert.deepEqual(dashboardRoute(current, 'pr-quality'), { area: 'console', view: 'pr-quality', project: 'project-1', item: null });
});

test('Dashboard usage summary stays labeled estimate and reports empty/current windows honestly', () => {
  const base: UsageEstimateView = {
    label: 'estimate',
    disclaimer: 'local estimate',
    moneyDisclaimer: 'not a bill',
    currentWindow: null,
    windowsLast7Days: 0,
    weekly: { available: false, needed: 'add reset anchor' },
  };
  assert.deepEqual(usageEstimateLines(base), ['No active five-hour window.', '0 windows in last 7 days.', 'add reset anchor']);
  assert.match(usageEstimateLines({
    ...base,
    currentWindow: { start: 'a', end: 'b', entryCount: 3 },
    weekly: { available: true, sinceReset: 'a', entryCount: 7, calibratedPercent: 42 },
  })[2] ?? '', /42% calibrated/u);
});

test('Dashboard usage derivation switches UI copy to Thai while preserving server detail', () => {
  const usage: UsageEstimateView = {
    label: 'estimate',
    disclaimer: 'server disclaimer',
    moneyDisclaimer: 'server money detail',
    currentWindow: { start: 'a', end: 'b', entryCount: 3 },
    windowsLast7Days: 2,
    weekly: { available: false, needed: 'TECHNICAL_RESET_REQUIRED' },
  };
  const rows = usageEstimateLines(usage, 'th');
  assert.match(rows[0] ?? '', /3/u);
  assert.match(rows[0] ?? '', /รายการ/u);
  assert.equal(rows[2], 'TECHNICAL_RESET_REQUIRED');
});

test('Dashboard latest PR quality uses authoritative updatedAt, then run id', () => {
  const run = (runId: string, updatedAt: string | null): PrGateProjection => ({
    runId,
    repository: 'owner/repo',
    pullRequest: 1,
    headSha: 'abc',
    state: 'COMPLETED',
    systemDecision: 'PASS',
    effectiveDecision: 'PASS',
    publication: 'PUBLISHED',
    updatedAt,
  });
  assert.equal(latestPrQuality([run('RUN-A', '2026-01-01T00:00:00Z'), run('RUN-B', '2026-01-02T00:00:00Z')])?.runId, 'RUN-B');
  assert.equal(latestPrQuality([]), null);
});
