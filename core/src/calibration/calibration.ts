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
