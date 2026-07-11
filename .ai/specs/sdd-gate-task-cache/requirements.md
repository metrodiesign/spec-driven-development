# Requirements: SDD Gate-Task Cache (tree-hash skip)

> Status: approved 2026-07-11, amended 2026-07-11

## Overview

`.ai/bin/gate-task.sh` currently reruns the full typecheck+test suite on every
`[ ]→[x]` checkbox flip in any `tasks.md`, even when the working tree is
byte-identical to a tree that already passed (e.g. flipping a second checkbox,
or adding an Evidence block after a green run). This spec adds a deterministic
tree-hash cache so an identical, previously-verified-green tree skips the
redundant rerun — without weakening the gate: a tree that has never been proven
green always runs the full suite.

## REQ-1: Deterministic working-tree fingerprint

**User Story:** As the task gate, I want a deterministic fingerprint of the
exact working-tree content, so that "identical tree" is provable rather than
assumed.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL compute the fingerprint from the working-tree content —
  tracked files including unstaged modifications AND untracked non-ignored
  files — EXCLUDING the spec-artifact directories (`.ai/specs/`,
  `.claude/specs/`): the gate only ever fires on a tasks.md edit, so a
  fingerprint that included spec artifacts would change on every invocation
  and never hit (the checkbox/Evidence edit itself must not invalidate the
  code verdict; spec artifacts are documentation the suite never reads).
- 1.6 IF the repository contains submodules (`.gitmodules` present) THEN THE
  SYSTEM SHALL disable the cache and always run the full suite (a dirty
  submodule changes test outcomes without changing the superproject tree).
- 1.2 THE SYSTEM SHALL include the effective gate configuration
  (`SDD_TYPECHECK_CMD`, `SDD_TEST_CMD`, or the auto-detected commands) in the
  fingerprint input, so a config change never reuses a stale verdict.
- 1.3 WHEN two fingerprint computations run on an unchanged tree THE SYSTEM
  SHALL produce the same value.
- 1.4 IF the fingerprint cannot be computed (e.g. git failure) THEN THE SYSTEM
  SHALL fall back to running the full suite.
- 1.5 THE SYSTEM SHALL include a toolchain salt in the fingerprint input:
  the output of `$SDD_GATE_TOOLCHAIN_CMD` when the operator declares one (any
  stack: e.g. `python3 --version`), plus `node --version` and `pnpm --version`
  automatically when a package.json is present — so a toolchain switch never
  reuses a stale verdict; a stack with no declared toolchain command gets a
  content-only fingerprint (documented residual).

## REQ-2: Cache write only on fully green runs

**User Story:** As a repo owner, I want the cache to only ever contain proven
results, so that a skip can never approve unverified work.

**Acceptance Criteria (EARS):**
- 2.1 WHEN typecheck and tests both pass THE SYSTEM SHALL record the
  fingerprint as green.
- 2.2 IF typecheck or tests fail THEN THE SYSTEM SHALL NOT write any cache
  entry for that fingerprint.
- 2.3 THE SYSTEM SHALL store the cache outside version control (untracked
  path; never committed).
- 2.4 IF the cache file is missing, unreadable, or malformed THEN THE SYSTEM
  SHALL treat it as empty and run the full suite (fail-closed to running).
- 2.5 THE SYSTEM SHALL write cache updates atomically (write to a temporary
  file, then rename into place) so concurrent gate invocations — e.g. parallel
  pane-loop sessions — cannot corrupt the cache.

## REQ-3: Skip only on exact green-fingerprint match

**User Story:** As a developer flipping checkboxes, I want redundant reruns
skipped when nothing changed, so that a 7-task session does not pay for 7 full
suites.

**Acceptance Criteria (EARS):**
- 3.1 WHEN the current fingerprint equals a recorded green fingerprint THE
  SYSTEM SHALL skip typecheck+test and report the gate as passed.
- 3.2 WHEN the current fingerprint differs from every recorded green
  fingerprint THE SYSTEM SHALL run the full suite.
- 3.3 WHEN a skip occurs THE SYSTEM SHALL print an explicit line naming the
  matched fingerprint so the skip is auditable in the transcript.
- 3.4 THE SYSTEM SHALL keep the Evidence-block check active on every
  invocation, including cache hits (only the test/typecheck rerun is cached —
  the policy check never is); NO code path in the cache logic (including a
  failed cache write) may exit before the Evidence stage has run.
- 3.5 THE SYSTEM SHALL treat the cache stage as valid only when invoked after
  the edit has reached disk (post-write hooks); an adapter that fires
  pre-write MUST invoke the engine with the cache disabled.

## REQ-4: Escape hatch and bounded cache

**User Story:** As an operator debugging the gate, I want to force a real run,
so that I can always reproduce a verdict from scratch.

**Acceptance Criteria (EARS):**
- 4.1 WHERE `SDD_GATE_NO_CACHE=1` is set THE SYSTEM SHALL bypass the cache
  entirely (no read, no write) and run the full suite.
- 4.2 THE SYSTEM SHALL bound the cache (keep at most the latest N green
  fingerprints, N fixed and small) so it cannot grow without limit.

## REQ-5: Guard-suite regression coverage

**User Story:** As the CI floor, I want adversarial tests for the cache, so
that a future edit cannot silently turn the cache into a gate bypass.

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL ship paired test cases in `.claude/hooks/tests/`
  covering: green run writes cache; red run writes nothing; identical tree
  skips; any file edit invalidates; config change invalidates;
  `SDD_GATE_NO_CACHE=1` forces a run; corrupt cache file falls back to a run.
- 5.2 IF any paired case fails THEN CI SHALL fail (same floor as existing
  guard tests).

## Edge Cases & Open Questions

- Untracked files: covered by REQ-1.1 (resolved by finding GTC-1) — design
  picks the git plumbing; `git add -A` into a temporary index + `write-tree`
  covers tracked+untracked in one pass.
- Multi-feature repos: cache key is per-repo, not per-feature — two features
  flipping checkboxes in the same tree state may legitimately share a green
  verdict. Accepted.
- Clock/ordering: no timestamps in the key; content-only (toolchain salt per
  REQ-1.5 is the only non-content input).
- Accepted residuals (all share the same property: they can only produce a
  stale-green skip in scenarios the develop-push full CI floor still catches,
  and `SDD_GATE_NO_CACHE=1` is the immediate operator escape):
  - Ignored inputs (`.env`, `node_modules` drift without a lockfile change)
    are outside the fingerprint — changing them without touching tracked
    content can reuse a verdict (ARC-7).
  - Environment variables the suite reads (`CI`, interpolated vars inside
    `SDD_*_CMD`, PATH re-pointing) are not in the key — the key hashes the
    command strings, not the environment (ARC-12).
  - A flaky test that passed once is cached as green for that tree — the
    cache assumes a deterministic suite; CI reruns remain the floor (ARC-8).
  - Tests asserting git metadata (branch names, `git describe`) can false-skip
    across branches with identical content — content-only key (ARC-13).
  - Same-second same-size edits on a filesystem with coarse (1s) mtime
    granularity can defeat git's stat-based change detection (racy-git
    ceiling); on APFS/ext4 (ns granularity) the window is nil. Coarse-fs
    setups must disable the cache (ARC-4).

### Findings log (spec-analyze, anchor: 5df8e87 — requirements.md uncommitted at analysis time)

- GTC-1 (logical inconsistency, REQ-1.1 vs edge note): untracked files in or
  out of fingerprint scope — DECIDED: in scope; REQ-1.1 amended.
- GTC-2 (gap): toolchain switch reuses stale verdict — DECIDED: add REQ-1.5
  (node/pnpm versions in fingerprint input).
- GTC-3 (gap): concurrent invocations corrupt cache — DECIDED: add REQ-2.5
  (atomic temp+rename write).

### Findings log (spec-architect design critique, 2026-07-11)

- ARC-1 (CRITICAL): fingerprint included tasks.md, the very file whose edit
  triggers the gate → cache could never hit — ACCEPTED: REQ-1.1 amended to
  exclude spec-artifact directories.
- ARC-2 (CRITICAL): undefined `fallback_run` control flow risked fail-open
  with an empty KEY — ACCEPTED: design specifies KEY-empty disables all cache
  I/O and cache lines are validated as 40-hex before matching.
- ARC-3 (CRITICAL): append-failure `exit 0` would bypass the Evidence stage —
  ACCEPTED: REQ-3.4 amended (no cache path may exit before Evidence); design
  reorders append to warn-and-continue.
- ARC-4: racy-git stat-cache window — ACCEPTED as documented residual (edge
  case above).
- ARC-5: non-Node stacks had no toolchain salt — ACCEPTED: REQ-1.5
  generalized via `SDD_GATE_TOOLCHAIN_CMD`.
- ARC-6: dirty submodules invisible to the tree hash — ACCEPTED: new REQ-1.6
  (`.gitmodules` present → cache disabled).
- ARC-7/8/12/13: ignored-input drift / flaky-green caching / env vars /
  git-metadata tests — ACCEPTED as documented residuals (edge cases above).
- ARC-9: pre-write adapters would fingerprint the pre-edit tree — ACCEPTED:
  new REQ-3.5 (cache valid post-write only).
- ARC-10: fixture must be an isolated `git init` repo (GIT_CEILING_DIRECTORIES)
  or the cache code escapes to the real repo — ACCEPTED: design testing
  strategy updated.
- ARC-11: worktrees have a `.git` FILE — ACCEPTED: cache path resolved via
  `git rev-parse --git-dir`, not a literal `.git/`.
- ARC-14: KEY must be computed after the auto-detect block — ACCEPTED: design
  spells out ordering.
- ARC-15: missing deleted-tracked-file test case — ACCEPTED: added.
- ARC-16: append lacked dedup; concurrency test racy — ACCEPTED: dedup before
  cap; concurrency test asserts file integrity (40-hex lines) not counts.
- ARC-17: grep-on-binary semantics — ACCEPTED: reads filtered through a
  40-hex line validator.
- ARC-18: cache-hit must fall through to Evidence, not exit — ACCEPTED:
  single-exit control flow specified.
