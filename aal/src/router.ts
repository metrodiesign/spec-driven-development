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

export interface Router {
  /** Returns the first eligible adapter, or throws NoCapacityError when none matches. */
  route(role: Role): AdapterInterface;
  /** The ordered eligible set (breaker- and health-filtered) for degraded re-routing. */
  eligibleAdapters(role: Role): RegisteredAdapter[];
  /** Refresh cached health once per round before routing (REQ-2.2); returns changes to emit. */
  refreshHealth(): Promise<HealthChange[]>;
}

export function createRouter(registry: Registry): Router {
  return {
    route(role) {
      const eligible = registry.eligible(role);
      const first = eligible[0];
      if (first === undefined) throw new NoCapacityError(role);
      return first.adapter;
    },
    eligibleAdapters(role) {
      return registry.eligible(role);
    },
    refreshHealth() {
      return registry.refreshHealth();
    },
  };
}
