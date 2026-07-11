# Requirements: Optimization Plan Reconcile (make the plan match reality)

> Status: approved 2026-07-11

## Overview

`docs/sdd-optimization-plan.md` still marks Tier 2 items (W3, W4, W5, W7, A5,
ST7) as not implemented, but all of them verifiably exist today (Status
headers in 5 specs, `spec-state.sh` wired into `/spec-implement`,
`spec-trace.sh` wired into 5 skills + CI, spec-analyze repair loop,
spec-quick self-check), and several Tier 5 gaps have since shipped (PreCompact
hook, spec-edit-guard). Anyone reading the plan re-derives finished work. This
spec reconciles the document against the repo with an evidence pointer per
claim, so the plan is trustworthy again as a backlog.

## REQ-1: Status reconciliation with evidence

**User Story:** As a future session reading the plan, I want every status to
be true and provable, so I never re-analyze shipped work.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL update the status of every Tier 1-4 item to its actual
  state, each with an evidence pointer (repo path, or path plus line/section)
  proving the state.
- 1.2 THE SYSTEM SHALL sweep all 22 Tier 5 items and mark each: done (with
  evidence pointer) | open | superseded (naming what supersedes it).
- 1.3 THE SYSTEM SHALL NOT delete or reword any unimplemented proposal — this
  is a status pass, not a re-plan.
- 1.4 WHEN an item's implementation deviates from the original proposal THE
  SYSTEM SHALL mark it done-with-deviation and note the difference in one
  line.

## REQ-2: Reconciliation stamp and open-item summary

**User Story:** As the repo owner, I want the plan to say when it was last
trued up and what genuinely remains, so staleness is detectable next time.

**Acceptance Criteria (EARS):**
- 2.1 THE SYSTEM SHALL add a `Last reconciled: <YYYY-MM-DD>` line to the
  document header.
- 2.2 THE SYSTEM SHALL add a short "Open items as of <date>" list at the top
  aggregating everything still marked open, with one line each.
- 2.3 WHERE an open item is now covered by one of the new sdd-* specs THE
  SYSTEM SHALL cross-reference that spec folder instead of leaving the item
  free-floating.

## REQ-3: Evidence pointers must resolve

**User Story:** As a verifier, I want every "done" claim checkable, so the
reconcile itself cannot introduce new fiction.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL ensure every evidence pointer names a path that exists
  in the repo at the reconcile commit.
- 3.2 IF a claim cannot be evidenced by an existing path THEN THE SYSTEM SHALL
  leave the item marked open rather than claiming done.
- 3.3 THE SYSTEM SHALL verify pointer resolution mechanically before commit
  (a one-shot check script or command run recorded in the task Evidence
  block; the check need not be permanent CI).

## Edge Cases & Open Questions

- Tier 5 items that were folded into other work without a clean artifact
  (e.g. covered by a skill rewrite): mark superseded with the covering
  artifact as evidence.
- The document is long (39KB) — reconcile edits statuses and headers in
  place; no restructuring (restructuring would defeat diff review).
