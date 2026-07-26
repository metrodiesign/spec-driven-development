// Deterministic task selection over a frozen task graph (spec §11.2,
// phase5-stage4 REQ-4.1). Pure by design: the only inputs are the frozen graph and
// a projection of THIS run's task states. Risk is settled at freeze (REQ-3.8) and
// leases are claimed AFTER selection (claim-then-verify), so neither risk, lease
// state, nor budget is an input here.

import type { TaskGraph, TaskGraphTask } from './graph.ts';

/**
 * A dependency counts as satisfied once its latest in-run state reaches one of
 * these (spec §11.2). Everything else — ESCALATED, BLOCKED, FAILED, ROLLED_BACK,
 * CANCELLED, QUARANTINED, CHANGES_REQUESTED — leaves dependents permanently
 * ineligible, which is how a dead branch of the graph stops the run.
 */
export const DEP_SATISFIED_STATES: ReadonlySet<string> = new Set([
  'PASSED',
  'REVIEWING',
  'APPROVED',
  'MERGE_QUEUED',
  'AUDITED',
  'COMPLETED',
]);

/**
 * Run-scoped view of task states, built by the composition from the event log.
 * `started` folds in both "already has a state in this run" and "unselectable for
 * the rest of this run" (a failed lease claim), so selection needs no other input.
 */
export interface TaskProjection {
  latestState(taskId: string): string | undefined;
  started(taskId: string): boolean;
}

/**
 * The next task to run, or null when nothing is eligible (the run ends). Eligible =
 * not started in this run AND every dependency satisfied; among eligible tasks the
 * graph's file order wins, which makes the choice deterministic.
 */
export function selectNextTask(graph: TaskGraph, projection: TaskProjection): TaskGraphTask | null {
  for (const task of graph.tasks) {
    if (projection.started(task.id)) continue;
    const depsSatisfied = task.dependsOn.every((dep) => {
      const state = projection.latestState(dep);
      return state !== undefined && DEP_SATISFIED_STATES.has(state);
    });
    if (depsSatisfied) return task;
  }
  return null;
}
