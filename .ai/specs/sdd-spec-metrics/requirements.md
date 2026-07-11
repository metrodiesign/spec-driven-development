# Requirements: Spec Effectiveness Metrics (measure the process itself)

> Status: approved 2026-07-11

## Overview

The platform measures itself (calibration suite, §12) but the SDD process
layer has no numbers: nobody can say what a feature cost in sessions, tokens,
or rework rounds, so ceremony decisions (which gates pay for themselves) rest
on feel. The raw data already exists — the cost ledger
(`~/.claude/cost-sessions/`), spec artifacts, git history, retrospectives.
This spec adds one offline aggregator that turns that data into a per-feature
metrics table, labeled as estimates per the repo's claim discipline, so future
process changes (including the other sdd-* specs) can be judged against a
baseline.

## REQ-1: Per-feature aggregation

**User Story:** As the repo owner, I want one command that reports what each
feature actually consumed, so process cost is a number, not an impression.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL provide `scripts/spec-metrics.py` that, per feature
  under `.ai/specs/` (including `archive/`), reports: task count (total and
  `[x]`), session count and cost attributed via the existing ledger/`cost_lib`
  attribution, wall-clock span (first to last artifact/commit touch), and PR
  count referencing the feature.
- 1.2 THE SYSTEM SHALL compute a rework signal per feature: count of
  fix/bugfix specs or fix-PRs that name the feature, and count of
  post-approval edits to its requirements.md/design.md (git history of the
  artifact after its `Status: approved` stamp).
- 1.3 THE SYSTEM SHALL reuse `scripts/cost_lib.py` for ledger parsing (no
  second parser).
- 1.4 THE SYSTEM SHALL run offline in one command with no network access and
  exit zero on a clean report.

## REQ-2: Honest gaps, labeled estimates

**User Story:** As a reader, I want missing data reported as missing, so a
gap never reads as "free".

**Acceptance Criteria (EARS):**
- 2.1 IF a feature has sessions with no ledger entry THEN THE SYSTEM SHALL
  report that feature's cost as a lower bound with an explicit `incomplete`
  marker (never silently zero) — matching the recorded lesson that closed
  sessions without a ledger lose cost data permanently.
- 2.2 THE SYSTEM SHALL label every monetary figure "API-equivalent value —
  not an actual bill" (same disclaimer discipline as the platform).
- 2.3 IF the ledger directory is absent entirely THEN THE SYSTEM SHALL still
  report the non-cost columns and mark cost columns `n/a`.

## REQ-3: Output formats

**User Story:** As a retro author, I want the table pasteable into a retro,
so the numbers actually get used.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL emit a Markdown table by default and JSON with
  `--json`.
- 3.2 THE SYSTEM SHALL include a totals row across features.
- 3.3 WHEN given `--feature <name>` THE SYSTEM SHALL report only that feature
  with a per-task breakdown (task id → sessions, cost) where the ledger
  attribution allows.

## REQ-4: Retro integration

**User Story:** As `/spec-retro`, I want the metrics step built in, so the
baseline accumulates without anyone remembering to run it.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL add a step to the `/spec-retro` skill that runs
  `spec-metrics.py --feature <active feature>` and includes the table in the
  retrospective file.
- 4.2 WHERE the script fails THE SYSTEM SHALL have the retro proceed with a
  note of the failure (metrics are additive, never a blocker).

## REQ-5: Tests

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL ship unit tests with fixture ledgers/specs covering:
  normal aggregation, missing-ledger lower-bound marking, absent ledger dir,
  and JSON output shape.
- 5.2 IF any test fails THEN CI SHALL fail.

## Edge Cases & Open Questions

- Attribution precision: session→feature mapping relies on the ledger's task
  labels; sessions spanning two features attribute by task label per
  `cost_lib` semantics — imprecision documented in the script header, not
  hidden.
- Baseline timing: the first useful comparison arrives only after the next
  1-2 features ship with metrics on; that latency is accepted and noted in
  the report header.
- No trend UI: markdown/JSON only — charts are out of scope (YAGNI until the
  table proves insufficient).
