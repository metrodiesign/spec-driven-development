// Multi-task driver basics (phase5-stage4 REQ-4.2/4.8/4.9/4.11, design D4 layer 2)
// with the FakeAdapter — no quota, CI-safe. Three things only, all about the DRIVER:
// which mode a run picks, a two-task graph actually running both tasks in dependency
// order, and a graph the planning gate rejects ending the run before anything is
// built. The deep wiring proofs (fresh budget per task, lease TTL, AC-golden
// isolation, approval targeting, kill switch, branch isolation) belong to task 5.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeAdapter, type AdapterInterface, type AgentRequest } from 'aal';
import { createLeaseManager, openEventLog, type TaskContract } from 'core';

import { loadGoalContract } from './loop-cli.ts';
import { runSupervisedLoop } from './loop-run.ts';
import { validateTaskGraphShape } from './task-graph-schema.ts';

const clock = { now: () => 1_000_000 };

/** Two ACs so a graph can split them across two tasks (coverage is total — REQ-3.3). */
const CONTRACT: TaskContract = {
  hash: 'b'.repeat(64),
  goal: { id: 'GRAPH-1', title: 'demo graph', objective: 'edit src/impl.txt so the tests pass' },
  acceptanceCriteria: [
    { id: 'AC-1', description: 'src/impl.txt contains correct', golden: true },
    { id: 'AC-2', description: 'the same file still contains correct', golden: true },
  ],
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

const TWO_TASK_GRAPH = {
  goal_id: 'GRAPH-1',
  tasks: [
    { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
    { id: 'T-2', title: 'second', satisfies: ['AC-2'], depends_on: ['T-1'] },
  ],
  checks: { max_diff_budget_per_task: 400 },
};

/** What the CLI hands the run: raw bytes + the parsed object (REQ-4.2) — no freeze here. */
function graphOption(graph: unknown): { rawBytes: Uint8Array; parsed: unknown } {
  const json = JSON.stringify(graph);
  return { rawBytes: Buffer.from(json, 'utf8'), parsed: JSON.parse(json) as unknown };
}

test('REQ-4.3: without a task-graph option the result keeps its exact single-task shape', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-single-'));
  try {
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
    });
    assert.equal(out.finalState, 'REVIEWING', 'no approval wait -> the package is left for a human');
    assert.equal('tasks' in out, false, 'the multi-task field is ADDITIVE and must not appear here');
    assert.deepStrictEqual(
      Object.keys(out),
      ['finalState', 'iterations', 'calibration', 'lessonHitRate', 'shadowProven', 'fusionUplift'],
      'single-task result shape (and key order) unchanged',
    );
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'TASK_GRAPH_FROZEN' }).length, 0, 'no graph -> no planning gate ran');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('REQ-4.2/4.9/4.11: a two-task graph runs both tasks in dependency order and reports a row each', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-multi-'));
  try {
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      taskGraph: graphOption(TWO_TASK_GRAPH),
    });
    assert.deepStrictEqual(
      out.tasks,
      [
        { id: 'T-1', finalState: 'REVIEWING', iterations: out.tasks?.[0]?.iterations ?? -1 },
        { id: 'T-2', finalState: 'REVIEWING', iterations: out.tasks?.[1]?.iterations ?? -1 },
      ],
      'one row per graph task, in graph order, both executed',
    );
    assert.equal(out.finalState, 'REVIEWING', 'run precedence over two REVIEWING tasks');
    assert.equal(
      out.iterations,
      (out.tasks?.[0]?.iterations ?? 0) + (out.tasks?.[1]?.iterations ?? 0),
      'run iterations = the sum over executed tasks',
    );
    assert.equal(out.calibration.n, 2, 'calibration samples the EXECUTED tasks, one each');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const frozen = log.all({ type: 'TASK_GRAPH_FROZEN' });
      assert.equal(frozen.length, 1, 'REQ-4.8: frozen exactly once, inside the run');
      assert.deepStrictEqual(frozen[0]?.payload['taskIds'], ['T-1', 'T-2']);
      assert.equal(typeof frozen[0]?.payload['graphHash'], 'string');
      assert.equal(log.all({ type: 'TASK_GRAPH_REJECTED' }).length, 0);

      // Dependency order, asserted from the log rather than from anything the agent
      // claimed: T-2's first state must come after T-1 reached a dep-satisfied state.
      const firstOf = (taskId: string): number =>
        log.all({ type: 'TASK_STATE', taskId })[0]?.seq ?? Number.MAX_SAFE_INTEGER;
      const t1Reviewing = log
        .all({ type: 'TASK_STATE', taskId: 'T-1' })
        .find((e) => e.payload['state'] === 'REVIEWING')?.seq;
      assert.ok(t1Reviewing !== undefined, 'T-1 reached REVIEWING');
      assert.ok(firstOf('T-1') < firstOf('T-2'), 'T-1 started first');
      assert.ok(firstOf('T-2') > t1Reviewing, 'T-2 was not dispatched until its dependency was satisfied');

      // REQ-4.6: each task's lease is claimed and released by this run.
      assert.deepStrictEqual(
        log.all({ type: 'LEASE_CLAIMED' }).map((e) => e.taskId),
        ['T-1', 'T-2'],
      );
      assert.deepStrictEqual(
        log.all({ type: 'LEASE_RELEASED' }).map((e) => e.taskId),
        ['T-1', 'T-2'],
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('REQ-4.8: a graph the planning gate rejects ends the run BLOCKED before any adapter is built', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-reject-'));
  let adapterBuilt = false;
  try {
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => {
        adapterBuilt = true;
        return new FakeAdapter({ id: 'fake', putContent: put });
      },
      clock,
      persistDir,
      // AC-2 is covered by no task — uncovered_acs must be empty (REQ-3.3).
      taskGraph: graphOption({
        goal_id: 'GRAPH-1',
        tasks: [
          { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
          { id: 'T-2', title: 'second', satisfies: ['AC-1'] },
        ],
        checks: { max_diff_budget_per_task: 400 },
      }),
    });
    assert.equal(out.finalState, 'BLOCKED');
    assert.equal(out.iterations, 0);
    assert.deepStrictEqual(out.tasks, [
      { id: 'T-1', finalState: 'NOT_STARTED', iterations: 0 },
      { id: 'T-2', finalState: 'NOT_STARTED', iterations: 0 },
    ]);
    assert.equal(adapterBuilt, false, 'the gate refused before the adapter factory was ever called');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const rejected = log.all({ type: 'TASK_GRAPH_REJECTED' });
      assert.equal(rejected.length, 1);
      const reasons = rejected[0]?.payload['reasons'] as string[];
      assert.ok(
        reasons.some((r) => r.includes('uncovered acceptance criteria') && r.includes('AC-2')),
        `structured reasons name the uncovered AC (got ${JSON.stringify(reasons)})`,
      );
      assert.equal(log.all({ type: 'TASK_GRAPH_FROZEN' }).length, 0);
      assert.equal(log.all({ type: 'TASK_STATE' }).length, 0, 'nothing was dispatched');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 5 — deep wiring (phase5-stage4 REQ-6.5 + the multi-task knobs of REQ-4).
// Every option under test is set to a NON-DEFAULT value and proven by a behavior
// that differs from the default, so a wire that was never connected cannot pass by
// two defaults happening to agree (lesson #wiring-test-nondefault-value).
// ---------------------------------------------------------------------------

/** The shipped calibration fixtures (spec §14 Stage-4 DoD). */
const CALIBRATION_DIR = join(import.meta.dirname, '..', '..', '..', '.ai', 'calibration');

test('REQ-6.5: the shipped calibration fixture pair drives a two-task run to REVIEWING for BOTH tasks', async () => {
  // Loaded through the REAL edge: the goal is frozen by loadGoalContract and the
  // graph is shape-validated by the same ajv validator the CLI uses, so a fixture
  // that drifts out of either contract fails here rather than in a live run.
  const contract = loadGoalContract(join(CALIBRATION_DIR, 'fixture-goal-graph.yaml'));
  const rawBytes = readFileSync(join(CALIBRATION_DIR, 'fixture-task-graph.json'));
  const parsed = JSON.parse(rawBytes.toString('utf8')) as unknown;
  assert.deepEqual(validateTaskGraphShape(parsed), [], 'the shipped graph fixture passes edge validation');

  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-calib-'));
  try {
    const out = await runSupervisedLoop({
      contract,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      taskGraph: { rawBytes, parsed },
    });
    assert.deepStrictEqual(
      out.tasks?.map((t) => [t.id, t.finalState]),
      [
        ['T-1', 'REVIEWING'],
        ['T-2', 'REVIEWING'],
      ],
      'the DoD item: every task of a >= 2-task graph reaches REVIEWING',
    );
    assert.equal(out.finalState, 'REVIEWING');
    assert.equal(out.calibration.n, 2, 'one held-out sample per executed task');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const frozen = log.all({ type: 'TASK_GRAPH_FROZEN' });
      assert.equal(frozen.length, 1, 'the pair passed the REAL planning gate, exactly once');
      assert.equal(
        frozen[0]?.payload['graphHash'],
        createHash('sha256').update(rawBytes).digest('hex'),
        'the recorded hash is of the shipped file bytes (INV-10)',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('REQ-4.12: each task builds a FRESH budget tracker — task 1 spending the whole cap never starves task 2', async () => {
  // Non-default: ONE iteration per task, where every other test here allows four.
  // A tracker created once per run would leave task 2 with nothing to spend.
  const contract: TaskContract = { ...CONTRACT, budget: { ...CONTRACT.budget, maxIterations: 1 } };
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-budget-'));
  try {
    const out = await runSupervisedLoop({
      contract,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      taskGraph: graphOption(TWO_TASK_GRAPH),
    });
    assert.deepStrictEqual(
      out.tasks,
      [
        { id: 'T-1', finalState: 'REVIEWING', iterations: 1 },
        { id: 'T-2', finalState: 'REVIEWING', iterations: 1 },
      ],
      'both tasks ran their own round against their own cap',
    );
    assert.ok(
      out.iterations > contract.budget.maxIterations,
      `the run spent ${out.iterations} rounds against a per-task cap of ${contract.budget.maxIterations} — only a per-task tracker allows that`,
    );
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('REQ-4.6: leaseTtlMs is what the claim actually records, not the contract-derived default', async () => {
  const ttlMs = 111_111;
  const defaultTtl = CONTRACT.budget.maxWallclockMs + 5 * 60_000;
  assert.notEqual(ttlMs, defaultTtl, 'the value under test must differ from the default it overrides');
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-ttl-'));
  try {
    await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      taskGraph: graphOption(TWO_TASK_GRAPH),
      leaseTtlMs: ttlMs,
    });
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      // The fixture clock is constant, so the deadline is exact rather than a bound.
      assert.deepStrictEqual(
        log.all({ type: 'LEASE_CLAIMED' }).map((e) => e.payload['leaseUntil']),
        [clock.now() + ttlMs, clock.now() + ttlMs],
        'every task claimed its lease for the overridden TTL',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('REQ-4.6: a task whose lease another owner already holds is never selected and ends NOT_STARTED', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-lease-'));
  try {
    // Someone else is already working T-2 — the same events.db the run will open.
    const other = createLeaseManager(join(persistDir, 'events.db'), clock, 'OTHER-RUN');
    try {
      assert.equal(other.claim('T-2', 'OTHER-RUN', 30 * 60_000), true, 'the foreign claim really took');
    } finally {
      other.close();
    }

    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      taskGraph: graphOption(TWO_TASK_GRAPH),
    });
    assert.deepStrictEqual(
      out.tasks,
      [
        { id: 'T-1', finalState: 'REVIEWING', iterations: 1 },
        // NOT_STARTED, never SKIPPED: SKIPPED means a dependency EXECUTED and ended
        // badly (REQ-4.11), and T-1 ended fine — T-2 simply never became runnable.
        { id: 'T-2', finalState: 'NOT_STARTED', iterations: 0 },
      ],
      'the unclaimable task is reported unrun, and the rest of the run still happened',
    );
    assert.equal(out.finalState, 'BLOCKED', 'NOT_STARTED counts as BLOCKED for run precedence (D10)');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'TASK_STATE', taskId: 'T-2' }).length, 0, 'T-2 was never dispatched');
      assert.deepStrictEqual(
        log.all({ type: 'LEASE_CLAIMED', taskId: 'T-2' }).map((e) => e.payload['ownerId']),
        ['OTHER-RUN'],
        'this run never took the held lease — the only claim on record is the foreign one',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test("REQ-4.13: a task's auto-merge is decided by ITS OWN acceptance criteria — another task's golden never counts", async () => {
  // AC-1 is golden-backed, AC-2 is not, and the contract risk is L1 so auto-merge is
  // reachable. With the ACs mapped per task, the split is visible in BOTH directions:
  // T-1 (golden) auto-merges to COMPLETED, T-2 (non-golden) must take the human
  // approval path. Were the whole contract mapped to every task, T-1 would see AC-2
  // and stop at REVIEWING too — so this one assertion catches the leak either way.
  const contract: TaskContract = {
    ...CONTRACT,
    risk: 'L1',
    acceptanceCriteria: [
      { id: 'AC-1', description: 'src/impl.txt contains correct', golden: true },
      { id: 'AC-2', description: 'the same file still contains correct', golden: false },
    ],
  };
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-golden-'));
  try {
    const out = await runSupervisedLoop({
      contract,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 0, depManifestPatterns: [] },
      taskGraph: graphOption(TWO_TASK_GRAPH),
    });
    assert.deepStrictEqual(
      out.tasks?.map((t) => [t.id, t.finalState]),
      [
        ['T-1', 'COMPLETED'],
        ['T-2', 'REVIEWING'],
      ],
      'the golden-backed task auto-merged; the task without a golden AC of its own did not',
    );

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.deepStrictEqual(
        log.all({ type: 'APPROVAL_PACKAGE_CREATED' }).map((e) => e.taskId),
        ['T-2'],
        'only the non-golden task needed a human package',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

// --- the live Human Plane wire (the last two scenarios drive the running loop) ---

interface ApprovalJSON {
  id: string;
  taskId: string;
  attestations: string[];
}

/** Poll `fn` until it returns non-null, or throw after `timeoutMs`. */
async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The live (non-tombstoned) Human Plane discovery record the run publishes. */
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

function fetchApprovals(url: string, token: string): Promise<ApprovalJSON[]> {
  return fetch(`${url}/approvals`, { headers: { authorization: `Bearer ${token}` } }).then(
    (res) => res.json() as Promise<ApprovalJSON[]>,
  );
}

/** Poll GET /approvals until a package for THIS task is pending. */
function waitForApprovalOf(url: string, token: string, taskId: string): Promise<ApprovalJSON> {
  return waitFor(async () => (await fetchApprovals(url, token)).find((p) => p.taskId === taskId) ?? null);
}

function decide(url: string, token: string, id: string, attestations: string[] = []): Promise<number> {
  return fetch(`${url}/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', attestations }),
  }).then((res) => res.status);
}

test('REQ-4.14: an approval decision is applied to the task it NAMES, never to whichever task is active', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-approve-'));
  try {
    // timeoutMs opts INTO the blocking human gate, so the run holds each task open
    // for a decision and both packages are decided over the real wire, in order.
    const runPromise = runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      approval: { timeoutMs: 30_000 },
      taskGraph: graphOption(TWO_TASK_GRAPH),
    });
    const { url, token } = await waitForDiscovery(persistDir);

    const first = await waitForApprovalOf(url, token, 'T-1');
    // T-2 is the task NOT waiting on anything: it has not been selected, so it has no
    // package. Naming it must change nothing — least of all T-1, the active task.
    assert.equal(await decide(url, token, 'T-2'), 404, 'a task with no pending package cannot be decided');
    assert.deepStrictEqual(
      (await fetchApprovals(url, token)).map((p) => p.taskId),
      ['T-1'],
      "the misdirected decision left the ACTIVE task's package untouched and pending",
    );

    assert.equal(await decide(url, token, first.id, first.attestations), 200);
    const second = await waitForApprovalOf(url, token, 'T-2');
    assert.equal(await decide(url, token, second.id, second.attestations), 200);

    const out = await runPromise;
    assert.deepStrictEqual(
      out.tasks?.map((t) => [t.id, t.finalState]),
      [
        ['T-1', 'COMPLETED'],
        ['T-2', 'COMPLETED'],
      ],
      'each task was carried on by its own decision',
    );

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.deepStrictEqual(
        log.all({ type: 'APPROVAL_RECORDED' }).map((e) => e.taskId),
        ['T-1', 'T-2'],
        'every recorded decision is filed against the task it named',
      );
      // The state each decision moved is that task's own, read per taskId (REQ-4.14).
      for (const taskId of ['T-1', 'T-2']) {
        assert.ok(
          log
            .all({ type: 'TASK_STATE', taskId })
            .some((e) => e.payload['state'] === 'APPROVED' && e.payload['trigger'] === 'approve'),
          `${taskId} moved to APPROVED on its own decision`,
        );
      }
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

/**
 * An adapter that trips the operator kill switch over the REAL Human Plane wire
 * during its first implementer round, then answers that round normally — so the task
 * in flight finishes and the kill lands BETWEEN tasks, which is the case REQ-4.15 is
 * about (kill must stop the driver, never degrade into "skip this one, carry on").
 */
function killsDuringFirstTask(put: (s: string) => string, persistDir: string): AdapterInterface {
  const inner = new FakeAdapter({ id: 'fake', putContent: put });
  let fired = false;
  return {
    manifest: () => inner.manifest(),
    send: async (req: AgentRequest) => {
      const response = await inner.send(req);
      if (!fired && req.agentRole === 'implementer') {
        fired = true;
        const { url, token } = await waitForDiscovery(persistDir);
        await fetch(`${url}/kill`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      }
      return response;
    },
  };
}

test('REQ-4.15: the kill switch stops the driver — remaining tasks end NOT_STARTED and the run is CANCELLED', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-kill-'));
  try {
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => killsDuringFirstTask(put, persistDir),
      clock,
      persistDir,
      taskGraph: graphOption(TWO_TASK_GRAPH),
    });
    assert.deepStrictEqual(
      out.tasks,
      [
        { id: 'T-1', finalState: 'REVIEWING', iterations: 1 },
        { id: 'T-2', finalState: 'NOT_STARTED', iterations: 0 },
      ],
      'the task in flight finished; the next one was never selected',
    );
    assert.equal(out.finalState, 'CANCELLED', 'a kill outranks every per-task end state');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'KILL_REQUESTED' }).length, 1, 'the kill really came over the wire');
      assert.equal(log.all({ taskId: 'T-2' }).length, 0, 'nothing at all was recorded for the unstarted task');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test("REQ-4.5: a task's own diff_budget reaches the approval package — not the composition's `?? 400` default", async () => {
  // The effective budget is only OBSERVABLE where it bites: buildApprovalPackage never
  // stores maxDiffBudget on the package, it escalates `split_required` and names the
  // number it used. So T-1 declares diff_budget 1 — under the two changed lines a
  // fixture task produces — while the graph-wide ceiling is a non-default 200 and the
  // composition fallback is 400. Both of those would let the same diff through, so a
  // budget that never reached the package cannot pass this (lesson
  // #wiring-test-nondefault-value). T-2 declares nothing and stays under the ceiling,
  // proving the escalate is the per-task budget talking and not the fixture diff.
  const graph = {
    goal_id: 'GRAPH-1',
    tasks: [
      { id: 'T-1', title: 'first', satisfies: ['AC-1'], diff_budget: 1 },
      // Independent on purpose: T-1 ending ESCALATED must not SKIP T-2 (REQ-4.4).
      { id: 'T-2', title: 'second', satisfies: ['AC-2'] },
    ],
    checks: { max_diff_budget_per_task: 200 },
  };
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-diffbudget-'));
  try {
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      taskGraph: graphOption(graph),
    });
    assert.deepStrictEqual(
      out.tasks?.map((t) => [t.id, t.finalState]),
      [
        ['T-1', 'ESCALATED'],
        ['T-2', 'REVIEWING'],
      ],
      'only the task with the tight budget was refused a package',
    );

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const escalated = log.all({ type: 'ESCALATED', taskId: 'T-1' });
      assert.equal(escalated.length, 1);
      assert.equal(escalated[0]?.payload['why'], 'split_required');
      assert.match(
        String(escalated[0]?.payload['detail']),
        /^diff \d+ lines exceeds budget 1$/,
        "the budget the package enforced is the TASK's declared 1 — neither checks.max_diff_budget_per_task (200) nor the `?? 400` fallback",
      );
      assert.deepStrictEqual(
        log.all({ type: 'APPROVAL_PACKAGE_CREATED' }).map((e) => e.taskId),
        ['T-2'],
        'the undeclared task took the graph-wide ceiling and its diff fit',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('REQ-4.6: a lease held under the RUN ID by a concurrent runner is not reclaimed (Codex P1, PR #124)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-graph-owner-'));
  try {
    // A second runner of the SAME goal, sharing this persistDir, holds T-2. Before the
    // fix both runners owned their leases as 'RUN-LIVE', and lease.ts's CAS lets a
    // claimer take over a lease it already owns — so this run would have stolen T-2
    // and executed it concurrently with its live holder.
    const concurrent = createLeaseManager(join(persistDir, 'events.db'), clock, 'RUN-LIVE');
    try {
      assert.equal(concurrent.claim('T-2', 'RUN-LIVE', 30 * 60_000), true, 'the concurrent claim really took');
    } finally {
      concurrent.close();
    }

    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      taskGraph: graphOption(TWO_TASK_GRAPH),
    });
    assert.equal(out.tasks?.find((t) => t.id === 'T-2')?.finalState, 'NOT_STARTED', 'the held task was left alone');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'TASK_STATE', taskId: 'T-2' }).length, 0, 'T-2 was never dispatched');
      const owners = log.all({ type: 'LEASE_CLAIMED' }).map((e) => String(e.payload['ownerId']));
      assert.deepStrictEqual(owners.filter((o) => o === 'RUN-LIVE'), ['RUN-LIVE'], 'only the concurrent runner claimed as the bare run id');
      const ours = owners.filter((o) => o !== 'RUN-LIVE');
      assert.equal(ours.length, 1, 'this run claimed exactly T-1');
      assert.match(ours[0] ?? '', /^RUN-LIVE#/, 'our owner is the run id plus a per-invocation suffix');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});
