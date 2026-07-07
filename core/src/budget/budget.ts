// Budget backstop (spec §6.6, REQ-10) — always on; the loop provably halts.

import type { BudgetLimits, Clock } from '../types.ts';

export interface BudgetTracker {
  noteIteration(costUnits: number): void;
  /** False while inside budget; otherwise names the first exceeded limit. */
  exceeded(): false | { limit: 'iterations' | 'costUnits' | 'wallclock' };
  /** Cost units still available (never negative) — the real remaining budget (REQ-6.3). */
  remaining(): number;
}

export function createBudget(limits: BudgetLimits, clock: Clock): BudgetTracker {
  const startedAt = clock.now();
  let iterations = 0;
  let costUnits = 0;

  return {
    noteIteration(cost) {
      iterations += 1;
      costUnits += cost;
    },
    exceeded() {
      if (iterations >= limits.maxIterations) return { limit: 'iterations' };
      if (costUnits > limits.maxCostUnits) return { limit: 'costUnits' };
      if (clock.now() - startedAt > limits.maxWallclockMs) return { limit: 'wallclock' };
      return false;
    },
    remaining() {
      return Math.max(0, limits.maxCostUnits - costUnits);
    },
  };
}
