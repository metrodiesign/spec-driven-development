# Implementation Tasks: Lessons to Guard Tests (mechanize the lesson ledger)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Coverage audit + checker — add [#slug] annotations to every
     LESSONS.md entry (wording untouched), write LESSONS-COVERAGE.md
     classifying all entries (mechanized/mechanizable/advisory + artifact
     path or reason), ship scripts/lessons-coverage-check.sh (slug-set match
     both directions + mechanized paths exist) wired into the CI verify job,
     with its own fixture tests (synced pass / orphan slug / dangling path).
     Satisfies: REQ-1 (all criteria).
     Verify: scripts/lessons-coverage-check.sh exits 0 on the real files;
     fixture cases red/green as designed.
- [ ] 2. Mechanize the backlog — for every `mechanizable` row from task 1:
     paired block/allow guard-test or tripwire case (file::case naming, slug
     comments both directions, tripwire honesty comment), starting with the
     two documented reintroduction patterns (verdict-null partition on
     review-fanout.js incl. the node -e replica; git-config read-allowed vs
     write-blocked pair in hook-bypass-guard.test.sh).
     Satisfies: REQ-2 (all criteria), REQ-4 (all). Depends on: 1.
     Verify: bash on each touched .claude/hooks/tests/*.test.sh; mutated
     review-fanout copy fails the tripwire.
- [ ] 3. Retro promotion step — spec-retro SKILL.md gains the classification
     requirement (+ follow-up work item for mechanizable; missing
     classification = retro incomplete).
     Satisfies: REQ-3 (all criteria).
     Verify: skill text review + next real retro exercises the step.

## Suggested execution batches

Tasks 1+2 share the coverage table and test corpus — ONE session
(`/spec-implement 1-2`). Task 3 is a small skill edit; Batch: B1 with nothing
— run standalone or append to the same session.
