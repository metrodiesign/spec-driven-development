# Requirements: Guard Engine Dedup (one implementation per policy)

> Status: approved 2026-07-11, amended 2026-07-11

## Overview

Three policies currently have duplicate implementations that must be edited in
lockstep: the Evidence gate exists as awk in `.ai/bin/gate-task.sh` AND as a
bash loop in `.githooks/pre-commit`; the git global-options regex (`GO`) is
copy-pasted between `.ai/bin/check-destructive.sh` and
`.ai/bin/check-bypass.sh` (the comment itself says "edit both"); the tasks.md
path matcher and checkbox regex appear in five files with slightly different
patterns. Guards evolve often here (one PR added 8 bypass modes), so every
duplicate is a future divergence bug. This spec consolidates each policy into
a single sourced implementation with the existing adversarial test suite as
the behavioral safety net — a pure refactor: zero intended behavior change.

## REQ-1: Single Evidence-gate implementation

**User Story:** As a guard maintainer, I want the Evidence policy in exactly
one file, so a policy change cannot half-land.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL provide one checker (`.ai/bin/check-evidence.sh`) that
  implements the "every newly flipped `[x]` task requires its own Evidence
  block" policy.
- 1.2 THE SYSTEM SHALL make both `.ai/bin/gate-task.sh` and
  `.githooks/pre-commit` delegate to that checker, removing their inline
  implementations.
- 1.3 WHEN given the same input under the same strictness mode THE SYSTEM
  SHALL produce a verdict identical to that call site's PRE-refactor behavior
  (parity is per-mode: gate-task's strict mode and pre-commit's added-only
  presence mode keep their existing, deliberately different strictness — the
  shared engine parameterizes the policy, it does not merge the levels).
- 1.4 IF the checker script is missing or non-executable THEN each caller
  SHALL fail closed (block, with a message naming the missing engine file).

## REQ-2: Shared git-regex fragments

**User Story:** As a guard maintainer, I want shared regex fragments sourced
by both git guards, so hardening lands everywhere at once.

**Acceptance Criteria (EARS):**
- 2.1 THE SYSTEM SHALL move the `GO` (git global options) pattern into one
  sourced fragment file under `.ai/bin/`, consumed by both
  `check-destructive.sh` and `check-bypass.sh`.
- 2.2 THE SYSTEM SHALL remove the "copy in sync" comments once the single
  source exists.
- 2.3 IF the fragment file cannot be sourced THEN each guard SHALL fail closed
  (exit non-zero, block the action).
- 2.4 THE SYSTEM SHALL extend check-bypass.sh's tamper-protection patterns
  (GUARD file-name set and the redirect rule) to cover every new engine file
  this spec introduces (`lib-guard.sh`, `check-evidence.sh`), so the dedup
  never creates a keystone the existing tamper rules do not defend.

## REQ-3: Unified tasks.md matcher and checkbox pattern (bash surface)

**User Story:** As a guard maintainer, I want one definition of "this is a
spec tasks file" and "this is a checked box" across the bash guards, so the
five variants cannot drift.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL define the tasks.md path matcher and the checkbox
  patterns in the shared fragment and reuse them in `gate-task.sh` and
  `pre-commit`; `task-gate.sh` (thin PreToolUse adapter) SHALL stay standalone
  — adding a sourced dependency to a four-line case statement would add a new
  failure mode worth more than the duplication it removes (its patterns gain
  a pointer comment to the fragment instead).
- 3.2 WHERE a consumer is not bash (`cost_lib.py`, `spec_trace.py`) THE SYSTEM
  SHALL leave it as-is and record the intentional cross-language duplication
  in a comment pointing at the fragment file.

## REQ-4: Behavior-preservation proof

**User Story:** As the repo owner, I want proof this refactor changed nothing,
so consolidation cannot become a silent gate loosening (prohibited by
governance rules).

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL pass the entire existing adversarial suite
  (`.claude/hooks/tests/*.test.sh`) unmodified — no existing test case may be
  edited, weakened, or deleted by this work.
- 4.2 THE SYSTEM SHALL add new paired cases only (shared-fixture parity test
  from REQ-1.3, fail-closed cases from REQ-1.4/2.3).
- 4.3 WHEN the refactor is complete THE SYSTEM SHALL show a call-site
  inventory (which file sources what) in the PR description.
- 4.4 THE SYSTEM SHALL keep every guard's user-facing error message
  byte-identical to the current output (messages stay in the callers; the
  engine emits data only), AND — because no existing test asserts message
  text — SHALL add message-snapshot cases locking the current strings, so
  future drift is caught by CI rather than convention.
- 4.5 THE SYSTEM SHALL capture the current pre-commit Evidence-loop behavior
  as fixture tests BEFORE the refactor lands (the existing suite covers the
  engine and Claude adapter paths but not pre-commit — the baseline must
  exist for parity to be provable).

## Edge Cases & Open Questions

- `.githooks/pre-commit` runs outside the Claude harness (plain git) — the
  shared checker must be dependency-free POSIX-compatible bash, same as the
  existing engine scripts.
- Worktrees/submodules: `.ai/bin/` path resolution from a git hook must use
  the repo root from `git rev-parse --show-toplevel`, not a relative path
  assumption (current pre-commit behavior preserved).
- The Tier-1/Tier-2 layering itself is intentional defense-in-depth and stays
  two layers — this spec dedups implementations within the engine, never
  collapses the layers.
- `gate-task.sh` is invoked from a PostToolUse hook: "fail closed" there means
  exit non-zero with the error naming the missing engine file (the edit has
  already happened; the gate's job is to red the turn, same as a failing test).

- Tab-form checkbox boundaries: the awk core uses `[[:space:]]` where
  pre-commit's loop used literal spaces — on a tab-indented checkbox the
  unified engine is STRICTER (a tab-form task line now closes a block). No
  artifact in this repo is tab-form (skills generate space-form only); the
  hardening is accepted as the one documented deviation from byte-behavior
  parity (ARC-F2) rather than maintaining two boundary dialects.
- Empty vs missing added-set: an `--added-only` FILE that exists but is empty
  means "no newly-added [x] tasks" → exit 0 (pass); a MISSING file is a
  caller bug → exit 2 (fail closed). pre-commit additionally keeps its
  existing early-continue when the added set is empty, so the engine is not
  even invoked on ordinary commits (ARC-F7).

### Findings log (spec-analyze, anchor: 5df8e87 — requirements.md uncommitted at analysis time)

- GD-1 (ambiguity, REQ-4.1): existing tests may assert exact error strings —
  strict no-test-edit rule could conflict with delegation — DECIDED: keep
  strict; add REQ-4.4 (error messages byte-identical). PostToolUse "block"
  wording clarified in edge cases.

### Findings log (spec-architect design critique, 2026-07-11)

- ARC-F1 (HIGH): lib-guard.sh/check-evidence.sh not covered by check-bypass
  tamper rules — ACCEPTED: new REQ-2.4.
- ARC-F2 (HIGH): `[[:space:]]` vs literal-space boundary drift on tab-form
  checkboxes — ACCEPTED as documented hardening (edge case above); REQ-1.3
  reworded to per-mode parity.
- ARC-F3 (HIGH): git-rev-parse prologue makes git a hard dependency of every
  guard — ACCEPTED: .ai/bin siblings resolve via `$(dirname "$0")`;
  only pre-commit keeps rev-parse (design updated).
- ARC-F4: no message-asserting tests exist — ACCEPTED: REQ-4.4 amended to add
  message-snapshot cases.
- ARC-F5: pre-commit loop has no baseline tests — ACCEPTED: new REQ-4.5.
- ARC-F6: REQ-1.3 over-claimed cross-site same-verdict — ACCEPTED: reworded.
- ARC-F7: empty vs missing added-set ambiguity — ACCEPTED: edge case above.
- ARC-F8: task-gate.sh should not gain a sourced dependency — ACCEPTED:
  REQ-3.1 reworded (pointer comment instead).
- ARC-F9: pre-commit `set -e` + exit 1/2 disambiguation — ACCEPTED: design
  call pattern specified (`if ! out=$(...)` + separate 1 vs 2 handling).
- ARC-F10: -x guard for check-evidence underspecified — ACCEPTED: design
  prologue extended to both engine files, exit 126/2 mapped to fail-closed.
- ARC-F11: "edit both" comment is Thai in the real files — ACCEPTED: test
  greps the actual Thai strings.
- ARC-F12: Overview oversold python-variant coverage — ACCEPTED: reworded to
  three bash surfaces + documented python pointers.
