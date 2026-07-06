// Budget backstop (spec §6.6, REQ-10) — always on; the loop provably halts.

import type { BudgetLimits, Clock } from '../types.ts';

export interface BudgetTracker {
  noteIteration(costUnits: number): void;
  /** False while inside budget; otherwise names the first exceeded limit. */
  exceeded(): false | { limit: 'iterations' | 'costUnits' | 'wallclock' };
}

export function createBudget(_limits: BudgetLimits, _clock: Clock): BudgetTracker {
  throw new Error('NotImplemented: createBudget');
}
