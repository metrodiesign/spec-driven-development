// RED in task 2 (createRouter throws NotImplemented); GREEN in task 3.
// Proves capability match + clean no_capacity (REQ-6.1/6.2).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRegistry } from './registry.ts';
import { createRouter, NoCapacityError } from './router.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { type ConformanceRecord } from './protocol.ts';
import { PASS_FAIL_PROBES } from './protocol.ts';

function passing(id: string): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'fake-1.0',
    ranAt: '2026-07-06T00:00:00Z',
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: `blob://${p}` })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

test('router returns the capability-matching adapter', () => {
  const reg = createRegistry();
  const adapter = new FakeAdapter({ id: 'ok' });
  reg.register(adapter, passing('ok'));
  const router = createRouter(reg);
  assert.equal(router.route('implementer'), adapter);
});

test('router surfaces no_capacity when nothing is eligible', () => {
  const reg = createRegistry();
  const router = createRouter(reg);
  try {
    router.route('implementer');
    assert.fail('should have thrown no_capacity');
  } catch (err) {
    assert.ok(err instanceof NoCapacityError);
    assert.equal((err as NoCapacityError).kind, 'no_capacity');
  }
});
