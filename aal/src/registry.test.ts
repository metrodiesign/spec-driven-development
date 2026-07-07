// RED in task 2 (createRegistry throws NotImplemented); GREEN in task 3.
// Proves conformance-gated registration + drift-canary staleness (REQ-2).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRegistry } from './registry.ts';
import { FakeAdapter } from './fake-adapter.ts';
import type { ConformanceRecord, ProbeVerdict } from './protocol.ts';
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
