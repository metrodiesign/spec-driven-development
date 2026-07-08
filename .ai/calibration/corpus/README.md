# Fusion calibration corpus

The 10-task-minimum fixture the fusion uplift/decorrelation numbers are measured
over (unified-platform-spec.md section 12, REQ-11). Loaded by
`loadCalibrationCorpus` in `core/src/calibration/corpus.ts`.

## Layout

- `manifest.json` — declares the task ids, the visible/held-out split, and
  `numbersAreFixture`.
- `tasks/<id>.json` — the MODEL-VISIBLE task spec: objective + budget only. This
  is the slice a candidate's context bundle may carry.
- `answers/<id>.json` — the HELD-OUT answer-key plus the hidden golden
  (`{ expected, sha256 }`). This directory is NEVER placed in a model's context
  bundle; it exists only so the harness can score single-vs-fused pass and verify
  the golden was not tampered with (the `sha256` must equal the hash of
  `expected`).

Keeping the answer-key and golden physically OUT of `tasks/` is the point: a
candidate is scored against evidence it never saw.

## Running the harness

The CI harness runs the corpus with the `FakeAdapter` — ZERO quota — and proves
only that the loader, the golden integrity check, and the calibration MATH are
correct. The numbers it produces are scripted fixtures, never section-12 metrics.

`numbersAreFixture` stays `true` until the LIVE task (task 13) runs at most three
real fusion activations under the profile caps and records the real uplift
interval into `docs/calibration/`. Until then, no file here carries a real
calibration number.
