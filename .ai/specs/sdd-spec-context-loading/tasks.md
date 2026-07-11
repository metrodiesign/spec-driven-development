# Implementation Tasks: Spec Context Loading Discipline (archive + per-task slice)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Archive mechanism end-to-end — scripts/spec-archive.sh (validated
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
     Evidence:
       - test: `bash .claude/hooks/tests/spec-slice.test.sh` -> 9 passed / 0 failed; full guard-suite sweep (9 files) -> all exit 0; `scripts/spec-trace.sh <feature> .ai/specs/archive` over all 5 REQ-based archived features (platform-phase0..4) -> all OK
       - viewports: n/a — logic-only (bash + jq)
       - deviations: (1) SessionStart's inline jq/shell one-liner in settings.json turned out too fragile to hand-edit safely (two attempts corrupted the JSON differently — an inline `grep -v '^archive$' | tr` insertion tripped the settings validator). Extracted the active-specs listing into `scripts/session-start-active-specs.sh` instead (small, testable, same output) and pointed settings.json's command at it — a safer implementation than the design's literal inline-grep sketch, same behavior, and consistent with REQ-5.3's own "testable scripts over inline shell" philosophy from sdd-ci-incremental-checks. (2) ci.yml's second glob (REQ-1.5) was initially missed on the first pass and added afterward, after task 4's live archive run exposed the gap — fixed before closing this task.
- [x] 2. Deterministic slicer — scripts/spec-slice.sh (task block → Satisfies
     REQs → traceability-mapped design sections, Status headers, MISSING
     markers, unknown-id listing) with its test rows.
     Satisfies: REQ-3 (all criteria), REQ-5.
     Verify: bash .claude/hooks/tests/spec-slice.test.sh (slice cases).
     Evidence:
       - test: `bash .claude/hooks/tests/spec-slice.test.sh` -> 9 passed / 0 failed (5 slice-specific cases: known-task-fully-resolved, unknown-id, absent-REQ MISSING, unmapped-design-cell MISSING, plus Status headers asserted inline on the known-task case)
       - viewports: n/a — logic-only (bash + awk)
       - deviations: macOS `/usr/bin/awk` (one-true-awk, not gawk) silently drops a lone backslash passed via `-v` string variables (`\[` becomes `[`), turning literal-bracket regexes into broken bracket-expressions — caught by testing against a REAL tasks.md checkbox line before wiring the whole script, not by inspection. Fixed by hardcoding bracket-containing regex fragments directly in the awk program text (only the plain numeric id/REQ-number is passed via `-v`) instead of round-tripping them through shell-to-awk string escaping
- [x] 3. Slice-first skill rewiring — spec-implement SKILL.md step 1 loads via
     spec-slice.sh with the three fallback triggers (MISSING / assembly-final /
     operator asks); gates and Evidence rules untouched.
     Satisfies: REQ-4 (all criteria). Depends on: 2.
     Verify: dry-run /spec-implement on a fixture feature — context comes from
     the slice; a MISSING marker forces the full read.
     Evidence:
       - test: dry-run `scripts/spec-slice.sh sdd-lessons-to-guard-tests 1` (a real upcoming task in this same session) -> STATUS+TASK+REQ-1 block returned, plus `MISSING: design section for "LESSONS-COVERAGE.md table + slug key"` / `"advisory reason column"` — correctly signals the full design.md read is needed for that task, exactly as step 1's new fallback rule specifies
       - viewports: n/a — skill/process doc edit
       - deviations: none. Steps 2-5 and all gates/Evidence rules in SKILL.md left untouched (REQ-4.4); bugfix specs explicitly routed around the slicer in the new step 1 text since bugfix.md uses F-IDs/B-IDs, a shape spec-slice.sh does not parse
- [x] 4. Archive the closed backlog — run spec-archive.sh over
     platform-phase0..4 + bugfix-console-fetch-status + bugfix-fchat-hardening
     (acceptance demo); confirm SessionStart lists only live specs and CI
     spec-trace stays green over the archive.
     Satisfies: REQ-1 (live proof), REQ-2. Depends on: 1.
     Verify: new session shows only active specs; CI green on the PR.
     Evidence:
       - test: `scripts/spec-archive.sh <feature>` x7 -> all exit 0, `git status --short` shows clean R (rename) entries for each; `scripts/session-start-active-specs.sh` -> lists only the 8 live sdd-* specs, no platform-phase*/bugfix-*/archive; `scripts/spec-trace.sh <feature> .ai/specs/archive` over all 5 REQ-based archived features -> all OK (bugfix-* use bugfix.md, already outside spec-trace's scope pre-archive, same as before)
       - viewports: n/a — repo/CI maintenance action
       - deviations: none. Full guard-suite sweep (9 files) still all exit 0 after the moves. Actual CI-green confirmation happens once this branch is pushed as a PR (same follow-up caveat as sdd-ci-incremental-checks task 3).

## Suggested execution batches

Tasks 1+2+3 share the fixture and the test file — ONE session
(`/spec-implement 1-3`). Task 4 is a mechanical follow-up in the same PR.
