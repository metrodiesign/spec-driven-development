// Router (§7.4; REQ-6, REQ-2/REQ-3). Capability match over the registered set;
// clean structured `no_capacity` when nothing is eligible — NO retry loops (the
// source owns the single degraded re-route, REQ-3.2). Phase 2 exposes the ordered
// eligible LIST (so the source can exclude just-failed keys) and refreshHealth
// (awaited once per round before routing).

import type { AdapterInterface } from './protocol.ts';
import type { HealthChange, RegisteredAdapter, Registry } from './registry.ts';
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
