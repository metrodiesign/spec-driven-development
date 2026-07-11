# Review Protocol

> Vendor-neutral. How any agent (or human) reviews a change before merge.
> Canonical source for the review-report shape in [OUTPUT_FORMATS.md](OUTPUT_FORMATS.md).

A review answers one question: **is this change correct, safe, and consistent with the
project, and is that claim backed by evidence?** Review the diff against the spec it
implements (its REQ-IDs / F-IDs / B-IDs), not against your own taste.

## Review dimensions

Walk every dimension that applies to the change. Skipping a dimension is a decision —
state it ("no API surface touched") rather than omitting it silently.

1. **Correctness** — does it do what the cited REQ-IDs require? Check happy path AND
   the `IF ... THEN` error/edge cases. Re-derive any tricky computation by hand.
2. **Security** — secrets, injection, unsafe shell/SQL, destructive ops, authz. Cross-
   check against [SECURITY_RULES.md](SECURITY_RULES.md). A security finding is at least
   High.
3. **Performance** — obvious hot-path regressions, N+1, unbounded loops/allocations,
   needless re-renders. Flag with a measurement or a concrete reason, not a hunch.
4. **Maintainability** — clarity, naming, dead code, over-abstraction, duplication.
   Simplicity-first: 200 lines that could be 50 is a finding.
5. **Architecture consistency** — does it match [ARCHITECTURE.md](ARCHITECTURE.md) and
   the patterns in [CODING_STANDARDS.md](CODING_STANDARDS.md)? Logic in the right
   layer, no banned anti-patterns, tokens/conventions respected.
6. **Type safety** — `strict` honored, no stray `any`, props/data typed, exhaustive
   handling where the type system can enforce it.
7. **Error handling** — every failure path handled per spec; no swallowed errors; no
   error handling for impossible scenarios.
8. **Tests** — do tests actually prove the cited IDs? Do they assert the OBSERVABLE
   behavior (output, computed value, layout) and not implementation detail? Are
   happy + error paths covered? No `.only` / `.skip` committed. See
   [TESTING_PROTOCOL.md](TESTING_PROTOCOL.md).
9. **Backward compatibility** — does it break existing callers, data, saved state, or
   contracts? Any migration needed?
10. **UX (frontend changes)** — responsive at the project breakpoints, interaction
    states (default/hover/focus/active/disabled), accessibility (semantic HTML,
    keyboard, contrast), no horizontal overflow, no empty/placeholder visuals.
11. **API compatibility (backend changes)** — request/response contract, status codes,
    versioning, idempotency. (This project ships no real backend; apply only when a
    change introduces a contract.)

## Evidence over assertion

Trust the diff and the `Evidence:` block, not the summary prose. If a claimed pass has
no recorded command + observed result, treat it as unverified and re-run it. A review
that finds nothing because nothing was checked is not a pass.

## Severity format

Group findings under these headers, highest severity first. Each finding cites the file
and line, the dimension, why it matters, and a concrete fix.

```
## Critical
<must fix before merge — data loss, security hole, broken core behavior, failing tests>

## High
<should fix before merge — wrong behavior on a real path, missing error handling, regression risk>

## Medium
<fix soon — maintainability, smaller correctness gaps, weak tests>

## Low
<minor — style within conventions, naming, small cleanups>

## Suggestions
<optional improvements, non-blocking ideas, follow-ups>
```

A merge is blocked while any **Critical** or **High** finding stands. Medium and below
may be tracked as follow-ups by agreement.

## Pre-merge multi-angle review (sdd-premerge-review-standard)

Phase-closing and large-diff merges get the automated multi-angle review
(`review-fanout`) as a REQUIRED pre-merge step, moving the known bug-catch point from
post-merge to pre-merge (retro evidence: Phase 3 found 4 real findings only after that
phase's PR had already merged).

**Trigger criteria** (either fires the gate; neither → no gate, small PRs keep the fast
path):
- **phase-close** — the PR carries the `phase-close` label, OR the PR's diff touches a
  `.ai/specs/*/tasks.md` and that file's post-merge content has zero `- [ ]` lines left
  (a model-executed heuristic from `gh pr diff`; the label is the explicit path when a
  human already knows). *Worked example*: a PR whose diff includes
  `.ai/specs/sdd-guard-dedup/tasks.md` going from 1 unchecked line to 0 → triggers.
- **size** — `additions + deletions > diffThreshold` (`.ai/policies/review-standard.json`,
  default 400). *Worked example*: a PR reporting `+310 -95` = 405 changed lines →
  triggers (405 > 400); a PR at `+200 -100` = 300 does not.
- Threshold changes are a normal PR (visible in review, not governance-gated) — raising
  it only widens the small-PR fast path, it never disables the phase-close trigger.

**Record format and location**: `docs/reviews/PR-<n>-<sha7>.md` (template:
[review-record.md](../templates/review-record.md)) — PR number, head commit, date,
finder/verifier counts, confirmed findings (or "none"), and outcome per finding (fixed |
accepted | rejected). `review-fanout`'s own output contract includes writing this record
(the calling loop writes it from the returned findings — workflow scripts have no
filesystem access).

**Staleness rule**: the record's `<sha7>` must equal the PR's CURRENT `headRefOid`
prefix. A record for an earlier head does not satisfy the gate — findings-fix pushes
change the head, so either write a new record (new sha) or update the existing one and
rename it; re-review scope after fixes is the operator's call, noted in the outcome
column.

**Override path**: the review is expensive and human-priced — this gate never
auto-runs `review-fanout` itself (a human decides to spend it). When triggered with no
current-head record, the merge STOPS and asks the operator to either run the review or
override with a one-line reason. An override is recorded the same way as a review (kind:
override, reason filled in) and committed TO THE PR BRANCH before the merge proceeds — an
unrecorded override, or one written only after merging, is not a valid path (it would let
the merge land unaudited).
