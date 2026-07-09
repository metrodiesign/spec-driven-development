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
): { order: RegisteredAdapter[]; reordered: boolean } {
  const rateOf = (r: RegisteredAdapter): number | null => {
    const s = stats[breakerKey(r.record.adapterId, r.record.modelVersion)];
    return s === undefined || s.attempts === 0 ? null : s.reviewingReached / s.attempts;
  };
  const rated = eligible
    .map((a, i) => ({ a, i, rate: rateOf(a) }))
    .filter((x): x is { a: RegisteredAdapter; i: number; rate: number } => x.rate !== null);
  if (rated.length === 0) return { order: eligible, reordered: false };

  const sorted = [...rated].sort((x, y) => y.rate - x.rate);
  const order = [...eligible];
  rated.forEach((slot, idx) => {
    const winner = sorted[idx];
    if (winner !== undefined) order[slot.i] = winner.a;
  });
  return { order, reordered: true };
}

/** Swap index 0/1 — the epsilon "explore the runner-up" move (REQ-15.2). Caller guarantees length >= 2. */
function swapFirstTwo(list: RegisteredAdapter[]): RegisteredAdapter[] {
  const out = [...list];
  const first = out[0];
  const second = out[1];
  if (first === undefined || second === undefined) return out;
  out[0] = second;
  out[1] = first;
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
 * swap positions 0/1 when the deterministic explore hash lands under epsilon
 * AND the eligible set has >= 2 entries (REQ-15.2). Every non-frozen round
 * appends exactly one `OUTCOME_ROUTE {order, explored, basis}` (REQ-15.4).
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
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'ERROR',
        payload: { reason: 'outcome_route_append_failed', detail: (err as Error).message },
      });
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
      const { order, reordered } = reorderByOutcome(eligible, deps.stats());
      let finalOrder = order;
      let explored = false;
      if (reordered && eligible.length >= 2 && hashPercent(deps.exploreKey()) < deps.epsilonPercent) {
        finalOrder = swapFirstTwo(finalOrder);
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
