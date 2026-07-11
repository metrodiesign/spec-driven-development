# Implementation Tasks: Guard Engine Dedup (one implementation per policy)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Baseline first — pre-commit Evidence-loop fixture suite capturing
     CURRENT behavior (flip+evidence / flip-without / mixed multi-task /
     no-new-flip commit) + message-snapshot fixtures for the gate-task Thai
     string and pre-commit English string, landing GREEN against today's code
     before any refactor.
     Satisfies: REQ-4.5, REQ-4.4 (snapshot half).
     Verify: bash .claude/hooks/tests/check-evidence.test.sh (baseline
     section) against unmodified engines.
- [ ] 2. The dedup itself — .ai/bin/lib-guard.sh (GO, is_spec_tasks_path,
     CB_*), .ai/bin/check-evidence.sh (one awk core, --strict /
     --added-only, empty-vs-missing FILE split), rewire gate-task.sh +
     pre-commit (dirname vs rev-parse resolution per design, -x guards,
     if-!-capture + exit-code case, messages verbatim), GO/matcher reuse in
     the two git guards, Thai "edit both" comments deleted, task-gate.sh
     pointer comment only, check-bypass GUARD + redirect patterns extended to
     the new engine files, python pointer comments in cost_lib.py /
     spec_trace.py.
     Satisfies: REQ-1 (all criteria), REQ-2 (all), REQ-3 (all). Depends on: 1.
     Verify: ALL existing suites in .claude/hooks/tests/ pass UNMODIFIED +
     baseline fixtures from task 1 unchanged-green.
- [ ] 3. Parity + tamper proof — per-mode parity fixtures through both entry
     points, strict-vs-added-only divergence case, engine chmod -x / moved
     lib fail-closed cases, tamper attempts on lib-guard.sh /
     check-evidence.sh blocked via check-bypass stdin, Thai-comment-absence
     grep, call-site inventory generated for the PR body.
     Satisfies: REQ-4.1, REQ-4.2, REQ-4.3, REQ-4.4 (lock half), REQ-2.4
     (test proof). Depends on: 2.
     Verify: bash .claude/hooks/tests/check-evidence.test.sh full — green;
     rc=0 loop over all guard tests.

## Suggested execution batches

Strictly ordered chain over one engine — ALL tasks in ONE session
(`/spec-implement all`).
