// Selection semantics — REQ-4.1 (phase5-stage4). The projection is written here as
// a plain object literal: core owns no projection helper, the composition builds
// one from its own run-scoped slice of the event log (D19).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TaskGraph, TaskGraphTask } from './graph.ts';

import { DEP_SATISFIED_STATES, selectNextTask, type TaskProjection } from './select.ts';

function taskOf(id: string, dependsOn: string[] = []): TaskGraphTask {
  return { id, title: id, satisfies: [`AC-${id}`], dependsOn, enabling: false, risk: 'L2', diffBudget: 400 };
}

function graphOf(tasks: TaskGraphTask[]): TaskGraph {
  return { goalId: 'G-1', tasks, checks: { maxDiffBudgetPerTask: 400 }, graphHash: 'f'.repeat(64) };
}

/**
 * `states` = the latest in-run TASK_STATE per task id; `unselectable` = the ids a
 * failed lease claim folded in. A task with a recorded state has started, which is
 * exactly the rule the composition applies.
 */
function projection(states: Record<string, string>, unselectable: string[] = []): TaskProjection {
  const started = new Set([...Object.keys(states), ...unselectable]);
  return { latestState: (id) => states[id], started: (id) => started.has(id) };
}

test('the dependency-satisfied set is exactly the six post-verification states (REQ-4.1)', () => {
  assert.deepEqual(
    [...DEP_SATISFIED_STATES].sort(),
    ['APPROVED', 'AUDITED', 'COMPLETED', 'MERGE_QUEUED', 'PASSED', 'REVIEWING'],
  );
});

test('on an empty run the first task in graph file order wins the tie (REQ-4.1)', () => {
  const graph = graphOf([taskOf('T-1'), taskOf('T-2'), taskOf('T-3')]);
  assert.equal(selectNextTask(graph, projection({}))?.id, 'T-1');
});

test('a task with an unstarted dependency is skipped; an independent task is picked instead (REQ-4.1)', () => {
  const graph = graphOf([taskOf('T-1', ['T-3']), taskOf('T-2')]);
  assert.equal(selectNextTask(graph, projection({}))?.id, 'T-2');
});

test('every state in the dependency-satisfied set unlocks the dependent (REQ-4.1)', () => {
  const graph = graphOf([taskOf('T-1'), taskOf('T-2', ['T-1'])]);
  for (const state of DEP_SATISFIED_STATES) {
    assert.equal(selectNextTask(graph, projection({ 'T-1': state }))?.id, 'T-2', `${state} must satisfy the dependency`);
  }
});

test('a dependency that ended outside the satisfied set leaves the dependent permanently ineligible (REQ-4.1/4.4)', () => {
  const graph = graphOf([taskOf('T-1'), taskOf('T-2', ['T-1'])]);
  for (const state of ['FAILED', 'ESCALATED', 'BLOCKED', 'CANCELLED', 'QUARANTINED', 'CHANGES_REQUESTED', 'ROLLED_BACK']) {
    assert.equal(selectNextTask(graph, projection({ 'T-1': state })), null, `${state} must not satisfy the dependency`);
  }
});

test('all dependencies must be satisfied, not just one (REQ-4.1)', () => {
  const graph = graphOf([taskOf('T-1'), taskOf('T-2'), taskOf('T-3', ['T-1', 'T-2'])]);
  assert.equal(
    selectNextTask(graph, projection({ 'T-1': 'PASSED', 'T-2': 'IMPLEMENTING' })),
    null,
    'T-2 started but not yet satisfying, so T-3 is not eligible',
  );
  assert.equal(selectNextTask(graph, projection({ 'T-1': 'PASSED', 'T-2': 'BLOCKED' })), null);
  assert.equal(selectNextTask(graph, projection({ 'T-1': 'PASSED', 'T-2': 'COMPLETED' }))?.id, 'T-3');
});

test('a task the run already started is never selected again (REQ-4.1)', () => {
  const graph = graphOf([taskOf('T-1'), taskOf('T-2')]);
  assert.equal(selectNextTask(graph, projection({ 'T-1': 'IMPLEMENTING' }))?.id, 'T-2');
});

test('a failed lease claim folds into started and takes the task out for the rest of the run (REQ-4.1/4.6)', () => {
  const graph = graphOf([taskOf('T-1'), taskOf('T-2')]);
  assert.equal(selectNextTask(graph, projection({}, ['T-1']))?.id, 'T-2');
  assert.equal(selectNextTask(graph, projection({}, ['T-1', 'T-2'])), null);
});

test('no eligible task returns null — the driver ends the run (REQ-4.1/4.4)', () => {
  const graph = graphOf([taskOf('T-1'), taskOf('T-2', ['T-1'])]);
  assert.equal(selectNextTask(graph, projection({ 'T-1': 'COMPLETED', 'T-2': 'COMPLETED' })), null);
});

test('risk and diff budget are not selection inputs — file order still decides (REQ-4.1, D15)', () => {
  const risky: TaskGraphTask = { ...taskOf('T-1'), risk: 'L4', diffBudget: 1 };
  const tame: TaskGraphTask = { ...taskOf('T-2'), risk: 'L0', diffBudget: 400 };
  assert.equal(selectNextTask(graphOf([risky, tame]), projection({}))?.id, 'T-1');
  assert.equal(selectNextTask(graphOf([tame, risky]), projection({}))?.id, 'T-2');
});
