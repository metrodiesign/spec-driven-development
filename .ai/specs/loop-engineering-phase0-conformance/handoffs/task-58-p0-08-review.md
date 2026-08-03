# Handoff: Task 58 — P0-08 fresh-context correctness/security review

> From: Codex fresh-context reviewer  To: parent / acceptance owner  Date: 2026-08-02

## Task Summary

ตรวจ implementation ของ P0-08 ใน `loop-engineering-phase0-conformance` เทียบกับ
REQ-8.1–REQ-8.11 และ design TD-6 โดยครอบคลุม verifier/manifest tamper, copy-only
operator fixture, paired unique-AC coverage, direct CI script และ console
composition wiring. Task 8 ยังต้องคง `[ ]` เพราะยังไม่มี operator-supplied golden
fixture bytes และมี finding ระดับ High ค้างอยู่.

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 1
- Medium: 1
- Low: 0

### High

1. `console/backend/src/loop-run.ts:267-303,523-538` — correctness/security
   (REQ-8.4, REQ-8.6, TD-6): `makeFixtureRepo()` เป็น exported runtime seam ที่
   สร้าง `test/golden/expected.txt` และ `_MANIFEST.sha256` เองเมื่อไม่มี
   `operatorGoldenFixtureDir`; `runSupervisedLoop()` เลือก path นี้เป็น default เมื่อ
   `requireOperatorGoldenFixture` ไม่ได้เปิด และทั้ง stub/live CLI ไม่ส่ง option นี้
   จึงยังสามารถเริ่ม operational composition ด้วย golden truth ที่ระบบสร้างเองได้
   แทนการคงสถานะ blocked. คอมเมนต์ที่เรียก path นี้ว่า “legacy/synthetic” ไม่ได้
   เปลี่ยน observable behavior หรือป้องกัน caller/agent จากการใช้ path นี้.
   แยก synthetic harness ออกจาก production API และทำให้ operational composition
   fail closed โดยต้องมี operator fixture (หรือส่ง blocker ไปยัง caller) ก่อน
   สร้าง target fixture; tests ที่ต้องใช้ synthetic data ควรเรียก helper ที่ตั้งชื่อ
   และ scope ชัดว่า non-operational.

### Medium

1. `console/backend/src/loop-run.ts:330-351,536-538` — correctness/provenance
   (REQ-8.11): เมื่อมี operator fixture `makeFixtureRepo()` ได้
   `GoldenFixtureProvenance` จริง แต่ `runSupervisedLoop()` เก็บไว้ใน `fx` แล้ว
   ทิ้ง ไม่ใส่ `LoopRunResult`, event/evidence หรือ output ของ composition. ดังนั้น
   production caller ที่รัน loop ไม่สามารถรับคำอธิบาย `source`, `sourceHash` และ
   `manifestHash` ของ bytes ที่ถูก copy ได้; หลักฐานปัจจุบันอยู่เฉพาะ unit test ที่
   เรียก `makeFixtureRepo()` โดยตรง และ shell script ที่รันแยกต่างหาก. เพิ่ม
   provenance เป็นผลลัพธ์/หลักฐานที่ authenticated และให้ CLI/record แสดงค่าดังกล่าว
   โดยคง attribution เป็น `operator-supplied` เท่านั้น.

## Acceptance Review

### สิ่งที่ยืนยันแล้ว

- `core/src/gates/golden.ts` ตรวจ canonical file set/bytes/manifest formatting,
  missing/empty manifests และ unsupported symlink nodes; optional trusted manifest
  hash ปฏิเสธ manifest rewrite.
- `scripts/check-golden-manifests.sh` ถูกเรียกโดย CI โดยตรง, คืน exit `2` พร้อม
  `BLOCKED: operator_golden_fixture_missing` เมื่อไม่มี fixture, คืน non-zero เมื่อ
  file/manifest tamper และตรวจ symlink entry.
- `copyOperatorGoldenFixture()` ทำ exact byte copy โดยไม่ regenerate manifest และ
  คืน source/tree hash + manifest hash + `operator-supplied` attribution.
- `computeGoldenCoverage()` deduplicate numerator/denominator, ตัด out-of-scope
  IDs และคืน zero เมื่อ denominator เป็นศูนย์; `CalibrationResult` รายงาน coverage
  คู่กับ held-out pass rate.
- ไม่มี `computeGoldenManifest` อยู่ใน public core export แล้ว; path ที่เหลือเป็น
  verification/copy-only API.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/gates/golden.test.ts src/calibration/calibration.test.ts` -> `24` pass, `0` fail.
- `pnpm --filter console-backend exec node --test --test-reporter spec src/golden.fixture.test.ts` -> `3` pass, `0` fail.
- `pnpm --filter aal test` -> `148` pass, `0` fail, `0` skip.
- `pnpm --filter core typecheck` -> exit `0`.
- `pnpm --filter console-backend typecheck` -> exit `0`.
- `scripts/check-golden-manifests.sh` (repo default, no operator fixture) -> exit `2`, `BLOCKED: operator_golden_fixture_missing`.
- Temporary symlink probe against the current script -> exit `1`,
  `golden_manifest_mismatch: symlink entry under golden root`. No repo fixture bytes
  were created.

## Gaps / blockers

- ยังไม่มี exact operator-supplied golden fixture bytes จึงห้าม flip Task 8 หรือ
  อ้าง P0-08/Phase 0 conformance ว่า complete; direct CI blocker เป็นผลที่คาดหมาย.
- ไม่ได้รัน console loop integration suite ที่ต้องเปิด listener เนื่องจาก managed
  sandbox `listen EPERM` blocker ตาม handoff ก่อนหน้า; ไม่ตีความเป็น PASS.
- ไม่ได้รัน full core suite ซ้ำใน review นี้; handoff implementation บันทึก
  `560` tests, `551` pass, `0` fail และ `9` explicit external-only skips. การ review
  นี้ใช้ focused P0-08 evidence ด้านบนเป็นหลัก.

## Constraints

- คง Task 8 เป็น `- [ ]`; ห้ามเพิ่ม Evidence/ปิด task จนกว่า High/Medium findings
  ได้รับการแก้และ fresh acceptance ตรวจซ้ำ พร้อม operator fixture bytes จริง.
- ห้าม fabricate/regenerate golden bytes, retry/circumvent external macOS blocker,
  แก้ requirements/design/authority หรือ commit/push ใน review นี้.

## Next Steps

1. แก้ operational default ให้ไม่มี generated golden truth และบังคับ explicit
   operator-fixture blocker; เพิ่ม regression ที่เรียก production composition path.
2. ส่ง provenance source/tree hash/manifest hash ผ่าน run result หรือ authenticated
   evidence/output และเพิ่ม wired regression.
3. รัน focused suites + direct script ใน environment ที่มี exact operator fixture
   แล้วให้ acceptance reviewer ตรวจซ้ำ; จึงค่อยพิจารณา Task 8 closure.
