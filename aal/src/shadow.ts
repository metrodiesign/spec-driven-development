// Outcome-routing shadow (§10.4, REQ-7). Off -> shadow only: routing NEVER
// consults outcome data in Phase 3 (active = Phase 4) — these are pure helpers
// the composition root uses to DECIDE what to record; they never touch route()
// or eligibleAdapters() themselves (recorder never alters route results, REQ-7.4).

import type { RegisteredAdapter } from './registry.ts';
import type { PlatformEvent, Role } from 'core/types';

export interface ShadowOutcomeStats {
  attempts: number;
  reviewingReached: number;
}

export interface ShadowChoiceInput {
  role: Role;
  /** adapterId@model — the router's actual pick this round. */
  liveChoice: string;
  /** adapterId@model keys, in router order (breaker-, health-, and hint-filtered). */
  eligible: string[];
  outcomeStats: Record<string, ShadowOutcomeStats>;
}

export interface ShadowChoice {
  wouldChoose: string;
  basis: string;
}

/**
 * Deterministic outcome-based pick (REQ-7.2): the eligible adapter with the
 * highest reviewing-reached rate wins; a tie keeps the first in eligible order
 * (router order — never randomized, so re-running with the same input always
 * agrees). No adapter has attempts yet -> the live choice stands unchanged,
 * basis 'insufficient_data' (never invents a preference from zero evidence).
 */
export function shadowWouldChoose(input: ShadowChoiceInput): ShadowChoice {
  const rated = input.eligible
    .map((key) => {
      const stats = input.outcomeStats[key];
      return stats === undefined || stats.attempts === 0
        ? null
        : { key, rate: stats.reviewingReached / stats.attempts };
    })
    .filter((r): r is { key: string; rate: number } => r !== null);

  if (rated.length === 0) return { wouldChoose: input.liveChoice, basis: 'insufficient_data' };

  const best = rated.reduce((a, b) => (b.rate > a.rate ? b : a));
  return { wouldChoose: best.key, basis: 'highest_reviewing_rate' };
}

/**
 * Conformance drift canary (REQ-7.3): any registered adapter gone stale freezes
 * shadow recording entirely — a drifted registered set makes outcome comparisons
 * meaningless. Caller passes `registry.all()`, the one enumeration that still
 * sees stale entries (`eligible()` already filters them out).
 */
export function shadowFrozen(adapters: RegisteredAdapter[]): boolean {
  return adapters.some((a) => a.stale);
}

export interface ShadowDivergence {
  at: string;
  live: string;
  shadow: string;
}

export interface ShadowComparison {
  n: number;
  agreementRate: number;
  divergences: ShadowDivergence[];
}

/**
 * Retrospective agreement math (REQ-7.6) — a pure fold over recorded SHADOW_ROUTE
 * events (any other event type in the array is ignored, so callers may pass a
 * pre-filtered slice or a raw log). No recorded routes yet -> agreementRate 1
 * (vacuous — no divergence has ever been observed), matching computeCalibration's
 * zero-n convention.
 */
export function compareShadow(events: PlatformEvent[]): ShadowComparison {
  const routes = events.filter((e) => e.type === 'SHADOW_ROUTE');
  const divergences = routes
    .filter((e) => e.payload['live'] !== e.payload['wouldChoose'])
    .map((e) => ({
      at: e.ts,
      live: e.payload['live'] as string,
      shadow: e.payload['wouldChoose'] as string,
    }));
  const n = routes.length;
  return {
    n,
    agreementRate: n === 0 ? 1 : (n - divergences.length) / n,
    divergences,
  };
}

/**
 * Per-adapter reviewing-reached stats (REQ-13.2), the cheapest outcome signal
 * that exists today: replay every prior SHADOW_ROUTE this log has recorded and
 * check whether ITS task ever reached REVIEWING. A task still in flight (the
 * common case for its own most-recent round) simply contributes 0 so far —
 * stats sharpen as a shared log accumulates across many tasks (e.g. the
 * calibration corpus), never from this round's own not-yet-known outcome.
 * Relocated from console/backend/src/loop-run.ts (REQ-13.2 — exported so both
 * the shadow recorder and `shadowProven` fold it identically, no duplicate math).
 */
export function computeShadowOutcomeStats(events: PlatformEvent[]): Record<string, ShadowOutcomeStats> {
  // Count PER TASK, not per SHADOW_ROUTE event: a multi-round task records one
  // SHADOW_ROUTE per iteration, so counting events inflated a 5-round task's weight
  // 5x and credited reviewingReached once per round — flipping rankings a 1-round
  // task never could (PR #50 review). One pass builds the set of REVIEWING taskIds
  // and the distinct-task set per adapter; a task counts once regardless of rounds.
  // Identify a task INSTANCE by (runId, taskId), not taskId alone: the loop
  // composition reuses the constant taskId 'T-1' every run, so taskId-only keying
  // would collapse distinct runs' tasks together and cross-credit REVIEWING if a
  // multi-run log were ever folded (PR #64 review). Today the fold is always
  // single-run (one events.db per run), so this hardens the general PlatformEvent[]
  // contract. ponytail: a true cross-run corpus would ALSO need the composition to
  // stamp distinct runIds (it emits a constant 'RUN-LIVE') — that's the corpus
  // builder's job, out of scope here.
  const key = (e: PlatformEvent): string => `${e.runId}\u0000${String(e.taskId)}`;
  const reviewingTasks = new Set<string>();
  const tasksByAdapter = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type === 'TASK_STATE' && e.payload['state'] === 'REVIEWING') {
      reviewingTasks.add(key(e));
    } else if (e.type === 'SHADOW_ROUTE') {
      const live = e.payload['live'] as string;
      let tasks = tasksByAdapter.get(live);
      if (tasks === undefined) {
        tasks = new Set();
        tasksByAdapter.set(live, tasks);
      }
      tasks.add(key(e));
    }
  }
  const stats: Record<string, ShadowOutcomeStats> = {};
  for (const [live, tasks] of tasksByAdapter) {
    let reviewingReached = 0;
    for (const t of tasks) if (reviewingTasks.has(t)) reviewingReached += 1;
    stats[live] = { attempts: tasks.size, reviewingReached };
  }
  return stats;
}

export interface ShadowProofCriteria {
  minSamples: number;
  /** Defaults to 1 when omitted (AZ-10 — the same default routing.json's outcomeRouting block falls back to). */
  minDivergences?: number;
}

export interface ShadowProofReport {
  proven: boolean;
  n: number;
  agreementRate: number;
  divergences: ShadowDivergence[];
  perAdapter: Record<string, ShadowOutcomeStats>;
}

/**
 * Evidence report for the human activation decision (REQ-13.1) — built entirely
 * on the existing folds (`compareShadow` for n/agreementRate/divergences,
 * `computeShadowOutcomeStats` for perAdapter, REQ-13.2's "no duplicate fold").
 * `proven` is n >= minSamples AND divergences >= minDivergences (REQ-13.3).
 * Nothing in routing code ever calls this — it is read by a human only (INV-16,
 * REQ-13.4); wiring a caller (CLI/report) is a separate, later concern.
 */
export function shadowProven(events: PlatformEvent[], c: ShadowProofCriteria): ShadowProofReport {
  const { n, agreementRate, divergences } = compareShadow(events);
  const perAdapter = computeShadowOutcomeStats(events);
  const minDivergences = c.minDivergences ?? 1;
  return {
    proven: n >= c.minSamples && divergences.length >= minDivergences,
    n,
    agreementRate,
    divergences,
    perAdapter,
  };
}
