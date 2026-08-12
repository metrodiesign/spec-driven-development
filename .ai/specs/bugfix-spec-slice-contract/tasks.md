# Implementation Tasks: Spec traceability slice contract

> Status: approved 2026-08-09

มี task เดียวแบบ end-to-end เพื่อให้ RED test, validator, producer contract และ active artifact
เปลี่ยนพร้อมกันโดยไม่ปล่อย state ครึ่งทางที่ gate กับ consumer ยังเห็น contract คนละชุด.

- [x] 1. ปิด traceability-to-slice contract drift end-to-end — เพิ่ม controlled RED fixtures
     ใน `.claude/hooks/tests/spec-slice.test.sh` สำหรับ column `REQ`/`Satisfies`, `Section`
     ที่หายหรือว่าง และ heading ที่ resolve ไม่ได้; ขยาย `scripts/spec_trace.py` ให้ reject
     เฉพาะ non-bugfix spec ที่ยังมี unchecked task พร้อม actionable diagnostics; sync producer
     contract ใน `/spec-quick`, Design-First backfill และ neutral feature workflow; retrofit
     `.ai/specs/context-accumulation/design.md` ให้ใช้ `Design element | REQ | Section` โดย
     `Section` ตรง real `##` heading; คง `scripts/spec-slice.sh`, runtime packages และ archived
     specs byte-unchanged; พิสูจน์ RED ก่อนแก้, GREEN หลังแก้, task 1–4 ไม่มี `MISSING:` และคืน
     DESIGN อย่างน้อยหนึ่ง section ต่อ task.
     Satisfies: F1-F11, B1-B11.
     Verify: `bash .claude/hooks/tests/spec-slice.test.sh`; `scripts/spec-trace.sh context-accumulation`;
     slice task 1–4; full guard-suite; `pnpm typecheck`; `pnpm lint`; `pnpm test`.
     Evidence:
       - RED: targeted suite บน validator เดิม -> `pass=28 fail=4`; invalid schema ทั้ง 4 แบบ
         ยังได้ `spec-trace` exit `0`.
       - review RED: misplaced REQ อยู่นอก named column -> `pass=32 fail=1`; หลังแก้ final
         targeted suite -> `pass=33 fail=0`.
       - trace sweep: active + archive requirements specs ทุกชุด -> exit `0`.
       - target: `context-accumulation` trace -> 21 criteria ผ่าน; task 1–4 ทุกตัว
         `rc=0 missing=0 design=2`.
       - guard suite: `.claude/hooks/tests/*.test.sh` ทุกไฟล์ -> exit `0`.
       - `pnpm typecheck` -> exit `0`; `pnpm lint` -> `ESLint: No issues found`.
       - `pnpm test` -> exit `0`: web `77/0`, core `612/0` (10 capability-gated skips),
         aal `192/0`, adapters `50/0`, console/backend `436/0`; sibling bugfix specs ปิด
         `F-Sys` และ nested-sandbox root causes แล้ว.

## Execution note

Test seam ได้รับอนุมัติใน `bugfix.md`: public commands `scripts/spec-trace.sh` และ
`scripts/spec-slice.sh` บน controlled temporary fixtures; assertions ตรวจ exit code และ output
ที่ผู้ใช้หรือ CI เห็น ไม่ตรวจ private helper.
