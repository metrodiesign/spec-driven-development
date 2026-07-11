# Implementation Tasks: Spec Effectiveness Metrics

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Aggregator end-to-end — scripts/spec-metrics.py (feature enumeration
     incl. archive, task/checkbox counts, cost via cost_lib import with
     incomplete-marker and n/a paths, post-approval-edit + fix-PR rework
     signals, markdown/--json/--feature outputs, disclaimer header, exit
     contract) + .claude/hooks/tests/spec-metrics.test.sh (fixture specs +
     fixture ledger via HOME override: normal aggregation / incomplete
     marker / absent ledger / JSON shape / per-task breakdown /
     post-approval-edit count / offline run).
     Satisfies: REQ-1 (all criteria), REQ-2 (all), REQ-3 (all), REQ-5 (all).
     Verify: bash .claude/hooks/tests/spec-metrics.test.sh green + a real run
     over this repo produces a table.
     Evidence:
       - test: `bash .claude/hooks/tests/spec-metrics.test.sh` -> 7 passed / 0 failed; `python3 scripts/spec-metrics.py` over the real repo -> 15-row table with real cost/session/span figures; full guard-suite sweep (12 files) -> all exit 0
       - viewports: n/a — logic-only (python + bash fixtures)
       - deviations: (1) real bug found + fixed via testing: completeness was originally checked against ALL task ids (done + not-yet-done), so any in-progress feature would ALWAYS show "incomplete" cost even with perfect coverage of its actually-done work — fixed to check DONE ids only (an empty done-set is vacuously complete). (2) fixture-construction bug found + fixed: macOS resolves `/var/folders/*` to `/private/var/folders/*` via symlink, and cost_lib's SLUG comes from Python's `os.getcwd()` (resolved) — the test fixture's slug must use `pwd -P` (physical path), not the raw mktemp path, or the fake ledger/transcript land in a directory cost_lib never looks in. (3) attribution imprecision confirmed live: two fixture features sharing task ids 1/2 mutually over-attributed each other's sessions — this is the spec's own accepted, documented limitation (edge case: "sessions spanning two features attribute by task label"), not a bug; the "two features" test row uses disjoint ids specifically to test the CLEAN attribution path, per REQ-1.1.
- [x] 2. Retro integration — spec-retro SKILL.md step running
     `spec-metrics.py --feature <active>` with the non-blocking failure note.
     Satisfies: REQ-4 (all criteria). Depends on: 1.
     Verify: skill text + one real retro includes the table.
     Evidence:
       - test: skill text review (Read after edit) — step 1 gains the gather instruction (REQ-4.1) with explicit non-blocking wording (REQ-4.2); step 2's template gains a `## Feature Metrics` / `<METRICS>` section right after Session Cost; `python3 scripts/spec-metrics.py --feature sdd-spec-metrics` (dry run, this active feature) -> produces a real table
       - viewports: n/a — skill/process doc edit
       - deviations: none. Live exercise at the next real `/spec-retro` run (cannot fabricate a full retro here without a real session boundary)

## Suggested execution batches

ONE session (`/spec-implement all`) — task 2 is a two-line skill edit riding
task 1's context.
