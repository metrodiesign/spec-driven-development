# Handoff: Task 72 — ปิด P0-08 (ได้รับ operator golden fixture แล้ว)

> จาก: Claude session 2026-08-03  ถึง: operator / agent Phase 0 คนถัดไป  วันที่: 2026-08-03

## สรุปงาน

ปิด Task 8 (P0-08) หลัง operator ส่ง golden fixture bytes มาจริง ซึ่งเป็น blocker
เดียวที่ค้างมาตั้งแต่ Task 61

## สถานะปัจจุบัน

`Task 8 = [x]` — Evidence block อยู่ใน `tasks.md`

## สิ่งที่ operator ส่งมา

ต้นทาง: `/Users/king_developer/Downloads/How to Create and Verify Golden Fixture Bytes/`

| ไฟล์ | SHA-256 | วางเข้า repo? |
|---|---|---|
| `_MANIFEST.sha256` | `c8ed772a…dba9d` | ใช่ |
| `login_failure.json` | `dcfeee53…cc783` | ใช่ |
| `login_success.json` | `a4baa49e…5cb11` | ใช่ |
| `registration_failure.json` | `53580d90…3ae14` | ใช่ |
| `registration_success.json` | `8c50cea3…cc207` | ใช่ |
| `goal.yaml` | — | **ไม่** (ดูด้านล่าง) |
| `Loop Engineering Test Suite…md` | — | **ไม่** (เป็นเอกสาร) |

copy แบบ byte-for-byte เข้า `test/golden/` — `cmp` ยืนยันว่าเหมือนต้นฉบับทั้ง 5 ไฟล์
core ไม่ได้ generate หรือ re-seal manifest (REQ-8.3/8.4/8.11)

## ทำไมไม่เอา goal.yaml กับ README เข้า golden root

verifier hash **ทุกไฟล์** ที่เจอใต้ golden root ยกเว้น `_MANIFEST.sha256` เอง
ถ้าใส่ `goal.yaml` เข้าไปด้วยจะได้ `golden_manifest_mismatch` ทันที (ทดสอบจริงแล้ว
เห็น diff บรรทัด `+6ecc4812…  goal.yaml`) โครงที่ถูกต้องตาม README ของ operator เอง
คือ `test/golden/` มีแค่ fixture กับ manifest ส่วน `goal.yaml` เป็น input แยกที่ส่ง
ผ่าน `--goal`

## การตรวจสอบ

- `scripts/check-golden-manifests.sh` -> exit `0`
  `OK: test/golden/_MANIFEST.sha256 (source=test/golden sourceHash=411eb626…82388 manifestHash=c8ed772a…dba9d)`
- tamper matrix บน bytes จริง (รันบนสำเนา ไม่แตะของจริง)
  edit -> `1`, delete -> `1`, add -> `1`, restore -> `0`
- `core` golden และ calibration -> `24/24` pass
- console production composition `src/loop-cli.test.ts` -> `11/11` pass

## เรื่องที่ค้างให้ operator ตัดสิน: goal.yaml

`goal.yaml` ที่ส่งมา **ยังไม่ผ่าน** `.ai/schemas/goal.schema.json` จึงยังไม่ได้
wire เข้า repo — ถ้า wire ตอนนี้ `platform loop run --goal` จะ reject

schema ต้องการ (เทียบกับ `.ai/calibration/fixture-goal.yaml`)

| ต้องมี | ที่ส่งมา |
|---|---|
| `goal: {id, title?, objective?}` — `additionalProperties: false` | `goal:` มี `name`, `description`, `acceptance_criteria` ซ้อนอยู่ข้างใน |
| `acceptance_criteria:` เป็น array ระดับบนสุดของ `{id, description, verification?, golden?}` | เป็น prose ซ้อนใต้ `goal:` ไม่มี id |
| `budget: {max_iterations_per_task, max_hypotheses_per_failure, max_total_tasks, max_parallel_agents, max_cost_units_per_task, max_wallclock_per_task_min}` | ไม่มีเลย |

การแปลงต้องให้ operator ตัดสิน 2 เรื่องที่ agent ตัดสินแทนไม่ได้

1. **AC ข้อไหนเป็น golden-backed** (`golden: true`) — เป็นตัวเศษของ coverage
   ตาม REQ-8.7/8.8 fixture ที่ส่งมาครอบ 4 ข้อแรก (register success/failure,
   login success/failure) ส่วน logout กับ session management ยังไม่มี fixture
   ถ้าประกาศ in-scope ทั้ง 6 ข้อ coverage จะเป็น 4/6 ไม่ใช่ 6/6
2. **ตัวเลข budget** — iteration/cost/wallclock cap เป็นการตัดสินใจเรื่องเงินและเวลา

Task 8 ปิดได้โดยไม่ต้องรอข้อนี้ เพราะ Verify line ของมันวัดที่ verifier, tamper
matrix, coverage control tests และการมีอยู่ของ fixture bytes ซึ่งครบแล้ว

## สิ่งที่ต้องทำต่อ

1. operator แปลง `goal.yaml` ตามตารางข้างบน แล้ววางที่ `.ai/goals/` หรือ path ที่เลือก
2. รัน `platform loop run --goal <path> --operator-golden-fixture test/golden/`
   เพื่อพิสูจน์ end-to-end (ยังไม่ได้ทำใน session นี้)
3. Task 10 (P0-10) ประเมินใหม่ได้แล้ว — blocker ทั้งหมดปลดครบ
