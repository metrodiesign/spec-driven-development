# Implementation Tasks: Spec Context Loading Discipline (archive + per-task slice)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Archive mechanism end-to-end — scripts/spec-archive.sh (validated
     git mv: tasks.md present, zero unchecked, destination free), SessionStart
     hook exclusion (`grep -v '^archive$'` in settings.json), spec-trace CLI
     extension `spec-trace.sh <feature> [<specs-dir>]` (default .ai/specs,
     threaded into spec_trace.py main — existing callers untouched), ci.yml
     second glob over .ai/specs/archive/*/ passing the archive root, plus the
     archive rows of the test suite (refuse-on-unchecked / refuse-no-tasksmd /
     clean move / trace-over-archive-via-specs-dir-arg / SessionStart output).
     Satisfies: REQ-1 (all criteria), REQ-2 (all), REQ-5.
     Verify: bash .claude/hooks/tests/spec-slice.test.sh (archive cases) +
     scripts/spec-trace.sh on an archived fixture.
- [ ] 2. Deterministic slicer — scripts/spec-slice.sh (task block → Satisfies
     REQs → traceability-mapped design sections, Status headers, MISSING
     markers, unknown-id listing) with its test rows.
     Satisfies: REQ-3 (all criteria), REQ-5.
     Verify: bash .claude/hooks/tests/spec-slice.test.sh (slice cases).
- [ ] 3. Slice-first skill rewiring — spec-implement SKILL.md step 1 loads via
     spec-slice.sh with the three fallback triggers (MISSING / assembly-final /
     operator asks); gates and Evidence rules untouched.
     Satisfies: REQ-4 (all criteria). Depends on: 2.
     Verify: dry-run /spec-implement on a fixture feature — context comes from
     the slice; a MISSING marker forces the full read.
- [ ] 4. Archive the closed backlog — run spec-archive.sh over
     platform-phase0..4 + bugfix-console-fetch-status + bugfix-fchat-hardening
     (acceptance demo); confirm SessionStart lists only live specs and CI
     spec-trace stays green over the archive.
     Satisfies: REQ-1 (live proof), REQ-2. Depends on: 1.
     Verify: new session shows only active specs; CI green on the PR.

## Suggested execution batches

Tasks 1+2+3 share the fixture and the test file — ONE session
(`/spec-implement 1-3`). Task 4 is a mechanical follow-up in the same PR.
