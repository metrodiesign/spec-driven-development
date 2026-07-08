// Capstone composition E2E (REQ-11.1) with the FakeAdapter — no quota, CI-safe.
// Proves the full wiring (core + AAL + context + adapter -> runTaskLoop on the
// fixture) reaches REVIEWING and the calibration MATH is computed. The numbers
// here are scripted and are NEVER reported as §12 metrics (REQ-11.2); real
// numbers come from a manual live run (task 11 runbook).
//
// Phase 2 (REQ-18.1): the run now starts a live Human Plane server (steering/kill/
// governance wired) and takes an injected Clock; a governance-approved deferred
// quarantine takes effect on load (REQ-9.5).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runSupervisedLoop, wrapRouterForShadow } from './loop-run.ts';
import { FakeAdapter, type RegisteredAdapter, type Registry, type Router } from 'aal';
import {
  approveProposal,
  openEventLog,
  proposeFlakyQuarantine,
  seedFixtureSnapshot,
  type EventLog,
  type EventType,
  type PlatformEvent,
  type TaskContract,
} from 'core';

const CONTRACT: TaskContract = {
  hash: 'a'.repeat(64),
  goal: { id: 'DEMO-1', title: 'demo', objective: 'edit src/impl.txt so the tests pass' },
  acceptanceCriteria: [{ id: 'AC-1', description: 'src/impl.txt contains correct', golden: true }],
  budget: { maxIterations: 4, maxCostUnits: 500, maxWallclockMs: 60_000 },
  approvalPolicy: [],
  raw: {},
};

const clock = { now: () => 1_000_000 };

test('supervised loop with the FakeAdapter reaches REVIEWING; calibration computed (harness math only)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
    });
    assert.equal(out.finalState, 'REVIEWING');
    assert.equal(out.calibration.n, 1);
    assert.equal(out.calibration.heldOutPassRate, 1, 'held-out (golden) passed — SCRIPTED, not a §12 metric');
    assert.equal(out.calibration.reproducibility, 1);

    // REQ-7.1: the composition root records shadow routes as a side channel; a
    // single registered adapter can never diverge from its own live choice.
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const shadowRoutes = log.all({ type: 'SHADOW_ROUTE' });
      assert.ok(shadowRoutes.length >= 1, 'each live route decision records a SHADOW_ROUTE event');
      assert.equal(shadowRoutes[0]?.payload['live'], shadowRoutes[0]?.payload['wouldChoose']);
    } finally {
      log.close();
    }

    // AZ-4/REQ-15.9: the run's finally block tombstones its human-plane.json on exit —
    // "ended" is discovery-file-absent-or-tombstoned, never a stale {url,token} that
    // would look live after the server that owned it has already closed.
    const metaPath = join(persistDir, 'human-plane.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { tombstoned?: boolean };
    assert.equal(meta.tombstoned, true);
    assert.equal(statSync(metaPath).mode & 0o777, 0o600, 'tombstoned discovery file stays 0600');
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

// An L1 task (declared risk in the frozen contract) with a golden-backed AC — the
// input the auto-merge gate needs to fire (REQ-7.2).
const L1_CONTRACT: TaskContract = { ...CONTRACT, raw: { risk: 'L1' } };

test('E2E (REQ-18.4): an L1 task auto-merges + the sampled audit reproduces -> COMPLETED', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
  try {
    const out = await runSupervisedLoop({
      contract: L1_CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      // Fixture rate 100 -> the sampled path always runs, deterministically (REQ-18.4).
      autoMerge: { auditSampleRate: 100, depManifestPatterns: ['package.json', 'pnpm-lock.yaml'] },
    });
    assert.equal(out.finalState, 'COMPLETED', 'L0/L1 green + golden ACs auto-merge to COMPLETED');

    // The audit trail proves it was a POLICY decision + a reproduced sampled audit,
    // never a human approval (REQ-7.2/8.2/8.6).
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const approved = log.all({ type: 'AUTO_APPROVED' });
      assert.equal(approved.length, 1);
      assert.equal(approved[0]?.payload['by'], 'auto_merge_policy');
      assert.equal(log.all({ type: 'AUDIT_SAMPLED' }).length, 1);
      const result = log.all({ type: 'AUDIT_RESULT' }).at(-1);
      assert.equal(result?.payload['sampled'], true);
      assert.equal(result?.payload['reproduced'], true, 'the clean-checkout T1 reproduced the loop T1');
      assert.equal(log.all({ type: 'APPROVAL_RECORDED' }).length, 0, 'no human approval on the auto path');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test(
  'E2E (REQ-5 production): an L1 task FAILS, self-repairs via a confirmed hypothesis, then auto-merges -> COMPLETED',
  { skip: process.platform !== 'darwin' ? 'darwin-only RUN_COMMAND sandbox (D-003)' : false },
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-repair-'));
    try {
      const out = await runSupervisedLoop({
        contract: L1_CONTRACT,
        // `repairable`: writes the wrong marker first (T1 fails -> DIAGNOSING), then the
        // correct one after the hypothesis is confirmed by a real sandboxed probe.
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', behavior: 'repairable', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
      });
      assert.equal(out.finalState, 'COMPLETED');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        // The AAL PRODUCED hypotheses and core PROBED them itself (INV-1): a real probe
        // ran and confirmed, proving the source->loop->engine production path.
        assert.ok(log.all({ type: 'PROBE_RUN' }).length >= 1, 'a probe ran through the executor');
        assert.equal(log.all({ type: 'HYPOTHESIS_CONFIRMED' }).length, 1);
        // ...and the confirmed repair carried on to a reproduced auto-merge.
        assert.equal(log.all({ type: 'AUTO_APPROVED' }).length, 1);
        assert.equal(log.all({ type: 'AUDIT_RESULT' }).at(-1)?.payload['reproduced'], true);
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test('a non-golden / no-risk task routes to the approval package — finalState stays REVIEWING (REQ-7.6/7.7)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-appkg-'));
  try {
    // CONTRACT has no `risk` -> defaults to L2 -> approval package, not auto-merge.
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
    });
    assert.equal(out.finalState, 'REVIEWING', 'L2 (default) never auto-merges');
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'AUTO_APPROVED' }).length, 0);
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('a governance-approved flaky_quarantine takes effect on load — the task is quarantined, never run (REQ-9.5)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-gov-'));
  const policyDir = mkdtempSync(join(tmpdir(), 'loop-pol-'));
  try {
    const logPath = join(persistDir, 'governance.jsonl');
    // Seed an approved policy snapshot (so policy is not the blocker), then approve a
    // deferred flaky_quarantine for T-1 via the CLI-equivalent append.
    seedFixtureSnapshot({ policyDir, logPath, clock });
    const proposal = proposeFlakyQuarantine({ logPath, taskId: 'T-1', clock });
    approveProposal({ logPath, id: proposal.id, clock, decidedBy: 'human' });

    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      governanceLogPath: logPath,
    });
    assert.equal(out.finalState, 'QUARANTINED');
    assert.equal(out.iterations, 0, 'a quarantined task never runs the loop');
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
    rmSync(policyDir, { recursive: true, force: true });
  }
});

// --- wrapRouterForShadow (REQ-7): isolated from the fixture so freeze/failure
// scenarios that the single-adapter E2E loop above can never exercise are
// provable directly. ---

function registeredAdapter(id: string, stale = false): RegisteredAdapter {
  return {
    adapter: new FakeAdapter({ id }),
    record: {
      adapterId: id,
      modelVersion: 'v1',
      ranAt: '2026-07-08T00:00:00Z',
      probes: [],
      p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
    },
    stale,
    susceptibilityScore: 0,
    lineage: 'unknown',
  };
}

function fakeRouter(eligible: RegisteredAdapter[]): Router {
  return {
    route: () => {
      throw new Error('unused by these tests');
    },
    eligibleAdapters: () => eligible,
    refreshHealth: async () => [],
  };
}

function fakeRegistry(all: RegisteredAdapter[]): Registry {
  return {
    register: () => undefined,
    recordConformance: () => undefined,
    eligible: () => all,
    all: () => all,
    refreshHealth: async () => [],
    get: () => undefined,
  };
}

function fakeLog(failType?: EventType): EventLog & { appended: PlatformEvent[] } {
  const appended: PlatformEvent[] = [];
  let seq = 0;
  return {
    appended,
    append(e) {
      if (failType !== undefined && e.type === failType) throw new Error('append failed');
      seq += 1;
      const event: PlatformEvent = { seq, ts: `t${seq}`, ...e };
      appended.push(event);
      return event;
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

test('wrapRouterForShadow never alters the eligible list — with or without the recorder (REQ-7.4)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const router = fakeRouter(adapters);
  const wrapped = wrapRouterForShadow(router, {
    registry: fakeRegistry(adapters),
    log: fakeLog(),
    runId: 'RUN-1',
    taskId: 'T-1',
  });
  assert.deepEqual(wrapped.eligibleAdapters('implementer'), router.eligibleAdapters('implementer'));
});

test('wrapRouterForShadow records a SHADOW_ROUTE event carrying the live choice (REQ-7.1/7.2)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const log = fakeLog();
  const wrapped = wrapRouterForShadow(fakeRouter(adapters), {
    registry: fakeRegistry(adapters),
    log,
    runId: 'RUN-1',
    taskId: 'T-1',
  });
  wrapped.eligibleAdapters('implementer');
  assert.equal(log.appended.length, 1);
  const event = log.appended[0];
  assert.equal(event?.type, 'SHADOW_ROUTE');
  assert.equal(event?.payload['role'], 'implementer');
  assert.equal(event?.payload['live'], 'a@v1');
  assert.equal(event?.payload['frozen'], false);
  assert.equal(event?.payload['basis'], 'insufficient_data', 'no outcome history yet');
});

test('any registered adapter gone stale freezes recording — no SHADOW_ROUTE appended (REQ-7.3)', () => {
  const adapters = [registeredAdapter('a'), registeredAdapter('b', true)];
  const log = fakeLog();
  const wrapped = wrapRouterForShadow(fakeRouter(adapters), {
    registry: fakeRegistry(adapters),
    log,
    runId: 'RUN-1',
    taskId: 'T-1',
  });
  const eligible = wrapped.eligibleAdapters('implementer');
  assert.equal(eligible.length, 2, 'the recorder never filters — that stays eligibleAdapters()\'s own job');
  assert.equal(log.appended.length, 0, 'frozen -> recording skipped entirely');
});

test('a failed SHADOW_ROUTE append logs ERROR and continues — the round is never blocked (REQ-7.5)', () => {
  const adapters = [registeredAdapter('a')];
  const log = fakeLog('SHADOW_ROUTE');
  const wrapped = wrapRouterForShadow(fakeRouter(adapters), {
    registry: fakeRegistry(adapters),
    log,
    runId: 'RUN-1',
    taskId: 'T-1',
  });
  const eligible = wrapped.eligibleAdapters('implementer');
  assert.equal(eligible.length, 1, 'the recording failure never blocks the live route');
  assert.equal(log.appended.length, 1);
  assert.equal(log.appended[0]?.type, 'ERROR');
  assert.equal(log.appended[0]?.payload['reason'], 'shadow_append_failed');
});

test('no eligible adapters -> nothing to shadow, no event appended', () => {
  const log = fakeLog();
  const wrapped = wrapRouterForShadow(fakeRouter([]), {
    registry: fakeRegistry([]),
    log,
    runId: 'RUN-1',
    taskId: 'T-1',
  });
  assert.deepEqual(wrapped.eligibleAdapters('implementer'), []);
  assert.equal(log.appended.length, 0);
});

test('outcome stats accumulate across rounds sharing a log — a proven adapter can shadow-diverge from the live pick (REQ-7.2)', () => {
  // 'b' routes first (registry/lineage order), but 'a' is the one with a proven
  // reviewing-reached history from earlier tasks in this same shared log.
  const adapters = [registeredAdapter('b'), registeredAdapter('a')];
  const log = fakeLog();
  log.append({ runId: 'RUN-1', taskId: 'T-old-a', type: 'SHADOW_ROUTE', payload: { role: 'implementer', live: 'a@v1', wouldChoose: 'a@v1', basis: 'insufficient_data', frozen: false } });
  log.append({ runId: 'RUN-1', taskId: 'T-old-a', type: 'TASK_STATE', payload: { state: 'REVIEWING' } });
  log.append({ runId: 'RUN-1', taskId: 'T-old-b', type: 'SHADOW_ROUTE', payload: { role: 'implementer', live: 'b@v1', wouldChoose: 'b@v1', basis: 'insufficient_data', frozen: false } });
  log.append({ runId: 'RUN-1', taskId: 'T-old-b', type: 'TASK_STATE', payload: { state: 'BLOCKED' } });

  const wrapped = wrapRouterForShadow(fakeRouter(adapters), {
    registry: fakeRegistry(adapters),
    log,
    runId: 'RUN-1',
    taskId: 'T-new',
  });
  wrapped.eligibleAdapters('implementer');
  const latest = log.appended.at(-1);
  assert.equal(latest?.type, 'SHADOW_ROUTE');
  assert.equal(latest?.payload['live'], 'b@v1', 'live choice is still eligible[0] — the recorder never influences it');
  assert.equal(latest?.payload['wouldChoose'], 'a@v1', 'a has the only proven reviewing-reached history — a real divergence');
  assert.equal(latest?.payload['basis'], 'highest_reviewing_rate');
});
