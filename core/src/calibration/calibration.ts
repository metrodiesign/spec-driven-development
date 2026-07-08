// Calibration harness MATH (spec §12, REQ-11.2). Pure metric computation over a
// set of loop outcomes + clean-checkout re-run outcomes. In CI these numbers are
// derived from the FakeAdapter and prove only that the MATH is correct — they are
// never reported as §12 metrics. Real numbers come from a manual live run (task 11).
//
// Held-out pass rate = fraction of tasks whose held-out (golden) verification
// passed. Small n -> reported as a range (Wilson-ish simple interval).
// Reproducibility = fraction of clean-checkout re-runs that matched the original.

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
