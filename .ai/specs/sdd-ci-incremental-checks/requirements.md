# Requirements: CI Incremental Checks (diff-scoped PR, full floor on develop)

> Status: approved 2026-07-11, amended 2026-07-11

## Overview

CI currently runs the full-tree secret scan (`check-secrets.sh --all`) and the
full test suite on every push and every PR. This spec scopes PR runs to what
the PR changed — diff-based secret scan and affected-package tests — while
keeping the full floor on every push to develop/main, so the security floor
never weakens: everything that lands on a protected branch still gets the
complete scan and suite.

## REQ-1: Diff-range mode for the secret scanner

**User Story:** As the single check engine, I want a range mode, so that CI
can scan exactly the files a PR touched using the same rules as the full scan.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL add a `--range <base>..<head>` mode to
  `.ai/bin/check-secrets.sh` that scans the added/modified content (diff
  hunks) and the filenames of files added or modified in that commit range —
  hunk-scoped by design, like the staged mode; whole-file coverage is the
  `--all` floor's job.
- 1.2 THE SYSTEM SHALL apply the identical rule set in all modes (staged,
  range, all) from the same script — no forked pattern lists.
- 1.3 IF the range cannot be resolved (missing base, shallow clone) THEN THE
  SYSTEM SHALL fall back to `--all`.
- 1.4 THE SYSTEM SHALL force-clear `SECRET_GUARD_SKIP` in CI in all modes
  (existing floor rule stays).

## REQ-2: PR jobs scan the diff, protected-branch pushes scan everything

**User Story:** As a repo owner, I want PR feedback fast but the floor intact,
so that speed never trades away the guarantee on develop/main.

**Acceptance Criteria (EARS):**
- 2.1 WHEN CI runs for a pull_request event THE SYSTEM SHALL run the secret
  scan in `--range` mode over the PR's base..head.
- 2.2 WHEN CI runs for a push to develop or main THE SYSTEM SHALL run
  `--all` (unchanged full-tree scan).
- 2.3 IF the range-mode scan finds a violation THEN CI SHALL fail the PR
  (same exit contract as today).
- 2.4 THE SYSTEM SHALL fetch enough git history in PR jobs to resolve
  base..head (checkout depth configured accordingly), so the range mode
  actually engages in the common path; WHEN the `--all` fallback triggers
  anyway THE SYSTEM SHALL log the cause, so a silently-permanent fallback is
  visible in CI logs.

## REQ-3: Affected-only tests on PRs

**User Story:** As a PR author, I want tests scoped to packages my change can
affect, so that a docs-or-single-package PR does not run all five suites.

**Acceptance Criteria (EARS):**
- 3.1 WHEN CI runs for a pull_request event THE SYSTEM SHALL run tests with
  pnpm's changed-since filter including dependent packages (the `...[<ref>]`
  form) where `<ref>` is the merge-base of the CI checkout HEAD and the base
  branch (with the default pull_request merge ref this equals the base tip —
  the PR is tested AS MERGED against current base), so a change in a package
  always runs that package's tests AND every package that depends on it.
- 3.2 WHEN CI runs for a push to develop or main THE SYSTEM SHALL run the full
  suite (unchanged).
- 3.3 IF the filter selects zero packages AND every changed file lies inside
  a workspace package directory THEN THE SYSTEM SHALL run repo-level checks
  only (typecheck, lint, vendor-check, guard tests, spec-trace) and skip
  package tests with an explicit log line naming the skip AND the skipped
  package count.
- 3.5 IF any changed file lies OUTSIDE every workspace package directory
  (root manifests, lockfile, shared configs — anything pnpm cannot attribute
  to a package) THEN THE SYSTEM SHALL run the full test suite (root changes
  can affect every package without being "in" one).
- 3.6 IF the merge-base cannot be resolved, or the package-scope probe itself
  fails, THEN THE SYSTEM SHALL run the full test suite and log the cause —
  scope-detection failures always fail closed to running everything, never to
  skipping.
- 3.4 THE SYSTEM SHALL keep typecheck (full, all packages), lint,
  vendor-check, guard regression tests, and spec-trace running on every event
  (they are cheap and are the floor) — only package TESTS are ever filtered.

## REQ-4: No silent scope reduction

**User Story:** As a reviewer reading CI logs, I want scoped runs to declare
their scope, so that "green" is never mistaken for "everything ran".

**Acceptance Criteria (EARS):**
- 4.1 WHEN a scoped run executes THE SYSTEM SHALL log the event type, the
  resolved base ref, the file/package count in scope, and the count skipped.
- 4.2 THE SYSTEM SHALL document in the workflow file that PR runs are scoped
  and develop/main pushes are the full floor.

## REQ-5: Regression coverage

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL extend the secrets guard test suite with range-mode
  cases: violation inside range fails; violation outside range passes the
  range scan; unresolvable range falls back to full scan.
- 5.3 THE SYSTEM SHALL implement the CI orchestration logic (event branch,
  merge-base resolution, root-file guard, package-scope probe) as small
  scripts under `scripts/` invoked by ci.yml — NOT as inline workflow shell —
  and cover those scripts with test cases for: probe failure → full suite,
  unresolvable base → full suite, root-file change → full suite, zero
  packages with in-package change → logged skip.
- 5.2 IF any case fails THEN CI SHALL fail.

## Edge Cases & Open Questions

- Squash-merge means PR contents re-enter as one push commit on develop — the
  full scan re-covers them there; a secret caught only at that point lands on
  develop and must be rotated per Secrets rules (late catch is a residual risk
  of diff-scoping; accepted because develop full scan + local staged hook both
  still run).
- Deleted files: range mode scans added/modified only; deletions carry no
  content to scan.
- History rewrite/force-push on PR branches changes the range — CI resolves
  base per run; no caching of ranges.
- Merge-base semantics: the default pull_request checkout is the ephemeral
  merge ref, so the computed merge-base is the base tip and the PR is scanned/
  tested AS MERGED against current base — staleness is smaller than the
  branch-point reading suggested (finding CIC-3 superseded by ARC-F5); the
  develop-push full suite remains the final catch.
- Pure renames (`git mv` of a file containing an old secret): rename hunks
  carry no `+` content and the new name may not be a forbidden pattern — a
  carried secret rides through the PR range scan and is caught by the develop
  full scan. Accepted residual, same class as the squash-merge late catch
  (ARC-F9).

### Findings log (spec-analyze, anchor: 5df8e87 — requirements.md uncommitted at analysis time)

- CIC-1 (conflicting constraints, REQ-3.3 vs REQ-3.4): typecheck missing from
  3.3's always-run list — DECIDED: typecheck always full on every event; 3.3
  and 3.4 amended.
- CIC-2 (unstated assumption): default shallow checkout makes `--range`
  permanently fall back to `--all` — DECIDED: add REQ-2.4 (fetch depth + log
  fallback cause).
- CIC-3 (ambiguity, REQ-3.1): filter base = develop tip vs merge-base —
  DECIDED: merge-base; develop-push full suite catches staleness; 3.1 amended,
  edge case recorded. (Superseded in part by ARC-F5 — see below.)

### Findings log (spec-architect design critique, 2026-07-11)

- ARC-F1 (HIGH): platform job checkout was shallow — merge-base would fail on
  every PR — ACCEPTED: fetch-depth 0 on BOTH jobs (design).
- ARC-F2 (HIGH): tests step had no fallback on unresolvable merge-base —
  ACCEPTED: new REQ-3.6 (scope failures fail closed to running everything).
- ARC-F3 (HIGH): package-count probe failed OPEN (probe error read as "0
  packages → skip") — ACCEPTED: REQ-3.6 covers probe failure; design probes
  with explicit exit-code capture.
- ARC-F4 (HIGH): root-file changes (lockfile, shared configs) select zero
  packages and would skip all tests — ACCEPTED: new REQ-3.5 (out-of-package
  change → full suite).
- ARC-F5 (HIGH): pull_request checkout is the merge ref, so "merge-base =
  branch point" rationale was wrong — ACCEPTED: REQ-3.1 reworded (PR tested
  as merged; base = base tip under the default merge ref); CIC-3 edge note
  superseded.
- ARC-F6: range gather lacked the empty/error guards the other modes have —
  ACCEPTED: design adds rev-parse both-ends guard + error-vs-empty separation.
- ARC-F7: REQ-1.1 wording implied whole-file scanning — ACCEPTED: reworded to
  hunk-scoped.
- ARC-F8: "count skipped" never emitted; logged file count mismatched the
  scanned set — ACCEPTED: REQ-3.3 amended; design logs use the same
  filter/exclude as the scan.
- ARC-F9: pure renames carry old secrets past the range scan — ACCEPTED as
  documented residual (edge case above).
- ARC-F10: SECRET_GUARD_SKIP mode check is load-bearing — ACCEPTED: design
  names the exact line change + header comment update; test row locks it.
- ARC-F11: origin/<base_ref> availability is a checkout behavior assumption —
  ACCEPTED: documented in design; failure path lands in REQ-3.6 fallback.
- ARC-F12/F13 (coverage): CI orchestration had no automated regression tests
  — ACCEPTED: new REQ-5.3 (orchestration as testable scripts under scripts/).
