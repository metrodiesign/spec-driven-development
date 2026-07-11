# Implementation Tasks: Optimization Plan Reconcile

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Reconcile pass end-to-end — status vocabulary applied to every Tier
     1-4 item and all 22 Tier-5 items (evidence pointer per claim, OPEN when
     unprovable, SUPERSEDED with covering artifact, deviation notes), header
     `Last reconciled:` stamp + Open-items summary with sdd-* spec
     cross-references, no proposal text deleted, one-shot pointer check run
     and its output recorded in this task's Evidence block.
     Satisfies: REQ-1 (all criteria), REQ-2 (all), REQ-3 (all).
     Verify: pointer-check one-shot prints "DANGLING: none"; git diff shows
     status/header edits only.

## Suggested execution batches

Single doc task — one short session (`/spec-implement 1`).
