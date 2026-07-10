// Router (§7.4; REQ-6, REQ-2/REQ-3). Capability match over the registered set;
// clean structured `no_capacity` when nothing is eligible — NO retry loops (the
// source owns the single degraded re-route, REQ-3.2). Phase 2 exposes the ordered
// eligible LIST (so the source can exclude just-failed keys) and refreshHealth
// (awaited once per round before routing).

import { createHash } from 'node:crypto';

import { breakerKey } from './breaker.ts';
import type { AdapterInterface } from './protocol.ts';
import type { HealthChange, RegisteredAdapter, Registry } from './registry.ts';
import { shadowFrozen } from './shadow.ts';
import type { ShadowOutcomeStats } from './shadow.ts';
import type { EventLog } from 'core';
import type { Role } from 'core/types';

/** Nothing eligible for the role — the task becomes BLOCKED(no_capacity); NO retry (REQ-6.2). */
export class NoCapacityError extends Error {
  readonly kind = 'no_capacity' as const;
  readonly role: Role;
  constructor(role: Role) {
    super(`no eligible adapter for role ${role}`);
    this.role = role;
    this.name = 'NoCapacityError';
  }
}

/**
 * Injection- and lineage-aware routing filters (REQ-5), backward-compatible:
 * absent hints => Phase-2 behavior byte-identical (REQ-5.1). Filters only ever
 * REMOVE candidates from the eligible set — never add or reorder — so the route
 * stays deterministic (registry order, filtered).
 */
export interface RouteHints {
  /** Exclude adapters whose p7 susceptibilityScore exceeds this cap (REQ-5.2). */
  maxSusceptibility?: number;
  /** Exclude adapters whose lineage is listed (REQ-5.3; e.g. test_designer != implementer). */
  excludeLineages?: string[];
}

/** Apply the hint filters to an already breaker/health-filtered eligible set. */
function filterHints(list: RegisteredAdapter[], hints?: RouteHints): RegisteredAdapter[] {
  if (hints === undefined) return list;
  let out = list;
  if (hints.maxSusceptibility !== undefined) {
    const cap = hints.maxSusceptibility;
    out = out.filter((r) => r.susceptibilityScore <= cap);
  }
  if (hints.excludeLineages !== undefined && hints.excludeLineages.length > 0) {
    const excluded = new Set(hints.excludeLineages);
    out = out.filter((r) => !excluded.has(r.lineage));
  }
  return out;
}

export interface Router {
  /** Returns the first eligible adapter, or throws NoCapacityError when none matches. */
  route(role: Role, hints?: RouteHints): AdapterInterface;
  /** The ordered eligible set (breaker-, health-, and hint-filtered) for degraded re-routing. */
  eligibleAdapters(role: Role, hints?: RouteHints): RegisteredAdapter[];
  /** Refresh cached health once per round before routing (REQ-2.2); returns changes to emit. */
  refreshHealth(): Promise<HealthChange[]>;
}

export function createRouter(registry: Registry): Router {
  return {
    route(role, hints) {
      const eligible = filterHints(registry.eligible(role), hints);
      const first = eligible[0];
      if (first === undefined) throw new NoCapacityError(role);
      return first.adapter;
    },
    eligibleAdapters(role, hints) {
      return filterHints(registry.eligible(role), hints);
    },
    refreshHealth() {
      return registry.refreshHealth();
    },
  };
}

// --- Outcome routing ACTIVE (REQ-13/14/15; workstream E). Reorders the
// already-filtered eligible set by reviewing-reached rate — breaker/health/hint
// filters still only remove (REQ-15.6); this wrapper only permutes what
// survives them. Sibling to loop-run.ts's wrapRouterForShadow, but lives here
// (not composition) because the reorder/epsilon math is pure and independently
// testable. ---

/** sha256 fold -> [0,100) integer percent — same no-RNG pattern as auto-merge.ts's auditSampleValue (REQ-15.3). */
function hashPercent(key: string): number {
  const hex = createHash('sha256').update(key).digest('hex');
  let acc = 0;
  for (const ch of hex) acc = (acc * 16 + parseInt(ch, 16)) % 100;
  return acc;
}

/**
 * Stable partial sort (REQ-15.1): only adapters with a rated outcome (attempts
 * > 0) are reordered among themselves by reviewing-reached rate desc (ties keep
 * their relative order — Array#sort is stable, ES2019); an unrated adapter
 * never moves from its original slot — zero evidence never invents a
 * preference (same rule as `shadowWouldChoose`). `reordered` is true iff >= 1
 * adapter was rated, even if the visible order happens not to change — that is
 * REQ-15.2's "an outcome-based reorder actually occurred" precondition for
 * epsilon exploration.
 */
function reorderByOutcome(
  eligible: RegisteredAdapter[],
  stats: Record<string, ShadowOutcomeStats>,
): { order: RegisteredAdapter[]; reordered: boolean; rated: { i: number }[] } {
  const rateOf = (r: RegisteredAdapter): number | null => {
    const s = stats[breakerKey(r.record.adapterId, r.record.modelVersion)];
    return s === undefined || s.attempts === 0 ? null : s.reviewingReached / s.attempts;
  };
  const rated = eligible
    .map((a, i) => ({ a, i, rate: rateOf(a) }))
    .filter((x): x is { a: RegisteredAdapter; i: number; rate: number } => x.rate !== null);
  if (rated.length === 0) return { order: eligible, reordered: false, rated: [] };

  const sorted = [...rated].sort((x, y) => y.rate - x.rate);
  const order = [...eligible];
  rated.forEach((slot, idx) => {
    const winner = sorted[idx];
    if (winner !== undefined) order[slot.i] = winner.a;
  });
  // rated[k].i is exactly the destination slot that ends up holding rank k (the
  // assignment above places sorted[idx] — rank idx — at rated[idx].i) — so rated[0].i/
  // rated[1].i are the winner's and runner-up's positions regardless of where any
  // pinned-unrated adapter sits.
  return { order, reordered: true, rated };
}

/**
 * Swap the winner with the RATED runner-up (REQ-15.2) — by rank, not physical
 * index 0/1: an unrated adapter can sit at physical index 1 (reorderByOutcome
 * never moves an unrated slot), and blindly swapping 0/1 would promote that
 * zero-evidence adapter ahead of the true rated runner-up (PR #50 review).
 * No-op when there is no second rated adapter to explore.
 */
function swapWithRatedRunnerUp(order: RegisteredAdapter[], rated: { i: number }[]): RegisteredAdapter[] {
  const winnerPos = rated[0];
  const runnerUpPos = rated[1];
  if (winnerPos === undefined || runnerUpPos === undefined) return order;
  const out = [...order];
  const winner = out[winnerPos.i];
  const runnerUp = out[runnerUpPos.i];
  if (winner === undefined || runnerUp === undefined) return out;
  out[winnerPos.i] = runnerUp;
  out[runnerUpPos.i] = winner;
  return out;
}

/**
 * Active outcome-based routing (REQ-15). Wraps only `eligibleAdapters` — same
 * scope as `wrapRouterForShadow` (the one method the live proposal flow reads
 * its pick from). Precedence, most to least authoritative (AZ-11): a stale
 * registered adapter (drift canary) freezes to the plain router order for the
 * round and appends ONLY `ROUTING_FROZEN` (REQ-15.5); otherwise no rated
 * adapter yet keeps the plain order with basis `insufficient_data` (REQ-15.7);
 * otherwise the set reorders by outcome (basis `reorder`) and MAY additionally
 * swap the winner with the rated runner-up when the deterministic explore hash
 * lands under epsilon AND there are >= 2 RATED entries (REQ-15.2) — an unrated,
 * zero-evidence adapter is never swapped in even if it physically sits at
 * index 1. Every non-frozen round appends exactly one `OUTCOME_ROUTE
 * {order, explored, basis}` (REQ-15.4).
 */
export function wrapRouterForOutcome(
  router: Router,
  deps: {
    registry: Registry;
    stats: () => Record<string, ShadowOutcomeStats>;
    epsilonPercent: number;
    /** runId+taskId+round, caller-derived from the durable log so a restart never repeats a round (REQ-15.3). */
    exploreKey: () => string;
    log: EventLog;
    runId: string;
    taskId: string;
  },
): Router {
  const keyOf = (r: RegisteredAdapter): string => breakerKey(r.record.adapterId, r.record.modelVersion);
  // A failed append never blocks the round — the order below is already decided;
  // only the audit trail write can fail (same resilience as wrapRouterForShadow).
  const safeAppend = (type: 'ROUTING_FROZEN' | 'OUTCOME_ROUTE', payload: Record<string, unknown>): void => {
    try {
      deps.log.append({ runId: deps.runId, taskId: deps.taskId, type, payload });
    } catch (err) {
      try {
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'ERROR',
          payload: { reason: 'outcome_route_append_failed', detail: (err as Error).message },
        });
      } catch {
        // A persistently-failing log must never escape and block the round — the
        // order is already decided, only the audit write can fail (PR #50 review).
      }
    }
  };
  return {
    ...router,
    eligibleAdapters(role: Role, hints?: RouteHints) {
      const eligible = router.eligibleAdapters(role, hints);
      if (shadowFrozen(deps.registry.all())) {
        safeAppend('ROUTING_FROZEN', { role });
        return eligible;
      }
      const { order, reordered, rated } = reorderByOutcome(eligible, deps.stats());
      let finalOrder = order;
      let explored = false;
      if (reordered && rated.length >= 2 && hashPercent(deps.exploreKey()) < deps.epsilonPercent) {
        finalOrder = swapWithRatedRunnerUp(finalOrder, rated);
        explored = true;
      }
      safeAppend('OUTCOME_ROUTE', {
        role,
        order: finalOrder.map(keyOf),
        explored,
        basis: reordered ? 'reorder' : 'insufficient_data',
      });
      return finalOrder;
    },
  };
}
