# Handoff: P0-05 gate sequencing implementation

> From: Codex implementation worker 2026-08-02
> To: parent agent / fresh reviewer
> Date: 2026-08-02

## Task Summary

Implemented the P0-05 portion of `loop-engineering-phase0-conformance` for REQ-5.1–5.10. The core loop now runs one authenticated T0 after every implementer/repair action batch (including zero-action claims), runs T1 only for READY after a passing T0 on the same `worktreeHash`, excludes diagnostician/probe rounds, and routes tier failures through deterministic diagnosis without advancing state. Task 5 remains `[ ]` in `tasks.md` pending the required fresh review.

## Current Status

Implementation and RED-first regressions are complete. No commit or push was made. Task 2's recorded external real-macOS blocker was not retried or circumvented.

## Files Changed

- `core/src/orchestrator/loop.ts` — edited — T0/T1 sequencing, authenticated verification, same-artifact guard, and shared deterministic failure/diagnosis path.
- `core/src/orchestrator/loop.test.ts` — created — P0-05 sequence-table regressions for WORKING/READY/BLOCKED, zero actions, T0/T1 failures, flaky T1, repair, and diagnostician/probe exclusion.
- `core/test/fault-injection.test.ts` — edited — reconciled stale DoD expectations with amended REQ-5 semantics; budget test seeds a green artifact so it exercises the independent iteration cap.
- `core/test/steering-loop.test.ts` — edited — wallclock test seeds a green artifact so T0 remains green while active time advances.
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-42-p0-05-implementation.md` — created — this handoff.

## Important Decisions

- T0 is keyed to an implementer/repair iteration (`opts.role === 'implementer'`) and executes after the entire action batch, regardless of claim or action count. Internal diagnostician proposals and executor-owned hypothesis probes never enter this gate block.
- A failed T0 or T1 moves through `VERIFYING → FAILED → DIAGNOSING`; no claim can override a core gate failure. A T1 fail-then-pass report remains `pass: false` with `flakySuspect: true` and follows diagnosis.
- `GateRunner.verify` is called for both tiers before any state advancement. T1 is rejected with `artifact_identity_mismatch` if its authenticated `worktreeHash` differs from T0's frozen artifact.
- Existing budget and steering tests that previously relied on a failing T0 to reach later iteration/wallclock assertions now make the fixture green explicitly; this preserves the independent backstop assertions without weakening the new gate semantics.

## Constraints

- Keep Task 5 `[ ]` until an independent fresh-context correctness/security review accepts this implementation.
- Do not edit Task 2's external blocker or claim a managed-sandbox skip as real macOS evidence; do not retry/circumvent the recorded cooldown.
- Do not modify P0-02/P0-04 production behavior, requirements, design, authority, dependencies, or git history in this handoff.
- No commit or push; parent owns review/branch integration.

## Tests Run

- RED baseline: `pnpm --filter core exec node --test --test-reporter spec src/orchestrator/loop.test.ts` -> 4 tests, 2 pass, 2 fail before the loop fix (WORKING/BLOCKED had no T0; repair path lacked sequencing).
- Focused P0-05: `pnpm --filter core exec node --test --test-reporter spec src/orchestrator/loop.test.ts` -> 5 pass, 0 fail.
- Targeted loop/fault/steering: `pnpm --filter core exec node --test --test-reporter spec test/fault-injection.test.ts test/steering-loop.test.ts src/orchestrator/loop.test.ts` -> 36 total, 31 pass, 0 fail, 5 explicit external-only skips.
- Full core: `pnpm --filter core test` -> 532 total, 523 pass, 0 fail, 9 explicit external-only skips.
- Typecheck: `pnpm --filter core typecheck` -> exit 0.
- Lint: `pnpm lint` -> `ESLint: No issues found`.
- Evidence gate: `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit 0 (Task 5 intentionally remains unchecked).
- Hygiene: `git diff --check` -> exit 0, no output.

## Known Issues

- Nine core tests remain explicit external-only skips for real macOS sandbox verification, inherited from the recorded P0-02 cooldown; this task did not retry them.
- Task 5 has not been marked `[x]`; fresh review must independently inspect exact call counts/order, same-artifact binding, evidence verification, and failure/flake handling before closure.

## Next Recommended Agent

Fresh-context correctness/security reviewer for P0-05, followed by the parent agent's task-boundary decision.

## Next Steps

1. Reconcile `tasks.md` and this handoff, confirming Task 5 is still `[ ]` and Task 2 remains externally blocked.
2. Run the focused P0-05 suite and inspect the diff in `core/src/orchestrator/loop.ts`.
3. Perform the independent review; only after approval may the owner add the Task 5 Evidence block and checkbox.
