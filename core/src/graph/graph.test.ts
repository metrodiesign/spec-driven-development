// Planning gate — one case per REQ-3 criterion (phase5-stage4). The contract side
// is built with the real freezeContract so the gate is proven against the same
// shape the run uses, not a hand-shaped stand-in.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { freezeContract, type TaskContract } from '../contract/contract.ts';

import { freezeTaskGraph, TaskGraphGateError } from './graph.ts';

const GOAL = {
  goal: { id: 'G-1', title: 'Graph', objective: 'multi-task run' },
  acceptance_criteria: [
    { id: 'AC-1', description: 'first' },
    { id: 'AC-2', description: 'second' },
  ],
  budget: {
    max_iterations_per_task: 8,
    max_hypotheses_per_failure: 3,
    max_total_tasks: 30,
    max_parallel_agents: 3,
    max_cost_units_per_task: 500,
    max_wallclock_per_task_min: 30,
  },
  risk: 'L2',
};

function bytesOf(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function contractOf(overrides: Record<string, unknown> = {}): TaskContract {
  const goal = { ...GOAL, ...overrides };
  return freezeContract(bytesOf(goal), goal);
}

function graphOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal_id: 'G-1',
    tasks: [
      { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
      { id: 'T-2', title: 'second', satisfies: ['AC-2'], depends_on: ['T-1'] },
    ],
    checks: { max_diff_budget_per_task: 400 },
    ...overrides,
  };
}

function freeze(graph: unknown, contract: TaskContract = contractOf()) {
  return freezeTaskGraph(bytesOf(graph), graph, contract);
}

/** The reasons of the single TaskGraphGateError the gate must throw. */
function rejectionReasons(graph: unknown, contract: TaskContract = contractOf()): string[] {
  try {
    freeze(graph, contract);
  } catch (err) {
    if (err instanceof TaskGraphGateError) return err.reasons;
    throw err;
  }
  assert.fail('expected the gate to reject this graph');
}

test('a conforming graph freezes: typed shape, sha256 of the RAW bytes, structured gate result (REQ-3.1/3.9)', () => {
  const graph = graphOf();
  const { graph: frozen, gate } = freeze(graph);

  assert.equal(frozen.goalId, 'G-1');
  assert.deepEqual(
    frozen.tasks.map((t) => t.id),
    ['T-1', 'T-2'],
  );
  assert.deepEqual(frozen.tasks[0]?.dependsOn, [], 'absent depends_on becomes an empty list');
  assert.equal(frozen.tasks[0]?.enabling, false, 'absent enabling defaults to false');
  assert.deepEqual(frozen.tasks[1]?.dependsOn, ['T-1']);
  assert.equal(frozen.checks.maxDiffBudgetPerTask, 400);
  assert.match(frozen.graphHash, /^[0-9a-f]{64}$/);

  assert.equal(gate.graphHash, frozen.graphHash);
  assert.deepEqual(gate.taskIds, ['T-1', 'T-2']);
  assert.deepEqual(gate.uncoveredAcs, []);
  assert.deepEqual(gate.orphanTasks, []);
});

test('graphHash hashes the raw bytes, not the parsed object (REQ-3.1)', () => {
  const graph = graphOf();
  const compact = freezeTaskGraph(new TextEncoder().encode(JSON.stringify(graph)), graph, contractOf());
  const spaced = freezeTaskGraph(new TextEncoder().encode(JSON.stringify(graph, null, 2)), graph, contractOf());
  assert.notEqual(compact.graph.graphHash, spaced.graph.graphHash);
});

test('effective risk and diff budget are baked at freeze — declared wins, else contract/checks (REQ-3.7/3.8, D15)', () => {
  const { graph } = freeze(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'], risk: 'L1', diff_budget: 120 },
        { id: 'T-2', title: 'second', satisfies: ['AC-2'] },
      ],
    }),
  );
  assert.equal(graph.tasks[0]?.risk, 'L1');
  assert.equal(graph.tasks[0]?.diffBudget, 120);
  assert.equal(graph.tasks[1]?.risk, 'L2', 'undeclared risk takes the contract risk');
  assert.equal(graph.tasks[1]?.diffBudget, 400, 'undeclared diff_budget takes checks.max_diff_budget_per_task');
});

test('an enabling task may carry an empty satisfies list (REQ-3.4 escape hatch)', () => {
  const { graph } = freeze(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'scaffold', satisfies: [], enabling: true },
        { id: 'T-2', title: 'both', satisfies: ['AC-1', 'AC-2'], depends_on: ['T-1'] },
      ],
    }),
  );
  assert.equal(graph.tasks[0]?.enabling, true);
});

test('unknown acceptance criterion id is rejected, naming the task and the id (REQ-3.2)', () => {
  const reasons = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
        { id: 'T-2', title: 'second', satisfies: ['AC-2', 'AC-9'] },
      ],
    }),
  );
  assert.match(reasons.join('\n'), /unknown acceptance criterion ids: T-2 -> AC-9/);
});

test('an acceptance criterion covered by no task is rejected, listing it (REQ-3.3)', () => {
  const reasons = rejectionReasons(graphOf({ tasks: [{ id: 'T-1', title: 'first', satisfies: ['AC-1'] }] }));
  assert.match(reasons.join('\n'), /uncovered acceptance criteria: AC-2/);
});

test('a task with empty satisfies and no enabling flag is an orphan and is rejected (REQ-3.4)', () => {
  const reasons = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1', 'AC-2'] },
        { id: 'T-2', title: 'drifter', satisfies: [] },
      ],
    }),
  );
  assert.match(reasons.join('\n'), /orphan tasks \(empty satisfies, not enabling\): T-2/);
});

test('a dependency on a task id that exists nowhere is rejected, naming the edge (REQ-3.5)', () => {
  const reasons = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
        { id: 'T-2', title: 'second', satisfies: ['AC-2'], depends_on: ['T-9'] },
      ],
    }),
  );
  assert.match(reasons.join('\n'), /unknown dependency edge: T-2 -> T-9/);
});

test('a self-dependency is rejected, naming the task — not reported as a cycle (REQ-3.10)', () => {
  const reasons = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
        { id: 'T-2', title: 'second', satisfies: ['AC-2'], depends_on: ['T-2'] },
      ],
    }),
  );
  assert.deepEqual(reasons, ['task T-2 depends on itself']);
});

test('two tasks with the same id are rejected, naming the duplicate (REQ-3.11)', () => {
  const reasons = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
        { id: 'T-1', title: 'clone', satisfies: ['AC-2'] },
      ],
    }),
  );
  assert.match(reasons.join('\n'), /duplicate task id: T-1/);
});

test('a dependency cycle is rejected, naming ids on the cycle (REQ-3.12)', () => {
  const reasons = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'], depends_on: ['T-2'] },
        { id: 'T-2', title: 'second', satisfies: ['AC-2'], depends_on: ['T-1'] },
      ],
    }),
  );
  const cycle = reasons.find((r) => r.startsWith('dependency cycle involving'));
  assert.ok(cycle !== undefined, `expected a cycle reason, got ${reasons.join(' | ')}`);
  assert.match(cycle, /T-1/);
  assert.match(cycle, /T-2/);
});

test('a longer cycle is caught and a diamond DAG is not (REQ-3.12)', () => {
  const three = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'a', satisfies: ['AC-1'], depends_on: ['T-3'] },
        { id: 'T-2', title: 'b', satisfies: ['AC-2'], depends_on: ['T-1'] },
        { id: 'T-3', title: 'c', satisfies: [], enabling: true, depends_on: ['T-2'] },
      ],
    }),
  );
  assert.match(three.join('\n'), /dependency cycle involving: T-1, T-2, T-3/);

  const diamond = freeze(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'root', satisfies: [], enabling: true },
        { id: 'T-2', title: 'left', satisfies: ['AC-1'], depends_on: ['T-1'] },
        { id: 'T-3', title: 'right', satisfies: ['AC-2'], depends_on: ['T-1'] },
        { id: 'T-4', title: 'join', satisfies: [], enabling: true, depends_on: ['T-2', 'T-3'] },
      ],
    }),
  );
  assert.deepEqual(diamond.gate.taskIds, ['T-1', 'T-2', 'T-3', 'T-4']);
});

test('more tasks than the contract budget.max_total_tasks is rejected (REQ-3.6)', () => {
  const reasons = rejectionReasons(graphOf(), contractOf({ budget: { ...GOAL.budget, max_total_tasks: 1 } }));
  assert.match(reasons.join('\n'), /task count 2 exceeds budget\.max_total_tasks 1/);
});

test('a declared diff_budget above checks.max_diff_budget_per_task is rejected (REQ-3.7)', () => {
  const reasons = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'], diff_budget: 401 },
        { id: 'T-2', title: 'second', satisfies: ['AC-2'] },
      ],
    }),
  );
  assert.match(reasons.join('\n'), /task T-1 diff_budget 401 exceeds checks\.max_diff_budget_per_task 400/);
});

test('a task risk above the contract risk is rejected; at or below it passes (REQ-3.8)', () => {
  const reasons = rejectionReasons(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'], risk: 'L3' },
        { id: 'T-2', title: 'second', satisfies: ['AC-2'] },
      ],
    }),
  );
  assert.match(reasons.join('\n'), /task T-1 risk L3 exceeds contract risk L2/);

  const ok = freeze(
    graphOf({
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-1'], risk: 'L2' },
        { id: 'T-2', title: 'second', satisfies: ['AC-2'], risk: 'L0' },
      ],
    }),
  );
  assert.equal(ok.graph.tasks[1]?.risk, 'L0');
});

test('a contract carrying a deploy block cannot be run as a task graph (REQ-3.13)', () => {
  const withDeploy = contractOf({
    deploy: {
      canary_cmd: './canary.sh',
      observe_cmd: './probe.sh',
      expand_cmd: './expand.sh',
      rollback_cmd: './rollback.sh',
      observe: { probes: 3, failure_threshold: 1, interval_ms: 1000 },
    },
  });
  const reasons = rejectionReasons(graphOf(), withDeploy);
  assert.match(reasons.join('\n'), /deploy block/);
});

test('a goal_id that differs from the frozen contract goal id is rejected (REQ-3.14)', () => {
  const reasons = rejectionReasons(graphOf({ goal_id: 'G-2' }));
  assert.match(reasons.join('\n'), /goal_id G-2 does not match the frozen contract goal id G-1/);
});

test('every violation is collected into one throw, not just the first (REQ-3 gate posture)', () => {
  const reasons = rejectionReasons(
    graphOf({
      goal_id: 'G-OTHER',
      tasks: [
        { id: 'T-1', title: 'first', satisfies: ['AC-9'], diff_budget: 999, risk: 'L4' },
        { id: 'T-1', title: 'clone', satisfies: [], depends_on: ['T-7'] },
      ],
    }),
  );
  const joined = reasons.join('\n');
  assert.match(joined, /duplicate task id: T-1/);
  assert.match(joined, /goal_id G-OTHER/);
  assert.match(joined, /unknown acceptance criterion ids/);
  assert.match(joined, /uncovered acceptance criteria: AC-1, AC-2/);
  assert.match(joined, /orphan tasks/);
  assert.match(joined, /unknown dependency edge: T-1 -> T-7/);
  assert.match(joined, /diff_budget 999/);
  assert.match(joined, /risk L4 exceeds contract risk L2/);
  assert.ok(reasons.length >= 8, `expected every violation, got ${reasons.length}: ${joined}`);
});

test('structural defects are rejected before any semantic check runs (freeze stands alone)', () => {
  assert.deepEqual(rejectionReasons(graphOf({ tasks: [] })), ['tasks must be a non-empty array']);
  assert.match(rejectionReasons(graphOf({ goal_id: '' })).join('\n'), /goal_id must be a non-empty string/);
  assert.match(rejectionReasons(graphOf({ checks: {} })).join('\n'), /max_diff_budget_per_task must be an integer >= 1/);
  assert.deepEqual(rejectionReasons([]), ['graph must be an object']);
  assert.match(
    rejectionReasons(graphOf({ tasks: [{ id: 'T-1', satisfies: ['AC-1'] }] })).join('\n'),
    /tasks\[0\]\.title must be a non-empty string/,
  );
});
