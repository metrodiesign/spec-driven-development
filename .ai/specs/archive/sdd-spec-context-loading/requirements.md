# Requirements: Spec Context Loading Discipline (archive + per-task slice)

> Status: approved 2026-07-11, amended 2026-07-12 (quick, no gates — REQ-3.6/3.7,
> closes the bare-id matcher gap in REQ-3.1/3.4); amended 2026-07-12 (REQ-3.8-3.12,
> REQ-6 — Section-column matcher, code-fence safety, retrofit; decided via
> /spec-analyze + independent second-opinion review, see Edge Cases)

## Overview

Spec artifacts grow monotonically (tasks.md 15KB in phase0 → 67KB in phase4;
design+tasks across phases ≈ 400KB) and every `/spec-implement` session reloads
whole files, while the SessionStart hook lists every spec ever created as
"active". This spec adds (a) an archive mechanism for closed specs so they
leave the active surface, and (b) a deterministic per-task slice so
`/spec-implement` loads only the sections the active task actually needs —
cutting input-token cost per session without losing correctness (full-file
loading stays available as the escape hatch).

2026-07-12 amendment: a repo-wide sweep (`.ai/shared/LESSONS.md`
`#slice-design-cell-heading-mismatch`) found the design-section half of REQ-3
resolves to `MISSING` for effectively every row in every one of the 11 active
specs — the design-element cell is free-text prose that never literally equals
a `## ` heading, so the slice has never actually returned design content for
any real spec. REQ-3.8-3.10 replace that guesswork with an explicit,
exact-match `Section` column; REQ-6 retrofits the 11 active specs so the fix
has immediate effect, not just for specs authored after today.

A `/spec-analyze` pass on this same amendment, independently re-verified by a
second reviewer model, found that `scripts/spec-slice.sh`'s own `## `-boundary
detection — shared by `section_from_heading()`, `req_block()`, and the
Requirement Traceability table extraction — does not track fenced code
blocks, so a heading-shaped line quoted inside a ``` block truncates the real
section silently, with no `MISSING:` marker at all. Reproduced directly
against this spec's own design.md: its "Data Models & Interfaces" section
returns 25 lines instead of the real 79, because a fenced example of
`spec-slice.sh`'s own output format embeds a line starting `## REQ-2:`. This
is strictly worse than today's loud `MISSING` failure, and REQ-6's retrofit
would point a real traceability row at exactly this section — so REQ-3.11
closes it inside this same amendment instead of as a follow-up. REQ-3.12 and
the REQ-6.1/6.3 changes close two smaller gaps the same review found: an
unpinned `Section`-column lookup rule, and an acceptance demo that could not
have caught the fence bug either.

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
- 3.8 THE SYSTEM SHALL match a Requirement Traceability row to its design.md
  section using an explicit `Section` column whose value is the heading text
  only — the text after `## `, never including the `## ` prefix itself —
  compared to each design.md `## ` heading's own text by case-sensitive exact
  equality after trimming leading/trailing whitespace from both sides —
  superseding the design.md mechanism that originally implemented 3.1
  (literal-substring match of the free-text design-element cell against
  headings), which is retired because a real spec's design-element cell is
  always a free-text summary that never literally equals its heading (see
  `.ai/shared/LESSONS.md` `#slice-design-cell-heading-mismatch`).
- 3.9 IF a traceability row's `Section` value is absent or does not exactly
  equal any `## ` heading in design.md THEN THE SYSTEM SHALL print a
  `MISSING:` marker for that design reference, the same as 3.4's existing
  unresolved-row case.
- 3.10 THE SYSTEM SHALL print each referenced design section's content only
  once, even when multiple traceability rows — for the same or different
  selected REQs — share the same `Section` value (deduplicate by `Section`,
  not by the design-element cell text).
- 3.11 THE SYSTEM SHALL treat lines inside fenced code blocks (delimited by a
  ```` ``` ```` line) as inert when detecting `## ` section or REQ-block
  boundaries in requirements.md, design.md, or tasks.md — the same boundary
  logic in `section_from_heading()`, `req_block()`, and the Requirement
  Traceability table extraction SHALL each apply this rule, since all three
  scan for `/^## /` alike. A heading-shaped line quoted inside a fence (for
  example, a design.md section that quotes `spec-slice.sh`'s own output
  format) SHALL NOT be treated as a real section or block boundary. Silently
  truncating a section without emitting the `MISSING:` marker required by 3.4
  is strictly worse than 3.4's loud failure and SHALL NOT occur.
- 3.12 THE SYSTEM SHALL locate the `Section` column of a Requirement
  Traceability table by its literal column header (`Section`), never by a
  fixed column position, so the column MAY be inserted at any position in the
  table without changing how it is found.

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

## REQ-6: Retrofit existing specs' traceability tables

**User Story:** As the operator, I want every currently-active spec's design
doc already wired for the new `Section`-based matcher, so REQ-3's fix has
immediate, repo-wide effect instead of only benefiting specs authored after
today.

**Acceptance Criteria (EARS):**
- 6.1 THE SYSTEM SHALL add a `Section` column to the Requirement Traceability
  table in each spec active under `.ai/specs/` at the time of retrofit
  (excludes `.ai/specs/archive/`; 11 specs as of this amendment), with every
  row's value set to the exact text of a real `## ` heading in that same
  design.md — either a heading already present, or a new peer-level `## `
  heading created during retrofit by splitting an existing one (see Edge
  Cases). A heading created this way SHALL always be `## ` level, never a
  deeper level such as `### `, so it stays visible to the `## `-only boundary
  scan that 3.11 also governs.
- 6.2 THE SYSTEM SHALL leave every archived spec under `.ai/specs/archive/`
  untouched by this retrofit (operator-confirmed exclusion — no live task
  reads an archived spec through the slicer).
- 6.3 WHEN the retrofit is complete THE SYSTEM SHALL demonstrate, for at least
  one task per retrofitted spec, that `scripts/spec-slice.sh` returns real
  DESIGN content instead of a `MISSING:` marker for at least one of that
  task's design references, AND that the returned content is complete — its
  last printed line matches the design.md section's real last line (the line
  immediately before the next `## ` heading, or EOF) — so a fence-truncated
  result (3.11) cannot pass this demonstration unnoticed.
- 6.4 THE SYSTEM SHALL keep `scripts/spec-trace.sh` green across all 11 specs
  after the retrofit — the REQ column's existing semantics (REQ-3.6/3.7's
  bare/prefixed matching) are untouched by adding a new column alongside it.

## Edge Cases & Open Questions

- Existing closed phases (platform-phase0..4, bugfix-*): archiving them is the
  first real use — do we archive all five phases immediately after this ships?
  (Recommend yes, as the acceptance demo.)
- Cross-feature references (phase4 tasks citing phase3 docs): slice only
  follows references inside the feature; cross-feature citations surface as
  `MISSING:` and trigger the full-file fallback — accepted.
- `.claude` rules-loader stubs and CLAUDE.md are untouched; only the
  SessionStart spec listing and the implement skill change.
- A design-element row may not map cleanly onto exactly one existing heading
  (the design decision it describes spans two headings, or the doc never gave
  it a heading at all). Retrofit should pick the closest, most-specific
  containing heading; if a design.md's heading structure is genuinely too
  coarse to give an honest per-row `Section` value, splitting that heading
  into more granular sub-sections is an acceptable, content-preserving
  design.md edit during retrofit — never pick an inaccurate `Section` value
  just to avoid touching headings.
- The old literal-substring mechanism (3.1's original wording) is retired, not
  kept as a fallback — running both a deterministic exact-match and a
  substring guess would reintroduce the ambiguity REQ-3.2 ("no model judgment,
  fully deterministic") already forbids.
- Choosing which `## ` heading best represents a design-element row (REQ-6) is
  an author-time judgment call, made once by whoever performs the retrofit,
  while writing the `Section` value. It is not the runtime judgment REQ-3.2
  forbids: `scripts/spec-slice.sh` itself still only ever does exact-string
  comparison against whatever `Section` value the retrofit already committed;
  no model or heuristic runs at slice time. (Resolved during /spec-analyze;
  REQ-3.2 is unchanged.)
- REQ-3.8 (matcher) and REQ-6 (retrofit) landing as separate tasks is
  accepted — verified in both orders: matcher-before-retrofit leaves every
  row without a `Section` value, which 3.9 turns into `MISSING` (identical to
  today's baseline); retrofit-before-matcher still runs the old
  literal-substring matcher, which also cannot see a `Section` column it
  doesn't look for yet. Both orders fail loudly via the existing `MISSING` +
  REQ-4.2 fallback, never silently, so no ordering constraint is needed.
- A design.md heading whose text contains a literal `|` would break this
  table's cell parsing (markdown pipe-splitting) — no such heading exists in
  any of the 11 active specs today; a future spec authoring a heading like
  this must avoid `|` in the heading text.
- If a future design.md heading's text happens to contain a REQ-shaped token
  (e.g. a heading literally named "Phase 3.2 rollout"), that text would flow
  into its row's `Section` value; `scripts/spec_trace.py`'s traceability scan
  (`REF_RE`) reads the whole row as text and could misread that token as REQ
  coverage. No heading in any of the 11 active specs contains such a token
  today — flagged here so a future retrofit or `/spec-analyze` pass checks
  again rather than rediscovering this from scratch.

### /spec-analyze findings — amendment REQ-3.8-3.12/REQ-6, anchor `2e4ac0b`

(all 5 independently re-verified by a second reviewer model before deciding;
repro details are in the bullets above where a finding produced a requirement
change)

1. REQ-6.1 vs the heading-reuse edge case above conflicted directly (6.1 said
   "already present", the edge case allowed creating one) — DECIDED: allow
   creating a new heading during retrofit (option A); 6.1 amended, restricted
   to peer `## ` level only, never `### `, per the second-opinion review.
2. `Section` value format was unspecified (prefix? trim? case?) — DECIDED:
   heading text only, no `## ` prefix, trim both sides, case-sensitive
   (option A); 3.8 amended. The second-opinion review also found the column
   couldn't be located deterministically (position vs header name) — closed
   as new 3.12, not part of the original finding.
3. REQ-3.2 "deterministic" read as contradicting REQ-6 "requires judgment" —
   DECIDED: not a real conflict, clarified above (option A); REQ-3.2 itself is
   untouched.
4. `section_from_heading()` truncates mid-section on a fenced heading-shaped
   line — DECIDED: real, independently reproduced (25 lines returned vs 79
   real, exactly 1 occurrence across all 11 active specs). Treated as a
   ship-blocker for this amendment, not merely its top-priority finding: the
   truncation carries no `MISSING:` marker, so it is strictly worse than
   today's loud failure. Fixed as new REQ-3.11 covering all three shared
   boundary scans (`section_from_heading()`, `req_block()`, trace-table
   extraction), not a single-site patch (option A, not B or C — patching the
   design.md example instead would have removed the one real instance this
   spec has to exercise the fix). REQ-6.3's acceptance demo strengthened with
   a completeness check so this exact failure can't pass unnoticed.
5. Can REQ-3.8 (matcher) and REQ-6 (retrofit) land as separate tasks? —
   DECIDED: yes (option A), transition window accepted; verified above to
   fail loudly in both landing orders, never silently.
