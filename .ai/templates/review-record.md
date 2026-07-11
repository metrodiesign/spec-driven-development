# Review record — PR #<n> @ <head sha7>

> sdd-premerge-review-standard — one file per reviewed PR head, keyed by head sha (not
> PR number alone: squash-merge makes PR titles/numbers an unreliable "what shipped"
> proxy, LESSONS.md `squash-merge-title-unreliable`). A record's `<sha7>` must equal the
> PR's CURRENT `headRefOid` prefix; a stale-head record does not satisfy the gate —
> write a new one (or update this one, renamed) after any post-review fix commit.

- date: <YYYY-MM-DD>
- kind: review-fanout | override
- finders/verifiers: <counts, e.g. "5 finders / 3 verifiers">            (override: "—")
- override reason: <one line — required for kind: override>              (review: "—")

| # | finding (file:line) | verdict | outcome |
|---|---|---|---|
| 1 | <path:line> | CONFIRMED \| PLAUSIBLE \| REFUTED | fixed \| accepted \| rejected |

(no confirmed findings → replace the table with a single line: "no confirmed findings")
