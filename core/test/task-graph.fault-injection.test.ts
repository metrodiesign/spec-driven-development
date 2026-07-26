// Task-graph fault injection, PURE-GATE halves (phase5-stage4 REQ-6.1/6.2, design
// D6). Same framing as the Phase-0 suite in fault-injection.test.ts: a mis-planned
// feature must be caught by the gate itself, and the gate must NAME what it caught —
// a rejection that says only "invalid" leaves the human guessing which task to fix.
//
// The composition halves (TG#1b/2b: the same two graphs going through
// runSupervisedLoop and reaching nothing) live in
// console/backend/src/loop-run-graph.fault-injection.test.ts, where the driver is
// (D8 — core cannot import the composition).
//
// The contract side is built with the REAL freezeContract, so these scenarios are
// gated against the same shape a run uses, never a hand-shaped stand-in.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { freezeContract, type TaskContract } from '../src/contract/contract.ts';
import { freezeTaskGraph, TaskGraphGateError } from '../src/graph/graph.ts';

const GOAL = {
  goal: { id: 'G-FI', title: 'Fault injection', objective: 'multi-task run' },
  acceptance_criteria: [
    { id: 'AC-1', description: 'first' },
    { id: 'AC-2', description: 'second' },
  ],
  budget: {
    max_iterations_per_task: 4,
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

const CONTRACT: TaskContract = freezeContract(bytesOf(GOAL), GOAL);

/** The reasons of the single gate error, or a failure if the graph was accepted. */
function reasonsOf(graph: unknown): string[] {
  try {
    freezeTaskGraph(bytesOf(graph), graph, CONTRACT);
  } catch (err) {
    assert.ok(err instanceof TaskGraphGateError, `expected TaskGraphGateError, got ${String(err)}`);
    return err.reasons;
  }
  return assert.fail('the planning gate accepted a graph it must reject');
}

test('TG#1a: a graph leaving an acceptance criterion uncovered is rejected, naming the AC (REQ-6.1)', () => {
  // Both tasks pile onto AC-1; nothing in the plan ever satisfies AC-2, so the run
  // could reach COMPLETED with a criterion no task ever attempted (§11.2's
  // uncovered_acs must be empty).
  const reasons = reasonsOf({
    goal_id: 'G-FI',
    tasks: [
      { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
      { id: 'T-2', title: 'second', satisfies: ['AC-1'], depends_on: ['T-1'] },
    ],
    checks: { max_diff_budget_per_task: 400 },
  });
  assert.ok(
    reasons.some((r) => r.includes('uncovered acceptance criteria') && r.includes('AC-2')),
    `the rejection names the uncovered criterion (got ${JSON.stringify(reasons)})`,
  );
  assert.ok(
    !reasons.some((r) => r.includes('AC-1')),
    'a covered criterion is never reported as uncovered',
  );
});

test('TG#2a: a graph carrying an orphan task is rejected, naming the task (REQ-6.2)', () => {
  // T-2 satisfies nothing and is not tagged `enabling`: work with no acceptance
  // criterion behind it cannot be verified by anything (§11.2's orphan_tasks must
  // be empty). T-3 is the control — the SAME empty `satisfies`, declared enabling.
  const reasons = reasonsOf({
    goal_id: 'G-FI',
    tasks: [
      { id: 'T-1', title: 'covers everything', satisfies: ['AC-1', 'AC-2'] },
      { id: 'T-2', title: 'orphan', satisfies: [] },
      { id: 'T-3', title: 'scaffolding', satisfies: [], enabling: true },
    ],
    checks: { max_diff_budget_per_task: 400 },
  });
  const orphan = reasons.find((r) => r.includes('orphan tasks'));
  assert.ok(orphan !== undefined, `the rejection reports orphans (got ${JSON.stringify(reasons)})`);
  assert.ok(orphan.includes('T-2'), 'the orphan task is named');
  assert.ok(!orphan.includes('T-3'), 'an explicitly enabling task is not an orphan');
});
