# Implementation Tasks: platform-phase5-stage1 — Spec-to-Goal Generator
> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. `iter_task_blocks` shared helper — เพิ่ม helper ใน `scripts/spec_trace.py`
     (yield task block: checkbox line + continuation lines, join เป็นข้อความเดียว)
     แล้ว refactor `satisfies_text()` ให้ build บน helper โดยผลลัพธ์เดิมต้อง
     byte-identical; done = spec-trace ยังเขียวทั้ง active spec และ archive.
     Satisfies: REQ-2.3. Verify: scripts/spec-trace.sh platform-phase4 .ai/specs/archive
     && scripts/spec-trace.sh platform-phase5-stage1.
     Evidence:
       - test: old-vs-new `satisfies_text` diff harness over all 16 tasks.md under
         `.ai/specs/` (9 active + 7 archive) -> byte-identical ทุกไฟล์;
         `scripts/spec-trace.sh` ทุก active feature (9) + archive (5 REQ-form OK,
         2 bugfix skip) -> exit 0 ทั้งหมด รวม `platform-phase4 .ai/specs/archive`
         และ `platform-phase5-stage1`
       - viewports: n/a — logic-only
       - deviations: none
- [x] 2. Generator end-to-end — `scripts/spec_to_goal.py` (gate chain REQ-1 ครบ,
     mapper criterion→AC + unique-cover Verify resolution, YAML emitter ตาม
     template ใน design: provenance/HUMAN banner/risk placeholder/empty-active +
     pending เมื่อ unresolved, atomic write) + wrapper `scripts/spec-to-goal.sh` +
     e2e test `console/backend/src/spec-to-goal.e2e.test.ts` ครบทุก case ในตาราง
     Testing Strategy (รวม freezeContract reject/pass + archive phase4 จริง);
     done = test file เขียวทั้งชุด.
     Satisfies: REQ-1 (all criteria), REQ-2 (all criteria), REQ-3 (all criteria),
     REQ-4 (all criteria), REQ-5 (all criteria). Depends on: 1.
     Verify: pnpm -C console/backend test spec-to-goal.
     Evidence:
       - test: `node --test src/spec-to-goal.e2e.test.ts` -> 12 passed / 0 failed
         (ทุก row ของตาราง Testing Strategy รวม freezeContract pass/reject จริง +
         archive phase4 จริง 126 AC + wrapper case); `pnpm -C console/backend test`
         -> 299 passed / 0 failed; `pnpm -C console/backend typecheck` -> clean;
         `scripts/spec-trace.sh platform-phase5-stage1` -> OK 30/30 เกณฑ์
       - viewports: n/a — logic-only
       - deviations: (1) archive-phase4 e2e case copy spec จริงไป temp --specs-dir
         แทนการเขียน goal.draft.yaml ลง tree ของ repo (กัน mutation ใน archive ที่
         commit แล้ว — bytes เดียวกันทุกอย่าง); (2) budget scaffold emit บรรทัดเดียว
         (template ใน design ตัดสองบรรทัด — ค่า parse ได้ตรงกัน 6 key, assert ใน test)

## Suggested execution batches

> Coupled feature ขนาดเล็ก (2 task, task 2 build บน helper ของ task 1) — รัน ALL
> ทาสก์ใน session เดียว: `/spec-implement all` หรือ
> `scripts/pane-loop.sh platform-phase5-stage1 all-in-one`. ไม่มี Batch: tag —
> ไม่มีกลุ่ม task เล็ก same-type ให้จัด.
