# Bugfix: System stats ต้อง degrade ต่อ metric โดยไม่ตอบ 500

> Status: approved 2026-08-09

ป้องกัน `GET /api/system/stats` ล้มทั้ง response เมื่อ host metric เดียวใช้งานไม่ได้
พร้อมคงค่าที่อ่านสำเร็จและแสดง metric ที่ขาดอย่างตรงไปตรงมา.

## Current Behavior (Defect)

WHEN รันคำสั่งต่อไปนี้บน managed macOS environment ที่ `os.uptime()` ถูกปฏิเสธ
THEN `GET /api/system/stats` ตอบ HTTP 500 แทน HTTP 200.

```bash
pnpm --filter console-backend exec node --test --test-reporter spec \
  --test-name-pattern='F-Sys: doctor degraded card never 500; stats from node:os' \
  src/app-surfaces.test.ts
```

| สิ่งที่วัด | ผลปัจจุบัน |
|---|---|
| `/api/system/doctor` degraded assertion | HTTP 200 และผ่าน |
| `/api/system/stats` assertion | HTTP 500 แทน HTTP 200 |
| failing metric | `os.uptime()` |
| system error | `ERR_SYSTEM_ERROR: uv_uptime returned EPERM` |

## Confirmed Root Cause

- `console/backend/src/app.ts:674-682` ประเมินทุก `node:os` call ใน object expression เดียว.
- `os.uptime()` ที่ `console/backend/src/app.ts:681` โยน exception แล้วไม่มี per-metric degradation.
- Fastify รับ unhandled route exception จึงตอบ HTTP 500 และทิ้ง metric อื่นที่อ่านสำเร็จแล้ว.
- Test name รวม doctor กับ stats แต่ failure จริงอยู่ที่ stats assertion
  `console/backend/src/app-surfaces.test.ts:222`.

## Expected Behavior

- F1 IF host metric ใดโยน exception ระหว่าง `GET /api/system/stats` THEN THE SYSTEM SHALL
  return HTTP 200 แทน HTTP 500.
- F2 WHEN host metric บางรายการอ่านสำเร็จ THE SYSTEM SHALL return ค่าจริงของรายการเหล่านั้น
  โดยไม่แทนด้วย fallback value.
- F3 IF host metric รายการใดอ่านไม่ได้ THEN THE SYSTEM SHALL represent เฉพาะรายการนั้นเป็น
  `null` แทนค่าตัวเลขปลอม.
- F4 WHEN stats response มี metric ที่อ่านไม่ได้ THE SYSTEM SHALL include `degraded: true`.
- F5 WHEN stats response มี metric ที่อ่านไม่ได้ THE SYSTEM SHALL include ชื่อ field นั้นใน
  `unavailableMetrics`.
- F6 WHEN System surface ได้รับ metric เป็น `null` THE SYSTEM SHALL display `unavailable`
  สำหรับ metric นั้นโดยยังแสดง metric ที่อ่านสำเร็จ.

## Unchanged Behavior

- B1 WHEN ทุก `node:os` metric พร้อมใช้งาน THE SYSTEM SHALL CONTINUE TO return `platform`,
  `arch`, `cpus`, `totalMem`, `freeMem`, `loadAvg` และ `uptimeS` ด้วยค่าและ type เดิม.
- B2 WHEN `doctorCapture` สำเร็จ THE SYSTEM SHALL CONTINUE TO return
  `{ available: true, output }` จาก `GET /api/system/doctor`.
- B3 WHEN `doctorCapture` โยน exception THE SYSTEM SHALL CONTINUE TO return HTTP 200 พร้อม
  `available: false` และ `degraded: true`.
- B4 WHEN System surface ได้รับ stats ปกติ THE SYSTEM SHALL CONTINUE TO display host,
  memory, load และ uptime rows ด้วยรูปแบบเดิม.
- B5 WHEN request ไม่ผ่าน host หรือ auth boundary THE SYSTEM SHALL CONTINUE TO enforce
  boundary เดิมก่อนเปิดเผย host stats.
- B6 WHEN retention endpoint รับ invalid input THE SYSTEM SHALL CONTINUE TO reject input
  ด้วย validation เดิม.
- B7 WHEN retention endpoint จะเปลี่ยนข้อมูล THE SYSTEM SHALL CONTINUE TO require consent
  ตาม contract เดิม.
- B8 WHEN retention endpoint เปลี่ยนข้อมูลสำเร็จ THE SYSTEM SHALL CONTINUE TO emit audit
  record ตาม contract เดิม.

## Hard Scope

ห้าม task ใดเปลี่ยน target ต่อไปนี้:

- `GET /api/system/doctor` contract.
- retention, MCP, hooks, skills, subagents และ terminal endpoints.
- `core/`, `aal/`, `adapters/` และ loop-run behavior.
- dependency หรือ package metadata.
- fallback ตัวเลขที่ทำให้ metric ที่อ่านไม่ได้ดูเหมือนค่าจริง.

## Validation Contract

| Case | ก่อนแก้ | หลังแก้ |
|---|---|---|
| `os.uptime()` โยน `ERR_SYSTEM_ERROR` | HTTP 500 | HTTP 200, `uptimeS: null`, degraded metadata ครบ |
| metric อื่นสำเร็จแต่ uptime ล้ม | response หายทั้งก้อน | successful metric คงค่าจริง |
| metric ทุกตัวสำเร็จ | HTTP 200 | HTTP 200 และ body เดิม |
| System surface ได้ `uptimeS: null` | ไม่มี deterministic behavior | แสดง `uptime: unavailable` |
| doctor capture ล้ม | HTTP 200 degraded | HTTP 200 degraded เหมือนเดิม |

Regression test ต้อง inject metric provider ที่โยน error แบบ deterministic และ assert เฉพาะ
HTTP response กับ rendered rows ห้ามพึ่ง ambient OS หรือ private helper.
