# Bugfix: Spec traceability ต้องรับรองว่า slice ใช้งานได้

> Status: approved 2026-08-09

แก้ contract drift ระหว่างผู้สร้าง `design.md`, ตัวตรวจ `spec-trace` และผู้ใช้
`spec-slice` เพื่อไม่ให้ spec ที่ slice ใช้ไม่ได้ผ่าน gate สีเขียวและบังคับอ่าน artifact เต็มทุก task.

## Current Behavior (Defect)

WHEN รันคำสั่งต่อไปนี้จาก repo root THEN `spec-trace` exit `0` แม้ task ทั้ง 4
ไม่มี design section ที่ใช้ได้และทุก task มี `MISSING:` อย่างน้อยหนึ่งรายการ.

```bash
scripts/spec-trace.sh context-accumulation
scripts/spec-slice.sh context-accumulation 1
scripts/spec-slice.sh context-accumulation 2
scripts/spec-slice.sh context-accumulation 3
scripts/spec-slice.sh context-accumulation 4
```

| สิ่งที่วัด | ผลปัจจุบัน |
|---|---:|
| criteria ที่ `spec-trace` รายงานว่าครบ | 21 |
| task ที่มี `MISSING:` | 4 จาก 4 |
| task ที่คืน real DESIGN section | 0 จาก 4 |
| ขนาด requirements + design ที่ fallback ต้องอ่าน | 60,591 bytes ต่อ task |

## Confirmed Root Cause

- Primary: `scripts/spec_trace.py` ตรวจเพียงว่า REQ token ปรากฏใน traceability text
  แต่ไม่ตรวจ table schema หรือ resolve `Section` กับ heading จริง.
- Consumer: `scripts/spec-slice.sh` ต้องพบ column `REQ` หรือ `Satisfies` พร้อม `Section`
  ซึ่งตรงกับ real `##` heading แบบ exact match จึงจะคืน design content.
- Producer drift: `/spec-design` ระบุ schema ถูกแล้ว แต่ `/spec-quick`, Design-First backfill
  และ neutral feature workflow ยังระบุ traceability แบบเก่าที่ไม่มี `Section`.
- Regression surface: test ปัจจุบันรับรองว่า table ไม่มี `Section` ยังผ่าน `spec-trace`
  และตรวจเพียงว่า slicer fallback อย่างปลอดภัย.

## Expected Behavior

- F1 WHEN `spec-trace` ตรวจ non-bugfix spec ที่ยังมี unchecked task THE SYSTEM SHALL
  validate ว่า Requirement Traceability ใช้ contract ที่ `spec-slice` resolve ได้.
- F2 IF Requirement Traceability ไม่มี column `REQ` หรือ `Satisfies` THEN THE SYSTEM SHALL
  exit non-zero พร้อมระบุชื่อ column ที่รองรับ.
- F3 IF Requirement Traceability ไม่มี column `Section` THEN THE SYSTEM SHALL exit non-zero
  พร้อมระบุว่า `Section` column หาย.
- F4 IF traceability row ที่ครอบ REQ มีค่า `Section` ว่าง THEN THE SYSTEM SHALL exit non-zero
  พร้อมระบุ REQ หรือ row ที่ผิด.
- F5 IF ค่า `Section` ไม่ตรงกับ real `##` heading ใน design เดียวกันแบบ case-sensitive exact match
  THEN THE SYSTEM SHALL exit non-zero พร้อมระบุค่าที่ resolve ไม่ได้.
- F6 WHEN traceability table ใช้ schema ถูกและทุก `Section` resolve ได้ THE SYSTEM SHALL
  ให้ `spec-trace` exit `0`.
- F7 WHEN traceability table ใช้ schema ถูกและทุก `Section` resolve ได้ THE SYSTEM SHALL
  ให้ `spec-slice` คืน real DESIGN section โดยไม่มี `MISSING:`.
- F8 WHEN workflow สร้างหรือ backfill Requirement Traceability THE SYSTEM SHALL เขียน column
  `Design element`, `REQ`, `Section`.
- F9 WHEN workflow เขียนค่า `Section` THE SYSTEM SHALL ใช้ข้อความที่ตรงกับ real `##` heading
  ใน design เดียวกันแบบ case-sensitive exact match.
- F10 WHEN artifact `context-accumulation` ถูกปรับให้ตรง contract THE SYSTEM SHALL ให้ task 1–4
  ไม่มี `MISSING:`.
- F11 WHEN artifact `context-accumulation` ถูกปรับให้ตรง contract THE SYSTEM SHALL ให้ task 1–4
  คืน real DESIGN section อย่างน้อยหนึ่ง section ต่อ task.

## Unchanged Behavior

- B1 WHEN valid table สลับลำดับ column, ใช้ `Satisfies` แทน `REQ` หรือไม่มี trailing pipe
  THE SYSTEM SHALL CONTINUE TO resolve column ตามชื่อและผ่าน validation.
- B2 WHEN requirement criterion ขาดจาก design coverage หรือ task `Satisfies:` coverage
  THE SYSTEM SHALL CONTINUE TO fail และแสดง criterion ที่ไม่ถูกครอบทั้งหมด.
- B3 WHEN requirement criterion ไม่ผ่าน EARS notation THE SYSTEM SHALL CONTINUE TO fail
  พร้อม EARS diagnostic เดิม.
- B4 WHEN `spec-slice` resolve REQ หรือ design section ไม่ได้ THE SYSTEM SHALL CONTINUE TO
  emit `MISSING:` ด้วย exit `0` เพื่อคง safe fallback.
- B5 WHEN `spec-slice` emit `MISSING:`, ใช้งานไม่ได้ หรือ error THE SYSTEM SHALL CONTINUE TO
  ให้ `/spec-implement` อ่าน `requirements.md` และ `design.md` เต็ม.
- B6 WHEN task เป็น final, assembly หรือผู้ใช้ขอ full context THE SYSTEM SHALL CONTINUE TO
  ให้ `/spec-implement` อ่าน artifact เต็มแม้ slice สำเร็จ.
- B7 WHEN ขอ task ID ที่ไม่มีอยู่ THE SYSTEM SHALL CONTINUE TO ให้ `spec-slice` exit `1`
  และแสดง task ID ที่มี.
- B8 WHEN Evidence transcript มีข้อความ `Satisfies:` หรือ REQ ID THE SYSTEM SHALL CONTINUE TO
  ตัด transcript ออกจาก coverage ผ่าน shared `iter_task_blocks()` boundary.
- B9 WHEN ตรวจ archived closed spec ผ่าน optional specs-dir argument THE SYSTEM SHALL CONTINUE TO
  ตรวจ EARS และ REQ coverage เดิมโดยไม่บังคับ retrofit เพื่อการ slice.
- B10 WHEN feature เป็น bugfix spec ที่มี `bugfix.md` แต่ไม่มี `requirements.md`
  THE SYSTEM SHALL CONTINUE TO ใช้ skip behavior เดิม.
- B11 WHEN รัน runtime packages THE SYSTEM SHALL CONTINUE TO ทำงานเหมือนเดิม เพราะ bugfix นี้
  เปลี่ยนเฉพาะ SDD authoring, validation และ active spec artifact.

## Hard Scope

ห้าม task ใดแก้ target ต่อไปนี้:

- `scripts/spec-slice.sh` และ output/fallback semantics ของมัน.
- `core/`, `aal/`, `adapters/` และ `console/`.
- artifact ใต้ `.ai/specs/archive/`.
- dependency, metadata format หรือ slicer ตัวใหม่.

## Validation Contract

| Case | ก่อนแก้ | หลังแก้ |
|---|---|---|
| table ไม่มี `Section` | `spec-trace` exit `0` | exit `1` พร้อม actionable error |
| `Section` cell ว่าง | `spec-trace` exit `0` | exit `1` พร้อมระบุ row หรือ REQ |
| `Section` ไม่ตรง heading | `spec-trace` exit `0` | exit `1` พร้อมระบุค่าที่ผิด |
| valid exact-match control | exit `0` | exit `0`, `MISSING:` = 0, DESIGN มากกว่า 0 |
| `context-accumulation` task 1–4 | `MISSING:` 4 จาก 4 task | `MISSING:` 0 จาก 4 task |

Regression test ต้องใช้ controlled temporary fixture ใน `.claude/hooks/tests/spec-slice.test.sh`
และพิสูจน์ RED ก่อนแก้, GREEN หลังแก้จาก observable command exit/output.
