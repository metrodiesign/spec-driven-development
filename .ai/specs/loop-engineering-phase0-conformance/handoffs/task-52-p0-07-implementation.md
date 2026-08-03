# Handoff: Task 52 — P0-07 normalized usage and budget arithmetic

- วันที่: 2026-08-02
- ผู้ปฏิบัติงาน: Codex implementation worker
- ขอบเขต: P0-07 ของ `loop-engineering-phase0-conformance` สำหรับ REQ-7.1–REQ-7.8
- สถานะ: implementation และ regression tests เสร็จแล้ว; Task 7 ยังคง `[ ]` เพื่อรอ independent review/acceptance

## Task Summary

เพิ่ม normalized usage boundary ที่ core และ AAL: `costUnits` ต้องเป็น finite,
non-negative number, ค่า zero ยอมรับ, aggregate ที่ overflow ถูกปฏิเสธก่อน credit,
และ invalid usage ต้องทำให้ task escalate เป็น `invalid_response` โดยไม่แก้ต้นทุนเดิม

## Current Status

`IMPLEMENTED — PENDING REVIEW`. RED-first faults ผ่าน GREEN แล้ว และไม่พบ failure
ใน focused/full package suites ที่รันได้ใน environment นี้

## Files Changed

- `core/src/budget/budget.ts` — เพิ่ม `validateCostUnits`, `addCostUnits`,
  `BudgetUsageError`; ทำ `noteIteration` แบบ validate-before-credit
- `core/src/budget/budget.test.ts` — เพิ่ม negative/non-finite/overflow/zero regressions
- `core/src/index.ts` — export shared budget validation primitives
- `core/src/ports.ts` — additive source-side `invalid_response` marker on `Proposal`
- `core/src/orchestrator/loop.ts` — validate proposal/diagnosis usage ที่ core boundary,
  consume source-side invalid marker, escalate `invalid_response` ก่อน actions/gates และไม่ credit invalid cost
- `core/src/orchestrator/loop.test.ts` — custom-source NaN fault proves no action/gate และ cost unchanged
- `aal/src/repair.ts` — validate usage ทุก repair round และ reject aggregate overflow ด้วย
  `AdapterError('invalid_response')`; malformed usage ถูกปฏิเสธด้วย
- `aal/src/repair.test.ts` — negative/non-finite/overflow response usage faults
- `aal/src/source.ts` — map invalid usage เป็น structured `ERROR` + `ESCALATED{why:invalid_response}`
  โดยไม่ reroute หรือส่ง cost ต่อ
- `aal/src/source.test.ts` — custom adapter usage faults ที่ source boundary
- `aal/src/fusion/run.ts` — validate candidate/judge usage และ checked aggregate; invalid
  usage คืน `FusionOutcome.escalateReason: 'invalid_response'` พร้อม preserve prior usage
- `aal/src/fusion/run.test.ts` — invalid candidate และ aggregate-overflow fusion faults
- `aal/src/fake-adapter.ts` — optional usage override เพื่อสร้าง deterministic fusion fault fixture

## Important Decisions

- `validateCostUnits` ใช้ `unknown` ที่ runtime boundary; ไม่พึ่ง type assertion ของ adapter/source
- `addCostUnits` ตรวจทั้ง operands และผลรวมด้วย `Number.isFinite`; overflow จะไม่เพิ่ม
  iteration หรือ cost
- `Proposal.costUnits` ยังคง optional ใน type เพื่อ compatibility แต่ core runtime ถือว่า
  `undefined`/ชนิดผิดเป็น invalid response (ไม่ default เป็น zero)
- AAL ไม่ reroute `AdapterError('invalid_response')` เพราะเป็น malformed response ไม่ใช่
  capacity/transport fault; source คืน `BLOCKED` พร้อม source-side invalid marker และเขียน
  escalation โดยไม่ charge usage; core consumes marker and transitions the task to `ESCALATED`
- Fusion คืน usage ที่สะสมก่อน invalid input เพื่อรักษา prior cost แต่ไม่ credit ค่าที่ invalid
- ไม่แก้ semantics เดิมของ exact-zero backstop (`budget_exhausted`) ที่มี regression เดิมอยู่

## Constraints

- คง `.ai/specs/loop-engineering-phase0-conformance/tasks.md` Task 7 เป็น `- [ ]`
  จนกว่า fresh-context review และ acceptance จะเสร็จ
- ห้ามแตะ/แก้ Task 2 external real-macOS blocker หรือ claim managed sandbox เป็น PASS
- ไม่มี dependency ใหม่, ไม่มี lockfile/secret/policy authority change, ไม่มี commit/push
- รักษา production/test edits ของ task อื่นใน shared worktree

## Tests Run

- RED baseline: focused core/AAL commands มี failing assertions ตาม fault cases ก่อนแก้
- `pnpm --filter core exec node --test --test-reporter spec src/budget/budget.test.ts src/orchestrator/loop.test.ts` -> 20 pass, 0 fail
- `pnpm --filter aal exec node --test --test-reporter spec src/repair.test.ts src/source.test.ts src/fusion/run.test.ts` -> 41 pass, 0 fail
- `pnpm --filter core typecheck` -> pass
- `pnpm --filter aal typecheck` -> pass
- `pnpm --filter core test` -> 553 total, 544 pass, 0 fail, 9 explicit external-only skips (before the final exact-zero event assertion; final targeted rerun below)
- `pnpm --filter aal test` -> 148 pass, 0 fail, 0 skip (before the final source-marker assertion; final targeted rerun below)
- `pnpm --filter core exec node --test --test-reporter spec src/orchestrator/loop.test.ts test/repair-loop.test.ts src/budget/budget.test.ts` -> 23 pass, 0 fail
- `pnpm --filter aal exec node --test --test-reporter spec src/repair.test.ts src/source.test.ts src/fusion/run.test.ts` -> 41 pass, 0 fail (final focused rerun)
- `pnpm lint` -> `ESLint: No issues found`
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit 0
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> 144 criteria covered; EARS lint passed
- `cmp -s /Users/king_developer/Downloads/loop-engineering-implementation-spec.md loop-engineering-implementation-spec.md` -> exit 0
- `shasum -a 256 loop-engineering-implementation-spec.md` -> `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- `git diff --check` -> exit 0

## Known Issues

- Task 7 has not been closed; fresh-context correctness/security review must verify all
  AAL/core/fusion boundaries and independent iteration/cost/active-wallclock controls
- Existing explicit external-only macOS sandbox skips remain unrelated and were not retried

## Next Recommended Agent

Fresh-context correctness/security reviewer for P0-07, followed by acceptance/closure owner

## Next Steps

1. Inspect the shared cost validator and all invalid-response paths for boundary completeness.
2. Run the focused P0-07 suites and review hidden malformed-response/independent-backstop cases.
3. Only after review, decide whether to add Task 7 Evidence and flip its checkbox; do not commit/push.
