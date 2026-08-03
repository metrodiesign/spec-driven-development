# Handoff: Task 71 — สถานะ P0-10 (ทุก gate เขียว เหลือ operator fixture)

> จาก: Claude session 2026-08-03  ถึง: operator / agent Phase 0 คนถัดไป  วันที่: 2026-08-03

> บันทึกนี้เป็นสถานะ ณ ก่อนที่ operator จะส่ง golden fixture bytes
> การปิด Task 10 จริงอยู่ที่ `task-73-p0-10-close.md`

## สรุปงาน

รัน full DoD 1–9 matrix, regression suites, enforcement floor และ REQ-10.10
authority-reference hygiene หลัง blocker ทั้งสามของ Task 67 ถูกปลด
ตอนบันทึกนี้ Task 10 ยังคง `[ ]` เพราะ operator golden fixture ยังไม่มี

## สถานะ ณ ตอนนั้น

`BLOCKED — Task 10 ยังเป็น [ ]` แต่เหตุผลเหลือข้อเดียว

Task checkbox: 1–7 และ 9 = `[x]`; 8 และ 10 = `[ ]`

## สิ่งที่เปลี่ยนไปจาก Task 67

Task 67 บันทึก unresolved gate ไว้ 4 กลุ่ม ตอนนั้นเหลือกลุ่มเดียว

| blocker ของ Task 67 | สถานะ |
|---|---|
| P0-02 real-macOS cooldown | ปลดแล้ว รันจริง เจอ regression 4 ข้อ แก้แล้ว (`task-69-p0-02-close.md`) |
| P0-06 wired composition (`1` pass / `11` EPERM) | `12/12` pass (`task-68-p0-06-close.md`) |
| P0-09 full aggregates ไม่ครบ | core `576/576`, console `394/394` (`task-70-p0-09-close.md`) |
| P0-08 operator golden fixture | ตอนนั้นยัง blocked |

## หลักฐานที่บันทึก

- DoD 1–9 matrix: `PHASE0_REAL_MACOS_TESTS=1 pnpm --filter core exec node --test
  --test-reporter spec test/fault-injection.test.ts` -> `28/28` pass `0` skipped
  (Task 67 ได้ `23` pass และ `5` external-only skip)
- regression: core `576/576`, console-backend `394/394`, AAL `148/148`
- live DoD 3: รันนอก nested managed sandbox บน macOS host จริง
- enforcement floor: typecheck (6 projects), lint, vendor check, spec-trace
  `144` criteria และ EARS, `ci-test-scope.sh push develop` -> `decision=full`
- L3/L4 human control: `src/loop-run-graph.test.ts` `12/12` ครอบ approval
  binding (REQ-4.14) และ kill switch ที่จบเป็น `CANCELLED` (REQ-4.15)

## หลักฐาน external macOS sandbox (ตาม REQ-10.11)

`sandbox-exec` ส่ง signal ได้เฉพาะ `SIGKILL`; `send-signal` ที่ระบุ `SIGXFSZ`,
`SIGXCPU`, `SIGPROF`, `SIGSYS`, `SIGABRT` ถูก parse ผ่านแต่ไม่เคยถูกส่งจริง
(syscall ยังถูก deny คืน `EPERM`) จึงแยก operation class จาก wait status ไม่ได้
นี่คือเหตุผลที่ `observedViolation.operation` เป็น `'unknown'` และ scope เป็น
`direct_only`

## การตัดสินใจเรื่อง REQ-10.10

แก้เฉพาะ 2 จุดที่ชี้ authority ผิด (Phase 0 DoD อยู่ที่ loop-engineering spec)

- `.github/workflows/ci.yml` — comment ของ platform job
- `core/test/fault-injection.test.ts` — header ของ suite ชี้ `§11`

คงไว้ 3 จุดเพราะอ้าง section สถาปัตยกรรม platform ที่มีอยู่จริงใน
`unified-platform-spec.md` (ตรวจแล้ว: `§2`, `§6`, `§7.1`) จึงไม่ misleading

- `scripts/check-core-vendor-free.sh` (`§1.2`, `§2`, `§7`)
- `core/src/types.ts` (`§6`)
- `aal/src/protocol.ts` (`§7.1`)

## Blocker เดียวที่เหลือ ณ ตอนนั้น

`scripts/check-golden-manifests.sh` -> exit `2`
`BLOCKED: operator_golden_fixture_missing (no _MANIFEST.sha256 under configured golden roots)`

ต้องได้ golden fixture bytes จาก operator เท่านั้น ห้ามสร้าง ห้าม regenerate
ห้าม copy หรือเปลี่ยนชื่อ test bytes ชั่วคราวมาอ้างเป็น operator truth (REQ-8.6)

## สิ่งที่ต้องทำต่อ (ณ ตอนนั้น)

1. operator วาง golden fixture bytes และ `_MANIFEST.sha256` ใต้ configured golden roots
2. รัน `scripts/check-golden-manifests.sh` และ production CLI ด้วย
   `--operator-golden-fixture <path>` ให้ผ่าน แล้วปิด Task 8
3. รัน DoD matrix, full suites และ enforcement floor อีกครั้ง แล้วจึงพิจารณาปิด Task 10
