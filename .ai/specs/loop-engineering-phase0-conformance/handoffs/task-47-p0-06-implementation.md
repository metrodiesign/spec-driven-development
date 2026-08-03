# Handoff: Task 47 — P0-06 lease lifecycle implementation

> From: Codex implementation worker  To: parent agent / fresh-context reviewer  Date: 2026-08-02

## Task Summary

เริ่ม implementation ของ Task 6 (P0-06) ใน `loop-engineering-phase0-conformance`
สำหรับ REQ-6.1–REQ-6.10 โดยเพิ่ม fencing token และ `TaskLeaseSession` ครอบ task
loop ทั้ง single-task และ graph composition พร้อม heartbeat, pause reacquire,
ownership checks และ terminal release. Task 6 ยังคง `[ ]` เพื่อรอ independent review
และ acceptance closure.

## Current Status

Production primitive และ wiring เสร็จใน working tree; focused lease/loop tests green.
Core loop รองรับ lease ที่ optional เพื่อคง legacy unit harnesses แต่ production
composition ของ `console/backend/src/loop-run.ts` สร้างและส่ง session ให้ทั้ง single
และ graph mode. TTL ที่ไม่มากกว่า max atomic duration + 1s margin จะ `ESCALATED`
ก่อนสร้าง adapter/branch/task. ไม่มีการแก้ Task 6 checkbox ใน tasks.md.

## Files Changed

- `core/src/state/schema.ts` — edited — additive `fencing_token`/`lease_fences` migration with fail-closed schema error handling.
- `core/src/state/lease.ts` — edited — monotonic fencing claim/renew/verify/release, TTL validator, `TaskLeaseSession`, heartbeat timer, pause reacquire.
- `core/src/index.ts` — edited — exports lease lifecycle APIs and types.
- `core/src/orchestrator/loop.ts` — edited — lease heartbeat, ownership fences before proposal/action/gate/diagnosis, pause reacquire, release wrapper, optional composition hold across post-loop work.
- `core/src/state/lease.test.ts` — edited — expiry replacement, stale-owner fencing, reacquire, invalid TTL tests.
- `core/src/orchestrator/loop.test.ts` — edited — deterministic two-owner contention, ownership loss during async proposal, and pause-past-TTL reacquire tests.
- `console/backend/src/loop-run.ts` — edited — shared invocation lease manager, single/graph claims, TTL refusal, task ownership checks, session handoff and terminal/error release.
- `console/backend/src/loop-run-lease.test.ts` — created — composition-level invalid-TTL refusal before adapter/task events.

## Important Decisions

- Fencing tokens increment only for a new ownership generation (expired takeover,
  explicit release/reclaim, or first claim); a live same-owner claim remains idempotent
  for compatibility. The `lease_fences` projection preserves monotonicity after rows
  are released.
- Old tokens can neither renew, verify nor release a replacement lease. Release uses
  owner + token in production; legacy owner-only API remains for existing merge queue
  callers.
- Heartbeat renewal runs on an unref'ed timer during asynchronous proposal/executor/gate
  waits. The timer stops at PAUSED so resume can exercise the required expiry/reclaim
  path; resume must reacquire before requesting another proposal.
- `runTaskLoop` releases by default; console composition sets `releaseLease: false` so
  approval/merge/deploy work remains inside the task lease and releases in its own
  `finally` path.
- Existing optional no-lease loop harnesses remain supported to avoid changing the
  already-accepted P0-05 tests; production single/graph paths always pass a session.

## Constraints

- Keep `.ai/specs/loop-engineering-phase0-conformance/tasks.md` Task 6 as `[ ]` until
  fresh-context correctness/security review and acceptance evidence are complete.
- Preserve the P0-02 real-macOS external blocker; do not retry/circumvent it or claim a
  managed-sandbox skip as PASS.
- Do not commit or push. Preserve unrelated uncommitted work from previous tasks.
- No new dependency, no secret, and no changes to authority bytes or guard scripts.

## Tests Run

- `pnpm --filter core typecheck` -> pass.
- `pnpm --filter console-backend typecheck` -> pass.
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-run-lease.test.ts` -> `1` pass, `0` fail (invalid-TTL path runs without opening the local server).
- `pnpm --filter core exec node --test --test-reporter spec src/state/lease.test.ts src/orchestrator/loop.test.ts` -> `16` pass, `0` fail (includes P0-05 regressions and P0-06 focused cases).
- `pnpm --filter core test` -> `542` total, `533` pass, `0` fail, `9` explicit external-only skips.
- `git diff --check` -> pass (no output).
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> pass (no output).
- `pnpm --filter console-backend exec node --test ...` -> sandbox blocked server tests with `listen EPERM: operation not permitted 127.0.0.1`; this is an environment limitation, not claimed as a green test.

## Known Issues

- Full console composition tests need to be rerun outside the nested sandbox (or on CI)
  because the test harness binds a local server and receives `EPERM` here.
- Lease/session API is additive and optional at the core loop type boundary for legacy
  tests; a future hardening pass may make it required after all callers migrate.

## Next Recommended Agent

Fresh-context correctness/security reviewer for P0-06, followed by an acceptance/closure
worker if no actionable Critical/High findings remain.

## Next Steps

1. Re-read this handoff, REQ-6/design lease sections, and inspect the current diff/status.
2. Run focused and full core tests plus console composition tests outside the sandbox;
   add any missing fault probes for terminal/error release and invalid TTL result shape.
3. Review ownership boundaries around post-REVIEWING merge/approval/deploy and confirm
   no old fencing token can produce action or gate events.
4. Only after review and exact Evidence are available, flip Task 6 `[x]` and create a
   closure handoff; preserve the P0-02 blocker and do not commit/push.
