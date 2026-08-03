# Handoff: Task 53 — P0-07 fresh-context correctness/security review

- วันที่: 2026-08-02
- ผู้ตรวจ: Codex fresh-context correctness/security reviewer
- ขอบเขต: Task 52 implementation, `core/src/budget/budget.ts`,
  `core/src/orchestrator/loop.ts`, `core/src/ports.ts`, AAL repair/source/fusion
  usage boundaries, tests ที่เกี่ยวข้อง และ REQ-7.1–REQ-7.8
- สถานะการแก้: read-only ต่อ production/tests/requirements/design/tasks; เพิ่มเฉพาะ
  handoff นี้

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 1
- Medium: 0
- Low: 0

ยังไม่ควร flip Task 7 เป็น `[x]`. พบช่องว่าง High หนึ่งข้อใน core loop: เมื่อ
ค่าใช้จ่ายสะสมแตะ `maxCostUnits` พอดี normal loop ใช้ exact-zero guard แล้ว
escalate ด้วย `budget_exhausted` โดยไม่ append `BUDGET_EXCEEDED` ทั้งที่ REQ-7.7
กำหนดให้ทุก iteration/cost/active-wallclock limit ที่ exhausted ต้อง emit event นี้.
Diagnosis-boundary guard มี event ดังกล่าวแล้ว จึงทำให้สองเส้นทางมี semantics ไม่ตรงกัน.

## High

### High 1 — exact cost-cap exhaustion ไม่ emit `BUDGET_EXCEEDED`

- Location: `core/src/orchestrator/loop.ts:297-302`
- Dimension: correctness / error handling / REQ-7.7–REQ-7.8
- Evidence: `createBudget.exceeded()` ใช้ `costUnits > limits.maxCostUnits`
  (`core/src/budget/budget.ts:79-83`) จึงคืน `false` เมื่อสะสมค่าใช้จ่ายเท่ากับ cap.
  จากนั้น normal loop เข้า `remaining() <= 0` และเรียก `escalate('budget_exhausted')`
  โดยไม่มี `BUDGET_EXCEEDED` event. ในทางกลับกัน diagnosis-boundary guard ที่
  `core/src/orchestrator/loop.ts:438-448` append event นี้ก่อน escalate.
- Impact: consumer/auditor ที่ใช้ `BUDGET_EXCEEDED` เป็น durable signal จะมองไม่เห็น
  cost exhaustion แบบ exact-cap ในเส้นทางปกติ แม้ task จะหยุดขอ proposal แล้ว;
  behavior จึงไม่เป็นไปตาม “any ... cost ... limit is exhausted”.
- Fix: กำหนด semantics ให้สอดคล้องกับ REQ-7.7 โดย append
  `BUDGET_EXCEEDED { limit: 'costUnits' }` ใน exact-zero branch (หรือปรับ
  `exceeded()` ให้คืน cost exhaustion ที่ boundary แล้วคง `budget_exhausted` เป็น
  supplementary reason) พร้อม regression ที่ assert event + terminal state และ
  no-next-proposal. หากต้องคง REQ-6.7 `budget_exhausted` ไว้ ให้ emit ทั้งสองอย่าง
  อย่างชัดเจนแทนการเลือกเพียง event เดียว.

## Verified controls

- `validateCostUnits` ปฏิเสธชนิดที่ไม่ใช่ number, `NaN`, `+/-Infinity` และค่าติดลบ
  ก่อน credit; `addCostUnits` ปฏิเสธ aggregate overflow โดยคง prior total.
- core `ProposalSource` boundary ตรวจ `Proposal.error` ก่อน charge/action/gate;
  invalid marker จาก AAL ทำให้ task เป็น `ESCALATED{why:invalid_response}` และ
  accumulated cost ไม่เปลี่ยน.
- repair loop ตรวจทุก response usage และ aggregate; invalid response ไม่ reroute
  ผ่าน AAL และไม่ส่ง cost ต่อ.
- fusion ตรวจ candidate/judge usage ด้วย checked aggregate; invalid/overflow คืน
  `invalid_response` พร้อม prior finite usage.
- zero และ finite positive usage ยอมรับ; iteration, cost และ active-wallclock
  backstops หยุดการขอ proposal ที่ boundary ที่ทดสอบได้.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/budget/budget.test.ts src/orchestrator/loop.test.ts` -> `20` pass, `0` fail.
- `pnpm --filter aal exec node --test --test-reporter spec src/repair.test.ts src/source.test.ts src/fusion/run.test.ts` -> `41` pass, `0` fail.
- Backstop-focused core command over `test/fault-injection.test.ts`,
  `test/repair-loop.test.ts`, `test/steering-loop.test.ts` -> `31` pass, `0` fail,
  `5` explicit external-only skips.
- `pnpm --filter core test` -> `553` total, `544` pass, `0` fail, `9` explicit
  external-only skips.
- `pnpm --filter aal test` -> `148` pass, `0` fail, `0` skip.
- `pnpm typecheck` -> all `6` workspace projects pass.
- `pnpm --filter core typecheck`, `pnpm --filter aal typecheck` -> exit `0`.
- `pnpm lint` -> `ESLint: No issues found`.

ไม่มีการแก้ production/test/spec checkbox, ไม่มีการ retry external real-macOS
blocker, ไม่มี commit หรือ push. Task 7 ต้องคง `[ ]` จนแก้ High 1 แล้วให้
fresh-context review ซ้ำ.

## Next Recommended Agent

Task 52 implementation owner เพื่อเพิ่ม `BUDGET_EXCEEDED` ใน normal exact-cost
branch และ regression RED/GREEN; จากนั้นให้ acceptance owner ตรวจซ้ำทุก REQ-7
boundary และตัดสินใจ closure.

