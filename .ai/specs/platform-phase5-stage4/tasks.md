# Implementation Tasks: platform-phase5-stage4 — Task Graph + Planning Gate (§11.2)
> Status: approved 2026-07-26 (quick-mode per operator /goal directive — see
> requirements.md header; operator post-hoc review pending)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Schema + core graph module (pure foundations) — governance
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

- [ ] 2. Generator task-graph emission — `scripts/spec_to_goal.py`:
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

- [ ] 3. loop-run layer-1 parameterization (mechanical, zero behavior change)
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

- [ ] 4. Multi-task driver + CLI + planner fusion piece — design D4 ชั้น 2
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
     (shape + supersessions 5 รายการ + ceilings 4 รายการ), §17 "จุดเริ่ม" →
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
