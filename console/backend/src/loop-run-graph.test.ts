// Multi-task driver basics (phase5-stage4 REQ-4.2/4.8/4.9/4.11, design D4 layer 2)
// with the FakeAdapter — no quota, CI-safe. Three things only, all about the DRIVER:
// which mode a run picks, a two-task graph actually running both tasks in dependency
// order, and a graph the planning gate rejects ending the run before anything is
// built. The deep wiring proofs (fresh budget per task, lease TTL, AC-golden
// isolation, approval targeting, kill switch, branch isolation) belong to task 5.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeAdapter } from 'aal';
import { openEventLog, type TaskContract } from 'core';

import { runSupervisedLoop } from './loop-run.ts';

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
