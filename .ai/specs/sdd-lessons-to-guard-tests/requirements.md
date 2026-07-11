# Requirements: Lessons to Guard Tests (mechanize the lesson ledger)

> Status: approved 2026-07-11

## Overview

`.ai/shared/LESSONS.md` records recurring process failures, but lessons are
prose: retrospectives show at least two incidents where a new tool
reintroduced a bug pattern that already had a written lesson (verdict-null
swallow; dedup filter). This spec makes mechanizable lessons executable — each
one becomes a paired block/allow case in the adversarial guard suite that CI
runs on every push — and adds a classification step to `/spec-retro` so future
lessons are triaged into "mechanized / mechanizable / advisory" instead of
defaulting to prose.

## REQ-1: Lesson coverage audit

**User Story:** As a repo owner, I want a complete map of lesson → enforcement
mechanism, so that "we have a lesson for that" provably means something runs.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL produce a coverage table listing every entry in
  `.ai/shared/LESSONS.md` with: lesson ID/line, classification (mechanized |
  mechanizable | advisory), and the enforcing artifact path for mechanized
  ones.
- 1.2 THE SYSTEM SHALL commit the table into the repo next to LESSONS.md so
  the classification is versioned.
- 1.3 IF a lesson is classified advisory THEN THE SYSTEM SHALL record the
  one-line reason it cannot be mechanized.

## REQ-2: Mechanizable lessons become guard tests

**User Story:** As the CI floor, I want each mechanizable lesson expressed as
a failing-then-passing check, so that reintroducing the pattern reds the
build.

**Acceptance Criteria (EARS):**
- 2.1 WHEN a lesson is classified mechanizable THE SYSTEM SHALL add a paired
  block/allow test case under `.claude/hooks/tests/` (or extend the matching
  existing guard's suite) that fails if the lesson's failure pattern returns.
- 2.2 THE SYSTEM SHALL name each test case with a reference back to the
  lesson entry (traceable both directions).
- 2.3 IF a lesson's pattern lives outside guard reach (e.g. workflow-script
  logic) THEN THE SYSTEM SHALL place the check in the nearest executable
  suite that CI runs, and record that location in the coverage table.
- 2.4 THE SYSTEM SHALL NOT weaken or rewrite any existing lesson text while
  mechanizing (LESSONS.md gains annotations only).

## REQ-3: Retro skill classifies at promotion time

**User Story:** As `/spec-retro`, I want a triage step when promoting a
lesson, so that the ledger never again accumulates enforceable-but-unenforced
prose.

**Acceptance Criteria (EARS):**
- 3.1 WHEN `/spec-retro` promotes a lesson into LESSONS.md THE SYSTEM SHALL
  require choosing a classification (mechanized | mechanizable | advisory) in
  the entry.
- 3.2 WHEN the classification is mechanizable THE SYSTEM SHALL require
  creating a follow-up work item (task or issue) for the guard test in the
  same retro.
- 3.3 IF classification is omitted THEN the retro checklist SHALL treat the
  retro as incomplete.

## REQ-4: Known reintroduction cases get tests first

**User Story:** As the person who paid for these incidents, I want the two
documented reintroduction patterns covered before anything else, so the
highest-evidence risks close first.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL include a test asserting review-orchestration dedup
  filters explicitly separate `unverified` from `rejected` (verdict-null
  swallow pattern).
- 4.2 THE SYSTEM SHALL include a test asserting guard scripts distinguish
  read-only git queries from writes for the patterns recorded in the
  over-block lesson.

## Edge Cases & Open Questions

- LESSONS.md entries may merge or renumber over time — the coverage table
  keys on stable lesson slugs (add slugs where missing) rather than line
  numbers.
- Some lessons are about human workflow (e.g. "read LESSONS before building a
  new harness") — those stay advisory; the audit's value is making that
  residual list small and explicit.
