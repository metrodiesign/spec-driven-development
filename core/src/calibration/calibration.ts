// Calibration harness MATH (spec §12, REQ-11.2). Pure metric computation over a
// set of loop outcomes + clean-checkout re-run outcomes. In CI these numbers are
// derived from the FakeAdapter and prove only that the MATH is correct — they are
// never reported as §12 metrics. Real numbers come from a manual live run (task 11).
//
// Held-out pass rate = fraction of tasks whose held-out (golden) verification
// passed. Small n -> reported as a range (Wilson-ish simple interval).
// Reproducibility = fraction of clean-checkout re-runs that matched the original.

import type { PlatformEvent } from '../types.ts';

export interface CalibrationInput {
  heldOut: boolean[]; // per task: did the held-out/golden check pass?
  reruns: boolean[]; // per COMPLETED task: did a clean-checkout re-run reproduce the result?
}

export interface CalibrationResult {
  n: number;
  heldOutPassRate: number;
  /** [low, high] — a plain ±1/√n band, since n is small (§12 "รายงานเป็นช่วง"). */
  range: [number, number];
  reproducibility: number;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function computeCalibration(input: CalibrationInput): CalibrationResult {
  const n = input.heldOut.length;
  const passes = input.heldOut.filter(Boolean).length;
  const rate = n === 0 ? 0 : passes / n;
  const band = n === 0 ? 0 : 1 / Math.sqrt(n);
  const reproN = input.reruns.length;
  const reproducibility = reproN === 0 ? 1 : input.reruns.filter(Boolean).length / reproN;
  return {
    n,
    heldOutPassRate: rate,
    range: [clamp01(rate - band), clamp01(rate + band)],
    reproducibility,
  };
}

// Fusion calibration MATH (spec §12, REQ-11). Same discipline as computeCalibration:
// in CI these numbers come from the FakeAdapter and prove only that the MATH is
// correct — never reported as §12 metrics. Real numbers come from <=3 manual live
// fusion activations (task 13). Uplift is reported as an INTERVAL (small n); the
// decorrelation number is a MEASUREMENT of panel disagreement, never a claim of model
// independence (§16 honest-claims).

export interface FusionCalibrationInput {
  /** Baseline single-model held-out pass/fail per corpus task. */
  single: boolean[];
  /** Same tasks through fusion — index-aligned with `single`. */
  fused: boolean[];
  /** Per-activation fraction of pairwise-divergent candidates (0..1). */
  panelDisagreements: number[];
}

export interface FusionCalibrationResult {
  n: number;
  /** fused pass rate − single pass rate; can be negative (fusion can hurt). */
  uplift: number;
  /** uplift ± 1/√n band, clamped to the valid uplift range [-1, 1] (REQ-11.1). */
  upliftRange: [number, number];
  /** Mean pairwise panel disagreement — a MEASUREMENT, never "independence" (REQ-11.2). */
  decorrelation: number;
}

function clampRange(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function computeFusionCalibration(input: FusionCalibrationInput): FusionCalibrationResult {
  // n = the number of paired tasks; a length mismatch counts only the shared prefix so
  // uplift never divides by an inconsistent denominator.
  const n = Math.min(input.single.length, input.fused.length);
  const decorrelation = clamp01(mean(input.panelDisagreements));
  // REQ-11.3: zero tasks -> a zero-n result, never a divide-by-zero.
  if (n === 0) {
    return { n: 0, uplift: 0, upliftRange: [0, 0], decorrelation };
  }
  const singleRate = input.single.slice(0, n).filter(Boolean).length / n;
  const fusedRate = input.fused.slice(0, n).filter(Boolean).length / n;
  const uplift = fusedRate - singleRate;
  const band = 1 / Math.sqrt(n);
  return {
    n,
    uplift,
    upliftRange: [clampRange(uplift - band), clampRange(uplift + band)],
    decorrelation,
  };
}

// Lesson hit-rate PROXY (REQ-24.1, spec §14 Phase 4 task 11). Same fold
// convention as aal's computeShadowOutcomeStats (group by taskId, check whether
// that task's log ever reached REVIEWING) — a proxy, not a quality claim; the
// caller labels it as such (same convention as the shadow reviewing-reached
// stat). Sharpens as a shared log accumulates across many real tasks; in CI a
// single-task fixture log yields n<=1, proving only that the fold is correct.

export interface LessonHitRateStats {
  /** Distinct tasks that received >=1 LESSON_INJECTED event. */
  injectionCount: number;
  /** Of those, the fraction that reached REVIEWING. 0 when injectionCount is 0 (never fabricated). */
  hitRateProxy: number;
}

export function computeLessonHitRate(events: PlatformEvent[]): LessonHitRateStats {
  // One pass collects both the injected-task set and the REVIEWING-task set, instead
  // of an O(n^2) inner `events.some` scan per injected task (PR #50 review — same
  // single-pass Set fix as aal's computeShadowOutcomeStats).
  // Key a task INSTANCE by (runId, taskId), not taskId alone — same reason as aal's
  // computeShadowOutcomeStats: the composition reuses a constant taskId per run, so
  // taskId-only keying would collapse/cross-credit tasks if a multi-run log were ever
  // folded (PR #64 review). Single-run today; this hardens the general contract.
  const key = (e: PlatformEvent): string => `${e.runId}\u0000${String(e.taskId)}`;
  const injectedTasks = new Set<string>();
  const reviewingTasks = new Set<string>();
  for (const e of events) {
    if (e.type === 'LESSON_INJECTED' && e.taskId !== null) injectedTasks.add(key(e));
    else if (e.type === 'TASK_STATE' && e.taskId !== null && e.payload['state'] === 'REVIEWING') reviewingTasks.add(key(e));
  }
  if (injectedTasks.size === 0) return { injectionCount: 0, hitRateProxy: 0 };
  let hits = 0;
  for (const k of injectedTasks) if (reviewingTasks.has(k)) hits += 1;
  return { injectionCount: injectedTasks.size, hitRateProxy: hits / injectedTasks.size };
}
