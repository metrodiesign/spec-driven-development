// Capstone composition E2E (REQ-11.1) with the FakeAdapter — no quota, CI-safe.
// Proves the full wiring (core + AAL + context + adapter -> runTaskLoop on the
// fixture) reaches REVIEWING and the calibration MATH is computed. The numbers
// here are scripted and are NEVER reported as §12 metrics (REQ-11.2); real
// numbers come from a manual live run (task 11 runbook).
//
// Phase 2 (REQ-18.1): the run now starts a live Human Plane server (steering/kill/
// governance wired) and takes an injected Clock; a governance-approved deferred
// quarantine takes effect on load (REQ-9.5).
//
// Phase 4 (REQ-1/2/3): the approval-package tests below drive the SAME live Human
// Plane server over real HTTP (the discovery file at persistDir/human-plane.json),
// concurrently with the in-flight runSupervisedLoop promise — proving the actual
// wire contract a real F-Loop client uses, not a hand-rolled stub.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { syntheticLoopSandbox } from '../test/helpers/synthetic-loop-sandbox.ts';
import { runSupervisedLoop, wrapRouterForShadow } from './loop-run.ts';
import { createDispatcher, FakeAdapter, type FusionProfile, type RegisteredAdapter, type Registry, type Router } from 'aal';
import {
  approveProposal,
  listPendingProposals,
  openEventLog,
  proposeFlakyQuarantine,
  readGovernanceLog,
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
  budget: {
    maxIterations: 4,
    maxCostUnits: 500,
    maxWallclockMs: 60_000,
    maxHypothesesPerFailure: 3,
    maxTotalTasks: 30,
    maxParallelAgents: 3,
  },
  risk: 'L2',
  approvalPolicy: [],
  raw: {},
};

const clock = { now: () => 1_000_000 };

// Every synthetic target in this legacy harness opts into the named test seam;
// production/CLI callers must provide operatorGoldenFixtureDir instead.
const runSyntheticLoop = (opts: Parameters<typeof runSupervisedLoop>[0]) =>
  runSupervisedLoop({
    ...opts,
    syntheticGoldenFixtureForTests: true,
    syntheticSandboxForTests: syntheticLoopSandbox,
  });

interface ApprovalPackageJSON {
  id: string;
  taskId: string;
  riskClass: string;
  goalExcerpt: string;
  acIds: string[];
  diffRef: string;
  evidence: { gateReports: string[]; worktreeHash: string };
  attestations: string[];
  provenance?: { specPath: string; requirementsCommit: string; requirementsSha256?: string; generatedAt: string };
}

/** Poll `fn` until it returns non-null, or throw after `timeoutMs` (default 45s). */
async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Poll persistDir/human-plane.json for a live (non-tombstoned) discovery record. */
function waitForDiscovery(persistDir: string): Promise<{ url: string; token: string }> {
  return waitFor(() => {
    let meta: { url?: unknown; token?: unknown; tombstoned?: unknown };
    try {
      meta = JSON.parse(readFileSync(join(persistDir, 'human-plane.json'), 'utf8')) as typeof meta;
    } catch {
      return null;
    }
    return meta.tombstoned === true || typeof meta.url !== 'string' || typeof meta.token !== 'string'
      ? null
      : { url: meta.url, token: meta.token };
  });
}

// The Human Plane server (core/src/human/api.ts, node:http keep-alive) shares this
// event loop with the sandboxed RUN_COMMAND subprocess hammering it; under load a
// keep-alive socket gets reset and fetch() THROWS a transport error (TypeError:
// fetch failed / ECONNRESET / socket hang up) with no recovery, flaking the run.
// Retry ONLY that thrown network failure — an HTTP response of ANY status (e.g. the
// 404 that decideDeploy tests assert) is returned as-is, never retried, so no
// assertion is masked. Success returns on the first try with zero delay.
// The injectable `doFetch` param is the test seam (rows 14-17); real callers omit it.
async function fetchRetry(
  input: string,
  init?: RequestInit,
  retries = 3,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await doFetch(input, init);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
}

async function fetchApprovals(url: string, token: string): Promise<ApprovalPackageJSON[]> {
  const res = await fetchRetry(`${url}/approvals`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as ApprovalPackageJSON[];
}

/** Poll GET /approvals until a package is pending, then return it. */
function waitForApprovalPackage(url: string, token: string): Promise<ApprovalPackageJSON> {
  return waitFor(async () => {
    const list = await fetchApprovals(url, token);
    return list[0] ?? null;
  });
}

function decide(url: string, token: string, id: string, decision: 'approve' | 'reject', attestations: string[] = []): Promise<number> {
  return fetchRetry(`${url}/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ decision, attestations }),
  }).then((res) => res.status);
}

interface DeployStatusJSON {
  state: string | null;
  approval: ApprovalPackageJSON | null;
}

function fetchDeploy(url: string, token: string): Promise<DeployStatusJSON> {
  return fetchRetry(`${url}/deploy`, { headers: { authorization: `Bearer ${token}` } }).then(
    (res) => res.json() as Promise<DeployStatusJSON>,
  );
}

/** Poll GET /deploy until `state` matches `want`, then return the full status. */
function waitForDeployState(url: string, token: string, want: string): Promise<DeployStatusJSON> {
  return waitFor(async () => {
    const s = await fetchDeploy(url, token);
    return s.state === want ? s : null;
  });
}

function decideDeploy(url: string, token: string, decision: 'approve' | 'reject', attestations: string[] = []): Promise<number> {
  return fetchRetry(`${url}/deploy/decision`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ decision, attestations }),
  }).then((res) => res.status);
}

function rollbackDeploy(url: string, token: string): Promise<number> {
  return fetchRetry(`${url}/deploy/rollback`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).then(
    (res) => res.status,
  );
}

// fetchRetry contract (adversarial rows 14-17): retry only thrown transport errors,
// never an HTTP status, and never delay the happy path.
test('fetchRetry: retries a thrown network error once, then succeeds (row 14, AC-11)', async () => {
  let calls = 0;
  const flaky: typeof fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });
    return new Response('ok', { status: 200 });
  };
  const res = await fetchRetry('http://x/', undefined, 3, flaky);
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test('fetchRetry: throws the real error after exhausting retries (row 15, AC-11)', async () => {
  let calls = 0;
  const dead: typeof fetch = async () => {
    calls++;
    throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
  };
  await assert.rejects(fetchRetry('http://x/', undefined, 3, dead), /fetch failed/);
  assert.equal(calls, 3);
});

test('fetchRetry: a 404 returns immediately, never retried (row 16, AC-12)', async () => {
  let calls = 0;
  const notFound: typeof fetch = async () => {
    calls++;
    return new Response('nope', { status: 404 });
  };
  const res = await fetchRetry('http://x/', undefined, 3, notFound);
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});

test('fetchRetry: a 200 returns on the first try with no retry (row 17, AC-13)', async () => {
  let calls = 0;
  const ok: typeof fetch = async () => {
    calls++;
    return new Response('ok', { status: 200 });
  };
  const res = await fetchRetry('http://x/', undefined, 3, ok);
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
});

test('supervised loop with the FakeAdapter reaches REVIEWING; calibration computed (harness math only)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    const out = await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      // L2 (no declared risk) never auto-merges; opting INTO the wait with a short
      // window resolves the resulting approval package to ESCALATED (REQ-3.4) — REVIEWING
      // itself, this test's actual subject, is asserted below from the event log
      // regardless of what happens to it afterward. (Omitting approval entirely returns
      // REVIEWING immediately — covered by the opt-in test above.)
      approval: { timeoutMs: 100 },
    });
    assert.equal(out.finalState, 'ESCALATED', 'nothing decides the resulting package here — REQ-3.4 timeout');
    assert.equal(out.calibration.n, 1);
    assert.equal(out.calibration.heldOutPassRate, 1, 'held-out (golden) passed — SCRIPTED, not a §12 metric');
    assert.equal(out.calibration.reproducibility, 1);

    // REQ-7.1: the composition root records shadow routes as a side channel; a
    // single registered adapter can never diverge from its own live choice.
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.ok(
        log.all({ type: 'TASK_STATE' }).some((e) => e.payload['state'] === 'REVIEWING'),
        'the loop reached REVIEWING',
      );
      assert.equal(log.all({ type: 'APPROVAL_PACKAGE_CREATED' }).length, 1, 'REQ-2: a real package was built');
      assert.equal(log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'approval_timeout', 'REQ-3.4');
      const shadowRoutes = log.all({ type: 'SHADOW_ROUTE' });
      assert.ok(shadowRoutes.length >= 1, 'each live route decision records a SHADOW_ROUTE event');
      assert.equal(shadowRoutes[0]?.payload['live'], shadowRoutes[0]?.payload['wouldChoose']);
      assert.deepEqual(
        shadowRoutes[0]?.payload['order'],
        [shadowRoutes[0]?.payload['live']],
        'full eligible order is recorded additively and starts with the unchanged live choice',
      );
      const descriptors = log.all({ type: 'RUN_DESCRIPTOR' });
      assert.equal(descriptors.length, 1);
      assert.equal(descriptors[0]?.payload['contractHash'], CONTRACT.hash);
      assert.equal(descriptors[0]?.payload['taskMode'], 'single');
      const budgetSnapshots = log.all({ type: 'BUDGET_SNAPSHOT' });
      assert.equal(budgetSnapshots[0]?.payload['phase'], 'init');
      assert.equal(budgetSnapshots.at(-1)?.payload['phase'], 'terminal');
      assert.equal((budgetSnapshots.at(-1)?.payload['used'] as { iterations?: unknown })?.iterations, out.iterations);
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

// --- outcomeRouting mode wiring (REQ-14.3) — the reorder/epsilon math itself is
// unit-tested in aal/src/router.test.ts; these are composition-level wiring
// smoke tests over the same single-adapter fixture. ---

test('outcomeRouting mode off suppresses SHADOW_ROUTE entirely (REQ-14.3)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      approval: { timeoutMs: 100 },
      outcomeRouting: { mode: 'off', epsilon: 0 },
    });
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'SHADOW_ROUTE' }).length, 0, 'mode off -> plain router, no shadow recording either');
      assert.equal(log.all({ type: 'OUTCOME_ROUTE' }).length, 0);
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('outcomeRouting mode active wraps shadow OUTSIDE the outcome wrapper — both record (REQ-14.3/15.4)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      approval: { timeoutMs: 100 },
      outcomeRouting: { mode: 'active', epsilon: 0 },
    });
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const outcomeRoutes = log.all({ type: 'OUTCOME_ROUTE' });
      assert.ok(outcomeRoutes.length >= 1, 'active mode reorders + records OUTCOME_ROUTE');
      assert.equal(outcomeRoutes[0]?.payload['basis'], 'insufficient_data', 'a single fresh adapter has no outcome history yet');
      assert.ok(log.all({ type: 'SHADOW_ROUTE' }).length >= 1, 'shadow still observes the (already-reordered) live choice');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('the human approval wait is OPT-IN: no approval option -> the package is left for a live client and the run returns REVIEWING immediately, never a 30-minute hang (PR #50 review, finding 1)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    // No `approval` option -> the CI/stub default: do NOT block on a human that isn't
    // there. Before the fix this hung 30 minutes then ESCALATED (approval_timeout).
    const out = await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
    });
    assert.equal(out.finalState, 'REVIEWING', 'returns REVIEWING immediately, not ESCALATED-via-timeout');
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'APPROVAL_PACKAGE_CREATED' }).length, 1, 'the package is still built + left in the approvals Map for a live client');
      assert.equal(log.all({ type: 'ESCALATED' }).length, 0, 'no approval_timeout escalation');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('outcomeRouting minSamples/minDivergences are threaded into the shadowProven snapshot, not dropped at the composition seam (PR #50 review, finding 12)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    // A single-adapter fixture records n>=1 SHADOW_ROUTE and 0 divergences; with BOTH
    // thresholds at 0, proven = n>=0 && divergences>=0 = true — only observable if the
    // knobs actually reach shadowProven (the hard-coded minSamples 20 would be false).
    const out = await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      approval: { timeoutMs: 100 },
      outcomeRouting: { mode: 'shadow', epsilon: 0, minSamples: 0, minDivergences: 0 },
    });
    assert.equal(out.shadowProven.proven, true, 'minSamples 0 / minDivergences 0 threaded through -> proven');
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('the shadowProven snapshot defaults to minSamples 20 when outcomeRouting omits the thresholds (finding 12 default preserved)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    const out = await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      approval: { timeoutMs: 100 },
    });
    assert.equal(out.shadowProven.proven, false, 'default minSamples 20 -> a single-adapter run is never "proven"');
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

// --- Planner-role fusion auto-routing (REQ-16) — runPlannerFusion itself is
// unit-tested in fusion.test.ts (resolution, PLAN_SCHEMA validation, PLAN_RESOLVED
// shape); these are composition-level wiring smoke tests proving the trigger
// contract (REQ-16.3) over the SAME single-adapter fixture the outcomeRouting
// tests above use — self-diversity (not cross_lineage) so the one registered
// FakeAdapter can seat a full 2-candidate panel. ---

const PLAN_PROFILE: FusionProfile = {
  artifact: 'plan',
  panel: { size: 2, diversity: { kind: 'self', seeds: [1, 2] } },
  resolve: 'deliberate_synthesis',
  budgetCapCostUnits: 40,
  estimateCostUnitsPerCandidate: 8,
};

test('planning enabled+triggered dispatches role planner BEFORE the task loop -> PLAN_RESOLVED; a resolved plan is advisory and never changes the task loop\'s outcome (REQ-16.2/16.5)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    const result = await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      approval: { timeoutMs: 100 },
      planning: { enabled: true, plannerRoleTrigger: true, profile: PLAN_PROFILE, dispatcher: createDispatcher({ buckets: new Map(), maxParallel: 2 }) },
    });
    // Same fixture/assertion as the plain-run test above (no autoMerge, L2 default
    // risk, 100ms approval window) — a resolved plan changes NOTHING about this.
    assert.equal(result.finalState, 'ESCALATED', 'REQ-3.4 timeout, byte-identical to the no-planning run');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const resolved = log.all({ type: 'PLAN_RESOLVED' });
      assert.equal(resolved.length, 1, 'dispatched exactly once');
      assert.equal(resolved[0]?.payload['winner'], true);
      assert.equal(typeof resolved[0]?.payload['panelSize'], 'number');
      assert.equal(typeof resolved[0]?.payload['costUnits'], 'number');
      // REQ-16.2: BEFORE the task loop — its seq precedes the loop's first CONTEXT_BUILT.
      const firstContextBuilt = log.all({ type: 'CONTEXT_BUILT' })[0];
      assert.ok(firstContextBuilt !== undefined, 'the task loop still ran');
      assert.ok((resolved[0]?.seq ?? Infinity) < (firstContextBuilt?.seq ?? -1), 'planner-fusion resolved before the task loop built its first context');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('planning never dispatches when EITHER axis is off, or the option is absent entirely (REQ-16.3: a test SHALL prove both offs)', async () => {
  const cases: ({ enabled: boolean; plannerRoleTrigger: boolean } | undefined)[] = [
    undefined, // absent entirely — Phase-3 parity, the default for every other test in this file
    { enabled: false, plannerRoleTrigger: true }, // composition option off
    { enabled: true, plannerRoleTrigger: false }, // governance policy flag off
  ];
  for (const planning of cases) {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
    try {
      await runSyntheticLoop({
        contract: CONTRACT,
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        approval: { timeoutMs: 100 },
        ...(planning !== undefined
          ? { planning: { ...planning, profile: PLAN_PROFILE, dispatcher: createDispatcher({ buckets: new Map(), maxParallel: 2 }) } }
          : {}),
      });
      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        assert.equal(
          log.all({ type: 'PLAN_RESOLVED' }).length,
          0,
          `planning=${JSON.stringify(planning)} must never dispatch the planner`,
        );
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  }
});

test('planner-fusion panel builds peek the SAME wrapped router (REQ-16.2) but record nothing — no SHADOW_ROUTE/OUTCOME_ROUTE against the planner role (PR #50 finding 6 / PR #64 P2-1)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    // Active mode wraps the task-loop router with BOTH recorders; the planner panel
    // routes through that SAME wrapped router (REQ-16.2/AZ-13) but via a non-recording
    // peek (eligibleAdapters record:false), so each planPanel call applies the governed
    // reorder yet appends no role:'planner' SHADOW_ROUTE/OUTCOME_ROUTE to pollute stats.
    await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      approval: { timeoutMs: 100 },
      outcomeRouting: { mode: 'active', epsilon: 0 },
      planning: { enabled: true, plannerRoleTrigger: true, profile: PLAN_PROFILE, dispatcher: createDispatcher({ buckets: new Map(), maxParallel: 2 }) },
    });
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'PLAN_RESOLVED' }).length, 1, 'the planner fusion still dispatched');
      assert.equal(
        log.all({ type: 'SHADOW_ROUTE' }).filter((e) => e.payload['role'] === 'planner').length,
        0,
        'a panel build never records a SHADOW_ROUTE for the planner role',
      );
      assert.equal(
        log.all({ type: 'OUTCOME_ROUTE' }).filter((e) => e.payload['role'] === 'planner').length,
        0,
        'nor an OUTCOME_ROUTE',
      );
      assert.ok(
        log.all({ type: 'SHADOW_ROUTE' }).some((e) => e.payload['role'] === 'implementer'),
        'the task loop itself still shadows its live implementer pick',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

// An L1 task (declared risk in the frozen contract) with a golden-backed AC — the
// input the auto-merge gate needs to fire (REQ-7.2). Risk is a typed field on the
// frozen contract since phase5-stage2 (REQ-3.5) — no longer read from raw.
const L1_CONTRACT: TaskContract = { ...CONTRACT, risk: 'L1' };

// Deploy config whose commands always succeed — reaches EXPANDED (REQ-6). Tiny
// probes/interval so the composition tests below stay fast.
const DEPLOY_OK: NonNullable<TaskContract['deploy']> = {
  canaryCmd: 'exit 0',
  observeCmd: 'exit 0',
  expandCmd: 'exit 0',
  rollbackCmd: 'exit 0',
  observe: { probes: 1, failureThreshold: 0, intervalMs: 5 },
};
const L1_CONTRACT_DEPLOY: TaskContract = { ...L1_CONTRACT, deploy: DEPLOY_OK };

// phase5-stage3 REQ-6.2: both approval-package construction sites (task-approval
// via ApprovalInput, deploy-approval via a direct literal — critique D3) must pass
// contract.provenance through unchanged.
const PROVENANCE: NonNullable<TaskContract['provenance']> = {
  specPath: '.ai/specs/fixture/requirements.md',
  requirementsCommit: 'abc1234',
  requirementsSha256: 'deadbeef',
  generatedAt: '2026-07-12T00:00:00Z',
};
const CONTRACT_WITH_PROVENANCE: TaskContract = { ...CONTRACT, provenance: PROVENANCE };
const L1_CONTRACT_DEPLOY_WITH_PROVENANCE: TaskContract = { ...L1_CONTRACT_DEPLOY, provenance: PROVENANCE };

test('E2E (REQ-18.4): an L1 task auto-merges + the sampled audit reproduces -> COMPLETED', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
  try {
    const out = await runSyntheticLoop({
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
      assert.equal(log.all({ type: 'DEPLOY_STATE' }).length, 0, 'no deploy: configured -> the deploy gate never fires (REQ-6.3)');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test(
  'E2E (REQ-5 production): an L1 task FAILS, self-repairs via a confirmed hypothesis, then auto-merges -> COMPLETED',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-repair-'));
    try {
      const out = await runSyntheticLoop({
        contract: L1_CONTRACT,
        // `repairable`: writes the wrong marker first (T1 fails -> DIAGNOSING), then the
        // correct one after the hypothesis is confirmed by a core-owned probe.
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

test(
  'E2E (REQ-10/11/12): a confirmed hypothesis becomes a pending lesson post-run; offline governance approval + the NEXT run\'s reconciler inject it',
  async () => {
    const persistDir1 = mkdtempSync(join(tmpdir(), 'loop-lesson-1-'));
    const persistDir2 = mkdtempSync(join(tmpdir(), 'loop-lesson-2-'));
    const lessonsDir = mkdtempSync(join(tmpdir(), 'loop-lesson-dir-'));
    const governanceLogPath = join(persistDir1, 'governance.jsonl');
    try {
      // Run 1: the SAME repair fixture as the test above confirms a hypothesis.
      // REQ-10.1: post-run, folded into a pending lesson + a lesson_promote proposal.
      const out1 = await runSyntheticLoop({
        contract: L1_CONTRACT,
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', behavior: 'repairable', putContent: put }),
        clock,
        persistDir: persistDir1,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
        governanceLogPath,
        lessons: { dir: lessonsDir },
      });
      assert.equal(out1.finalState, 'COMPLETED');
      // REQ-24.1: no approved lesson exists yet at run 1's own injection point (it is
      // PROPOSED post-run, from run 1's own log) -> zero injections this run.
      assert.deepEqual(out1.lessonHitRate, { injectionCount: 0, hitRateProxy: 0 });
      // REQ-24.3: never fabricated — this composition has no paired corpus to compute one from.
      assert.deepEqual(out1.fusionUplift, { available: false });

      const log1 = openEventLog(join(persistDir1, 'events.db'), clock);
      let lessonId: string;
      try {
        const proposed = log1.all({ type: 'LESSON_PROPOSED' });
        assert.equal(proposed.length, 1);
        lessonId = String(proposed[0]?.payload['lessonId']);
        assert.equal(proposed[0]?.payload['sourceRunId'], 'RUN-LIVE');
      } finally {
        log1.close();
      }

      const proposals = listPendingProposals(readGovernanceLog(governanceLogPath));
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0]?.kind, 'lesson_promote');
      assert.equal(proposals[0]?.lessonId, lessonId);

      // "Approved via the CLI while no run is live" — REQ-11.3's offline case.
      approveProposal({ logPath: governanceLogPath, id: proposals[0]?.id ?? '', clock, decidedBy: 'human' });

      // Run 2: a plain (non-repairing) run against the SAME lessons/governance state.
      // REQ-11.3: the reconciler moves pending/ -> approved/ on load. REQ-12: the
      // approved lesson is then injected into this run's own context bundle.
      const out2 = await runSyntheticLoop({
        contract: CONTRACT,
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir: persistDir2,
        approval: { timeoutMs: 100 },
        governanceLogPath,
        lessons: { dir: lessonsDir },
      });
      assert.equal(out2.finalState, 'ESCALATED', 'REQ-3.4 timeout on the resulting L2 approval package — not this test\'s subject');
      // REQ-24.1: the reconciled lesson WAS injected into run 2's own T-1 — which DID
      // reach REVIEWING (a real, already-logged transition) before the approval
      // package's timeout later escalated it. The proxy is a point-in-time fact
      // ("reached REVIEWING", per REQ-24.1's literal text), not "eventually
      // completed" — so this counts as a hit despite the run's finalState above.
      assert.deepEqual(out2.lessonHitRate, { injectionCount: 1, hitRateProxy: 1 });
      // REQ-24.2: a real (if tiny) shadowProven snapshot rides along — evidence only,
      // never a gate (INV-16); n is far below the 20-sample default so honestly unproven.
      assert.ok(out2.shadowProven.n >= 1, 'the default shadow mode recorded at least one round');
      assert.equal(out2.shadowProven.proven, false, 'small-n fixture run never claims activation');
      assert.deepEqual(out2.fusionUplift, { available: false });

      const log2 = openEventLog(join(persistDir2, 'events.db'), clock);
      try {
        const approved = log2.all({ type: 'LESSON_APPROVED' });
        assert.equal(approved.length, 1, 'the offline reconciler moved + logged it on THIS run\'s load');
        assert.equal(approved[0]?.payload['lessonId'], lessonId);

        const injected = log2.all({ type: 'LESSON_INJECTED' });
        assert.ok(injected.length >= 1, 'the now-approved lesson was injected into at least one round');
        assert.deepEqual(injected[0]?.payload['ids'], [lessonId]);
      } finally {
        log2.close();
      }
    } finally {
      rmSync(persistDir1, { recursive: true, force: true });
      rmSync(persistDir2, { recursive: true, force: true });
      rmSync(lessonsDir, { recursive: true, force: true });
    }
  },
);

test('a non-golden / no-risk task builds a real approval package with the core-computed fields (REQ-2.1/2.2/2.4/2.5, REQ-7.6/7.7)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-appkg-'));
  try {
    // CONTRACT has no `risk` -> defaults to L2 -> the approval package, not auto-merge.
    const resultPromise = runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
      approval: { timeoutMs: 5000 },
    });
    const { url, token } = await waitForDiscovery(persistDir);
    const pkg = await waitForApprovalPackage(url, token); // REQ-2.5: listed at GET /approvals while pending
    assert.equal(pkg.taskId, 'T-1');
    assert.equal(pkg.riskClass, 'L2', 'no declared risk defaults to L2 (REQ-7.6) — carried as effectiveRisk (REQ-2.1)');
    assert.equal(pkg.goalExcerpt, CONTRACT.goal.objective);
    assert.deepEqual(pkg.acIds, ['AC-1']);
    assert.ok(pkg.diffRef.length > 0, 'the task diff was evidence-stored (REQ-2.1)');
    assert.ok(pkg.evidence.worktreeHash.length > 0);
    assert.ok(pkg.evidence.gateReports.length > 0);

    const status = await decide(url, token, pkg.id, 'approve', pkg.attestations);
    assert.equal(status, 200, 'attestations generated from riskClass satisfy the completeness check');

    const out = await resultPromise;
    assert.equal(out.finalState, 'COMPLETED', 'REQ-3.2: approve -> APPROVED -> runApprovedMerge -> COMPLETED');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'AUTO_APPROVED' }).length, 0, 'a human decision, never a policy one (REQ-1.3)');
      assert.equal(log.all({ type: 'APPROVAL_PACKAGE_CREATED' }).length, 1);
      assert.equal(log.all({ type: 'APPROVAL_RECORDED' }).at(-1)?.payload['decision'], 'approve');
      assert.ok(
        log.all({ type: 'TASK_STATE' }).some((e) => e.payload['state'] === 'APPROVED' && e.payload['trigger'] === 'approve'),
        'onDecision logs the HTTP decision string as trigger, not the state-machine trigger name',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('contract.provenance flows through to the task approval package (phase5-stage3 REQ-6.2)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-appkg-prov-'));
  try {
    const resultPromise = runSyntheticLoop({
      contract: CONTRACT_WITH_PROVENANCE,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
      approval: { timeoutMs: 5000 },
    });
    const { url, token } = await waitForDiscovery(persistDir);
    const pkg = await waitForApprovalPackage(url, token);
    assert.deepEqual(pkg.provenance, PROVENANCE);

    await decide(url, token, pkg.id, 'approve', pkg.attestations);
    const out = await resultPromise;
    assert.equal(out.finalState, 'COMPLETED');
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('a human reject ends the run CHANGES_REQUESTED — terminal, no retry (REQ-3.3)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-reject-'));
  try {
    const resultPromise = runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
      approval: { timeoutMs: 5000 },
    });
    const { url, token } = await waitForDiscovery(persistDir);
    const pkg = await waitForApprovalPackage(url, token);
    const status = await decide(url, token, pkg.id, 'reject');
    assert.equal(status, 200);

    const out = await resultPromise;
    assert.equal(out.finalState, 'CHANGES_REQUESTED');
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'APPROVAL_RECORDED' }).at(-1)?.payload['decision'], 'reject');
      assert.equal(log.all({ type: 'AUTO_APPROVED' }).length, 0);
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('kill while a package is pending ends the wait -> CANCELLED, the same terminal a mid-loop kill reaches (REQ-3.6)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-killpkg-'));
  try {
    const resultPromise = runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
      approval: { timeoutMs: 5000 },
    });
    const { url, token } = await waitForDiscovery(persistDir);
    await waitForApprovalPackage(url, token);
    const res = await fetchRetry(`${url}/kill`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);

    const out = await resultPromise;
    assert.equal(out.finalState, 'CANCELLED');
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('invalid task-approval evidence escalates and releases the pending decision wait immediately', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-approval-invalid-evidence-'));
  try {
    const resultPromise = runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
      approval: { timeoutMs: 1000 },
    });
    const { url, token } = await waitForDiscovery(persistDir);
    const pending = await waitForApprovalPackage(url, token);
    assert.ok(pending.diffRef.startsWith('blob://'));
    rmSync(join(persistDir, 'evidence', pending.diffRef.slice('blob://'.length)));

    const decideStatus = await decide(url, token, pending.id, 'approve', pending.attestations);
    assert.equal(decideStatus, 409);

    const released = await Promise.race([
      resultPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    const out = await resultPromise;
    assert.equal(released, true, 'evidence escalation must not leave the loop waiting for approval timeout');
    assert.equal(out.finalState, 'ESCALATED');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'APPROVAL_RECORDED' }).length, 0);
      assert.equal(log.all({ type: 'TASK_STATE' }).at(-1)?.payload['state'], 'ESCALATED');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

// --- Deploy gate (REQ-6): built ALWAYS post-COMPLETED when deploy: is configured,
// on a SEPARATE surface from the task approvals Map/onDecision (architect finding
// #1) — guard-path unit coverage (400/404/409/501) lives in core/src/human/api.test.ts;
// these prove the real composition wiring end-to-end. ---

test(
  'deploy approval package built ALWAYS after COMPLETED; approve -> EXPANDED; never touches the task Map/onDecision (REQ-6.1/6.2/6.4/6.12)',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-deploy-approve-'));
    try {
      const resultPromise = runSyntheticLoop({
        contract: L1_CONTRACT_DEPLOY,
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
        approval: { timeoutMs: 5000 },
        deploy: { expandedWindowMs: 50 },
      });
      const { url, token } = await waitForDiscovery(persistDir);
      const pending = await waitForDeployState(url, token, 'PENDING_APPROVAL');
      assert.equal(pending.approval?.id, 'deploy-T-1');
      assert.equal(pending.approval?.riskClass, 'L4', 'architect finding #7: deploy uses L4 attestations');
      const deployDiffRef = pending.approval?.diffRef;
      if (deployDiffRef === undefined) assert.fail('deploy approval is missing diffRef');
      const reviewedDeployDiff = readFileSync(
        join(persistDir, 'evidence', deployDiffRef.slice('blob://'.length)),
        'utf8',
      );
      assert.match(reviewedDeployDiff, /src\/impl\.txt/, 'deploy approver receives the signed merge first-parent diff');

      // Regression (architect finding #1): the deploy package never enters GET /approvals.
      const taskApprovals = await fetchApprovals(url, token);
      assert.ok(!taskApprovals.some((p) => p.id === 'deploy-T-1'));

      const decideStatus = await decideDeploy(url, token, 'approve', pending.approval?.attestations ?? []);
      assert.equal(decideStatus, 200);

      const out = await resultPromise;
      assert.equal(out.finalState, 'COMPLETED', 'deploy outcome never changes the task finalState');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        assert.deepEqual(
          log.all({ type: 'DEPLOY_STATE' }).map((e) => e.payload['state']),
          ['CANARY', 'OBSERVING', 'EXPANDED'],
        );
        assert.equal(log.all({ type: 'DEPLOY_DECISION' }).at(-1)?.payload['decision'], 'approve');
        assert.equal(log.all({ type: 'DEPLOY_WINDOW_CLOSED' }).length, 1, 'REQ-6.12: window closes after EXPANDED');
        assert.equal(log.all({ type: 'APPROVAL_RECORDED' }).length, 0, 'a deploy decision is never a task APPROVAL_RECORDED');
        assert.equal(
          log.all({ type: 'TASK_STATE' }).filter((e) => e.payload['trigger'] === 'approve').length,
          0,
          'deploy approve never fires a task transition (architect finding #1)',
        );
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test(
  'invalid deploy evidence escalates and releases the pending decision wait immediately',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-deploy-invalid-evidence-'));
    try {
      const resultPromise = runSyntheticLoop({
        contract: L1_CONTRACT_DEPLOY,
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
        approval: { timeoutMs: 1000 },
      });
      const { url, token } = await waitForDiscovery(persistDir);
      const pending = await waitForDeployState(url, token, 'PENDING_APPROVAL');
      const diffRef = pending.approval?.diffRef;
      if (diffRef === undefined) assert.fail('deploy approval is missing diffRef');
      assert.ok(diffRef.startsWith('blob://'));
      rmSync(join(persistDir, 'evidence', diffRef.slice('blob://'.length)));

      const decideStatus = await decideDeploy(url, token, 'approve', pending.approval?.attestations ?? []);
      assert.equal(decideStatus, 409);

      const released = await Promise.race([
        resultPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      if (!released) await resultPromise;
      assert.equal(released, true, 'evidence escalation must not leave the loop waiting for approval timeout');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        assert.equal(log.all({ type: 'DEPLOY_STATE' }).at(-1)?.payload['state'], 'ESCALATED');
        assert.equal(log.all({ type: 'DEPLOY_DECISION' }).length, 0);
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test(
  'contract.provenance flows through to the deploy approval package too — direct-literal site, critique D3 (phase5-stage3 REQ-6.2)',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-deploy-prov-'));
    try {
      const resultPromise = runSyntheticLoop({
        contract: L1_CONTRACT_DEPLOY_WITH_PROVENANCE,
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
        approval: { timeoutMs: 5000 },
        deploy: { expandedWindowMs: 60_000 },
      });
      const { url, token } = await waitForDiscovery(persistDir);
      const pending = await waitForDeployState(url, token, 'PENDING_APPROVAL');
      assert.deepEqual(pending.approval?.provenance, PROVENANCE);

      await decideDeploy(url, token, 'approve', pending.approval?.attestations ?? []);
      await waitForDeployState(url, token, 'EXPANDED');
      const killStartedAt = Date.now();
      const kill = await fetchRetry(`${url}/kill`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      assert.equal(kill.status, 200);
      const out = await resultPromise;
      assert.equal(out.finalState, 'COMPLETED');
      assert.ok(Date.now() - killStartedAt < 30_000, 'kill releases the remaining expanded window');
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test(
  'deploy reject -> DEPLOY_DECISION{decision:reject}, stage skipped, task stays COMPLETED (REQ-6.7)',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-deploy-reject-'));
    try {
      const resultPromise = runSyntheticLoop({
        contract: L1_CONTRACT_DEPLOY,
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
        approval: { timeoutMs: 5000 },
      });
      const { url, token } = await waitForDiscovery(persistDir);
      await waitForDeployState(url, token, 'PENDING_APPROVAL');
      const status = await decideDeploy(url, token, 'reject');
      assert.equal(status, 200);

      const out = await resultPromise;
      assert.equal(out.finalState, 'COMPLETED');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        assert.equal(log.all({ type: 'DEPLOY_STATE' }).length, 0, 'a rejected deploy never starts the stage');
        assert.equal(log.all({ type: 'DEPLOY_DECISION' }).at(-1)?.payload['decision'], 'reject');
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test(
  'deploy decision timeout -> DEPLOY_DECISION{decision:timeout}, stage skipped, task stays COMPLETED (REQ-6.11)',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-deploy-timeout-'));
    try {
      const out = await runSyntheticLoop({
        contract: L1_CONTRACT_DEPLOY,
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
        approval: { timeoutMs: 50 },
      });
      assert.equal(out.finalState, 'COMPLETED', 'a skipped deploy never touches finalState');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        assert.equal(log.all({ type: 'DEPLOY_STATE' }).length, 0, 'a timed-out deploy decision never starts the stage');
        assert.equal(log.all({ type: 'DEPLOY_DECISION' }).at(-1)?.payload['decision'], 'timeout');
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test(
  'manual rollback at EXPANDED runs rollback_cmd -> ROLLED_BACK, audited (REQ-6.8/6.10)',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-deploy-rollback-'));
    const audited: Record<string, unknown>[] = [];
    try {
      const resultPromise = runSyntheticLoop({
        contract: { ...L1_CONTRACT, deploy: { ...DEPLOY_OK, rollbackCmd: 'sleep 1' } },
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
        approval: { timeoutMs: 5000 },
        deploy: { expandedWindowMs: 500 },
        auditSink: (entry) => audited.push(entry),
      });
      const { url, token } = await waitForDiscovery(persistDir);
      const pending = await waitForDeployState(url, token, 'PENDING_APPROVAL');
      await decideDeploy(url, token, 'approve', pending.approval?.attestations ?? []);
      await waitForDeployState(url, token, 'EXPANDED');

      const status = await rollbackDeploy(url, token);
      assert.equal(status, 200);
      assert.equal(
        (await fetchDeploy(url, token)).state,
        'ROLLING_BACK',
        'Human Plane stays open while the accepted rollback command is running',
      );

      const out = await resultPromise;
      assert.equal(out.finalState, 'COMPLETED', 'a deploy rollback never touches the task finalState');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        const states = log.all({ type: 'DEPLOY_STATE' });
        assert.deepEqual(
          states.map((e) => e.payload['state']),
          ['CANARY', 'OBSERVING', 'EXPANDED', 'ROLLING_BACK', 'ROLLED_BACK'],
        );
        assert.equal(states.find((e) => e.payload['state'] === 'ROLLING_BACK')?.payload['trigger'], 'manual_rollback');
        assert.ok(audited.some((e) => e['event'] === 'deploy_manual_rollback'), 'REQ-6.10: manual rollback audited');
        assert.equal(log.all({ type: 'DEPLOY_WINDOW_CLOSED' }).length, 1, 'window closes after rollback settles');
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test(
  'manual rollback whose rollback_cmd FAILS still closes the window cleanly — terminal ESCALATED, run COMPLETED, no dangling ROLLING_BACK (PR #50 review, finding 2)',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-deploy-rbfail-'));
    try {
      const resultPromise = runSyntheticLoop({
        contract: { ...L1_CONTRACT, deploy: { ...DEPLOY_OK, rollbackCmd: 'exit 3' } },
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
        approval: { timeoutMs: 5000 },
        deploy: { expandedWindowMs: 60_000 },
      });
      const { url, token } = await waitForDiscovery(persistDir);
      const pending = await waitForDeployState(url, token, 'PENDING_APPROVAL');
      await decideDeploy(url, token, 'approve', pending.approval?.attestations ?? []);
      await waitForDeployState(url, token, 'EXPANDED');
      assert.equal(await rollbackDeploy(url, token), 200);

      // Accepted rollback ends the remaining window. A kill only cleans up the RED
      // path so this regression never leaves the Human Plane server running.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        resultPromise.then((out) => ({ out })),
        new Promise<null>((resolve) => {
          deadlineTimer = setTimeout(() => resolve(null), 30_000);
        }),
      ]);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (settled === null) {
        const kill = await fetchRetry(`${url}/kill`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
        assert.equal(kill.status, 200);
        await resultPromise;
        assert.fail('accepted manual rollback did not end the remaining expanded window');
      }
      const { out } = settled;
      assert.equal(out.finalState, 'COMPLETED', 'a failed deploy rollback never touches the task finalState');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        const states = log.all({ type: 'DEPLOY_STATE' }).map((e) => e.payload['state']);
        assert.equal(states.at(-1), 'ESCALATED', 'terminal deploy state is ESCALATED (rollback_failed), never a dangling ROLLING_BACK');
        assert.equal(log.all({ type: 'DEPLOY_WINDOW_CLOSED' }).length, 1, 'the window still closed cleanly (REQ-6.12)');
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test('a diff over the budget escalates split_required — no package built (REQ-2.3)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-splitreq-'));
  try {
    const out = await runSyntheticLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
      approval: { maxDiffBudget: 0 }, // any non-empty diff exceeds a budget of 0
    });
    assert.equal(out.finalState, 'ESCALATED');
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'APPROVAL_PACKAGE_CREATED' }).length, 0, 'over budget -> no package (REQ-2.3)');
      assert.equal(log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'split_required');
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

    const out = await runSyntheticLoop({
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

test('wrapRouterForShadow reuses an injected round stats cache instead of independently recomputing (PR #50 review)', () => {
  // The log itself has NO history for 'a' — an independent computeShadowOutcomeStats(log.all())
  // would say insufficient_data. The injected cache claims 'a' is already proven instead; if the
  // wrapper truly reuses it (rather than recomputing its own fold from the log), the recorded
  // basis must reflect THIS injected verdict, not the empty log's.
  const adapters = [registeredAdapter('a'), registeredAdapter('b')];
  const log = fakeLog();
  let calls = 0;
  const stats = {
    get: (): Record<string, { attempts: number; reviewingReached: number }> => {
      calls += 1;
      return { 'a@v1': { attempts: 5, reviewingReached: 5 } };
    },
    invalidate: (): void => undefined,
  };
  const wrapped = wrapRouterForShadow(fakeRouter(adapters), {
    registry: fakeRegistry(adapters),
    log,
    runId: 'RUN-1',
    taskId: 'T-1',
    stats,
  });
  wrapped.eligibleAdapters('implementer');
  assert.equal(calls, 1, 'the shared cache was actually used');
  assert.equal(
    log.appended[0]?.payload['basis'],
    'highest_reviewing_rate',
    'reflects the injected stats, not an independent (empty) log recompute',
  );
});

// ---------------------------------------------------------------------------
// phase5-stage2 consumer wiring (REQ-4.1/4.2, tests 6.8/6.9).
// ---------------------------------------------------------------------------

test(
  'the contract\'s max_hypotheses_per_failure observably bounds the repair cycle — a NON-default cap of 5 evaluates 5 hypotheses, not the static default 3 (REQ-4.1/6.8)',
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-exhaust-'));
    try {
      const out = await runSyntheticLoop({
        contract: { ...CONTRACT, budget: { ...CONTRACT.budget, maxHypothesesPerFailure: 5 } },
        // Never self-heals + diagnoses with 8 never-confirming hypotheses: only the
        // contract cap can end the cycle. With the wire disconnected the engine
        // would stop at the core default (3) and this test would fail.
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', behavior: 'exhaust_hypotheses', putContent: put }),
        clock,
        persistDir,
      });
      assert.equal(out.finalState, 'ESCALATED');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        assert.equal(log.all({ type: 'PROBE_RUN' }).length, 5, 'exactly cap-many probes ran (one per evaluated hypothesis)');
        assert.equal(log.all({ type: 'HYPOTHESIS_CONFIRMED' }).length, 0, 'nothing ever confirms');
        const escalated = log.all({ type: 'ESCALATED' }).at(-1);
        assert.equal(escalated?.payload['reason'], 'max_hypotheses', 'the cycle ended at the contract cap, not all_refuted');
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test('a planning dispatcher assembled WIDER than the contract\'s max_parallel_agents is refused before the run starts (REQ-4.2/6.9)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-guard-'));
  try {
    await assert.rejects(
      runSyntheticLoop({
        contract: { ...CONTRACT, budget: { ...CONTRACT.budget, maxParallelAgents: 1 } },
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
        clock,
        persistDir,
        approval: { timeoutMs: 100 },
        planning: { enabled: true, plannerRoleTrigger: true, profile: PLAN_PROFILE, dispatcher: createDispatcher({ buckets: new Map(), maxParallel: 2 }) },
      }),
      /exceeds contract max_parallel_agents 1/,
    );
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('the guard mirrors the dispatch condition: planner trigger OFF -> no dispatch this run, an over-wide dispatcher is NOT refused (REQ-4.2 is WHILE-dispatching — Codex review PR #110)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-guard-off-'));
  try {
    const out = await runSyntheticLoop({
      contract: { ...CONTRACT, budget: { ...CONTRACT.budget, maxParallelAgents: 1 } },
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      approval: { timeoutMs: 100 },
      planning: { enabled: true, plannerRoleTrigger: false, profile: PLAN_PROFILE, dispatcher: createDispatcher({ buckets: new Map(), maxParallel: 2 }) },
    });
    assert.equal(out.finalState, 'ESCALATED', 'the run proceeds exactly like the no-planning run (approval timeout terminal)');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'PLAN_RESOLVED' }).length, 0, 'and indeed nothing was dispatched');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});
