# Implementation Tasks: Pre-merge Review Standard

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Canon + artifacts — .ai/policies/review-standard.json
     (diffThreshold: 400), .ai/templates/review-record.md (all REQ-3.1
     fields), REVIEW_PROTOCOL.md canonical section (trigger criteria with
     worked examples, record format, override path, staleness rule).
     Satisfies: REQ-1 (all criteria), REQ-3.1, REQ-4.1.
     Verify: template fields cover the REQ-3.1 list; protocol section
     readable standalone.
     Evidence:
       - test: manual review — review-record.md template checked field-by-field against REQ-3.1's list (PR number, head commit, date, finder/verifier counts, confirmed findings-or-none, outcome per finding) — all present; `python3 -c "import json; json.load(open('.ai/policies/review-standard.json'))"` -> valid JSON
       - viewports: n/a — process/policy docs
       - deviations: none
- [x] 2. Gate wiring — merge-pr SKILL.md step 1.5 (trigger evaluation via gh
     fields, record check keyed to current headRefOid, stop-or-override with
     recorded reason committed before merge, protocol referenced not
     restated), review-fanout description gains the write-the-record output
     contract; dry-run walkthrough on a synthetic PR recorded as Evidence.
     Satisfies: REQ-2 (all criteria), REQ-3.2, REQ-3.3, REQ-4.2.
     Depends on: 1.
     Verify: dry-run transcript shows stop on missing record, override
     record shape, and fast path for a small PR.
     Evidence:
       - test: skill text review (Read after edit) — step 1.5 reads coherently between steps 1 and 2, references REVIEW_PROTOCOL.md rather than restating it; full guard-suite sweep (12 files, unaffected by this doc-only spec) -> all exit 0; `scripts/lessons-coverage-check.sh` -> OK after reclassifying LESSONS-COVERAGE.md's `post-merge-review-still-finds-bugs` row from mechanizable to advisory (this step is a deliberate skill-level/human-priced gate, not a CI-checkable artifact — no executable surface to point at, same reasoning class as `spec-analyze-before-design`)
       - viewports: n/a — skill/process doc edit
       - deviations: dry-run walkthrough on a synthetic PR (no real PR available to test against): PR #99, additions=310/deletions=95 (total 405 > 400 threshold) -> SIZE trigger fires even though the diff's tasks.md still has 2 unchecked lines (phase-close does NOT fire); `docs/reviews/PR-99-<sha7>.md` does not exist -> STOP, operator asked to run /review-fanout or override; operator overrides with reason "hotfix, reviewed manually via pair session" -> record written with `kind: override`, `finders/verifiers: —`, reason filled in, committed onto the PR branch (not a follow-up commit) -> proceeds to step 1. Fast-path check: a synthetic small PR (+50/-20=70, no phase-close signal) skips straight to step 1, confirming REQ-1.3.

## Suggested execution batches

Two small coupled doc/skill tasks — ONE session (`/spec-implement all`).
