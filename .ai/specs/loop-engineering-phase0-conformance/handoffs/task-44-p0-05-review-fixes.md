# Handoff: Task 44 — P0-05 review fixes

> From: Codex P0-05 review-fix worker  To: parent agent / fresh reviewer  Date: 2026-08-02

## Task Summary

ปิดช่องว่าง Medium 3 ข้อจาก Task 43 fresh-context review ของ P0-05
(`loop-engineering-phase0-conformance`, REQ-4.12, REQ-5.4–5.5 และ REQ-5.9–5.10)
ด้วย regression tests แบบ wired และ RED-first intent: same-artifact identity,
T0 evidence authentication และ explicit T3 Phase-0 stub logging

## Current Status

เสร็จเฉพาะ review fixes แล้ว; Task 5 ใน `tasks.md` ยังคง `[ ]` ตาม approval boundary
และยังไม่มี production change เพิ่มเติมจาก Task 42 implementation

## Files Changed

- `core/src/orchestrator/loop.test.ts` — เพิ่ม mismatch regression: T0 ผ่านบน
  `tree-a`, T1 ผ่านบน `tree-b` ต้องเป็น `ESCALATED{why:artifact_identity_mismatch}`
  และห้ามมี `REVIEWING`/`PASSED`
- `core/test/fault-injection.test.ts` — เพิ่ม wired T0 authentication fault โดย
  `verify` throw `ReportIntegrityError(signature_mismatch)`; ยืนยัน fail-closed,
  ไม่มี T1 และไม่มี state advancement
- `core/src/gates/runner.test.ts` — เพิ่ม explicit T3 stub regression ตรวจ
  `pass: not_enabled`, `checks: []`, `GATE_RESULT{tier:T3}` และ
  `gateConfigHash` ที่ตรงกับ SHA-256 ของ ladder bytes
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-44-p0-05-review-fixes.md`
  — handoff นี้

## Important Decisions

- คง production guard ใน `core/src/orchestrator/loop.ts` เดิมไว้ เพราะมีการตรวจ
  `worktreeHash` หลัง authenticated T1 และ T0 `verify` catch ก่อน state advancement
  อยู่แล้ว; ช่องว่างเป็น regression proof ไม่ใช่ missing implementation
- ใช้ real `createGateRunner`/`ReportIntegrityError` ใน T0 fault เพื่อพิสูจน์ trust
  boundary จริง ไม่ใช้ fake report-only seam
- ไม่ flip Task 5, ไม่แก้ requirements/design/policy และไม่ retry external macOS tests

## Constraints

- ห้ามแก้หรือ claim PASS สำหรับ P0-02 real-macOS external suite ที่ยังอยู่ใน recorded
  cooldown; 9 core skips เป็น external-only และสืบทอดจาก baseline
- ห้ามแก้ Task 5 checkbox/Evidence จน parent ได้ independent acceptance review
- ห้าม commit, push หรือ revert shared worktree changes

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/orchestrator/loop.test.ts src/gates/runner.test.ts test/fault-injection.test.ts`
  -> 55 total, 50 pass, 0 fail, 5 explicit external-only skips
- `pnpm --filter core test` -> 535 total, 526 pass, 0 fail, 9 explicit external-only skips
- `pnpm --filter core typecheck` -> exit 0
- `pnpm lint` -> `ESLint: No issues found`
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> exit 0
- `git diff --check` -> exit 0

## Known Issues

- ไม่มี actionable P0-05 gap เหลือจาก findings ทั้งสามตามหลักฐาน test; Task 5 ยังรอ
  fresh-context acceptance และ parent เป็นผู้บันทึก Evidence/checkbox
- External macOS sandbox verification ไม่ได้รันตามข้อจำกัดเดิม

## Next Recommended Agent

fresh-context correctness/security reviewer เพื่อยืนยัน RED/GREEN regressions ทั้งสาม
ก่อน parent ปิด Task 5

## Next Steps

1. อ่าน handoff นี้, Task 42 และ Task 43 แล้วตรวจ `git status` ว่า tests ใหม่อยู่จริง
2. รัน focused P0-05 และตรวจผล wired T0 fault/mismatch/T3 event
3. เมื่อ review อนุมัติ ให้ parent เพิ่ม Task 5 Evidence และ flip `[x]`; อย่าเปลี่ยน
   external blocker หรือ retry macOS suite
