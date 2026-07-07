// Phase-1 minimal router (§7.4; REQ-6). Capability match over the registered set;
// clean structured `no_capacity` when nothing is eligible — NO retry loops
// (the breaker arrives in Phase 2).

import type { AdapterInterface } from './protocol.ts';
import type { Registry } from './registry.ts';
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
  /** Returns an eligible adapter, or throws NoCapacityError when none matches. */
  route(role: Role): AdapterInterface;
}

export function createRouter(registry: Registry): Router {
  return {
    route(role) {
      const eligible = registry.eligible(role);
      const first = eligible[0];
      if (first === undefined) throw new NoCapacityError(role);
      return first.adapter;
    },
  };
}
