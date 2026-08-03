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

export type CostValidationReason = 'non_finite' | 'negative' | 'overflow';

export type CostValidation =
  | { ok: true; value: number }
  | { ok: false; reason: CostValidationReason; detail: string };

/**
 * Validate one untrusted usage value before it can enter a budget or aggregate.
 * `unknown` is deliberate: this is a runtime boundary, not a type assertion.
 */
export function validateCostUnits(value: unknown): CostValidation {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: 'non_finite', detail: 'costUnits must be a finite number' };
  }
  if (value < 0) {
    return { ok: false, reason: 'negative', detail: 'costUnits must be non-negative' };
  }
  return { ok: true, value };
}

/** Add untrusted usage without allowing an IEEE-754 overflow to become credit. */
export function addCostUnits(total: unknown, increment: unknown): CostValidation {
  const prior = validateCostUnits(total);
  if (!prior.ok) return prior;
  const next = validateCostUnits(increment);
  if (!next.ok) return next;
  const value = prior.value + next.value;
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'overflow', detail: 'costUnits aggregate overflowed the finite range' };
  }
  return { ok: true, value };
}

export class BudgetUsageError extends Error {
  readonly reason: CostValidationReason;
  constructor(result: Extract<CostValidation, { ok: false }>) {
    super(result.detail);
    this.name = 'BudgetUsageError';
    this.reason = result.reason;
  }
}

export function createBudget(limits: BudgetLimits, clock: Clock): BudgetTracker {
  const startedAt = clock.now();
  let iterations = 0;
  let costUnits = 0;
  let excludedMs = 0;

  return {
    noteIteration(cost) {
      const next = addCostUnits(costUnits, cost);
      if (!next.ok) throw new BudgetUsageError(next);
      // Validate first so invalid input and aggregate overflow cannot consume an
      // iteration or alter the accumulated cost.
      iterations += 1;
      costUnits = next.value;
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
