# Tasks — SDD framework distribution

> Status: completed 2026-09-10
> Approval: not recorded

รายการนี้ผูก implementation กับ requirements และ verification ที่รันได้ใน repository

## สถานะงาน

สถานะ `completed` หมายถึง tasks artifact และ implementation ทั้ง 6 ข้อเสร็จแล้ว โดยยังไม่มีการบันทึก explicit user phase approval

## รายการงาน

- [x] 1. Canonical artifacts
  - Satisfies: REQ-1, REQ-2, REQ-3, REQ-4, REQ-5, REQ-6, REQ-7, REQ-8, REQ-9, REQ-10, REQ-11, REQ-12, REQ-13, REQ-14
  - Verify: canonical requirements, design, tasks และ handoff มีครบ, traceability ครบ และ metadata แยก phase approval จาก implementation status ชัดเจน

  - Evidence:
    - test: `scripts/spec-trace.sh sdd-framework-distribution` -> ผ่าน 16 criteria และ EARS lint
    - test: `rg -n '^> (Status: completed 2026-09-10|Approval: not recorded)$' .ai/specs/sdd-framework-distribution/{requirements,design,tasks}.md` -> พบ completed status และ approval field แยกกันครบทั้ง 3 ไฟล์
    - viewports: n/a — CLI และเอกสาร ไม่มีหน้าจอ
    - deviations: ไม่มี

- [x] 2. Explicit manifest
  - Satisfies: REQ-2, REQ-9, REQ-10, REQ-12, REQ-14
  - Verify: `node scripts/sdd-framework.mjs validate --source . --ref 40c4f2a1b65a512b2d80362aca5142b66cbb4251`

  - Evidence:
    - test: `node scripts/sdd-framework.mjs validate --source . --ref 40c4f2a1b65a512b2d80362aca5142b66cbb4251` -> exit 0, manifest valid และ identity ตรง committed snapshot
    - test: `node --test scripts/sdd-framework.test.mjs` -> ผ่าน 8/8 tests รวม manifest schema, path, mode, Git object และ reference validation
    - viewports: n/a — CLI ไม่มีหน้าจอ
    - deviations: ไม่มี

- [x] 3. Snapshot และ offline inspection
  - Satisfies: REQ-1, REQ-2, REQ-7, REQ-8, REQ-9, REQ-11, REQ-14
  - Verify: `node --test scripts/sdd-framework.test.mjs`

  - Evidence:
    - test: `node --test scripts/sdd-framework.test.mjs` -> ผ่าน 8/8 tests รวม snapshot identity, offline `status` และ source-backed `check`
    - viewports: n/a — CLI ไม่มีหน้าจอ
    - deviations: ไม่มี

- [x] 4. Install และ adopt
  - Satisfies: REQ-3, REQ-4, REQ-10, REQ-13
  - Verify: `node --test scripts/sdd-framework.test.mjs`

  - Evidence:
    - test: `node --test scripts/sdd-framework.test.mjs` -> ผ่าน 8/8 tests รวม two-consumer install, idempotent no-op และ exact-copy adopt
    - viewports: n/a — CLI ไม่มีหน้าจอ
    - deviations: ไม่มี

- [x] 5. Update transaction และ rollback
  - Satisfies: REQ-5, REQ-6, REQ-10, REQ-13
  - Verify: `node --test scripts/sdd-framework.test.mjs`

  - Evidence:
    - test: `node --test scripts/sdd-framework.test.mjs` -> ผ่าน 8/8 tests รวม update, local drift, collision, caught write failure และ rollback
    - viewports: n/a — CLI ไม่มีหน้าจอ
    - deviations: ไม่มี

- [x] 6. Consumer runtime และ CI wrapper
  - Satisfies: REQ-7, REQ-8, REQ-10
  - Verify: `bash .claude/hooks/tests/sdd-framework-distribution.test.sh`

  - Evidence:
    - test: `bash .claude/hooks/tests/sdd-framework-distribution.test.sh` -> หลักฐานที่เก็บไว้จาก implementation ผ่าน 8/8 tests รวมสอง consumer และ installed `spec-trace` กับ `gate-task` แบบ offline
    - viewports: n/a — CLI ไม่มีหน้าจอ
    - deviations: ไม่มี
