// RED in task 2 (createRegistry throws NotImplemented); GREEN in task 3.
// Proves conformance-gated registration + drift-canary staleness (REQ-2).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBreaker } from './breaker.ts';
import { createRegistry } from './registry.ts';
import { FakeAdapter } from './fake-adapter.ts';
import type { AdapterHealth, ConformanceRecord, ProbeVerdict } from './protocol.ts';
import { PASS_FAIL_PROBES } from './protocol.ts';

function record(adapterId: string, allPass: boolean): ConformanceRecord {
  const probes: ProbeVerdict[] = PASS_FAIL_PROBES.map((id) => ({
    id,
    pass: allPass,
    evidenceRef: `blob://${id}`,
  }));
  return {
    adapterId,
    modelVersion: 'fake-1.0',
    ranAt: '2026-07-06T00:00:00Z',
    probes,
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

test('registry refuses an adapter whose record fails any pass/fail probe', () => {
  const reg = createRegistry();
  assert.throws(() => reg.register(new FakeAdapter({ id: 'bad' }), record('bad', false)));
  assert.equal(reg.get('bad'), undefined);
});

test('registry accepts a fully-passing record and lists it eligible', () => {
  const reg = createRegistry();
  const adapter = new FakeAdapter({ id: 'ok' });
  reg.register(adapter, record('ok', true));
  const eligible = reg.eligible('implementer');
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]?.adapter, adapter);
  assert.equal(eligible[0]?.stale, false);
});

test('drift canary: a regressed re-run marks the adapter stale', () => {
  const reg = createRegistry();
  reg.register(new FakeAdapter({ id: 'ok' }), record('ok', true));
  reg.recordConformance('ok', record('ok', false));
  assert.equal(reg.get('ok')?.stale, true);
  assert.equal(reg.eligible('implementer').length, 0, 'stale adapter is not eligible');
});

test('an open breaker key is excluded from eligible() (REQ-1.3)', () => {
  const breaker = createBreaker({ windowSize: 1, failureThreshold: 1, openMs: 100_000 }, () => 0, () => {});
  const reg = createRegistry({ breaker });
  reg.register(new FakeAdapter({ id: 'ok' }), record('ok', true));
  assert.equal(reg.eligible('implementer').length, 1, 'closed breaker -> eligible');
  breaker.recordFailure('ok@fake-1.0', 'transport'); // 1/1 failures -> open
  assert.equal(breaker.state('ok@fake-1.0'), 'open');
  assert.equal(reg.eligible('implementer').length, 0, 'open breaker -> excluded');
});

test('refreshHealth caches a not-ok probe and excludes it; the change is returned (REQ-2.2/2.4)', async () => {
  const reg = createRegistry();
  const a = new FakeAdapter({ id: 'q', fault: 'health_unhealthy' });
  reg.register(a, record('q', true), a.healthProbe);
  assert.equal(reg.eligible('implementer').length, 1, 'ok until the first probe runs');
  const changes = await reg.refreshHealth();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.health.ok, false);
  assert.equal(changes[0]?.health.reason, 'quota_threshold');
  assert.equal(reg.eligible('implementer').length, 0, 'quota-unhealthy -> excluded');
});

test('a hung health probe times out as probe_failed (REQ-2.7)', async () => {
  const reg = createRegistry({ healthProbeTimeoutMs: 5 });
  const hang: () => Promise<AdapterHealth> = () => new Promise(() => {}); // never resolves
  reg.register(new FakeAdapter({ id: 'slow' }), record('slow', true), hang);
  const changes = await reg.refreshHealth();
  assert.equal(changes[0]?.health.ok, false);
  assert.equal(changes[0]?.health.reason, 'probe_failed');
  assert.equal(reg.eligible('implementer').length, 0, 'a hung probe never blocks, it excludes');
});

test('an absent health probe stays always-ok and emits no change (REQ-2.1)', async () => {
  const reg = createRegistry();
  reg.register(new FakeAdapter({ id: 'plain' }), record('plain', true));
  const changes = await reg.refreshHealth();
  assert.equal(changes.length, 0, 'no probe -> no QUOTA_PROBE');
  assert.equal(reg.eligible('implementer').length, 1);
});

test('diagnostician role is eligible (reasoning-only capability) (REQ-4.2)', () => {
  const reg = createRegistry();
  reg.register(new FakeAdapter({ id: 'ok' }), record('ok', true));
  assert.equal(reg.eligible('diagnostician').length, 1);
});
