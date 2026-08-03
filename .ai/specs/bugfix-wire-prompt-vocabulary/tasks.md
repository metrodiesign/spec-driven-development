# Implementation Tasks: bugfix-wire-prompt-vocabulary — wire prompt vocabulary gap
> Status: approved 2026-08-03

> Bugfix spec: bugfix.md. หนึ่ง task เดียว — F1/F2/F3 ทั้งหมดอยู่ในฟังก์ชันเดียว
> (`buildProposePrompt`) แก้พร้อมกันตามที่อนุมัติไว้ ไม่แยกเป็นหลาย task

- [x] 1. แก้ `buildProposePrompt` (`adapters/src/wire.ts`) ให้สอน vocabulary ครบ
      ตามที่ระบบรองรับจริง: (F1) เพิ่ม `READ_FILE` เข้า proposal types ที่ประกาศ
      ให้ทุก role เห็น; (F2) เมื่อ `req.agentRole === 'diagnostician'` สลับไปใช้
      protocol block คนละแบบที่อธิบาย shape ของ `Hypothesis`/`HypothesisProbe`
      (`statement`, `probes[{cmd,expected}]` เรียงถูกสุดก่อน,
      `ifConfirmed{patchPlan,estimatedBlastRadius}` ตาม `core/src/types.ts:67-80`)
      และสั่งให้ส่งกลับผ่าน field ระดับบนสุด `hypotheses`; (F3) serialize
      `req.taskContract.acceptanceCriteria` เข้า prompt เมื่อมีค่า ต้องไม่แตะ
      signature ของ `buildProposePrompt` หรือ call site ใด ๆ (`req.agentRole` มี
      อยู่ใน `AgentRequest` แล้ว) และห้ามแตะ
      `core/src/executor/executor.ts`/`aal/src/source.ts`'s enforcement logic,
      `.ai/goals/auth-test-loop-01.yaml`, หรือ `test/golden/**` เด็ดขาด (B8-B10)
      diagnostician prompt ใหม่ต้องไม่ชวนเสนอ `WRITE_FILE` (write allowlist ว่าง
      เปล่า — B6)

      เพิ่ม test ใน `adapters/src/wire.test.ts` (ไฟล์เดียวที่ pin prompt text
      อยู่แล้ว):
      - prompt (`agentRole:'implementer'`) มีคำว่า `READ_FILE` ปรากฏ — RED ก่อน
        แก้, GREEN หลังแก้ (F1)
      - prompt ของ `agentRole:'diagnostician'` **ต่างจาก**
        `agentRole:'implementer'` (input อื่นเหมือนกัน) และมีคำว่า
        `Hypothesis`/`probes` ปรากฏ — RED ก่อนแก้ (เหมือนกันเป๊ะ), GREEN หลังแก้
        (F2)
      - prompt มีข้อความจาก `req.taskContract.acceptanceCriteria` เมื่อ populate
        ค่าไว้ในตัว fake request — RED ก่อนแก้, GREEN หลังแก้ (F3)
      - assertion เดิมทั้งหมดใน `wire.test.ts:48-70` (UNTRUSTED DATA marking,
        no-tools statement, `WRITE_FILE`/`REQUEST_TOOL` vocabulary, schema
        clause, ทั้ง `fenceGuard` true/false) ต้องเขียวต่อเนื่องไม่เปลี่ยน (B1,
        B3, B4)

      Satisfies: F1, F2, F3, B1, B2, B3, B4, B5, B6, B7, B8, B9, B10.
      Depends on: none.
      Verify: `pnpm -C adapters test && pnpm typecheck && pnpm lint`.

      หมายเหตุ B2 (conformance regression, probe P5 ต้องยังได้
      `REQUEST_TOOL{name:"fusion.deliberate"}`) ยืนยันด้วย unit test ในสโคปนี้
      ไม่ได้ — ต้องรัน `platform conformance --live` จริงหลัง merge (กิน quota
      จริง ต้องคนรันเองผ่าน TTY จริง ตาม guard เดิม) เทียบกับ baseline
      `.ai/calibration/conformance-claude-2026-08-03T14-03-25-995Z.json` นี่คือ
      manual follow-up แยกจาก DoD อัตโนมัติของ task นี้ ไม่ใช่เงื่อนไขที่ต้องผ่าน
      ก่อน mark `[x]`
      Evidence:
        - test: เพิ่ม 3 test ใหม่ใน `adapters/src/wire.test.ts` ก่อนแก้โค้ด —
          รัน `pnpm -C adapters test` ยืนยัน RED จริง (3 fail ตรงกับ F1/F2/F3
          เป๊ะ, exit 1) จากนั้นแก้ `adapters/src/wire.ts` (เพิ่ม
          `acceptanceCriteriaBlock` + `protocolBlock` แยก role, ไม่แตะ
          signature/call site) แล้วรัน `pnpm -C adapters test` ซ้ำ -> **42
          passed / 0 failed** (39 เดิม + 3 ใหม่ ทุกตัว GREEN, exit 0)
        - test: `pnpm typecheck` (`pnpm -r typecheck`) -> 6/6 workspace
          projects (`console/web`, `spikes`, `core`, `aal`, `adapters`,
          `console/backend`) Done, exit 0
        - other: `pnpm lint` (`eslint .`) -> ไม่มี finding, exit 0
        - other: `scripts/spec-trace.sh bugfix-wire-prompt-vocabulary` ->
          ข้ามการตรวจ traceability ตามที่ออกแบบไว้ (bugfix spec ไม่มี
          requirements.md)
        - viewports: n/a — logic-only, ไม่มี UI
        - deviations: ไม่มี — ตรงตาม bugfix.md ทุกข้อ B2 (conformance
          --live re-run) ยังไม่ได้ทำ บันทึกเป็น manual follow-up ตามที่ระบุไว้
          ใน bugfix.md/tasks.md ไม่ใช่ deviation
