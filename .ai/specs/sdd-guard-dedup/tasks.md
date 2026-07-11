# Implementation Tasks: Guard Engine Dedup (one implementation per policy)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Baseline first — pre-commit Evidence-loop fixture suite capturing
     CURRENT behavior (flip+evidence / flip-without / mixed multi-task /
     no-new-flip commit) + message-snapshot fixtures for the gate-task Thai
     string and pre-commit English string, landing GREEN against today's code
     before any refactor.
     Satisfies: REQ-4.5, REQ-4.4 (snapshot half).
     Verify: bash .claude/hooks/tests/check-evidence.test.sh (baseline
     section) against unmodified engines.
     Evidence:
       - test: `bash .claude/hooks/tests/check-evidence.test.sh` -> 7 passed / 0 failed (sandboxed real git repo per case; pre-commit's own check-secrets.sh resolved via symlinked .ai/bin)
       - viewports: n/a — logic-only (bash guard engine)
       - deviations: none — baseline captured against unmodified gate-task.sh/pre-commit; confirms pre-commit's presence-only Evidence check (accepts `Evidence: TODO`) differs from gate-task's non-trivial check, which task 2/3 must preserve per-mode (REQ-1.3)
- [x] 2. The dedup itself — .ai/bin/lib-guard.sh (GO, is_spec_tasks_path,
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
     Evidence:
       - test: `bash .claude/hooks/tests/gate-task.test.sh` -> 25 passed / 0 failed (existing suite, unmodified, unchanged-green post-refactor)
       - viewports: n/a — logic-only (bash guard engine)
       - deviations: pre-commit's tasks.md file-selection filter (`grep -E '(^|/)tasks\.md$'`) deliberately LEFT UNTOUCHED — it is intentionally broader than is_spec_tasks_path() and narrowing it would silently shrink Evidence-check scope (the exact gate-loosening REQ-4 forbids); only the per-line checkbox regexes were unified (CB_ANY/CB_DONE, the one ARC-F2-accepted tab-boundary hardening)
- [x] 3. Parity + tamper proof — per-mode parity fixtures through both entry
     points, strict-vs-added-only divergence case, engine chmod -x / moved
     lib fail-closed cases, tamper attempts on lib-guard.sh /
     check-evidence.sh blocked via check-bypass stdin, Thai-comment-absence
     grep, call-site inventory generated for the PR body.
     Satisfies: REQ-4.1, REQ-4.2, REQ-4.3, REQ-4.4 (lock half), REQ-2.4
     (test proof). Depends on: 2.
     Verify: bash .claude/hooks/tests/check-evidence.test.sh full — green;
     rc=0 loop over all guard tests.
     Evidence:
       - test: `for t in .claude/hooks/tests/*.test.sh; do bash "$t"; done` -> check-evidence 24/24, codex-adapters 7/7, destructive-guard 150/150, gate-task 25/25, hook-bypass-guard 92/92, secrets-guard 27/27, spec-edit-guard 13/13 — all exit 0, zero regressions (338 total assertions)
       - viewports: n/a — logic-only (bash guard engine)
       - deviations: none. Call-site inventory (REQ-4.3, `grep -rl 'lib-guard.sh\|check-evidence.sh' .ai/bin .githooks .claude/hooks`): check-destructive.sh, check-evidence.sh, check-bypass.sh, lib-guard.sh, gate-task.sh, .githooks/pre-commit, check-evidence.test.sh, task-gate.sh (pointer comment only, not a sourcing consumer — ARC-F8)

## Suggested execution batches

Strictly ordered chain over one engine — ALL tasks in ONE session
(`/spec-implement all`).
