# Implementation Tasks: CI Incremental Checks (diff-scoped PR, full floor on develop)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Range mode in the scanner — check-secrets.sh `--range <base>..<head>`
     (both-end rev-parse guard, error-vs-empty separation, logged `exec $0
     --all` fallbacks), tighten the skip rule to `[ "$MODE" = staged ]` +
     header comment, extend secrets-guard.test.sh (secret-in-range /
     secret-outside-range / bad endpoint fallback / SKIP ignored in range /
     staged-vs-range reason parity).
     Satisfies: REQ-1 (all criteria), REQ-2.3, REQ-5.1, REQ-5.2.
     Verify: bash .claude/hooks/tests/secrets-guard.test.sh — all green.
- [ ] 2. Scope orchestration scripts — scripts/ci-secret-scope.sh +
     scripts/ci-test-scope.sh (event branch, merge-base resolution,
     root-file guard from pnpm-workspace.yaml, captured-exit package probe,
     scope log lines with affected/skipped counts, CI_SCOPE_DRY_RUN seam) +
     new ci-scope.test.sh covering every fail-closed path.
     Satisfies: REQ-2.1, REQ-3.1, REQ-3.3, REQ-3.5, REQ-3.6, REQ-4.1,
     REQ-5.3. Depends on: 1.
     Verify: bash .claude/hooks/tests/ci-scope.test.sh — decision matrix green.
- [ ] 3. Workflow wiring + live proof — ci.yml: fetch-depth 0 on BOTH jobs,
     scan/test steps become thin calls into the scope scripts, push path
     byte-identical to today (`--all`, full `pnpm test`), comments documenting
     scoped-PR-vs-full-floor and the merge-ref rationale; record this PR's own
     pull_request scope logs + the post-merge develop full run as Evidence.
     Satisfies: REQ-2.2, REQ-2.4, REQ-3.2, REQ-3.4, REQ-4.2. Depends on: 2.
     Verify: CI green on the PR with scope lines visible; develop push runs
     the full floor.

## Suggested execution batches

Coupled chain (scripts consume the scanner; yml consumes the scripts): ALL
tasks in ONE session — `/spec-implement all`.
