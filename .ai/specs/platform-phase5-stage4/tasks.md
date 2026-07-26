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

- [ ] 5. Fault-injection + calibration fixtures + wiring tests — design D6:
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

- [ ] 6. Constitution v1.7 + assembly trace — `unified-platform-spec.md`:
     banner v1.7, §14 Stage-4 ส่งมอบแล้ว + ceilings, §17 changelog v1.7
     (shape + supersessions 6 รายการ + ceilings 4 รายการ), §17 "จุดเริ่ม" →
     Stage 5; cross-check ทุก REQ ต่อ satisfying code/test (assembly task —
     uncovered REQ = blocker); รัน spec-trace + drift + guard suites ให้
     เขียวครบ. Done = `scripts/spec-trace.sh platform-phase5-stage4` OK ครบ
     ทุก criterion + full gate เขียว.
     Satisfies: REQ-7 (all criteria). Depends on: 5. Verify: scripts/spec-trace.sh platform-phase5-stage4 && pnpm typecheck && pnpm test && pnpm lint.

## Suggested execution batches

> Feature นี้ COUPLED (schema → generator/core → composition → tests แชร์ shape
> เดียวกันทั้งสาย) — ลำดับบังคับ: 1 → 2 → 3 → 4 → 5 → 6 (2 กับ 3 ขนานกันได้
> เชิงข้อมูล แต่ run นี้รัน sequential 1 teammate/task ตาม operator directive:
> fresh context ต่อ task + อ่าน spec + handoff ของ task ก่อนหน้าใน
> `.ai/specs/platform-phase5-stage4/handoffs/`).
