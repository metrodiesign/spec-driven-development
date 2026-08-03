# Handoff: Task 73 — ปิด P0-10 (Phase 0 conformance ครบทั้ง 10 task)

> จาก: Claude session 2026-08-03  ถึง: operator / agent คนถัดไป  วันที่: 2026-08-03

## สรุปงาน

ปิด Task 10 (P0-10) หลัง blocker ทุกตัวถูกปลดครบ ทำให้ทั้ง spec
`loop-engineering-phase0-conformance` เป็น `[x]` ทั้ง 10 task

## สถานะปัจจุบัน

Task 1–10 = `[x]` ทั้งหมด ไม่มี gate ใดค้างสถานะ blocked

## Blocker ที่ปลดใน session นี้

| blocker เดิม | สถานะ |
|---|---|
| P0-02 real-macOS run (บันทึกว่ารอ cooldown ตั้งแต่ Task 07) | รันจริงแล้ว เจอ regression 4 ข้อ แก้ครบ (`task-69`) |
| P0-06 wired composition (`1` pass / `11` EPERM) | `12/12` pass (`task-68`) |
| P0-09 full aggregates ไม่ครบ | core `576/576`, console `394/394` (`task-70`) |
| P0-08 operator golden fixture | operator ส่ง bytes มาแล้ว verifier เขียว (`task-72`) |

## หลักฐานที่บันทึก

- DoD 1–9 fault matrix: `PHASE0_REAL_MACOS_TESTS=1 pnpm --filter core exec node
  --test --test-reporter spec test/fault-injection.test.ts` -> `28/28` pass
  `0` skipped (เดิม `23` pass + `5` external-only skip)
- regression suites หลังวาง fixture: core `576/576`, console-backend `394/394`,
  AAL `148/148` ทั้งหมด `0` fail `0` skipped
- live DoD 3: รันนอก nested managed sandbox บน macOS host จริง; probe อิสระ
  ยืนยัน DNS, raw-IP TCP, UDP, unix-domain socket ทั้งหมด `rc=137`
- golden gate: `scripts/check-golden-manifests.sh` -> exit `0`
- enforcement floor: typecheck (`6` projects), lint, vendor check,
  spec-trace `144` criteria + EARS, `ci-test-scope.sh push develop` -> `full`
- L3/L4 human control: `src/loop-run-graph.test.ts` `12/12`

## หลักฐาน external macOS sandbox (REQ-10.11)

`sandbox-exec` ส่ง signal ได้เฉพาะ `SIGKILL` — ทดสอบ `send-signal` ด้วย
`SIGXFSZ`, `SIGXCPU`, `SIGPROF`, `SIGSYS`, `SIGABRT` แล้ว parser รับหมดแต่ไม่เคย
ส่งจริงสักตัว (syscall ยังถูก deny คืน `EPERM`) จึงแยก operation class จาก
wait status ไม่ได้ ผลคือ `observedViolation.operation` เป็น `'unknown'` และ
denial-observation scope คงเป็น `direct_only` ไม่ใช่การอ้างเกินจริง

## การตัดสินใจเรื่อง REQ-10.10 authority-reference hygiene

แก้เฉพาะสองจุดที่ชี้ authority ของ Phase 0 DoD ผิด

- `.github/workflows/ci.yml` — comment ของ platform job
- `core/test/fault-injection.test.ts` — header ของ suite ชี้ `§11` ของ
  `loop-engineering-implementation-spec.md`

คงไว้สามจุดเพราะอ้าง section สถาปัตยกรรม platform ที่มีอยู่จริงและตรวจแล้วว่าตรง
(`unified-platform-spec.md` `§2`, `§6`, `§7.1`)

- `scripts/check-core-vendor-free.sh`
- `core/src/types.ts`
- `aal/src/protocol.ts`

## สิ่งที่ยังไม่ได้ทำ (ไม่กระทบเกณฑ์ REQ-10)

ยังไม่ได้รัน `platform loop run --goal <path> --operator-golden-fixture test/golden/`
แบบ end-to-end เพราะ `goal.yaml` ที่ operator ส่งมายังไม่ผ่าน
`.ai/schemas/goal.schema.json` รายละเอียดการแปลงอยู่ใน `task-72-p0-08-close.md`
สองเรื่องที่ต้องให้ operator ตัดสินเอง

1. AC ข้อไหนเป็น golden-backed (`golden: true`) — เป็นตัวเศษของ coverage
   ตาม REQ-8.7/8.8 fixture ที่มีครอบ 4 ข้อแรก ส่วน logout กับ session management
   ยังไม่มี fixture
2. ตัวเลข `budget` — เป็นการตัดสินใจเรื่องงบและเวลา

## สิ่งที่ต้องทำต่อ

1. งานทั้งหมดยัง uncommitted บน branch `codex/loop-engineering-phase0-conformance`
   ต้องให้ operator ตัดสินใจเรื่อง commit และเปิด PR
2. operator แปลง `goal.yaml` แล้วรัน loop end-to-end เพื่อพิสูจน์ระดับ product
3. Phase 0 ปิดแล้วในเชิง conformance criteria — ขั้นถัดไปคือ Phase 1 ตาม §11
   ของ authority spec
