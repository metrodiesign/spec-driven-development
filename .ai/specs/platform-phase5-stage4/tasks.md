# Implementation Tasks: platform-phase5-stage4 — Task Graph + Planning Gate (§11.2)
> Status: approved 2026-07-26 (quick-mode per operator /goal directive — see
> requirements.md header; operator post-hoc review pending)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Schema + core graph module (pure foundations) — governance
     `.ai/schemas/task-graph.schema.json` + embedded `TASK_GRAPH_SCHEMA` +
     `validateTaskGraphShape` (`console/backend/src/task-graph-schema.ts`) +
     parity/shape tests ตาม design D1; core `core/src/graph/graph.ts`
     (typed `TaskGraph` effective-baked, `freezeTaskGraph` รวบ reasons,
     `TaskGraphGateError`) + `core/src/graph/select.ts`
     (`DEP_SATISFIED_STATES`, `selectNextTask`) + เพิ่ม
     `TASK_GRAPH_FROZEN`/`TASK_GRAPH_REJECTED` ใน `core/src/types.ts`
     EventType union + co-located unit tests ปิดทุกกิ่ง reject/select ตาม
     design D3 (Kahn cycle, goal_id binding, deploy reject, effective bake,
     run-scoped projection semantics เป็น literal ใน test). Done = ทุกกิ่ง
     REQ-1/REQ-3/4.1 มี test เขียว, core ปลอด vendor name.
     Satisfies: REQ-1 (all), REQ-3 (all), REQ-4.1. Verify: pnpm -C core test && pnpm -C console/backend test task-graph-schema && pnpm typecheck.
     Evidence:
       - test: `pnpm -C core test` -> 282 passed / 0 failed (graph.test.ts 19 +
         select.test.ts 10 = 29 new; ทุก criterion REQ-3.1-3.14 มี case ของตัวเอง
         + collect-all-reasons + structural standalone; select ปิด REQ-4.1
         dep-set/file-order/started/lease-fold/risk-ไม่ใช่-input)
       - test: `pnpm -C console/backend test task-graph-schema` -> 353 passed /
         0 failed; ยิงไฟล์เดี่ยว `node --test --test-reporter spec
         'src/task-graph-schema.test.ts'` (ใน console/backend) -> 9 passed / 0
         failed (parity deep-equal + REQ-1.1/1.3/1.4/1.5)
       - typecheck: `pnpm typecheck` -> clean ทั้ง 6 workspace projects
       - lint: `pnpm lint` -> ESLint: No issues found
       - vendor: `bash scripts/check-core-vendor-free.sh` -> OK (INV-7)
       - viewports: n/a — logic-only
       - deviations: (1) `TaskGraphGateError` เขียน field + assignment ใน
         constructor แทน parameter property `readonly reasons` ตามภาพร่าง D3 —
         `erasableSyntaxOnly: true` ใน tsconfig.base.json ห้าม parameter
         property (สัญญาภายนอกเหมือนเดิม: `readonly reasons: string[]`);
         (2) เพิ่ม export block ของ `graph/` ใน `core/src/index.ts` (design D3
         ไม่ได้ระบุ) — จำเป็นเพราะ `core/package.json` exports แค่
         `.`/`./ports`/`./types` ดังนั้น composition (task 4) import จาก root
         ได้ทางเดียว; (3) คำสั่ง verify `pnpm -C console/backend test
         task-graph-schema` — arg ท้ายเป็น no-op กับ test script ของ package นี้
         (node --test เมิน pattern ที่ไม่ match) จึงรันทั้ง suite ไม่ได้ filter
         — ไม่มีไฟล์ test เดิมถูกแก้ (`git status` = M เฉพาะ core/src/index.ts
         + core/src/types.ts, ที่เหลือเป็นไฟล์ใหม่)

- [x] 2. Generator task-graph emission — `scripts/spec_to_goal.py`:
     `TASK_HEAD_RE` (รับ indent), title extraction + fallback + truncate 120,
     `Depends on:` grammar แคบ (pin fixture บรรทัดจริงของ stage-2), validate
     dangling Satisfies/Depends/ordinal ซ้ำ/ordinal หาย (exit 1), emit
     `task-graph.draft.json` (goal_id, key order pin, checks 400, atomic
     write, per-file `--force` gate exit 1), ไม่ auto-promote; ขยาย
     `console/backend/src/spec-to-goal.e2e.test.ts` ตาม design D2 รวม
     pre-flight sweep กับทุก approved spec เดิม (เจอ fail = แก้ spec นั้นใน
     PR นี้ ไม่ลด validation) และ assert draft ผ่าน `validateTaskGraphShape`
     + `freezeTaskGraph` จริง. Done = e2e เขียวทั้งชุด.
     Satisfies: REQ-2 (all criteria). Depends on: 1. Verify: pnpm -C console/backend test spec-to-goal.
     Evidence:
       - test: `pnpm -C console/backend test spec-to-goal` -> 360 passed / 0 failed
         (arg ท้ายเป็น no-op filter ของ package นี้ = รันทั้ง suite); ยิงไฟล์เดี่ยว
         `node --test --test-reporter spec 'src/spec-to-goal.e2e.test.ts'` (ใน
         console/backend) -> 23 passed / 0 failed = 16 เดิม (แก้ 1 case, ดู
         deviation 1) + 7 ใหม่: happy 3-task+deps/key order/checks 400 +
         validateTaskGraphShape + freezeTaskGraph จริง, grammar fixture ของ
         stage-2 (deps = ["T-1"] เท่านั้น), indented checkbox + title cut 120 +
         marker-less fallback, 4 failure paths (dangling dep / dangling
         satisfies / ordinal หาย / ordinal ซ้ำ = exit 1 และไม่เขียน draft ใด),
         per-file gate สองทาง + --force, tasks.md absent, pre-flight sweep
       - test: `pnpm -C core test` -> 282 passed / 0 failed (ไม่ได้แตะ core)
       - sweep: pre-flight (D18) รันใน e2e กับ 11 approved specs ใต้ `.ai/specs`
         (non-archive) -> 0 failures + graph draft ทุกตัว schema-clean; กวาดมือ
         เพิ่มรวม `.ai/specs/archive/*` = 17 specs -> 0 failures — **ไม่มี spec
         จริงตัวไหนต้องแก้** ภายใต้กติกาใหม่
       - typecheck: `pnpm typecheck` -> clean ทั้ง 6 workspace projects
       - lint: `pnpm lint` -> ESLint: No issues found
       - viewports: n/a — logic-only
       - deviations: (1) แก้ e2e case เดิม 1 บรรทัด (`readdirSync` expectation ของ
         case "generator touches nothing but goal.draft.yaml") — REQ-2.1
         supersede Stage-1 REQ-4.1/4.6 ที่ pin ว่ามีไฟล์ใหม่ไฟล์เดียว; ประกาศ
         supersession เพิ่มใน requirements.md Overview แล้ว (รายการที่ 6) →
         task 6 ต้องบันทึกใน §17 ด้วย; invariant จริงของ case นั้น (ไม่มี temp
         file ค้าง / input ไม่ถูกแตะ / ไม่ promote เอง) ยัง assert ครบ.
         (2) `Depends on:` สะสม**ทุก** occurrence ในบล็อก (grammar แคบเท่าเดิมต่อ
         occurrence) ไม่ใช่ occurrence แรกอย่างเดียว — บล็อกของ task นี้เอง quote
         คำว่า marker ใน prose (backtick) ทำให้กติกา "occurrence แรก" ทิ้ง
         dependency จริงเงียบ ๆ (ตรวจพบตอน implement, สะกดตรงกับพฤติกรรม
         Satisfies ที่สะสมอยู่แล้ว). (3) `json.dumps(..., ensure_ascii=False)` —
         title ของ spec จริงเป็นภาษาไทย, ไฟล์ต้องให้มนุษย์อ่านก่อน promote.
         (4) tasks.md มีอยู่แต่ไม่มี task block เลย -> warn + ข้าม graph (REQ ไม่
         ครอบเคสนี้; emit `tasks: []` จะผิด schema `minItems: 1` ทันที).
         (5) title ว่าง (marker ติดหัวบล็อกทันที) ไม่เพิ่ม failure path ใหม่ —
         schema `minLength: 1` จับที่ edge validation ตอน promote.

- [x] 3. loop-run layer-1 parameterization (mechanical, zero behavior change)
     — แตก per-task machinery ของ `runSupervisedLoop` เป็น
     `executeTask(task)` closure ตามตาราง per-run/per-task ใน design D4
     ชั้น 1 เป๊ะ (per-run singletons ห้ามย้าย; literal `'T-1'`/`'RUN-LIVE'`
     6 จุดใน run-level closures → `activeTaskId()` getter;
     `currentState(taskId)` filter; onDecision/onInject/escalate/
     deferred-quarantine รับ taskId). single-task path เรียก
     `executeTask('T-1')` ครั้งเดียว. Done = **ทุก test เดิมเขียวโดยไม่แก้
     ไฟล์ test เดิมแม้บรรทัดเดียว** (`git diff --stat` ต้องไม่มีไฟล์
     `*.test.ts` เดิม) + typecheck/lint เขียว — นี่คือหลักฐานของ REQ-4.3.
     Satisfies: REQ-4.3, REQ-4.14 (กลไก taskId-scoping). Depends on: 1. Verify: pnpm -C console/backend test && pnpm typecheck && pnpm lint.
     Evidence:
       - test: `pnpm -C console/backend test` -> 360 passed / 0 failed — **เท่ากับ
         baseline เป๊ะ** (รัน baseline ก่อนแก้บน HEAD 0c9fe80 = 360/360 เช่นกัน)
       - test: `pnpm -C core test` -> 282 passed / 0 failed (core ไม่ถูกแตะ)
       - typecheck: `pnpm typecheck` -> clean ทั้ง 6 workspace projects
       - lint: `pnpm lint` -> ESLint: No issues found
       - **zero test-file edit (หลักฐานของ REQ-4.3):** `git status --porcelain` ->
         ` M console/backend/src/loop-run.ts` บรรทัดเดียว; `git diff --stat` ->
         `1 file changed, 124 insertions(+), 94 deletions(-)`;
         `git diff --name-only | grep -c test` -> `0`
       - byte-identical proof (นอกเหนือจาก suite): probe ชั่วคราวนอก repo รัน
         `runSupervisedLoop` เวอร์ชันก่อน/หลัง refactor คู่กัน 4 scenario
         (plain+autoMerge / plain ไม่มี autoMerge opt / repairable+autoMerge /
         outcome-routing active) แล้ว diff event stream ทั้งสาย (type|taskId|payload
         ตามลำดับ) + result object + ลำดับ key ของ result -> `ALL SCENARIOS
         IDENTICAL` (16/16/34/17 events). Control run (baseline เทียบตัวเอง) ใช้
         พิสูจน์ว่าฟิลด์ที่ normalize ออก (git commit SHA 40-hex ใน
         `snapshotRef`/`commitHash` ซึ่งฝัง timestamp) เป็น noise ระหว่างรันจริง
         ไม่ใช่ผลของ refactor — control ก่อน normalize ก็ต่างบรรทัดเดียวกัน,
         หลัง normalize ทั้ง control และ A/B = IDENTICAL ทั้ง 4 scenario.
         ไฟล์ probe + baseline copy ถูกลบก่อน commit (`git status` ยืนยันเหลือ
         ไฟล์เดียว)
       - viewports: n/a — logic-only, ไม่มี UI
       - deviations: (1) `executeTask` คืน `{finalState, iterations,
         reachedReviewing}` แล้วให้ผู้เรียกคำนวณ `calibration` — design ไม่ได้ระบุ
         return shape; ทำแบบนี้เพราะ early-return ของ deferred-quarantine กับเส้น
         ปกติเคยคำนวณ `computeCalibration` คนละจุดด้วยค่าที่เท่ากันอยู่แล้ว
         (`heldOut:[false]` = `reachedReviewing:false`) รวมเป็นจุดเดียวได้โดยผลไม่
         เปลี่ยน. (2) `wrapRouterForOutcome`/`wrapRouterForShadow` รับ
         `taskId` ผ่าน **getter property** (`get taskId() { return activeTaskId(); }`)
         แทนการแก้ signature ของ wrapper — ทั้งสองตัวอ่าน `deps.taskId` ตอนเรียกจริง
         (aal/src/router.ts:196,201 · loop-run.ts wrapRouterForShadow) จึงได้ค่า
         dynamic โดยไม่แตะ aal และไม่แตะ signature ที่ test เดิม pin ไว้.
         (3) deferred-quarantine early-return ย้ายเข้า `executeTask` ตามตาราง design
         D4 ชั้น 1 ซึ่งทำให้มันเกิด**หลัง** adapter/router/human-plane server ถูกสร้าง
         (เดิมเกิดก่อน) — event log ไม่เปลี่ยน (ไม่มี event ใดถูก append ระหว่างนั้น)
         และ test REQ-9.5 เขียวตามเดิม แต่ผลข้างเคียงคือ `opts.adapterFactory` ถูก
         เรียกและ server ถูกเปิด/ปิด แม้ task โดน quarantine. (4) `activeTask` ถูก set
         ที่หัว `executeTask` (ไม่ใช่เฉพาะที่ driver ตาม pseudocode ชั้น 2) เพื่อไม่ให้
         task 4 ลืม set แล้วได้ payload ผิดเงียบ ๆ — driver จะ set ซ้ำก็ไม่มีผล.
         (5) `runPlannerFusion` ยังส่ง `taskId: TASK_ID` ('T-1') ตามเดิม — เป็น per-run
         block ที่รันก่อนมี task ใด ๆ ถูกเลือก, `activeTaskId()` ตอนนั้นก็คืน 'T-1'
         เท่ากัน จึงไม่ใช่สิ่งที่ชั้น 1 แก้ได้; **task 4 ต้องตัดสินใจ** ว่า fusion event
         ควรติดป้าย taskId อะไรใน multi-task mode (ดู handoff task-3 ข้อ Landmines)

- [x] 4. Multi-task driver + CLI + planner fusion piece — design D4 ชั้น 2
     ทั้งหมด: `opts.taskGraph {rawBytes, parsed}` + single freeze หลังเปิด
     log (FROZEN/REJECTED + frozenSeq scope), driver loop (kill poll →
     select → claim(TTL = wallclock+5m default, override option) → branch
     hygiene 4 ขั้น → executeTask(fresh budget, mappedAcs = satisfies,
     excerpt ต่อ task, maxDiffBudget effective) → release(taskId, ownerId);
     lease-fail → unselectable + NOT_STARTED), approval targeting
     `{ok:false, detail:'unknown_task'}`, result additive `tasks[]` +
     precedence + iterations Σ + calibration rule; `loadTaskGraphOption`
     ใน `loop-cli.ts` + wiring/summary ใน `bin/platform.ts`; planner fusion
     graph piece (`ContextPiece {kind:'contract', reason:'task_graph'}`,
     single-task bundle ว่างเดิม) + comment sweep 3 จุด (fusion.ts,
     plan.schema.json `$comment`, contract.ts:20-25) โดย PLAN_SCHEMA parity
     ยังเขียว. เขียน test ใหม่ใน `loop-run-graph.test.ts` เฉพาะส่วน driver
     พื้นฐาน (mode selection, single-task regression shape) — wiring tests
     เชิงลึกอยู่ task 5. Done = test ใหม่ + suite เดิมเขียวทั้ง workspace.
     Satisfies: REQ-4.2, REQ-4.4-4.15, REQ-5 (all). Depends on: 3. Verify: pnpm -C console/backend test && pnpm -C core test && pnpm typecheck && pnpm lint.
     Evidence:
       - test: `pnpm -C console/backend test` -> 363 passed / 0 failed (baseline ก่อนแก้
         บน HEAD bbd4e19 = 360/360; +3 = ไฟล์ใหม่ `src/loop-run-graph.test.ts`); ยิงไฟล์
         เดี่ยว `node --test --test-reporter spec 'src/loop-run-graph.test.ts'` (ใน
         console/backend) -> 3 passed / 0 failed = single-task regression (ไม่มี field
         `tasks`, key order เดิม 6 ตัว, ไม่มี TASK_GRAPH_FROZEN), happy 2-task run
         (T-2 dep T-1: ทั้งคู่ถึง REVIEWING, tasks[] เรียงตาม graph, iterations = Σ,
         calibration.n = 2, FROZEN ครั้งเดียว + LEASE_CLAIMED/RELEASED ครบสองตัว,
         ลำดับจาก event seq ยืนยันว่า T-2 เริ่มหลัง T-1 ถึง REVIEWING), gate reject
         (uncovered AC -> TASK_GRAPH_REJECTED + BLOCKED + ทุก task NOT_STARTED +
         **adapterFactory ไม่เคยถูกเรียก** + ไม่มี TASK_STATE ใดเลย)
       - test: `pnpm -C core test` -> 282 passed / 0 failed (core แตะแค่ comment ของ
         `maxTotalTasks`)
       - test: `pnpm -C aal test` -> 143 passed / 0 failed (aal แตะแค่ type ของ
         `FusionDeps.taskId` -> `string | null`)
       - typecheck: `pnpm typecheck` -> clean ทั้ง 6 workspace projects
       - lint: `pnpm lint` -> ESLint: No issues found
       - vendor: `bash scripts/check-core-vendor-free.sh` -> OK (INV-7)
       - zero test-file edit (REQ-4.3 ต่อเนื่องจาก task 3): `git status --porcelain` ->
         M เฉพาะ `.ai/schemas/plan.schema.json`, `aal/src/fusion/run.ts`,
         `console/backend/bin/platform.ts`, `console/backend/src/fusion.ts`,
         `console/backend/src/loop-cli.ts`, `console/backend/src/loop-run.ts`,
         `core/src/contract/contract.ts` + `??` ไฟล์ test ใหม่;
         `git diff --name-only | grep -c test` -> `0`
       - viewports: n/a — logic-only, ไม่มี UI
       - deviations: (1) **planner fusion taskId = `null` ใน multi-task mode**
         (landmine 1 ของ handoff task-3): block นี้เป็น per-run รันก่อนเลือก task ใด ๆ
         และ `'T-1'` เป็น id ของ task จริงในกราฟ — ถ้าคงไว้ event ของ planning จะถูก
         ติดป้ายเป็นของ task ที่ยังไม่เริ่ม (หรืออาจไม่ได้รันเลย). ขยาย type สองจุด:
         `PlannerFusionOptions.taskId` และ `FusionDeps.taskId` (`aal/src/fusion/run.ts`)
         เป็น `string | null` (ใช้เฉพาะใน `log.append` ซึ่งรับ null อยู่แล้ว — precedent
         `KILL_REQUESTED` ที่ `core/src/human/api.ts:162`); ผลข้างเคียงสองจุดใน
         `console/backend/src/fusion.ts`: plan id fallback เป็น `plan-run` และ
         FUSION_PANEL lookup ตัด filter `taskId` ทิ้งเมื่อเป็น null (multi-task มี panel
         เดียวต่อ run อยู่แล้ว). single-task ยังส่ง `'T-1'` เหมือนเดิมทุก byte.
         (2) **branch hygiene แยกสองที่**: driver ทำ 3 ขั้นแรก (`checkout main` ->
         `reset --hard main` -> `clean -fd`) ก่อนเรียก executeTask ส่วนขั้นที่ 4
         (`checkout -b task/<id>`) ยังอยู่ใน executeTask ที่ task 3 วางไว้ — ครบ 4 ขั้น
         ต่อ task ตาม D1 โดย single-task ไม่ได้ git op เพิ่มแม้แต่คำสั่งเดียว.
         (3) `executeTask(taskId, graphTask?)` — เพิ่ม parameter ที่สองแบบ optional แทน
         การเปลี่ยน signature เป็น task object เพื่อให้ call site ของ single-task เหมือน
         เดิม; `graphTask` เป็นตัวคุมทั้ง `taskAcs` (REQ-4.13) และ `maxDiffBudget`
         (REQ-4.5). (4) เซต `closed` (unselectable) fold **ทั้ง lease-fail และ task ที่
         execute จบแล้ว** — design ระบุแค่ lease-fail; ถ้า task ใดจบโดยไม่มี TASK_STATE
         เลย projection จะเลือกมันซ้ำไม่รู้จบ นี่คือกันลูปค้าง. (5) event
         `TASK_GRAPH_FROZEN`/`TASK_GRAPH_REJECTED` append ด้วย `taskId: null` (run-scoped
         — design ไม่ได้ระบุ; เหตุผลเดียวกับ (1)). (6) label ของ dependent ที่ dep
         claim lease ไม่ได้ = `NOT_STARTED` ไม่ใช่ `SKIPPED` (REQ-4.11: SKIPPED = "dep
         ended outside the dep-satisfied set" — dep ที่ไม่เคยรันไม่ได้ "end" อะไรเลย);
         SKIPPED แพร่จาก task ที่ execute จริงแล้วจบนอกเซต + แพร่ต่อแบบ transitive
         (fixpoint loop เพราะ graph file order ไม่การันตี topological). (7) guard
         `unknown_task` ใน `onDecision` เปิดเฉพาะ multi-task mode — single-task มี task
         เดียว การเพิ่ม check ที่นั่นจะเปลี่ยน `detail` ของ refusal เดิมโดยไม่ได้อะไร.
         (8) ไม่แตะ `pendingApprovalResolve` (landmine 3): sequential + guard ข้อ (7)
         ทำให้ decision ที่ resolve wait ได้ต้องมี package pending อยู่จริง และเส้นที่
         package ของ task ก่อนหน้าค้างใน Map ได้ (ไม่มี `approval.timeoutMs`) เป็นเส้นที่
         `pendingApprovalResolve` เป็น null อยู่แล้ว.

- [x] 5. Fault-injection + calibration fixtures + wiring tests — design D6:
     `core/test/task-graph.fault-injection.test.ts` (TG#1a/2a pure gate);
     `console/backend/src/loop-run-graph.fault-injection.test.ts`
     (TG#1b/2b REJECTED+no-dispatch บนเส้น production, TG#3 dep ordering
     จาก event seq, TG#4 fake-green ต่อ task + SKIPPED, branch isolation
     D1); `makeFixture` ขยาย additive (per-task target files);
     `.ai/calibration/fixture-goal-graph.yaml` + `fixture-task-graph.json`;
     `loop-run-graph.test.ts` เพิ่ม: 2-task ถึง REVIEWING (REQ-6.5),
     budget-fresh non-default, lease TTL option, AC-mapping golden
     isolation, approval targeting, kill switch → NOT_STARTED + CANCELLED.
     Done = ชุดใหม่เขียวทั้งหมด + suite เดิมเขียว.
     Satisfies: REQ-6 (all criteria). Depends on: 4. Verify: pnpm -C core test && pnpm -C console/backend test.
     Evidence:
       - test: `pnpm -C core test` -> 284 passed / 0 failed (baseline บน HEAD dfb4224 =
         282; +2 = ไฟล์ใหม่ `core/test/task-graph.fault-injection.test.ts`); ยิงไฟล์เดี่ยว
         `node --test --test-reporter spec 'test/task-graph.fault-injection.test.ts'`
         (ใน core) -> 2 passed / 0 failed = TG#1a (REQ-6.1 uncovered AC: reasons ระบุ
         AC-2 และ**ไม่**ระบุ AC-1 ที่ถูกครอบ) + TG#2a (REQ-6.2 orphan: reasons ระบุ T-2
         และไม่ระบุ T-3 ที่ประกาศ `enabling` เป็น control ในกราฟเดียวกัน); contract
         ฝั่งนี้สร้างด้วย `freezeContract` จริง ไม่ใช่ literal ปลอม
       - test: `pnpm -C console/backend test` -> 375 passed / 0 failed (baseline = 363; +12)
       - test: `node --test --test-reporter spec 'src/loop-run-graph.fault-injection.test.ts'`
         (ใน console/backend) -> 5 passed / 0 failed = TG#1b + TG#2b (REQ-6.1/6.2 สอง
         reject class ผ่าน `runSupervisedLoop` จริง: `TASK_GRAPH_REJECTED` 1 ใบ +
         BLOCKED + iterations 0 + ทุก task NOT_STARTED + **adapterFactory ไม่เคยถูกเรียก**
         + TASK_STATE/ACTION_INTENT/ACTION_APPLIED/PROPOSAL_INTENT/LEASE_CLAIMED = 0 ทั้งหมด),
         TG#3 (REQ-6.3 dep ordering จาก seq ของ log: TASK_STATE แรกของ T-B > seq ที่ T-A
         ถึง PASSED + ไม่มี event ใดของ T-B ก่อนหน้านั้นนอกจาก LEASE_CLAIMED; ยืนยันก่อนว่า
         ทั้งคู่รันจริงเพื่อไม่ให้ ordering proof กลวง), TG#4 (REQ-6.4 chain 3 task,
         T-2 โกหก READY_FOR_VERIFICATION ทุกรอบโดย marker ไม่เคยถูกแก้ -> ESCALATED,
         **ไม่มี PASSED ใน state ของ T-2 เลย**, T-3 = SKIPPED และไม่มี event สักใบ,
         run = ESCALATED ตามเส้นที่ T-2 จบ), branch isolation (D1: สอง task เขียนคนละไฟล์
         ทั้งคู่ถึง REVIEWING -> diff ที่ **เข้า approval package จริง** (อ่านจาก evidence
         store ของ run) ของ task 2 ไม่มีไฟล์ของ task 1 และของ task 1 ก็ไม่มีของ task 2)
       - test: `node --test --test-reporter spec 'src/loop-run-graph.test.ts'` (ใน
         console/backend) -> 10 passed / 0 failed = 3 เดิมของ task 4 (ไม่แก้แม้บรรทัดเดียว)
         + 7 ใหม่: **REQ-6.5** fixture คู่จริงจาก `.ai/calibration/` โหลดผ่าน edge จริง
         (`loadGoalContract` + `validateTaskGraphShape` -> [] ) -> ทั้งสอง task ถึง
         REVIEWING, calibration.n = 2, FROZEN ครั้งเดียวและ `graphHash` = sha256 ของ
         bytes ไฟล์ที่ ship จริง; REQ-4.12 budget fresh (`maxIterations` = 1 non-default
         -> แต่ละ task ได้ 1 รอบของตัวเอง, run ใช้ 2 รอบ **มากกว่า cap ต่อ task**);
         REQ-4.6 `leaseTtlMs` = 111_111 (non-default; default ของ contract นี้ = 360_000)
         ปรากฏใน `leaseUntil` ของทั้งสอง claim; REQ-4.6 lease-fail (pre-claim T-2 ด้วย
         ownerId `OTHER-RUN` -> T-2 = NOT_STARTED **ไม่ใช่ SKIPPED**, run BLOCKED,
         LEASE_CLAIMED ของ T-2 มีใบเดียวคือของ OTHER-RUN); REQ-4.13 golden isolation
         (AC-1 golden / AC-2 ไม่ golden, risk L1 -> T-1 auto-merge COMPLETED, T-2
         REVIEWING + เป็น task เดียวที่มี APPROVAL_PACKAGE_CREATED — assert เดียวจับการรั่ว
         **ได้ทั้งสองทาง**); REQ-4.14 approval targeting ผ่าน HTTP จริงของ Human Plane
         (ดู deviation 3); REQ-4.15 kill ระหว่าง task (adapter ยิง POST /kill กลางรอบของ
         T-1 -> T-1 จบ REVIEWING ตามปกติ, T-2 = NOT_STARTED และ**ไม่มี event ใดเลย**,
         run = CANCELLED)
       - test: `pnpm -C aal test` -> 143 passed / 0 failed (ไม่ได้แตะ aal)
       - typecheck: `pnpm typecheck` -> clean ทั้ง 6 workspace projects
       - lint: `pnpm lint` -> ESLint: No issues found
       - vendor: `bash scripts/check-core-vendor-free.sh` -> OK (INV-7)
       - zero production-code edit: `git status --porcelain` -> ` M` เฉพาะ
         `console/backend/src/loop-run-graph.test.ts` (ไฟล์ของ task 4 เอง — ขยายด้วย
         test ใหม่, บรรทัดที่ถูกลบมีแค่ 3 บรรทัด import ที่กว้างขึ้น ตรวจด้วย
         `git diff -U0 | grep -E '^-[^-]'`) + `??` ไฟล์ใหม่ 4 ไฟล์ (fault-injection
         สองไฟล์ + calibration fixture คู่); ไม่มีไฟล์ production หรือ test เดิมถูกแก้
       - viewports: n/a — logic-only, ไม่มี UI
       - deviations: (1) **ไม่ได้ขยาย `makeFixture`** (`core/test/helpers/fixture.ts`)
         ตามที่ design D6 เขียนไว้ — composition ไม่ได้ใช้ helper ตัวนั้นเลย:
         `runSupervisedLoop` สร้าง fixture ของตัวเองด้วย `makeFixtureRepo()` ใน
         `loop-run.ts` ซึ่งไม่รับ option และ core/test กับ console/backend import ข้ามกัน
         ไม่ได้ (D8) -> option ที่เพิ่มจะไม่มี test ใดเรียกใช้ (dead helper ที่จะเน่า).
         per-task target file ทำผ่านทางที่ inject ได้จริงแทน = adapter (`writesFiles`)
         เขียน `src/only-task-one.txt`/`src/only-task-two.txt` เพิ่มจาก `src/impl.txt`
         ที่ gate grep — พิสูจน์ branch isolation ได้แรงกว่าเดิมด้วย เพราะสิ่งที่ assert
         คือ bytes ที่เข้า approval package จริงใน evidence store ไม่ใช่ diff ที่ test
         คำนวณเอง. (2) `writesFiles` ต้อง **READ_FILE ไฟล์เป้าหมายในรอบแรกก่อน** แล้วค่อย
         WRITE ในรอบถัดไป: AAL source ปฏิเสธ WRITE ไป path ที่ไม่อยู่ใน context bundle และ
         ไม่เคยถูก READ_FILE-request (`context_violation`, `aal/src/source.ts:357-368`);
         ไฟล์ใหม่ยังไม่มีจริง read จึงถูกปฏิเสธว่า `file not found` ซึ่งไม่เป็นไร — สิ่งที่
         write ต้องการคือ provenance record ไม่ใช่ bytes (พบตอน implement: เวอร์ชันแรกที่
         write ตรง ๆ ทำให้ task จบ ESCALATED ด้วย `budget:iterations`). (3) **approval
         targeting: `{ok:false, detail:'unknown_task'}` เอื้อมไม่ถึงจาก HTTP surface ที่
         ประกอบอยู่วันนี้** — `core/src/human/api.ts:110` หา `pkg` จาก `deps.approvals`
         ก่อนแล้วค่อยเรียก `onDecision(pkg.taskId, ...)`; guard ที่ `loop-run.ts:601`
         สแกน `approvals.values()` หา taskId เดียวกันนั้น จึงเป็นจริงเสมอเมื่อ `pkg` มี
         และเมื่อไม่มี HTTP ตอบ 404 `no_such_approval` ตั้งแต่ก่อนถึง `onDecision`.
         **ไม่แก้ production code** (guard เป็นการกันของ port ไม่ใช่ defect ที่มีอาการ และ
         REQ-4.14 สะกด shape นี้ไว้เอง) — test พิสูจน์คุณสมบัติที่ REQ-4.14 ต้องการจริงและ
         เอื้อมถึงได้แทน: decision ที่ระบุ task ซึ่งไม่มี package pending ถูกปฏิเสธ (404)
         **โดยไม่แตะ package ของ task ที่กำลัง active** และ decision แต่ละใบลงที่ task ที่มัน
         ระบุ (APPROVAL_RECORDED + TASK_STATE:APPROVED ต่อ taskId, ทั้งคู่จบ COMPLETED)
         -> task 6 ควรบันทึกเป็น ceiling/ข้อสังเกตใน §17. (4) TG#4 ใช้ FakeAdapter behavior
         `exhaust_hypotheses` เป็นตัวโกหก (claim READY_FOR_VERIFICATION + เขียน marker ผิด
         + hypotheses ที่ไม่มีวัน confirm) ทำให้ T-2 จบ `ESCALATED`; design D6 ไม่ได้ระบุ
         end state ของ TG#4 ไว้ ระบุแค่ "ไม่มีวัน PASSED + dependent ไม่ถูกเลือก" ซึ่ง
         assert ครบทั้งสองข้อ. (5) `.ai/calibration/fixture-goal-graph.yaml` pin
         `risk: L2` ไว้ชัดเจน (ต่างจาก `fixture-goal.yaml` ที่ปล่อยว่างแล้วพึ่ง default)
         — REQ-6.5 วัดที่ REVIEWING จึงไม่ควรให้ผลลัพธ์ขึ้นกับ default ที่อาจเปลี่ยน

- [x] 6. Constitution v1.7 + assembly trace — `unified-platform-spec.md`:
     banner v1.7, §14 Stage-4 ส่งมอบแล้ว + ceilings, §17 changelog v1.7
     (shape + supersessions 6 รายการ + ceilings 4 รายการ), §17 "จุดเริ่ม" →
     Stage 5; cross-check ทุก REQ ต่อ satisfying code/test (assembly task —
     uncovered REQ = blocker); รัน spec-trace + drift + guard suites ให้
     เขียวครบ. Done = `scripts/spec-trace.sh platform-phase5-stage4` OK ครบ
     ทุก criterion + full gate เขียว.
     Satisfies: REQ-7 (all criteria). Depends on: 5. Verify: scripts/spec-trace.sh platform-phase5-stage4 && pnpm typecheck && pnpm test && pnpm lint.
     Evidence:
       - amend: `unified-platform-spec.md` แตะ **4 region เท่านั้น** ตาม hard constraint —
         `git diff -U0 unified-platform-spec.md | grep '^@@'` -> `@@ -3 +3 @@` (banner v1.7),
         `@@ -575 +575 @@` (§14 Stage-4 ส่งมอบแล้ว + pointer + delivered shape + 4 ceilings),
         `@@ -609 +609 @@` (§17 จุดเริ่ม -> v1.7, stage 1-4 ส่งมอบ, ถัดไป = Stage 5),
         `@@ -611,0 +612 @@` (§17 changelog v1.7 แทรกเป็นรายการแรก); `git diff --stat` ->
         `1 file changed, 4 insertions(+), 3 deletions(-)` — ศูนย์ reflow ส่วนอื่น, ไม่มี emoji
       - trace: `bash scripts/spec-trace.sh platform-phase5-stage4` -> `OK: 'platform-phase5-stage4'
         เกณฑ์ 55 ข้อ ถูกอ้างครบใน design.md และ tasks.md, EARS lint ผ่านทุกข้อ`
       - test: `pnpm test` (workspace) -> console/web 74, core 284, aal 143, adapters 39,
         console/backend 375 — **pass 915 / fail 0** ทุก project (ตรงกับตัวเลขที่ task 5
         ส่งมอบเป๊ะ: core 284, console/backend 375, aal 143)
       - typecheck: `pnpm typecheck` -> clean ทั้ง 6 workspace projects
       - lint: `pnpm lint` -> `eslint .` ไม่มี output (0 issue), exit 0
       - vendor: `bash scripts/check-core-vendor-free.sh` -> `OK: core/ and aal/ are
         vendor-name-free (INV-7)`
       - drift: `bash scripts/spec-goal-drift.sh platform-phase5-stage4` ->
         `not applicable (no promoted goal.yaml)` exit 0 — advisory, ผลที่คาดไว้
         (feature นี้ยังไม่มี goal.yaml ที่ promote)
       - guard: `for f in .claude/hooks/tests/*.test.sh; do bash "$f"; done` -> 14/14 ไฟล์ผ่าน
         (check-evidence 24, ci-scope 9, codex-adapters 7, destructive-guard 156,
         gate-task 42, hook-bypass-guard 122, lesson-tripwires 8, lessons-coverage 5,
         null-byte-secret-scan 2, repo-policy-alignment 17, secrets-guard 33,
         spec-edit-guard 13, spec-metrics 9, spec-slice 26 — fail=0 ทุกไฟล์)
       - **REQ-trace cross-check (assembly duty, TASK_PROTOCOL DoD):** เดินครบ REQ-1..REQ-7
         ทุก criterion เทียบไฟล์จริง ไม่ใช่แค่ Evidence ของ task ก่อนหน้า —
         REQ-1.1-1.5 = `console/backend/src/task-graph-schema.test.ts` (9 tests, parity
         deep-equal กับ `.ai/schemas/task-graph.schema.json` = 1.2) · REQ-2.1-2.9 =
         `spec-to-goal.e2e.test.ts` 7 บล็อกใหม่ (ทุก criterion ปรากฏในชื่อ test อย่างน้อย
         หนึ่งตัว) + `scripts/spec_to_goal.py` · REQ-3.1-3.14 = `core/src/graph/graph.test.ts`
         (19 tests, หนึ่ง criterion ต่ออย่างน้อยหนึ่ง test + collect-all-reasons) ·
         REQ-4.1 = `core/src/graph/select.test.ts` (10) · 4.2/4.9/4.11 =
         `loop-run-graph.test.ts:87` + `:60` · 4.3 = `:60` + zero-test-file-edit proof ของ
         task 3 · 4.4 = `select.test.ts` (dep นอกเซต -> dependent ineligible ถาวร; no
         eligible -> null) + TG#4 (dependents SKIPPED) · 4.6 = `:284`/`:314` · 4.8 = `:149`
         + TG#1b/2b · 4.12 = `:254` · 4.13 = `:360` · 4.14 = `:461` · 4.15 = `:547` ·
         REQ-5.2 = กิ่ง else ของ `fusion.ts:216-218` เป็น literal เดิมทุก byte + test เดิม
         (`fusion.test.ts:194`, `loop-run.test.ts:337/411/1272` ที่เปิด `planning` โดยไม่มีกราฟ)
         เขียวโดยไม่ถูกแก้ · REQ-5.3 = `fusion.test.ts:228`/`:252` (pre-existing) ·
         REQ-5.4 = สาม text อัปเดตครบจริง (`core/src/contract/contract.ts:20-25` pointer,
         `.ai/schemas/plan.schema.json:4` `$comment`, `console/backend/src/fusion.ts` doc
         comment + bundle comment) + PLAN_SCHEMA parity `fusion.test.ts:283` เขียว ·
         REQ-6.1-6.5 = split ตาม D8 (`core/test/task-graph.fault-injection.test.ts` 2 +
         `loop-run-graph.fault-injection.test.ts` 5 + `loop-run-graph.test.ts:208`) ·
         REQ-7.1-7.3 = task นี้. **ไม่มี criterion ใดที่ไม่มีโค้ดรองรับ — ศูนย์ blocker.**
       - **ช่องว่างที่พบและบันทึกไว้ (ไม่ใช่ missing behavior — โค้ดครบทุกตัว แต่ไม่มี test
         เจาะจง):** REQ-4.5 (effective `diff_budget` -> `maxDiffBudget`,
         `loop-run.ts:904`) — fixture ทุกตัวใช้ค่า default 400 จึงแยกไม่ออกว่าค่ามาจาก
         กราฟหรือ fallback `?? 400` (ขาด non-default discrimination ตาม lesson
         #wiring-test-nondefault-value) · REQ-4.7 (draft ถูกมองข้าม, `loop-cli.ts:41-51`)
         — จริงโดย construction เพราะอ่านเฉพาะชื่อ `task-graph.json` · REQ-4.10 (CLI
         edge-validate + option + per-task summary, `loop-cli.ts:41` +
         `bin/platform.ts:377,455,481`) · REQ-5.1 (fusion graph piece,
         `fusion.ts:216-223` + `loop-run.ts:560`) — ไม่มี test ตัวใดส่ง `taskGraphJson`
         และไม่มี multi-task test ตัวใดเปิด `planning`. ทั้งสี่ข้อ **บันทึกตรง ๆ ใน §17
         v1.7** ใต้หัวข้อ ceiling/ความซื่อสัตย์ ตาม §16 claim discipline แทนการอ้างเกินจริง;
         ceiling ข้อ 4 จึงเขียนว่า graph piece "ยังไม่มี test ตัวใด exercise" ไม่ใช่
         "test-reachable" ตามที่ REQ-7.3 ร่างไว้ (A21 พูดถึง `runPlannerFusion` ทั้งตัว
         ซึ่ง test-reachable จริง — แต่ piece ที่ stage นี้เพิ่มไม่ใช่)
       - supersession cross-check: ทั้ง 6 รายการใน Overview ของ requirements.md สะท้อนอยู่
         จริงที่ที่มันอ้าง — Stage-2 REQ-4.3/4.4 (`contract.ts:20-25` เปลี่ยนเป็น pointer),
         Phase-2 REQ-7.2 (`taskAcs` narrowing + test REQ-4.13), Phase-4 REQ-16.2
         (`fusion.ts` bundle branch), Phase-4 REQ-16.5 (`plan.schema.json` `$comment` +
         `fusion.ts` doc), Stage-1 REQ-4.2 (per-file gate ใน `spec_to_goal.py` + e2e:641),
         Stage-1 REQ-4.1/4.6 (e2e:495 assertion ที่ถูกขยาย) — และครบทั้ง 6 ใน §17 v1.7
       - viewports: n/a — docs-only task, ไม่มี UI
       - deviations: (1) **ศูนย์ production-code edit และศูนย์ test-file edit** ตาม hard
         constraint — `git status --porcelain` แสดงเฉพาะ `unified-platform-spec.md` กับ
         `.ai/specs/platform-phase5-stage4/tasks.md`; ช่องว่าง 4 ข้อข้างบนจึงถูก *รายงาน*
         ไม่ใช่ hotfix เงียบ ๆ. (2) §17 v1.7 บันทึกความซื่อสัตย์ **เกิน** 4 ceiling ที่
         REQ-7.3 ระบุ: เพิ่มข้อสังเกต `{ok:false, detail:'unknown_task'}` ของ task 5
         (defensive depth ของ port — เอื้อมไม่ถึงจาก HTTP surface ที่ประกอบวันนี้) และ
         ช่องว่าง test ของ REQ-4.5/4.7/4.10 — เป็นการเพิ่มความแม่นของ claim ไม่ใช่ scope
         ใหม่ (§16 ห้ามอ้างเกินจริง). (3) §14 ย่อ ceiling ทั้ง 4 เป็นบรรทัดเดียวแล้วชี้ไป
         §17 v1.7 ที่ให้เหตุผลเต็ม — กันไม่ให้ §14 (roadmap) บวมจนอ่านไม่ออก

## Suggested execution batches

> Feature นี้ COUPLED (schema → generator/core → composition → tests แชร์ shape
> เดียวกันทั้งสาย) — ลำดับบังคับ: 1 → 2 → 3 → 4 → 5 → 6 (2 กับ 3 ขนานกันได้
> เชิงข้อมูล แต่ run นี้รัน sequential 1 teammate/task ตาม operator directive:
> fresh context ต่อ task + อ่าน spec + handoff ของ task ก่อนหน้าใน
> `.ai/specs/platform-phase5-stage4/handoffs/`).
