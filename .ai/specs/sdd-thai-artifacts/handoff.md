# Handoff Note: เอกสาร SDD ภาษาไทย

> From: Codex   To: any   Date: 2026-09-07

## Task Summary

ปรับต้นทางเอกสารให้ใช้ภาษาไทย และจัดหลักฐานให้แสดงเป็นรายการอ่านง่าย ครอบคลุม REQ-1 ถึง REQ-3
ใน `sdd-thai-artifacts` โดยคงรหัสอ้างอิงและข้อมูลสถานะ ไม่แปลเอกสารเก่าทั้งคลัง

## Current Status

งานที่ 1 และ 2 เสร็จแล้ว พร้อมหลักฐานแยกรอบ ตรวจหน้าตัวอย่าง VS Code จริงแล้ว
ผลตรวจโค้ดไม่พบจุดต้องแก้ ผลทดสอบรอบล่าสุดอยู่ในหัวข้อ “การตรวจรอบปรับรูปแบบ”
branch: `docs/sdd-thai-artifacts` ยังไม่ commit หรือ push

## Files Changed

- `.ai/shared/` — ปรับนโยบาย ตัวอย่าง EARS, output, Evidence และ handoff
- `.ai/templates/` — ปรับ placeholder และคำอธิบายเอกสารประกอบ
- `.claude/skills/spec-*/SKILL.md` — อ้างนโยบายกลางและปรับตัวอย่างผลลัพธ์
- `.claude/skills/spec-sync-github/references/body-templates.md` — ปรับข้อความ issue
- `.agents/skills/spec-retro/SKILL.md` — เติม pointer นโยบายที่ wrapper นี้ยังไม่มี
- `.claude/hooks/tests/spec-slice.test.sh` — เพิ่ม fixture ภาษาไทยสำหรับ slice, trace และ Evidence
- `.ai/specs/sdd-thai-artifacts/` — สร้าง requirements, design, tasks และ handoff ใหม่ ยังเป็น untracked
- `scripts/spec_trace.py` — รองรับรูปประโยคข้อกำหนดภาษาไทยห้าแบบ พร้อมคงรูปภาษาอังกฤษเดิม
- `scripts/spec_to_goal.py` — อ่านชื่อเรื่องจากหัวข้อ “ข้อกำหนด:” โดยไม่ติดคำนำหน้าไปในชื่อที่ส่งต่อ
- `console/backend/src/spec-to-goal.e2e.test.ts` — ทดสอบการแปลงเอกสารภาษาไทยและการแยกหลักฐานจริง

## Important Decisions

- ข้อกำหนดใช้หัวข้อและประโยคไทย คงเฉพาะรหัสอ้างอิงและข้อมูลสถานะที่เครื่องอ่าน
- ใช้ต้นทางร่วมทุกเครื่องมือ เพิ่มการอ่านประโยคไทยในตัวตรวจเดิมโดยไม่เพิ่มแพ็กเกจ
- ไม่แปล spec เดิมย้อนหลัง ไม่แก้สถานะอนุมัติหรือผลทดสอบเก่า
- หลักฐานใช้ระยะเยื้องสองช่องและบรรทัดว่างก่อน/หลัง `Evidence:` ไม่เว้นบรรทัดก่อนข้อมูลอ้างอิงงาน

## Constraints

- `AGENTS.md`, `CLAUDE.md`, `.DS_Store` และ `.ai/.DS_Store` มีการเปลี่ยนแปลงก่อนเริ่มงาน ไม่รวมในงานนี้
- ไม่ส่ง issue ออก GitHub และไม่เปลี่ยน approval workflow
- artifact ชุดนี้ยังใช้ `Status: draft` เพราะผู้ใช้สั่ง implement แผน ไม่ได้อนุมัติ artifact แยก

## Tests Run

ผลรอบแรกก่อนแก้ตามภาพตัวอย่าง เก็บตามที่รันจริง ไม่ใช้แทนผลตรวจรอบล่าสุด:

- `bash .claude/hooks/tests/spec-slice.test.sh` -> pass=37 fail=0
- `bash .claude/hooks/tests/check-evidence.test.sh` -> pass=31 fail=0
- `bash .claude/hooks/tests/cross-harness-conformance.test.sh` -> shell-adapters 11 ผ่าน, node-conformance 24 ผ่าน
- `bash .claude/hooks/tests/lesson-tripwires.test.sh` -> pass=8 fail=0
- `bash scripts/spec-trace.sh sdd-thai-artifacts` -> 5 เกณฑ์อ้างครบ และ EARS lint ผ่าน
- `pnpm typecheck` -> exit 0
- `pnpm lint` -> exit 0
- `pnpm test` -> 1495 ผ่าน, 0 ไม่ผ่าน, 10 skipped ใน core; exit 0
- `git diff --check` -> exit 0
- ตรวจ Markdown 28 ไฟล์ -> link ภายใน 58 จุดมีปลายทางครบ ไม่มี emoji และหัวข้อเดิมคงอยู่
- review โดย verifier -> APPROVE ไม่พบ actionable finding

task gate สำหรับงานเอกสาร รันคำสั่งต่อไปนี้แล้วได้ exit 0:

```bash
SDD_TYPECHECK_CMD='pnpm typecheck' SDD_TEST_CMD='env -u SDD_TYPECHECK_CMD -u SDD_TEST_CMD bash .claude/hooks/tests/spec-slice.test.sh && env -u SDD_TYPECHECK_CMD -u SDD_TEST_CMD bash .claude/hooks/tests/check-evidence.test.sh' GATE_FILE='.ai/specs/sdd-thai-artifacts/tasks.md' GATE_NEW="$(cat .ai/specs/sdd-thai-artifacts/tasks.md)" bash .ai/bin/gate-task.sh
```

แยก env ของ test fixture เพราะ check-evidence เรียก gate ซ้อนใน temporary repo
รอบแรกที่ปล่อยให้ fixture รับ `SDD_TEST_CMD` จาก outer gate ทำให้ snapshot 2 ข้อล้ม
รอบที่แยก env ผ่านโดยไม่แก้ source; workspace suite เต็มรันผ่านแยกตามรายการด้านบน

## การตรวจรอบปรับรูปแบบ

- `bash .claude/hooks/tests/spec-slice.test.sh` -> pass=39 fail=0
- `node --test console/backend/src/spec-to-goal.e2e.test.ts` -> 24 ผ่าน, 0 ไม่ผ่าน
- `node --test console/backend/src/spec-goal-drift.e2e.test.ts` -> 9 ผ่าน, 0 ไม่ผ่าน
- `bash .claude/hooks/tests/check-evidence.test.sh` -> pass=31 fail=0
- `bash scripts/spec-trace.sh sdd-thai-artifacts` -> 8 เกณฑ์อ้างครบ และรูปประโยคผ่าน
- `pnpm typecheck` และ `pnpm lint` -> exit 0 ทั้งสองคำสั่ง
- ตรวจโค้ดอิสระ -> ไม่พบจุดต้องแก้ รูปภาษาอังกฤษเดิมและขอบเขตหลักฐานยังทำงานถูกต้อง
- เปิดหน้าตัวอย่าง VS Code จริง -> หัวข้อและเนื้อหาข้อกำหนดเป็นไทย หลักฐานแยกเป็นย่อหน้าและรายการย่อย
- ใช้ Pandoc ที่ติดตั้งอยู่แล้วตรวจโครงสร้าง -> ก่อนแก้ไม่มี Evidence ที่เป็นย่อหน้าแยก หลังแก้แยกย่อหน้าได้

ตัวตรวจปิดงานรอบล่าสุดได้ exit 0 ด้วยคำสั่งนี้:

```bash
SDD_TYPECHECK_CMD='pnpm typecheck' SDD_TEST_CMD='env -u SDD_TYPECHECK_CMD -u SDD_TEST_CMD bash .claude/hooks/tests/spec-slice.test.sh && env -u SDD_TYPECHECK_CMD -u SDD_TEST_CMD bash .claude/hooks/tests/check-evidence.test.sh && node --test console/backend/src/spec-to-goal.e2e.test.ts console/backend/src/spec-goal-drift.e2e.test.ts' GATE_FILE='.ai/specs/sdd-thai-artifacts/tasks.md' GATE_NEW="$(cat .ai/specs/sdd-thai-artifacts/tasks.md)" bash .ai/bin/gate-task.sh
```

## Known Issues

ไม่มีงานติดขัด ผลชุดทดสอบแอปจากรอบแรกอยู่ที่ `/tmp/sdd-thai-workspace-test.log`
core มี 10 skipped ตามเงื่อนไขชุดทดสอบเดิม ไม่ได้เปลี่ยน skip condition
รอบปรับรูปแบบทดสอบตัวอ่านและเครื่องมือเอกสารโดยตรง ไม่ได้รันชุดทดสอบแอปทั้งหมดซ้ำ
การตรวจต้นทางไม่ใช่การรับประกันพฤติกรรมการสร้างข้อความของโมเดลทุกตัว

## Next Recommended Agent

gitops สำหรับเตรียม commit/PR เมื่อผู้ใช้สั่ง โดยแยก dirty changes เดิมออก

## Next Steps

1. อ่าน spec ชุดนี้และรัน `bash scripts/spec-state.sh sdd-thai-artifacts` เพื่อเทียบสถานะกับ filesystem
2. หากเตรียม commit/PR ให้เลือกเฉพาะไฟล์งานนี้ ไม่รวม dirty changes ที่มีอยู่ก่อน
