// Automation guard (REQ-16) — pure decision + policy loader. The guard is
// scheduler-agnostic (REQ-16.5): no event log, no process, no clock — just the
// estimate, the threshold, and the override.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { decideAutomationStart, loadAutomationConfig } from './guards.ts';

test('under-threshold estimate starts (REQ-16.2 non-trip)', () => {
  const d = decideAutomationStart({ estimate: { fiveHourPct: 40, weeklyPct: 70 }, thresholdPercent: 85, override: false });
  assert.deepEqual(d, { ok: true, overridden: false });
});

test('max window at/over threshold defers with the tripping window + reset (REQ-16.2, AZ-19)', () => {
  const d = decideAutomationStart({
    estimate: { fiveHourPct: 90, weeklyPct: 55 },
    thresholdPercent: 85,
    override: false,
    resets: { fiveHour: '2026-07-07T20:00:00.000Z', weekly: '2026-07-12T00:00:00.000Z' },
  });
  assert.deepEqual(d, { defer: true, reason: 'quota_threshold', window: 'fiveHour', percent: 90, until: '2026-07-07T20:00:00.000Z' });
});

test('the WEEKLY window trips when it is the larger one; until = its reset', () => {
  const d = decideAutomationStart({
    estimate: { fiveHourPct: 60, weeklyPct: 88 },
    thresholdPercent: 85,
    override: false,
    resets: { weekly: '2026-07-12T00:00:00.000Z' },
  });
  assert.deepEqual(d, { defer: true, reason: 'quota_threshold', window: 'weekly', percent: 88, until: '2026-07-12T00:00:00.000Z' });
});

test('the boundary is inclusive — exactly the threshold defers', () => {
  const d = decideAutomationStart({ estimate: { fiveHourPct: 85, weeklyPct: 10 }, thresholdPercent: 85, override: false });
  assert.equal('defer' in d, true);
});

test('a missing reset omits `until` but still defers (no undefined key under exactOptionalPropertyTypes)', () => {
  const d = decideAutomationStart({ estimate: { fiveHourPct: 99, weeklyPct: 1 }, thresholdPercent: 85, override: false });
  assert.deepEqual(d, { defer: true, reason: 'quota_threshold', window: 'fiveHour', percent: 99 });
});

test('a null estimate defers fail-closed as estimate_unavailable (REQ-16.6, AZ-10)', () => {
  const d = decideAutomationStart({ estimate: null, thresholdPercent: 85, override: false });
  assert.deepEqual(d, { defer: true, reason: 'estimate_unavailable' });
});

test('--force-quota-override bypasses the refusal, even a null estimate (REQ-16.4)', () => {
  assert.deepEqual(
    decideAutomationStart({ estimate: null, thresholdPercent: 85, override: true }),
    { ok: true, overridden: true },
  );
  assert.deepEqual(
    decideAutomationStart({ estimate: { fiveHourPct: 99, weeklyPct: 99 }, thresholdPercent: 85, override: true }),
    { ok: true, overridden: true },
  );
});

test('loadAutomationConfig reads the shipped policy (REQ-16.3 Sonnet default)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-'));
  try {
    writeFileSync(join(dir, 'automation.json'), JSON.stringify({ thresholdPercent: 70, autonomousModel: 'sonnet', auditSampleRate: 100 }));
    assert.deepEqual(loadAutomationConfig(join(dir, 'automation.json')), {
      thresholdPercent: 70,
      autonomousModel: 'sonnet',
      auditSampleRate: 100,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing/corrupt automation.json falls back to conservative defaults (never loosens)', () => {
  assert.deepEqual(loadAutomationConfig(join(tmpdir(), 'does-not-exist-automation.json')), {
    thresholdPercent: 85,
    autonomousModel: 'sonnet',
    auditSampleRate: 25,
  });
});

test('the SHIPPED .ai/policies/automation.json parses to the production defaults', () => {
  const shipped = loadAutomationConfig(join(import.meta.dirname, '..', '..', '..', '.ai', 'policies', 'automation.json'));
  assert.equal(shipped.thresholdPercent, 85);
  assert.equal(shipped.autonomousModel, 'sonnet');
  assert.equal(shipped.auditSampleRate, 25, 'production rate is 25; the CI fixture overrides to 100 (REQ-18.4)');
});
