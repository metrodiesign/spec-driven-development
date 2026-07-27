// platform-phase5-stage4 task 1: schema parity (REQ-1.2) + edge shape cases
// (REQ-1.1/1.3/1.4/1.5). The semantic twins (uncovered ACs, orphans, cycles,
// ceilings, goal binding) live in core graph.test.ts — this file is shape only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TASK_GRAPH_SCHEMA, validateTaskGraphShape } from './task-graph-schema.ts';

/** Minimal valid graph (REQ-1.1's required trio only). */
function minimalGraph(): Record<string, unknown> {
  return {
    goal_id: 'G-1',
    tasks: [{ id: 'T-1', title: 'first', satisfies: ['AC-1'] }],
    checks: { max_diff_budget_per_task: 400 },
  };
}

test('parity: TASK_GRAPH_SCHEMA is deep-equal to the governance copy at .ai/schemas/task-graph.schema.json (REQ-1.2)', () => {
  const governance = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', '.ai', 'schemas', 'task-graph.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepStrictEqual(TASK_GRAPH_SCHEMA, governance);
});

test('minimal graph passes; a full graph using every optional task field passes (REQ-1.1/1.3)', () => {
  assert.deepEqual(validateTaskGraphShape(minimalGraph()), []);

  const full = {
    goal_id: 'G-1',
    tasks: [
      { id: 'T-1', title: 'scaffold', satisfies: [], enabling: true },
      { id: 'T-2', title: 'feature', satisfies: ['AC-1', 'AC-2'], depends_on: ['T-1'], risk: 'L3', diff_budget: 120 },
    ],
    checks: { max_diff_budget_per_task: 400 },
  };
  assert.deepEqual(validateTaskGraphShape(full), []);
});

test('unknown keys are rejected with the offending key named, at every level (REQ-1.4)', () => {
  const typoTop = { ...minimalGraph(), goal: 'G-1' };
  assert.match(validateTaskGraphShape(typoTop).join('\n'), /^\/: .*\(goal\)/m);

  const typoTask = minimalGraph();
  (typoTask['tasks'] as Record<string, unknown>[])[0]!['depends'] = ['T-0'];
  assert.match(validateTaskGraphShape(typoTask).join('\n'), /\/tasks\/0.*\(depends\)/);

  const typoChecks = minimalGraph();
  (typoChecks['checks'] as Record<string, unknown>)['max_diff_budget'] = 400;
  assert.match(validateTaskGraphShape(typoChecks).join('\n'), /\/checks.*\(max_diff_budget\)/);
});

test('tasks: empty or missing is rejected — a graph with no tasks is not a graph (REQ-1.5)', () => {
  assert.match(validateTaskGraphShape({ ...minimalGraph(), tasks: [] }).join('\n'), /\/tasks/);

  const missing = minimalGraph();
  delete missing['tasks'];
  assert.match(validateTaskGraphShape(missing).join('\n'), /tasks/);
});

test('goal_id and checks are required, non-empty / integer >= 1 (REQ-1.1)', () => {
  for (const key of ['goal_id', 'checks']) {
    const missing = minimalGraph();
    delete missing[key];
    assert.match(validateTaskGraphShape(missing).join('\n'), new RegExp(key), `missing ${key} must be named`);
  }
  assert.match(validateTaskGraphShape({ ...minimalGraph(), goal_id: '' }).join('\n'), /\/goal_id/);

  for (const bad of [0, -1, 2.5, '400']) {
    const wrong = minimalGraph();
    (wrong['checks'] as Record<string, unknown>)['max_diff_budget_per_task'] = bad;
    assert.match(
      validateTaskGraphShape(wrong).join('\n'),
      /\/checks\/max_diff_budget_per_task/,
      `max_diff_budget_per_task=${JSON.stringify(bad)} must fail at its path`,
    );
  }
});

test('task item shape: id/title/satisfies required, empty strings rejected, satisfies may be empty (REQ-1.1)', () => {
  for (const key of ['id', 'title', 'satisfies']) {
    const missing = minimalGraph();
    delete (missing['tasks'] as Record<string, unknown>[])[0]![key];
    assert.match(validateTaskGraphShape(missing).join('\n'), new RegExp(`/tasks/0`), `missing ${key} must fail`);
    assert.match(validateTaskGraphShape(missing).join('\n'), new RegExp(key), `missing ${key} must be named`);
  }

  for (const key of ['id', 'title']) {
    const empty = minimalGraph();
    (empty['tasks'] as Record<string, unknown>[])[0]![key] = '';
    assert.match(validateTaskGraphShape(empty).join('\n'), new RegExp(`/tasks/0/${key}`), `empty ${key} must fail`);
  }

  const emptySatisfies = minimalGraph();
  (emptySatisfies['tasks'] as Record<string, unknown>[])[0]!['satisfies'] = [];
  assert.deepEqual(
    validateTaskGraphShape(emptySatisfies),
    [],
    'an empty satisfies list is shape-legal — orphan tasks are decided at freeze',
  );
});

test('optional task fields are type-checked: depends_on, enabling, risk, diff_budget (REQ-1.1)', () => {
  const cases: [string, unknown, RegExp][] = [
    ['depends_on', 'T-1', /\/tasks\/0\/depends_on/],
    ['depends_on', [''], /\/tasks\/0\/depends_on\/0/],
    ['enabling', 'yes', /\/tasks\/0\/enabling/],
    ['risk', 'L5', /\/tasks\/0\/risk/],
    ['risk', 'l2', /\/tasks\/0\/risk/],
    ['diff_budget', 0, /\/tasks\/0\/diff_budget/],
    ['diff_budget', 2.5, /\/tasks\/0\/diff_budget/],
  ];
  for (const [key, value, path] of cases) {
    const bad = minimalGraph();
    (bad['tasks'] as Record<string, unknown>[])[0]![key] = value;
    assert.match(validateTaskGraphShape(bad).join('\n'), path, `${key}=${JSON.stringify(value)} must fail`);
  }

  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
    const ok = minimalGraph();
    (ok['tasks'] as Record<string, unknown>[])[0]!['risk'] = level;
    assert.deepEqual(validateTaskGraphShape(ok), [], `${level} must pass`);
  }
});

test('allErrors: independent defects are all reported, not just the first (REQ-1.3)', () => {
  const doubly = minimalGraph();
  doubly['goal_id'] = '';
  (doubly['checks'] as Record<string, unknown>)['max_diff_budget_per_task'] = 0;
  const errs = validateTaskGraphShape(doubly);
  assert.ok(
    errs.some((e) => e.includes('/goal_id')),
    'goal_id error present',
  );
  assert.ok(
    errs.some((e) => e.includes('/checks/max_diff_budget_per_task')),
    'checks error present',
  );
});

test('non-object roots fail with the root path (REQ-1.1)', () => {
  for (const root of [[], 'graph', null, 42]) {
    assert.match(validateTaskGraphShape(root).join('\n'), /^\/: /);
  }
});

test('task ids and depends_on entries are constrained to a branch-safe charset (REQ-1.1, Codex P2 PR #124)', () => {
  for (const id of ['feature:1', '-lead', 'has space', 'a/b', 'x'.repeat(65)]) {
    const g = minimalGraph();
    (g['tasks'] as Record<string, unknown>[])[0]!['id'] = id;
    assert.match(
      validateTaskGraphShape(g).join('\n'),
      /^\/tasks\/0\/id: /m,
      `id ${JSON.stringify(id)} must fail at the edge with its path`,
    );
  }

  const dangling = minimalGraph();
  (dangling['tasks'] as Record<string, unknown>[])[0]!['depends_on'] = ['bad:dep'];
  assert.match(validateTaskGraphShape(dangling).join('\n'), /^\/tasks\/0\/depends_on\/0: /m);

  // `..` and a `.lock` suffix are inside the charset — the edge lets them through on
  // purpose and freeze refuses them (core graph.test.ts REQ-3.15), so the two layers
  // stay honest about which rule each one owns.
  for (const id of ['T-1', 'stage4.task_2-b', 'a..b', 'x.lock']) {
    const g = minimalGraph();
    (g['tasks'] as Record<string, unknown>[])[0]!['id'] = id;
    assert.deepEqual(validateTaskGraphShape(g), [], `${id} is shape-legal`);
  }
});
