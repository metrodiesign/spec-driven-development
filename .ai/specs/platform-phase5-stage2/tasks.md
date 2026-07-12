# Implementation Tasks: platform-phase5-stage2 — goal.schema.json + Typed Contract
> Status: approved 2026-07-12

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Schema pair + validator — เขียน `.ai/schemas/goal.schema.json` (C1, shape
     เต็มตาม design) + `console/backend/src/goal-schema.ts` (C2: `GOAL_SCHEMA`
     embedded copy + `validateGoalShape` ajv allErrors, เพิ่ม dependency `ajv` ใน
     console/backend เท่านั้น) + `goal-schema.test.ts` (parity deep-equal + shape
     cases ทั้งตาราง: unknown key, budget missing/zero/negative/fractional/สตริง,
     risk enum ครบ + invalid, stack free-form, provenance, deploy 4-command);
     done = test file เขียว + parity fail เมื่อแก้ฝั่งเดียว.
     Satisfies: REQ-1 (all criteria), REQ-2.5, REQ-6.1.
     Verify: pnpm -C console/backend test goal-schema.
     Evidence:
       - test: `node --test --test-reporter spec src/goal-schema.test.ts` (ใน
         console/backend) -> 13 passed / 0 failed (parity deep-equal ผ่าน — form
         `assert.deepStrictEqual(GOAL_SCHEMA, governance)` fail ทันทีเมื่อฝั่งใด
         เปลี่ยนเดี่ยว; shape table ครบ: unknown top/nested/AC-item key, budget 6
         key × missing/0/-1/2.5/"8", risk L0-L4 + l2/TODO/L5/2, stack free-form +
         non-string reject, provenance, deploy 4-cmd + cross-field ปล่อยให้ freeze,
         allErrors multi-defect, non-object roots); `pnpm typecheck` -> clean;
         `pnpm test` (console/backend เต็ม) -> 314 passed / 0 failed; dependency
         ใหม่: `ajv ^8.20.0` ใน console/backend เท่านั้น + pnpm-lock.yaml commit
       - viewports: n/a — logic-only
       - deviations: none
- [x] 2. Typed freeze ใน core — `ContractBudget extends BudgetLimits` (6 field) +
     `risk: RiskClass` default L2 + `reqPosInt` helper + reject rules ตาม C4 +
     Stage-4 deferral comment ที่ `maxTotalTasks` (4.4) + ขยาย
     `core/src/contract/contract.test.ts` (budget 6-key ทุก failure mode ระบุ key,
     risk absent/valid/invalid, `some_future_key` raw passthrough คงอยู่, GOAL
     fixture อัป 6-key); done = core test เขียว — เมื่อรวมกับ task 1 = 6.2/6.3
     ครบทั้งสองชั้น.
     Satisfies: REQ-3.1, REQ-3.2, REQ-3.3, REQ-3.4, REQ-3.5, REQ-3.6, REQ-4.3,
     REQ-4.4, REQ-6.2, REQ-6.3. Depends on: 1 (เฉพาะความครบของ 6.2/6.3 —
     โค้ด core ไม่ import อะไรจาก task 1).
     Verify: pnpm -C core test.
     Evidence:
       - test: `pnpm -C core test` -> 243 passed / 0 failed (ใหม่ 6 tests: 3 caps
         typed, missing-key ระบุ key ทั้ง 6, zero/-1/2.5/"8" reject ทั้ง 6 key,
         risk absent -> L2 / L0-L4 round-trip / l2-TODO-L5-2-null reject;
         `some_future_key` raw passthrough เดิมยังผ่าน); `pnpm -C core typecheck`
         -> clean
       - viewports: n/a — logic-only
       - deviations: checkbox flip หลัง task 3-4 land (gate = workspace-wide
         `pnpm -r`, console fixtures แดงระหว่างกลางตาม rollout PR เดียวโดย design)
- [x] 3. Edge integration + consumer wiring — `loadGoalContract` validate-then-freeze
     (C3) + repair wiring `repairPolicy` จาก contract + export
     `DEFAULT_REPAIR_POLICY` ผ่าน barrel (C5/AD3) + แทน `parseRisk` ด้วย
     `contract.risk` แล้วลบ orphan + dispatch `ceiling` + `effectiveMaxParallel` +
     planning guard fail-closed (C6) + migrate fixtures ในแนวนี้: calibration
     goal yaml 4 ไฟล์, `loop-cli.test.ts`, `loop-run.test.ts` (risk-via-raw →
     typed field, L1 ต้องยังเป็น L1 — AD1), `dispatch.test.ts` ceiling cases;
     done = wiring tests เขียว (hypothesis cap non-default 5 สังเกตได้จริง,
     dispatch clamp + guard refuse).
     Satisfies: REQ-2.1, REQ-2.2, REQ-2.3, REQ-2.4, REQ-2.6, REQ-4.1, REQ-4.2,
     REQ-6.8, REQ-6.9. Depends on: 1, 2.
     Verify: pnpm -C aal test && pnpm -C console/backend test loop-cli loop-run.
     Evidence:
       - test: `pnpm -C aal test` -> 143 passed / 0 failed (ceiling clamp
         maxParallel 4 + ceiling 3 -> observed concurrency 3; absent/สูงกว่า =
         dormant; ceiling 0 -> floor 1); `node --test src/loop-run.test.ts
         src/loop-cli.test.ts` -> 40 passed / 0 failed รวม (6.8) contract cap 5 +
         behavior `exhaust_hypotheses` -> PROBE_RUN = 5 เป๊ะ (default 3 จะ fail),
         ESCALATED reason `max_hypotheses`; (6.9) planning dispatcher
         maxParallel 2 + contract cap 1 -> reject ก่อน run เริ่ม; edge validation
         โยน error รวม 4 defect paths (typo'd budget key, zero, unknown top key,
         risk enum); L1 auto-merge e2e ยังเขียวด้วย typed `risk: 'L1'`
       - viewports: n/a — logic-only
       - deviations: เพิ่ม FakeBehavior `exhaust_hypotheses` ใน aal fake-adapter
         (ไม่อยู่ใน design โดยชื่อ — จำเป็นเพื่อให้ 6.8 เป็น behavioral proof จริง
         ตามที่ AD6/6.8 เรียกร้อง ไม่ใช่ helper-only test)
- [x] 4. Lifecycle + docs + sweep — `hasPromotedGoal` loopManaged redefinition
     (C7 try/catch) + `claude-data.test.ts` สี่เคส (6.7) + banner promotion step
     ใน `spec_to_goal.py` (C8) + rewrite `spec-to-goal.e2e.test.ts` สองจังหวะตาม
     3.7 (reject ที่ `risk:"TODO"` → fill → freeze ผ่าน) + 6.4 (error paths มี
     empty-AC โดยเฉพาะ + freeze direct reject) + 6.5 สองระดับ (unresolved fixture
     exercise rename clause + phase4 corpus scale — AD4) + §11.1 canonical path +
     `risk: L2` example + promotion sentence + §17 changelog v1.5 (สาม
     supersession) + sweep สุดท้ายยืนยันไม่มี fixture/doc ตกค้าง repo-wide;
     done = ทุก package เขียว + spec-trace เขียว.
     Satisfies: REQ-3.7, REQ-5.1, REQ-5.2, REQ-5.3, REQ-5.4, REQ-5.5, REQ-6.4,
     REQ-6.5, REQ-6.6, REQ-6.7. Depends on: 1, 2.
     Verify: pnpm -C console/backend test claude-data spec-to-goal &&
     scripts/spec-trace.sh platform-phase5-stage2.
     Evidence:
       - test: `node --test src/spec-to-goal.e2e.test.ts src/claude-data.test.ts`
         -> 19 passed / 0 failed (สองจังหวะ 3.7: resolved draft freeze reject ที่
         /risk แล้วผ่านหลัง fill L2; 6.4: schema errors มี /acceptance_criteria
         [minItems] + pending key + /risk ครบ + freeze direct reject; 6.5 สองระดับ:
         unresolved fixture rename+fill+risk -> schema ว่าง + freeze ผ่าน risk L1,
         resolved fixture fill risk -> ผ่าน; 6.7 สี่เคส: promoted true / draft-only
         false / legacy root false / bare false; banner ทั้งสอง variant มี promotion
         step); `pnpm -r typecheck && pnpm -r test` -> ทุก package เขียว (core 243,
         aal 143, adapters 39, console/backend 318); sweep grep budget-3-key
         (นอก archive) -> 0 leftover; `scripts/spec-trace.sh platform-phase5-stage2`
         -> OK 40/40 + EARS lint ผ่าน
       - viewports: n/a — logic-only (loopManaged เป็น boolean ฝั่ง backend;
         console/web อ่านค่าเดิมไม่แตะ)
       - deviations: none

## Suggested execution batches

> Coupled feature (schema + freeze + wiring + sweep แชร์ contract shape เดียวกัน,
> ต้อง land พร้อมกันเป็น PR เดียว — requirements "Rollout ลำดับ commit เดียว") —
> รัน ALL ทาสก์ใน session เดียว: `/spec-implement all` หรือ
> `scripts/pane-loop.sh platform-phase5-stage2 all-in-one`. ไม่มี Batch: tag —
> ทุก task ใหญ่และคนละ region, ไม่มีกลุ่มเล็ก same-type.
> หมายเหตุ 6.6: task 3 migrate fixtures ในแนวของตัวเองไปพร้อมงาน; task 4 เป็นผู้
> claim 6.6 เพราะปิด sweep ทั้ง repo เป็นด่านสุดท้าย.
