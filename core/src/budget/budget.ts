// Budget backstop (spec §6.6, REQ-10) — always on; the loop provably halts.

import type { BudgetLimits, Clock } from '../types.ts';

export interface BudgetTracker {
  noteIteration(costUnits: number): void;
  /**
   * Exclude an interval from the ACTIVE wallclock — a pause (PAUSE_REQUESTED →
   * RESUMED) or an approval-wait window (REQ-6.5). The wallclock budget trips on
   * active time only, so steering never counts against it.
   */
  noteExcludedMs(ms: number): void;
  /** False while inside budget; otherwise names the first exceeded limit. */
  exceeded(): false | { limit: 'iterations' | 'costUnits' | 'wallclock' };
  /** Cost units still available (never negative) — the real remaining budget (REQ-6.3). */
  remaining(): number;
}

export function createBudget(limits: BudgetLimits, clock: Clock): BudgetTracker {
  const startedAt = clock.now();
  let iterations = 0;
  let costUnits = 0;
  let excludedMs = 0;

  return {
    noteIteration(cost) {
      iterations += 1;
      costUnits += cost;
    },
    noteExcludedMs(ms) {
      if (ms > 0) excludedMs += ms;
    },
    exceeded() {
      if (iterations >= limits.maxIterations) return { limit: 'iterations' };
      if (costUnits > limits.maxCostUnits) return { limit: 'costUnits' };
      if (clock.now() - startedAt - excludedMs > limits.maxWallclockMs) return { limit: 'wallclock' };
      return false;
    },
    remaining() {
      return Math.max(0, limits.maxCostUnits - costUnits);
    },
  };
}
