# Requirements: Spec Context Loading Discipline (archive + per-task slice)

> Status: approved 2026-07-11, amended 2026-07-12 (quick, no gates — REQ-3.6/3.7,
> closes the bare-id matcher gap in REQ-3.1/3.4)

## Overview

Spec artifacts grow monotonically (tasks.md 15KB in phase0 → 67KB in phase4;
design+tasks across phases ≈ 400KB) and every `/spec-implement` session reloads
whole files, while the SessionStart hook lists every spec ever created as
"active". This spec adds (a) an archive mechanism for closed specs so they
leave the active surface, and (b) a deterministic per-task slice so
`/spec-implement` loads only the sections the active task actually needs —
cutting input-token cost per session without losing correctness (full-file
loading stays available as the escape hatch).

## REQ-1: Spec archive mechanism

**User Story:** As an operator, I want closed specs moved out of the active
set, so that new sessions do not pay context for finished work.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL provide a single command (`scripts/spec-archive.sh
  <feature>`) that moves `.ai/specs/<feature>/` to
  `.ai/specs/archive/<feature>/` via `git mv`.
- 1.2 WHEN archiving THE SYSTEM SHALL verify every task checkbox in the
  feature's tasks.md is `[x]`.
- 1.3 IF any checkbox is unchecked THEN THE SYSTEM SHALL refuse with a message
  listing the unchecked task IDs.
- 1.4 IF the feature has no tasks.md THEN THE SYSTEM SHALL refuse (nothing
  provably finished).
- 1.5 THE SYSTEM SHALL keep archived specs traceable: the CI spec-trace step
  SHALL also run over `.ai/specs/archive/*/` so archived artifacts cannot rot
  silently.

## REQ-2: SessionStart surface lists active specs only

**User Story:** As a session starting up, I want to see only specs that can
still receive work, so that the always-on context stays proportional to live
work.

**Acceptance Criteria (EARS):**
- 2.1 THE SYSTEM SHALL exclude `.ai/specs/archive/` from the SessionStart
  hook's "Active specs" line.
- 2.2 WHEN a spec is archived THE SYSTEM SHALL show it in no session-start
  surface without further configuration.

## REQ-3: Deterministic per-task slice

**User Story:** As `/spec-implement`, I want the exact subset of spec text a
task needs, so that implementing task N does not load every other task's
detail.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL provide `scripts/spec-slice.sh <feature> <task-id>`
  printing, in order: the full task block for `<task-id>` from tasks.md
  (verbatim), the requirements blocks for every REQ listed in that task's
  `Satisfies:` line, and the design.md sections that task or those REQs
  reference.
- 3.2 THE SYSTEM SHALL resolve references deterministically from the existing
  artifact structure (no model judgement in the slicer).
- 3.3 IF `<task-id>` does not exist THEN THE SYSTEM SHALL exit non-zero and
  list the available task IDs.
- 3.4 IF a referenced REQ or design section cannot be located THEN THE SYSTEM
  SHALL print an explicit `MISSING:` marker for it rather than omitting it
  silently.
- 3.5 THE SYSTEM SHALL include the artifact `Status:` headers in the slice so
  approval state remains visible to the consumer.
- 3.6 THE SYSTEM SHALL match a Requirement Traceability row to a selected REQ
  number whether its REQ column writes the id `REQ-`-prefixed (`REQ-1.2`) or as
  a bare dotted id (`1.2`) — both denote the same requirement, and a table
  written entirely in one style SHALL NOT drop the design section silently
  (closes a gap in 3.1: the original matcher only recognized the `REQ-`
  prefixed form).
- 3.7 WHEN a task's selected REQ number matches zero Requirement Traceability
  rows at all THE SYSTEM SHALL print a `MISSING:` marker for that REQ's design
  coverage, the same as when a matched row's design-element cell resolves to
  no heading (3.4) — a table using only one id style must surface as loudly as
  a single unresolved row, never as a quiet zero-row omission.

## REQ-4: spec-implement uses the slice by default

**User Story:** As the implement skill, I want slice-first loading with a
full-file fallback, so that token savings never outrank correctness.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL update `/spec-implement`'s SKILL.md to load task context
  via `spec-slice.sh` by default when implementing a single task or range.
- 4.2 WHERE the slice output contains any `MISSING:` marker THE SYSTEM SHALL
  fall back to reading the full artifacts for that feature.
- 4.3 WHERE the operator asks for full context, or the task is the feature's
  final integration/assembly task, THE SYSTEM SHALL read the full artifacts
  (assembly tasks need cross-task awareness by design).
- 4.4 THE SYSTEM SHALL leave all approval-gate and Evidence rules unchanged —
  this spec changes what is read, never what is enforced.

## REQ-5: Regression coverage

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL ship test cases covering: archive refuses on unchecked
  tasks; archive moves and CI trace still passes; slice returns task+REQ+design
  for a known fixture; slice errors on unknown task id; slice marks missing
  references.
- 5.2 IF any case fails THEN CI SHALL fail.

## Edge Cases & Open Questions

- Existing closed phases (platform-phase0..4, bugfix-*): archiving them is the
  first real use — do we archive all five phases immediately after this ships?
  (Recommend yes, as the acceptance demo.)
- Cross-feature references (phase4 tasks citing phase3 docs): slice only
  follows references inside the feature; cross-feature citations surface as
  `MISSING:` and trigger the full-file fallback — accepted.
- `.claude` rules-loader stubs and CLAUDE.md are untouched; only the
  SessionStart spec listing and the implement skill change.
