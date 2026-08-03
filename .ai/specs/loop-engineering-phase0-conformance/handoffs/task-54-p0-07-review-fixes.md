# Handoff: Task 54 — P0-07 budget exhaustion review fixes
> From: Codex review-fixes worker   To: parent P0-07 review/acceptance owner   Date: 2026-08-02

## Task Summary

แก้ High 1 จาก `handoffs/task-53-p0-07-review.md` ของ P0-07 ใน
`loop-engineering-phase0-conformance`: normal loop
ต้องบันทึก `BUDGET_EXCEEDED` เมื่อ `remaining() <= 0` ก่อน escalation โดยคงเหตุผลเดิม
`budget_exhausted` และทำให้ iteration, cost, active-wallclock exhaustion ใช้ structured
budget event อย่างสม่ำเสมอ โดยไม่ปนกันระหว่าง controls

## Current Status

`IMPLEMENTED — READY FOR FRESH REVIEW`; Task 7 ใน `tasks.md` ยังคง `- [ ]` ตามที่กำหนด
และยังไม่ได้เพิ่ม Evidence block หรือปิด task

RED-first regression ถูกเพิ่มใน `core/src/orchestrator/loop.test.ts` โดยตั้ง
`maxCostUnits: 0`, `maxIterations: 10`, `maxWallclockMs: 60_000` และ source ที่ห้ามถูกเรียก:
ก่อน production fix ได้ `1` fail, `13` pass; หลัง fix ได้ `14` pass, `0` fail

## Files Changed

- `core/src/orchestrator/loop.ts` — เพิ่ม `emitBudgetExceeded` และเรียกใช้ใน normal exact-zero,
  pre-diagnosis exact-zero, top-level limit, และ hypothesis budget/wallclock exhaustion paths
- `core/src/orchestrator/loop.test.ts` — เพิ่ม regression ที่ตรวจ event ordering และรักษา
  `ESCALATED{why:budget_exhausted}` legacy reason (ไฟล์เป็น untracked จาก Task 52)
- `core/test/fault-injection.test.ts` — ยืนยัน iteration-only exhaustion มี
  `BUDGET_EXCEEDED{limit:iterations}`
- `core/test/steering-loop.test.ts` — ยืนยัน active-wallclock-only exhaustion มี
  `BUDGET_EXCEEDED{limit:wallclock}`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-54-p0-07-review-fixes.md` — handoff นี้

ไฟล์อื่นใน worktree มีการเปลี่ยนแปลงจาก tasks ก่อนหน้า; ไม่ได้ revert หรือแก้ไขนอก scope
review fix นี้

## Important Decisions

- `emitBudgetExceeded(limit)` เป็น helper ใน core loop เพื่อให้ทุก exhaustion path append
  event เดียวกันก่อน `ESCALATED`; payload ยังคง `{ limit, iterations }`
- normal exact-zero และ diagnosis exact-zero ยังคง `ESCALATED{why:budget_exhausted}` เพื่อ
  รักษา compatibility ของ existing tests/spec ขณะที่เพิ่ม event ที่ REQ-7.7 ต้องการ
- hypothesis outcome ที่รายงาน `budget`/`wallclock` ตรวจ `budget.exceeded()` เพื่อเก็บ
  limit ที่แท้จริง; มี fallback แบบ fail-closed หาก snapshot เปลี่ยนเป็นไม่ exhausted
- iteration, cost, และ active-wallclock tests ใช้ caps อิสระต่อกัน จึงไม่ยืนยัน event จาก
  control อื่นโดยบังเอิญ

## Constraints

- ห้าม flip Task 7 เป็น `[x]`; acceptance owner ต้องตัดสินหลัง fresh-context review
- ห้าม retry หรืออ้าง PASS สำหรับ external real-macOS P0-02 blocker
- ไม่มี dependency, lockfile, secret, authority, policy, commit หรือ push ใหม่

## Tests Run

- RED baseline: `pnpm --filter core exec node --test --test-reporter spec src/orchestrator/loop.test.ts` -> `13` pass, `1` fail (new normal exact-zero assertion)
- focused GREEN: `pnpm --filter core exec node --test --test-reporter spec src/orchestrator/loop.test.ts` -> `14` pass, `0` fail
- full core: `pnpm --filter core test` -> `554` total, `545` pass, `0` fail, `9` explicit external-only skips
- full AAL: `pnpm --filter aal test` -> `148` pass, `0` fail, `0` skip
- workspace typecheck: `pnpm typecheck` -> all 6 projects pass
- lint: `pnpm lint` -> `ESLint: No issues found`
- Evidence gate: `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit `0`
- spec trace: `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria covered; EARS lint passed
- authority: `cmp -s /Users/king_developer/Downloads/loop-engineering-implementation-spec.md loop-engineering-implementation-spec.md` -> pass; SHA-256 `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- hygiene: `git diff --check` -> exit `0`

## Known Issues

P0-02 real-macOS suite remains an explicit external blocker until its recorded cooldown;
the 9 core skips are unchanged. Task 7 still awaits fresh correctness/security review and
acceptance closure.

## Next Recommended Agent

Fresh-context P0-07 reviewer, then acceptance/closure owner; verify the helper does not
alter existing budget ordering and inspect hypothesis probe exhaustion coverage.

## Next Steps

1. Re-read Task 52 and this handoff, then run the focused loop regression and inspect event order.
2. Run the recorded full core/AAL/typecheck/lint/Evidence checks in the authorized environment.
3. If review is clean, acceptance owner may add Task 7 Evidence and flip its checkbox; otherwise
   keep it open and record any further review finding in a new handoff.
