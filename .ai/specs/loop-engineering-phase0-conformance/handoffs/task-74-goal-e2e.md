# Handoff: Task 74 — goal.yaml conversion + end-to-end stub run + แก้ verifier ordering bug

> จาก: Claude session 2026-08-03  ถึง: operator / agent Phase 0 คนถัดไป  วันที่: 2026-08-03

## สรุปงาน

operator ส่งโฟลเดอร์ fixture ชุดใหม่ (`How to Create and Verify Golden Fixture
Bytes (1)`) — fixture bytes เหมือนชุดเดิมทุกไฟล์ แต่ `goal.yaml` เป็นฉบับที่ตัดสิน
สองเรื่องค้างจาก `task-72-p0-08-close.md` ครบแล้ว จึงแปลงให้ผ่าน schema แล้วรัน
`platform loop run` end-to-end ได้เป็นครั้งแรก และการรันนั้น expose bug จริงใน
core verifier หนึ่งจุด ซึ่งแก้แล้วพร้อม regression test

## สิ่งที่ operator ตัดสินมา (ใน goal.yaml ฉบับใหม่)

1. golden-backed AC = 4/6: `AC-1..AC-4` (`golden: true`) ครอบ fixture ทั้ง 4 ไฟล์
   ส่วน `AC-5` (logout) กับ `AC-6` (session management) เป็น `golden: false`
2. budget: `max_iterations: 10`, `max_cost_usd: 2.0`, `max_wallclock_seconds: 1800`
   (+ field เสริมที่ schema ไม่มีช่องรองรับ)

## การแปลง -> `.ai/goals/auth-test-loop-01.yaml`

id/title/objective/AC ทั้ง 6 ข้อคงตาม operator ทุกตัวอักษร ส่วน budget map ดังนี้
(บันทึกซ้ำใน comment หัวไฟล์)

| operator | schema | ค่า |
|---|---|---|
| `max_iterations: 10` | `max_iterations_per_task` | `10` |
| `max_wallclock_seconds: 1800` | `max_wallclock_per_task_min` | `30` |
| `max_cost_usd: 2.0` | `max_cost_units_per_task` | `200` (1 unit = 1k tokens ตาม `costUnitsPer1k` default; ~$2 ที่ราคา Sonnet เฉลี่ย) |
| ไม่ได้ระบุ | `max_hypotheses_per_failure` | `3` (default จาก calibration fixture) |
| ไม่ได้ระบุ | `max_total_tasks` | `30` (default จาก calibration fixture) |
| ไม่ได้ระบุ | `max_parallel_agents` | `3` (default จาก calibration fixture) |

field ที่ schema ไม่มีช่อง (`iteration_budget_usd`, `warning_threshold_usd`,
`cooldown_seconds`) ถูกตัดทิ้ง — `additionalProperties: false` reject อยู่แล้ว

## bug ที่ end-to-end run เจอ: manifest line ordering

- อาการ: `platform loop run` ตาย `golden_manifest_mismatch: manifest formatting
  or duplicate-entry mismatch` ทั้งที่ `scripts/check-golden-manifests.sh` ผ่าน
- root cause: `canonicalManifest` ใน `core/src/gates/golden.ts` เรียก `.sort()`
  หลัง map เป็นบรรทัด `"<hash>  <path>"` — hash นำหน้าจึงกลายเป็นเรียงตาม digest
  แต่ manifest มาตรฐานที่ operator สร้าง (สไตล์ `shasum`) เรียงตามชื่อไฟล์
  set ของบรรทัดเท่ากันทุกบรรทัด แต่ byte ทั้งก้อนไม่เท่า จึงตกไปที่ข้อความ
  formatting mismatch
- ทำไม test เดิมไม่จับ: fixture ใน `golden.test.ts` ใช้ content `alpha`/`beta`
  ซึ่ง hash order บังเอิญตรง name order (`b6a9… < f2c8…`) ทุกชุด
- แก้: เรียงตาม relative path (code-unit compare ตรงกับ `find | sort` ภายใต้
  `LC_ALL=C` ของ script) แล้วค่อยประกอบบรรทัด — ห้ามแก้ manifest ของ operator
  (REQ-8.6 ห้าม regenerate/re-seal)
- regression test ใหม่: `name-sorted operator manifest verifies even when hash
  order differs (REQ-8.3)` — สลับ content ให้ digest order สวน name order จริง

## หลักฐานการรัน

- governance gate (REQ-9.2) ทำงานตาม flow: proposal `gov-46bb223a2c6eeb2e`
  ถูก approve ก่อน run แรกจะผ่าน preflight
- `platform loop run --goal .ai/goals/auth-test-loop-01.yaml
  --operator-golden-fixture test/golden` (stub adapter, no quota) ->
  `goal auth-test-loop-01 -> REVIEWING (1 iterations)`
  `golden fixture: sourceHash=411eb626…82388 manifestHash=c8ed772a…dba9d
  attribution=operator-supplied`
- `core/src/gates/golden.test.ts` -> `10/10` pass
- full core (`PHASE0_REAL_MACOS_TESTS=1`) -> `577/577` pass `0` fail `0` skipped
  (เพิ่มจาก `576` เพราะ regression test ใหม่)
- full console-backend -> `394/394` pass
- `pnpm typecheck` (`6` projects) + `pnpm lint` -> ผ่าน

## สิ่งที่ยังค้าง

1. งานทั้งหมดยัง uncommitted บน `codex/loop-engineering-phase0-conformance`
   (รวม `test/golden/`, `.ai/goals/auth-test-loop-01.yaml` และ fix ใน golden.ts)
   — ต้องรอ operator สั่ง commit + เปิด PR
2. live run (`--live`) ยังไม่ได้ทำ — ต้องมี ConformanceRecord จริงใน
   `.ai/calibration/` และ typed confirmation จาก operator กิน quota จริง
3. `AC-5`/`AC-6` ยังไม่มี golden fixture — coverage ตาม REQ-8.7/8.8 คือ 4/6
   ตามที่ operator ประกาศ
