# รายการงาน: เอกสารภาษาไทย

> Status: draft

- [x] 1. ปรับต้นทางและตัวอย่างภาษาไทย พร้อมตรวจความเข้ากันได้ของเครื่องมือ
  Satisfies: REQ-1, REQ-2. Verify: ตรวจ diff และรันชุด spec-slice, check-evidence, spec-trace และ git diff --check.

  Evidence:

  - test: `bash .claude/hooks/tests/spec-slice.test.sh` -> pass=37 fail=0 รวม fixture ภาษาไทย 4 กรณี
  - test: `bash .claude/hooks/tests/check-evidence.test.sh` -> pass=31 fail=0
  - test: `bash .claude/hooks/tests/cross-harness-conformance.test.sh` -> shell-adapters 11 ผ่าน, node-conformance 24 ผ่าน
  - test: `bash .claude/hooks/tests/lesson-tripwires.test.sh` -> pass=8 fail=0
  - test: `bash scripts/spec-trace.sh sdd-thai-artifacts` -> 5 เกณฑ์อ้างครบ และ EARS lint ผ่าน
  - test: `pnpm typecheck` -> exit 0
  - test: `pnpm lint` -> exit 0
  - test: `pnpm test` -> 1495 ผ่าน, 0 ไม่ผ่าน, 10 skipped ใน core ตามเงื่อนไขชุดทดสอบเดิม
  - test: `git diff --check` -> exit 0
  - review: verifier ตรวจ diff และ machine contract -> APPROVE ไม่พบ finding
  - viewports: n/a — งานเอกสารและ shell fixture ไม่มี UI
  - deviations: ไม่ได้ทดสอบการสร้างข้อความด้วย live session ของทุกโมเดล; คง Status: draft โดยไม่สร้าง approval metadata

- [x] 2. จัดหลักฐานให้อ่านแยกรายการ และใช้ประโยคข้อกำหนดภาษาไทย
  Satisfies: REQ-1, REQ-2, REQ-3. Verify: ตรวจตัวอ่านข้อกำหนด การส่งต่อคำสั่ง หลักฐาน และภาพแสดงผลเอกสารจริง.

  Evidence:

  - test: `bash .claude/hooks/tests/spec-slice.test.sh` -> pass=39 fail=0 รวมประโยคไทยห้าแบบและการแยกหลักฐานออกจากคำสั่ง
  - test: `node --test console/backend/src/spec-to-goal.e2e.test.ts` -> 24 ผ่าน, 0 ไม่ผ่าน
  - test: `node --test console/backend/src/spec-goal-drift.e2e.test.ts` -> 9 ผ่าน, 0 ไม่ผ่าน
  - test: `bash .claude/hooks/tests/check-evidence.test.sh` -> pass=31 fail=0
  - test: `bash scripts/spec-trace.sh sdd-thai-artifacts` -> 8 เกณฑ์อ้างครบ และตรวจรูปประโยคผ่าน
  - test: `pnpm typecheck` และ `pnpm lint` -> exit 0 ทั้งสองคำสั่ง
  - review: ตรวจโค้ดและความเข้ากันได้กับรูปแบบเดิม -> ไม่พบจุดต้องแก้
  - viewports: เปิดหน้าตัวอย่าง requirements.md และ tasks.md ใน VS Code จริง -> ข้อกำหนดเป็นไทย หลักฐานแยกย่อหน้าและรายการย่อย
  - deviations: ทดสอบเฉพาะเครื่องมือเอกสารและตัวอ่านที่เกี่ยวข้อง ไม่ได้รันชุดทดสอบแอปทั้งหมดซ้ำจากรอบแรก
