# Requirements: Pre-merge Review Standard (multi-angle review before phase-closing merges)

> Status: approved 2026-07-11

## Overview

Phase 3's retrospective records four real findings discovered by automated
multi-angle review only AFTER the phase PR merged — live verification passed,
edge cases slipped. The repo already owns the tool (`review-fanout` workflow,
`.claude/workflows/review-fanout.js`); what is missing is the rule for when it
MUST run. This spec makes multi-angle review a required pre-merge step for
high-stakes PRs (phase-closing or large diffs), wired into the `merge-pr`
skill as a confirm-gate with an explicit, recorded override — moving the
known bug-catch point from post-merge to pre-merge.

## REQ-1: Trigger criteria for required review

**User Story:** As a repo owner, I want objective criteria for "this PR needs
the full review", so the rule fires on risk, not on memory.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL require a multi-angle review before merging a PR that
  closes a spec phase (its tasks.md reaches all-`[x]` in the PR, or the PR is
  labeled `phase-close`).
- 1.2 THE SYSTEM SHALL require a multi-angle review before merging a PR whose
  diff exceeds a configurable line threshold (default 400 changed lines,
  matching the task-graph diff-budget convention).
- 1.3 WHERE a PR meets neither criterion THE SYSTEM SHALL NOT require the
  review (small PRs keep their current fast path).

## REQ-2: merge-pr enforces the rule as a confirm-gate

**User Story:** As the merge skill, I want to check for a review record before
merging, so the standard executes where merges actually happen.

**Acceptance Criteria (EARS):**
- 2.1 WHEN `merge-pr` runs on a PR meeting REQ-1 criteria THE SYSTEM SHALL
  check for a review record (REQ-3) for the PR's head commit.
- 2.2 IF no review record exists THEN THE SYSTEM SHALL stop and ask the
  operator to either run the review or explicitly override.
- 2.3 WHEN the operator overrides THE SYSTEM SHALL record the override (who,
  when, PR, reason line) in the review-records location before proceeding —
  an unrecorded override is not a valid path.
- 2.4 THE SYSTEM SHALL never auto-run the multi-angle review itself from
  merge-pr (it is expensive; the human decides to spend it).

## REQ-3: Review record format and location

**User Story:** As a future reader, I want a durable trace of what was
reviewed and what it found, so "review ran" is verifiable.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL define one file per reviewed PR under
  `docs/reviews/` (e.g. `PR-<n>-<headsha7>.md`) containing: PR number, head
  commit, date, finder/verifier counts, confirmed findings (or "none"), and
  outcome per finding (fixed | accepted | rejected).
- 3.2 WHEN `review-fanout` completes THE SYSTEM SHALL make writing this record
  part of its documented output contract.
- 3.3 IF findings were fixed after the review THEN the record SHALL be updated
  (or a new record written) for the new head commit — a stale-head record does
  not satisfy REQ-2.1.

## REQ-4: Protocol documentation

**User Story:** As any agent working this repo, I want the rule in the shared
canon, so every session knows it without rediscovery.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL document the trigger criteria, the record format, and
  the override path in the canonical review protocol under `.ai/shared/`.
- 4.2 THE SYSTEM SHALL update the `merge-pr` skill text to reference that
  canonical section rather than restating it.

## Edge Cases & Open Questions

- Hotfix urgency: the override path (REQ-2.3) is the designed escape — no
  separate hotfix exemption needed.
- Reviews on a moving PR: findings-fix pushes change the head; REQ-3.3 keeps
  the record honest without forcing a full re-review (re-review scope after
  fixes is the operator's call, recorded in the outcome column).
- Threshold tuning: 400 lines is a default, changed via the same config file
  the skill reads — changing it is a normal PR (visible in review), not
  governance-gated, since raising it only widens the fast path for SMALL
  PRs, never disables phase-close review.
