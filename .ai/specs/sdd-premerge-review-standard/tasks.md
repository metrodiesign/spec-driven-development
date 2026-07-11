# Implementation Tasks: Pre-merge Review Standard

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Canon + artifacts — .ai/policies/review-standard.json
     (diffThreshold: 400), .ai/templates/review-record.md (all REQ-3.1
     fields), REVIEW_PROTOCOL.md canonical section (trigger criteria with
     worked examples, record format, override path, staleness rule).
     Satisfies: REQ-1 (all criteria), REQ-3.1, REQ-4.1.
     Verify: template fields cover the REQ-3.1 list; protocol section
     readable standalone.
- [ ] 2. Gate wiring — merge-pr SKILL.md step 1.5 (trigger evaluation via gh
     fields, record check keyed to current headRefOid, stop-or-override with
     recorded reason committed before merge, protocol referenced not
     restated), review-fanout description gains the write-the-record output
     contract; dry-run walkthrough on a synthetic PR recorded as Evidence.
     Satisfies: REQ-2 (all criteria), REQ-3.2, REQ-3.3, REQ-4.2.
     Depends on: 1.
     Verify: dry-run transcript shows stop on missing record, override
     record shape, and fast path for a small PR.

## Suggested execution batches

Two small coupled doc/skill tasks — ONE session (`/spec-implement all`).
