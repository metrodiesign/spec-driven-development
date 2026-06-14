# Testing Protocol

> Vendor-neutral. How any agent proves a change is correct.
> Canonical source for the testing expectations in [TASK_PROTOCOL.md](TASK_PROTOCOL.md)
> and the test-report shape in [OUTPUT_FORMATS.md](OUTPUT_FORMATS.md).

## Runner and scope

- Test runner: **vitest** — `npm test` runs `vitest run`.
- Unit tests cover **pure logic** only, co-located in `app/lib/` as `*.test.ts`. The
  runner's `include` is `app/lib/**/*.test.ts`; that is where headless tests go.
- This project has no DB / backend, so there is no integration-test tier against a real
  service. UI behavior is verified in a real browser (see below), not by vitest.

## Pure-logic-first

Extract testable logic (formulas, validation, formatting) into **pure functions** in
`app/lib/`, and get their unit tests GREEN before wiring any UI. Correctness then does
not get entangled with rendering, and the numeric / behavioral acceptance criteria are
closed before the component layer exists. Components call these functions; they never
embed the formula in JSX. See the patterns in [LESSONS.md](LESSONS.md) and the layering
in [ARCHITECTURE.md](ARCHITECTURE.md).

## Test quality

- Each test maps to a REQ-ID (or F-ID / B-ID for a bugfix) — a test exists because a
  requirement demands it.
- Assert the **observable behavior** (returned value, computed result, rendered output,
  layout measurement), NEVER an implementation detail (which CSS class was used, which
  private function was called). Asserting implementation detail is a known way to pass
  while the real failure mode slips through.
- Cover the happy path AND the error/edge cases (`IF ... THEN` from
  [EARS.md](EARS.md)).
- For a bugfix, validation is three-dimensional: (a) a repro test that is RED before the
  fix and GREEN after (the F-IDs), (b) a 1:1 assertion for every B-ID, (c) each
  assertion checks the observable failure mode.
- No `.only` / `.skip` may be committed. Coverage must not fall below the project
  threshold. (Both are CI-enforced — see [SECURITY_RULES.md](SECURITY_RULES.md).)

## UI verification

Logic that cannot be tested headless under vitest is verified in a real browser. Browser
verification here uses a **production build** (`npm run build` then `next start` on
`127.0.0.1`), and you must confirm `document.documentElement.clientWidth === target` at
each acceptance viewport before trusting a result.

Before ANY browser-based verification, READ the browser-verify reference first — it
contains the probe recipes, the viewport / scrollbar gotchas, the hydration check, and
the false-positive traps (SVG geometry, gradient backgrounds, focus-ring measurement):

`.claude/skills/spec-implement/references/browser-verify.md`

(That file currently lives under the Claude skill; it is the canonical UI-verify
reference for every agent until/unless it moves under `.ai/`.)

## Evidence block format

When a task is marked `- [x]` in `tasks.md`, append an `Evidence:` block in the SAME
edit — the checkbox and the evidence flip together. Record what you ACTUALLY ran and
observed, not the planned check:

```
Evidence:
  - test: `<exact command>` -> <result, e.g. 47 passed / 0 failed>
  - viewports: 375 OK | 768 OK | 1440 OK   (browser tasks; else `n/a — logic-only`)
  - deviations: <none | what differed from design/requirements and why>
```

- The command must be the exact one you ran, copy-pasteable.
- For a browser task, the viewport line records the measured `clientWidth` outcome at
  each acceptance viewport; never assert a pass you did not observe.
- If a check could not be run, say so explicitly in `deviations:` — do not leave it
  blank or claim a pass.

Before marking the LAST task (or any assembly task), run the REQ-trace check; any
uncovered REQ it reports is a blocker, never skipped silently.
