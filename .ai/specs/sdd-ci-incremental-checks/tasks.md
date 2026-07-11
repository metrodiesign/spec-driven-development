# Implementation Tasks: CI Incremental Checks (diff-scoped PR, full floor on develop)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Range mode in the scanner — check-secrets.sh `--range <base>..<head>`
     (both-end rev-parse guard, error-vs-empty separation, logged `exec $0
     --all` fallbacks), tighten the skip rule to `[ "$MODE" = staged ]` +
     header comment, extend secrets-guard.test.sh (secret-in-range /
     secret-outside-range / bad endpoint fallback / SKIP ignored in range /
     staged-vs-range reason parity).
     Satisfies: REQ-1 (all criteria), REQ-2.3, REQ-5.1, REQ-5.2.
     Verify: bash .claude/hooks/tests/secrets-guard.test.sh — all green.
     Evidence:
       - test: `bash .claude/hooks/tests/secrets-guard.test.sh` -> 33 passed / 0 failed (28 pre-existing regression cases unchanged-green + 5 new range-mode sections)
       - viewports: n/a — logic-only (bash guard engine)
       - deviations: none. staged-vs-range parity test deliberately picked the AWS AKIA detector (its reason string has no `$MODE` interpolation) since several OTHER detectors intentionally label their reason with the mode name (e.g. "detected in staged content" vs "in range content") — that is a label, not a forked rule (REQ-1.2 is about one shared pattern set, not byte-identical prose across every detector)
- [x] 2. Scope orchestration scripts — scripts/ci-secret-scope.sh +
     scripts/ci-test-scope.sh (event branch, merge-base resolution,
     root-file guard from pnpm-workspace.yaml, captured-exit package probe,
     scope log lines with affected/skipped counts, CI_SCOPE_DRY_RUN seam) +
     new ci-scope.test.sh covering every fail-closed path.
     Satisfies: REQ-2.1, REQ-3.1, REQ-3.3, REQ-3.5, REQ-3.6, REQ-4.1,
     REQ-5.3. Depends on: 1.
     Verify: bash .claude/hooks/tests/ci-scope.test.sh — decision matrix green.
     Evidence:
       - test: `bash .claude/hooks/tests/ci-scope.test.sh` -> 9 passed / 0 failed; full guard-suite sweep (8 files incl. this one) -> all exit 0
       - viewports: n/a — logic-only (bash CI scripts)
       - deviations: none. Empirically verified `pnpm ls -r --depth -1 --parseable --filter "...[ref]"` needs no `pnpm install`/lockfile (workspace graph alone suffices) before building fixtures on it; zero-affected and probe-failure cases use a PATH-stubbed fake `pnpm` for deterministic control (real pnpm counts any in-package file change, including docs, as affecting that package, so "zero affected" isn't reachable with real fixtures)
- [x] 3. Workflow wiring + live proof — ci.yml: fetch-depth 0 on BOTH jobs,
     scan/test steps become thin calls into the scope scripts, push path
     byte-identical to today (`--all`, full `pnpm test`), comments documenting
     scoped-PR-vs-full-floor and the merge-ref rationale; record this PR's own
     pull_request scope logs as Evidence (the develop-push full-floor run
     cannot exist until after this PR merges, so it cannot gate this task's
     closing Evidence — confirm it post-merge as a follow-up note instead).
     Satisfies: REQ-2.2, REQ-2.4, REQ-3.2, REQ-3.4, REQ-4.2. Depends on: 2.
     Verify: CI green on the PR with scope lines visible. Post-merge
     follow-up: confirm the develop push runs the full floor.
     Evidence:
       - test: `ruby -ryaml -e "YAML.load_file('.github/workflows/ci.yml')"` -> valid; full guard-suite sweep (8 files) -> all exit 0
       - viewports: n/a — CI workflow (no UI)
       - deviations: live dry-run against THIS repo's real state (not just fixtures) since the PR itself doesn't exist yet: `CI_SCOPE_DRY_RUN=1 scripts/ci-secret-scope.sh pull_request develop` -> `decision=range base=5df8e87..head=f4cd427`; `ci-test-scope.sh pull_request develop` -> `decision=full cause="root-file change (.ai/specs/sdd-ci-incremental-checks/.github-sync.json)"` (correctly falls back full since a spec-sync artifact sits outside every pnpm package dir); push event on both -> `decision=all`/`decision=full cause="non-PR event"`. Live PR-run scope-log confirmation and the develop-push full-floor confirmation are follow-ups once this branch is actually opened as a PR (task's own instruction — cannot gate this closing Evidence).

## Suggested execution batches

Coupled chain (scripts consume the scanner; yml consumes the scripts): ALL
tasks in ONE session — `/spec-implement all`.
