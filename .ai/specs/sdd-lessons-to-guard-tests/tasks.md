# Implementation Tasks: Lessons to Guard Tests (mechanize the lesson ledger)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Coverage audit + checker — add [#slug] annotations to every
     LESSONS.md entry (wording untouched), write LESSONS-COVERAGE.md
     classifying all entries (mechanized/mechanizable/advisory + artifact
     path or reason), ship scripts/lessons-coverage-check.sh (slug-set match
     both directions + mechanized paths exist) wired into the CI verify job,
     with its own fixture tests (synced pass / orphan slug / dangling path).
     Satisfies: REQ-1 (all criteria).
     Verify: scripts/lessons-coverage-check.sh exits 0 on the real files;
     fixture cases red/green as designed.
     Evidence:
       - test: `scripts/lessons-coverage-check.sh` -> "OK — slugs synced, all mechanized artifacts present and marked" (exit 0); `bash .claude/hooks/tests/lessons-coverage.test.sh` -> 5 passed / 0 failed; full guard-suite sweep (10 files) -> all exit 0
       - viewports: n/a — logic-only (bash + markdown)
       - deviations: 33 entries total (not 32 — recounted lines 13-45 inclusive). 5 classified mechanized against PRE-EXISTING artifacts (destructive-guard.test.sh, hook-bypass-guard.test.sh, spec-state.sh, check-core-vendor-free.sh, eslint.config.mjs) that predate this spec's slugs — added a `[#slug]` marker comment to each so the checker's marker requirement holds; those 5 edits are comment-only, no behavior change, confirmed by the unchanged guard-suite pass counts. `guard-read-vs-write`'s design citation "(LESSONS.md:27/42)" — line 42 in the CURRENT file is about branch-protection over-blocking, not read-vs-write; classified against line 27 alone (content match) and noted the stale line-number citation rather than force-fitting 42, consistent with the spec's own edge case ("slugs are the stable key, not line numbers").
- [x] 2. Mechanize the backlog — for every `mechanizable` row from task 1:
     paired block/allow guard-test or tripwire case (file::case naming, slug
     comments both directions, tripwire honesty comment), starting with the
     two documented reintroduction patterns (verdict-null partition on
     review-fanout.js incl. the node -e replica; git-config read-allowed vs
     write-blocked pair in hook-bypass-guard.test.sh).
     Satisfies: REQ-2 (all criteria), REQ-4 (all). Depends on: 1.
     Verify: bash on each touched .claude/hooks/tests/*.test.sh; mutated
     review-fanout copy fails the tripwire.
     Evidence:
       - test: `bash .claude/hooks/tests/lesson-tripwires.test.sh` -> 8 passed / 0 failed; `scripts/lessons-coverage-check.sh` -> OK; full guard-suite sweep (11 files) -> all exit 0
       - viewports: n/a — logic-only (bash tripwires + node -e replica)
       - deviations: (1) `guard-read-vs-write` (REQ-4.2's named pair) was found ALREADY mechanized pre-existing in hook-bypass-guard.test.sh (lines 102-104, from an earlier PR) — only needed its [#slug] marker added, no new test. (2) `post-merge-review-still-finds-bugs` stays `mechanizable`, deliberately NOT built here — its real mechanism is sdd-premerge-review-standard's merge-pr step 1.5 (spec 7 of this same batch, not yet implemented); will flip to `mechanized` when that spec lands. (3) `skill-output-path-explicit-scratchpad` reclassified `mechanizable` -> `advisory` after discovering its named artifact (session-report) is a third-party plugin skill with no source in this repo to check. (4) `cost-from-ledger-only`'s tripwire targets `cost-summary.py`/`inject-cost.py` (which exist now) rather than `spec-metrics.py` (not yet built, spec 6). (5) Mutation check on the flagship REQ-4.1 case: reintroduced the verdict-null-swallow bug in review-fanout.js (`unverified` forced to `[]`) — tripwire caught it (7/8 pass, named the exact failure); reverted via Edit tool (git diff confirms byte-identical to original after revert).
- [x] 3. Retro promotion step — spec-retro SKILL.md gains the classification
     requirement (+ follow-up work item for mechanizable; missing
     classification = retro incomplete).
     Satisfies: REQ-3 (all criteria).
     Verify: skill text review + next real retro exercises the step.
     Evidence:
       - test: skill text review (Read after edit) — step 2's `## Lessons Learned` template now shows a `**Classification**:` field per entry, step 3 requires classification for anything promoted to LESSONS.md + a same-retro follow-up item for `mechanizable` + states the incomplete-retro consequence when omitted; step 5's `git add .ai/shared/` already covers the new LESSONS-COVERAGE.md path (no change needed there)
       - viewports: n/a — skill/process doc edit
       - deviations: none. Live exercise of the step happens at this repo's next real `/spec-retro` run (cannot be fabricated here without a real session to retro on)

## Suggested execution batches

Tasks 1+2 share the coverage table and test corpus — ONE session
(`/spec-implement 1-2`). Task 3 is a small skill edit; Batch: B1 with nothing
— run standalone or append to the same session.
