// RED in task 2 (createRouter throws NotImplemented); GREEN in task 3.
// Proves capability match + clean no_capacity (REQ-6.1/6.2).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRegistry } from './registry.ts';
import { createRouter, NoCapacityError } from './router.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { type ConformanceRecord } from './protocol.ts';
import { PASS_FAIL_PROBES } from './protocol.ts';

function passing(id: string, susceptibilityScore = 0): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'fake-1.0',
    ranAt: '2026-07-06T00:00:00Z',
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: `blob://${p}` })),
    p7: { susceptibilityScore, evidenceRef: 'blob://p7' },
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

// --- RouteHints (REQ-5) ---

test('no hints -> Phase-2 behavior byte-identical (REQ-5.1)', () => {
  const reg = createRegistry();
  const risky = new FakeAdapter({ id: 'risky', lineage: 'familyB' });
  reg.register(risky, passing('risky', 1)); // high susceptibility, but no hint filters it
  const router = createRouter(reg);
  assert.equal(router.route('implementer'), risky);
  assert.deepEqual(router.eligibleAdapters('implementer'), reg.eligible('implementer'));
});

test('maxSusceptibility excludes adapters above the cap (REQ-5.2)', () => {
  const reg = createRegistry();
  const safe = new FakeAdapter({ id: 'safe' });
  const risky = new FakeAdapter({ id: 'risky' });
  reg.register(safe, passing('safe', 0.2));
  reg.register(risky, passing('risky', 0.9));
  const router = createRouter(reg);
  const eligible = router.eligibleAdapters('implementer', { maxSusceptibility: 0.5 });
  assert.deepEqual(eligible.map((r) => r.record.adapterId), ['safe'], 'high-P7 adapter filtered out');
  assert.equal(router.route('implementer', { maxSusceptibility: 0.5 }), safe);
  // The boundary is inclusive: score == cap survives.
  assert.equal(router.eligibleAdapters('implementer', { maxSusceptibility: 0.9 }).length, 2);
});

test('excludeLineages excludes adapters whose lineage is listed (REQ-5.3)', () => {
  const reg = createRegistry();
  const adapterA = new FakeAdapter({ id: 'adapterA', lineage: 'familyA' });
  const adapterB = new FakeAdapter({ id: 'adapterB', lineage: 'familyB' });
  reg.register(adapterA, passing('adapterA'));
  reg.register(adapterB, passing('adapterB'));
  const router = createRouter(reg);
  const eligible = router.eligibleAdapters('test_designer', { excludeLineages: ['familyB'] });
  assert.deepEqual(eligible.map((r) => r.lineage), ['familyA']);
});

test('filtering to empty -> route throws NoCapacityError; eligibleAdapters returns [] (REQ-5.4)', () => {
  const reg = createRegistry();
  reg.register(new FakeAdapter({ id: 'only', lineage: 'familyB' }), passing('only'));
  const router = createRouter(reg);
  assert.deepEqual(router.eligibleAdapters('test_designer', { excludeLineages: ['familyB'] }), []);
  assert.throws(() => router.route('test_designer', { excludeLineages: ['familyB'] }), (e: unknown) => e instanceof NoCapacityError);
});

test('reviewer role routes any conformant adapter (REQ-4.2)', () => {
  const reg = createRegistry();
  const a = new FakeAdapter({ id: 'judge' });
  reg.register(a, passing('judge'));
  assert.equal(createRouter(reg).route('reviewer'), a);
});
