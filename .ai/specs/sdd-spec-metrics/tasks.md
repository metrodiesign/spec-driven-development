# Implementation Tasks: Spec Effectiveness Metrics

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Aggregator end-to-end — scripts/spec-metrics.py (feature enumeration
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
- [ ] 2. Retro integration — spec-retro SKILL.md step running
     `spec-metrics.py --feature <active>` with the non-blocking failure note.
     Satisfies: REQ-4 (all criteria). Depends on: 1.
     Verify: skill text + one real retro includes the table.

## Suggested execution batches

ONE session (`/spec-implement all`) — task 2 is a two-line skill edit riding
task 1's context.
