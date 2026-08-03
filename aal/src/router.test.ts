// RED in task 2 (createRouter throws NotImplemented); GREEN in task 3.
// Proves capability match + clean no_capacity (REQ-6.1/6.2).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRegistry } from './registry.ts';
import { type RegisteredAdapter, type Registry } from './registry.ts';
import { createRouter, NoCapacityError, wrapRouterForOutcome, type Router } from './router.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { type ShadowOutcomeStats } from './shadow.ts';
import { type ConformanceRecord } from './protocol.ts';
import { PASS_FAIL_PROBES } from './protocol.ts';
import { type EventLog, type PlatformEvent } from 'core';

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

// --- wrapRouterForOutcome (REQ-15) — isolated from a real registry so every
// precedence branch (frozen/insufficient_data/reorder/epsilon) is provable
// directly, mirroring loop-run.test.ts's wrapRouterForShadow fakes. ---

function registeredAdapter(id: string, stale = false): RegisteredAdapter {
  return {
    adapter: new FakeAdapter({ id }),
    record: {
      adapterId: id,
      modelVersion: 'v1',
      ranAt: '2026-07-09T00:00:00Z',
      probes: [],
      p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
    },
    stale,
    susceptibilityScore: 0,
    lineage: 'unknown',
  };
}

function fakeRouterFrom(eligible: RegisteredAdapter[]): Router {
  return {
    route: () => {
      throw new Error('unused by these tests');
    },
    eligibleAdapters: () => eligible,
    refreshHealth: async () => [],
  };
}

function fakeRegistryFrom(all: RegisteredAdapter[]): Registry {
  return {
    register: () => undefined,
    recordConformance: () => undefined,
    eligible: () => all,
    all: () => all,
    refreshHealth: async () => [],
    get: () => undefined,
  };
}

function fakeLog(): EventLog & { appended: PlatformEvent[] } {
  const appended: PlatformEvent[] = [];
  let seq = 0;
  return {
    appended,
    append(e) {
      seq += 1;
      const event: PlatformEvent = { seq, ts: `t${seq}`, ...e };
      appended.push(event);
      return event;
    },
    appendFenced(e) {
      return this.append(e);
    },
    all(filter) {
      return appended.filter(
        (e) =>
          (filter?.type === undefined || e.type === filter.type) &&
          (filter?.taskId === undefined || e.taskId === filter.taskId),
      );
    },
    exportJsonl: () => '',
    projection: () => ({ tasks: {}, eventCount: appended.length }),
    close: () => undefined,
  };
}

function outcomeDeps(registry: Registry, log: EventLog, stats: Record<string, ShadowOutcomeStats>, epsilonPercent = 0) {
  return { registry, stats: () => stats, epsilonPercent, exploreKey: () => 'RUN-1:T-1:0', log, runId: 'RUN-1', taskId: 'T-1' };
}

test('a stale registered adapter freezes to the unwrapped router order — ROUTING_FROZEN only, no OUTCOME_ROUTE (REQ-15.5)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b', true)];
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(
    fakeRouterFrom(adapters),
    outcomeDeps(fakeRegistryFrom(adapters), log, { 'a@v1': { attempts: 5, reviewingReached: 5 } }, 100),
  );
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(order, adapters, 'unwrapped router order — no reorder despite a rated adapter + epsilon 100');
  assert.equal(log.appended.length, 1);
  assert.equal(log.appended[0]?.type, 'ROUTING_FROZEN');
});

test('no rated adapter yet -> order unchanged, basis insufficient_data (REQ-15.7)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, {}, 0));
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(order, adapters);
  assert.equal(log.appended.length, 1);
  assert.equal(log.appended[0]?.type, 'OUTCOME_ROUTE');
  assert.deepEqual(log.appended[0]?.payload, {
    role: 'implementer',
    order: ['a@v1', 'b@v1'],
    explored: false,
    basis: 'insufficient_data',
  });
});

test('stats present but all-zero attempts also count as insufficient_data, same as no entry at all (REQ-15.7)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const stats = { 'a@v1': { attempts: 0, reviewingReached: 0 }, 'b@v1': { attempts: 0, reviewingReached: 0 } };
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 0));
  assert.deepEqual(wrapped.eligibleAdapters('implementer'), adapters);
  assert.equal(log.appended[0]?.payload['basis'], 'insufficient_data');
});

test('reorders by reviewing-reached rate desc; an unrated adapter keeps its original slot (REQ-15.1)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b'), registeredAdapter('c')]; // b unrated
  const stats = {
    'a@v1': { attempts: 10, reviewingReached: 3 }, // 0.3
    'c@v1': { attempts: 10, reviewingReached: 9 }, // 0.9
  };
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 0));
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(order.map((r) => r.record.adapterId), ['c', 'b', 'a'], 'c (0.9) then a (0.3) reorder around b, which never moves from slot 1');
  assert.equal(log.appended[0]?.payload['basis'], 'reorder');
  assert.equal(log.appended[0]?.payload['explored'], false, 'epsilon 0 never fires');
});

test('a tied rate keeps router order — stable sort, never randomized (REQ-15.1/15.3)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const stats = { 'a@v1': { attempts: 4, reviewingReached: 2 }, 'b@v1': { attempts: 8, reviewingReached: 4 } }; // both 0.5
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 0));
  assert.deepEqual(wrapped.eligibleAdapters('implementer').map((r) => r.record.adapterId), ['a', 'b']);
});

test('epsilon 100 always swaps 0/1 once a reorder occurred and eligible >= 2 (REQ-15.2)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const stats = { 'a@v1': { attempts: 10, reviewingReached: 9 }, 'b@v1': { attempts: 10, reviewingReached: 1 } }; // a wins the reorder
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 100));
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(order.map((r) => r.record.adapterId), ['b', 'a'], 'reorder puts a first, epsilon 100 swaps it back to b first');
  assert.equal(log.appended[0]?.payload['explored'], true);
  assert.equal(log.appended[0]?.payload['basis'], 'reorder');
});

test('epsilon never fires with fewer than 2 eligible entries, even at epsilon 100 (REQ-15.2)', () => {
  const adapters = [registeredAdapter('a')];
  const stats = { 'a@v1': { attempts: 5, reviewingReached: 5 } };
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 100));
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(order.map((r) => r.record.adapterId), ['a']);
  assert.equal(log.appended[0]?.payload['explored'], false);
});

test('epsilon never fires on an insufficient_data round, even at epsilon 100 (precedence AZ-11)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, {}, 100));
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(order, adapters);
  assert.equal(log.appended[0]?.payload['explored'], false);
  assert.equal(log.appended[0]?.payload['basis'], 'insufficient_data');
});

test('identical inputs -> identical order and explored, every call — no RNG (REQ-15.3)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b'), registeredAdapter('c')];
  const stats = { 'a@v1': { attempts: 10, reviewingReached: 2 }, 'c@v1': { attempts: 10, reviewingReached: 8 } };
  const deps = outcomeDeps(fakeRegistryFrom(adapters), fakeLog(), stats, 50);
  const first = wrapRouterForOutcome(fakeRouterFrom(adapters), deps).eligibleAdapters('implementer');
  const second = wrapRouterForOutcome(fakeRouterFrom(adapters), deps).eligibleAdapters('implementer');
  assert.deepEqual(first, second);
});

test('a persistently-failing log never blocks the round — safeAppend swallows the fallback ERROR throw too (PR #50 review)', () => {
  // Both the primary append and the fallback ERROR append throw; the round order is
  // already decided, so eligibleAdapters must still return, not double-throw out.
  const throwingLog: EventLog = {
    append() { throw new Error('disk full'); },
    appendFenced() { throw new Error('disk full'); },
    all: () => [],
    exportJsonl: () => '',
    projection: () => ({ tasks: {}, eventCount: 0 }),
    close: () => undefined,
  };
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const stats = { 'a@v1': { attempts: 10, reviewingReached: 9 }, 'b@v1': { attempts: 10, reviewingReached: 1 } };
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), throwingLog, stats, 100));
  assert.doesNotThrow(() => {
    const order = wrapped.eligibleAdapters('implementer');
    assert.deepEqual(order.map((r) => r.record.adapterId), ['b', 'a'], 'the reorder+epsilon result still returns despite the failing log');
  });
});

test('record:false peeks the reordered order but appends NOTHING — fusion panel reads the governed order without polluting stats (REQ-16.2, PR #64 review)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const stats = { 'a@v1': { attempts: 10, reviewingReached: 1 }, 'b@v1': { attempts: 10, reviewingReached: 9 } }; // b outranks a
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 0));
  const peeked = wrapped.eligibleAdapters('planner', undefined, { record: false }).map((r) => r.record.adapterId);
  assert.deepEqual(peeked, ['b', 'a'], 'the learned reorder IS applied on a peek — same governed order the task loop sees');
  assert.equal(log.appended.length, 0, 'but no OUTCOME_ROUTE/ROUTING_FROZEN is recorded for a peek');
  // a normal (recording) call on the SAME wrapper still records, proving the flag is the only difference
  wrapped.eligibleAdapters('implementer');
  assert.equal(log.appended.length, 1, 'a recording call still appends exactly one OUTCOME_ROUTE');
  assert.equal(log.appended[0]?.type, 'OUTCOME_ROUTE');
});

test('epsilon explores the RATED runner-up, never an unrated adapter pinned at index 1 (PR #50 review)', () => {
  // c (i0, rated .3) < a (i2, rated .9) is the real winner/runner-up pair; b (i1) is
  // unrated and must never move from its pinned slot, let alone get swapped in.
  const adapters = [registeredAdapter('c'), registeredAdapter('b'), registeredAdapter('a')];
  const stats = { 'c@v1': { attempts: 10, reviewingReached: 3 }, 'a@v1': { attempts: 10, reviewingReached: 9 } };
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 100));
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(
    order.map((r) => r.record.adapterId),
    ['c', 'b', 'a'],
    'winner (a) and rated runner-up (c) swap; unrated b never moves from slot 1',
  );
  assert.equal(log.appended[0]?.payload['explored'], true);
});

test('epsilon never fires with only one rated adapter — no rated runner-up to explore (PR #50 review)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')]; // b unrated
  const stats = { 'a@v1': { attempts: 10, reviewingReached: 5 } };
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 100));
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(order.map((r) => r.record.adapterId), ['a', 'b'], 'no swap — b has zero evidence, not a real runner-up');
  assert.equal(log.appended[0]?.payload['explored'], false);
});

test('never invents or drops a candidate — only permutes what the filtered eligible set already contains (REQ-15.6)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b'), registeredAdapter('c')];
  const stats = { 'a@v1': { attempts: 10, reviewingReached: 1 }, 'c@v1': { attempts: 10, reviewingReached: 9 } };
  const log = fakeLog();
  const wrapped = wrapRouterForOutcome(fakeRouterFrom(adapters), outcomeDeps(fakeRegistryFrom(adapters), log, stats, 0));
  const order = wrapped.eligibleAdapters('implementer');
  assert.deepEqual(new Set(order.map((r) => r.record.adapterId)), new Set(['a', 'b', 'c']));
  assert.equal(order.length, adapters.length);
});
