# Implementation Tasks: Optimization Plan Reconcile

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Reconcile pass end-to-end — status vocabulary applied to every Tier
     1-4 item and all 22 Tier-5 items (evidence pointer per claim, OPEN when
     unprovable, SUPERSEDED with covering artifact, deviation notes), header
     `Last reconciled:` stamp + Open-items summary with sdd-* spec
     cross-references, no proposal text deleted, one-shot pointer check run
     and its output recorded in this task's Evidence block.
     Satisfies: REQ-1 (all criteria), REQ-2 (all), REQ-3 (all).
     Verify: pointer-check one-shot prints "DANGLING: none"; git diff shows
     status/header edits only.
     Evidence:
       - test: one-shot pointer check (`grep -oE` every backtick-quoted path in the doc, `[ -e "$p" ]` each, excluding glob patterns) -> "DANGLING: none" after accounting for 3 intentional absence-citations (api-design.md, components.md, stack-nextjs.md — evidence IS that they no longer exist); `git diff --stat` -> 146 insertions/9 deletions, and all 9 "deleted" lines are the ORIGINAL item text reappearing verbatim with a `**[STATUS]**` tag prepended (confirmed by manual diff read) plus one header line (22→20 count correction, explicitly flagged) and one paragraph→one-line-per-item reformat of the Tier-5 "รอง" block (content preserved, only line breaks added) — no proposal wording deleted or reworded
       - viewports: n/a — documentation-only
       - deviations: reconciliation surfaced real drift the ORIGINAL "Tier 1-4 applied แล้ว" narrative header didn't capture at per-item granularity: 4 items (A2, A3, ST6, A6) are APPLIED-WITH-DEVIATION (later `.ai/` vendor-neutral layer refactor relocated their artifacts), 1 item (S1) is SUPERSEDED by its chosen alternative (A1), and Tier-5 turned out to have 3 SUPERSEDED items (8, 9, 10 — all mooted by the same `.ai/` layer refactor) plus 1 genuinely OPEN backfill item (#6) and 9 other OPEN items (11-20, mostly minor/out-of-repo-scope) that the old narrative simply never mentioned. Cross-referenced sdd-guard-dedup + sdd-ci-incremental-checks against Tier-5 #15 (partial coverage, not full) per REQ-2.3.

## Suggested execution batches

Single doc task — one short session (`/spec-implement 1`).
