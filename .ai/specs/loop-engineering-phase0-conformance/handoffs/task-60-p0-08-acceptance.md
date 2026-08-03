# Handoff: Task 60 — P0-08 acceptance
> From: Codex fresh-context acceptance reviewer  To: parent P0-08 owner  Date: 2026-08-02

## Task Summary

ตรวจ acceptance ของ Task 8 (P0-08) ใน `loop-engineering-phase0-conformance` หลัง
Task 59 เทียบ REQ-8.1–REQ-8.11, design TD-6 และ handoffs Task 57–59 โดยเน้นการ
ปิด High/Medium findings เรื่อง synthetic truth, operational default, operator
fixture blocker และ provenance

## Verdict

`APPROVE_WITH_OPERATOR_FIXTURE_BLOCKER`

- Critical: 0
- High: 0
- Medium: 0
- Low: 0

Task 59 แก้ High/Medium findings ครบจาก source ที่ตรวจ: operational composition
ไม่สร้าง golden truth โดยปริยาย, CLI ต้องรับ `--operator-golden-fixture`, synthetic
fixture อยู่ใน helper/flag ที่ระบุว่า test-only เท่านั้น, และ provenance ถูกส่งผ่าน
`LoopRunResult.goldenFixture`, evidence blob และ `GOLDEN_FIXTURE_PROVISIONED` event
พร้อม `source`, `sourceHash`, `manifestHash`, `attribution` และ `evidenceRef`.

ยังห้าม flip Task 8 เป็น `[x]`: ยังไม่มี exact operator-supplied golden fixture bytes
ใน repository/working tree ตาม REQ-8.6. `scripts/check-golden-manifests.sh` จึงคืน
exit `2` พร้อม `BLOCKED: operator_golden_fixture_missing` ตามที่ต้องเป็น และ P0-08/
Phase 0 closure ยังไม่ complete. ห้ามนำ synthetic test bytes หรือ temporary test
fixtures มาอ้างเป็น operator truth

## Verified Controls

- `runSupervisedLoop()` fail-closed ก่อนสร้าง fixture/state หากไม่มี
  `operatorGoldenFixtureDir`; `makeFixtureRepo()` รับ operator path แบบ required.
- `makeSyntheticFixtureRepoForTests()` และ `syntheticGoldenFixtureForTests` เป็น
  explicit test seam; เมื่อมี operator path จะไม่เลือก synthetic branch.
- `copyOperatorGoldenFixture()` ตรวจ manifest/bytes ก่อน copy และ copy exact bytes
  รวม manifest โดยไม่ regenerate/rewrite; ไม่มี `computeGoldenManifest` ใน public
  core export.
- `verifyGoldenRoot`/`verifyGoldenManifests` ตรวจ set/bytes/manifest formatting,
  empty/missing manifest และ unsupported symlink; edit/delete/add/tamper routes
  fail closed.
- paired coverage ใช้ unique in-scope AC IDs, ตัด out-of-scope golden IDs และคืน
  zero เมื่อ denominator เป็นศูนย์; `CalibrationResult` รายงาน coverage คู่กับ
  held-out pass rate.
- `.github/workflows/ci.yml` เรียก direct verifier แบบ unconditional; default CI
  จึงคง blocker แทนการยอมรับ empty truth set.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/gates/golden.test.ts src/calibration/calibration.test.ts` -> 24 pass, 0 fail (manifest edit/delete/add, trusted-manifest tamper, symlink, copy-only, missing blocker, direct script, unique coverage).
- `pnpm --filter console-backend exec node --test --test-reporter spec src/golden.fixture.test.ts` -> 5 pass, 0 fail (operational default blocker, exact copy/provenance, event/evidence provenance).
- `pnpm --filter console-backend exec node --test --test-reporter spec src/golden.fixture.test.ts src/loop-cli.test.ts src/loop-run.test.ts src/loop-run-graph.test.ts src/loop-run-graph.fault-injection.test.ts src/loop-run-lease.test.ts` -> 70 total, 28 pass, 42 fail; ทุก failure เป็น `listen EPERM: operation not permitted 127.0.0.1` จาก Human Plane listener ใน managed sandbox จัดเป็น environment blocker และไม่ตีความเป็น PASS/skip.
- `pnpm --filter core test` -> 564 total, 555 pass, 0 fail, 9 explicit external-only skips.
- `pnpm --filter aal test` -> 148 pass, 0 fail, 0 skip.
- `pnpm typecheck` -> workspace projects ทั้ง 6 ผ่าน.
- `pnpm lint` -> `ESLint: No issues found`.
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit 0.
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> 144 criteria covered; EARS lint passed.
- `git diff --check` -> exit 0.
- `scripts/check-golden-manifests.sh` (repo default, no operator fixture) -> exit 2, `BLOCKED: operator_golden_fixture_missing` (expected REQ-8.6 blocker).
- `cd console/backend && node bin/platform.ts loop run --goal ../../package.json` (ไม่มี `--operator-golden-fixture`) -> exit 2, `operator_golden_fixture_missing`.

## Constraints

- คง Task 8 เป็น `- [ ]`; ห้ามเพิ่ม Evidence/ปิด task ใน acceptance นี้.
- ห้าม fabricate/regenerate/copy operator golden bytes เข้าสู่ repo, ห้ามแก้
  requirements/design/authority หรือ Task 8, และห้าม commit/push.
- ไม่ retry external P0-02 macOS verification; listener `EPERM` ต้องรันซ้ำใน
  authorized environment/CI ที่อนุญาต local `listen` ก่อน closure.

## Known Issues / Blockers

- Operator-supplied fixture bytes ยังไม่ถูกส่งมอบ จึงเป็น product-input blocker ที่
  requirement ระบุให้คงสถานะ BLOCKED.
- Wired console loop integration ยังยืนยันไม่ได้ใน managed sandbox เพราะ
  `listen EPERM`; focused non-listener golden/CLI checks ผ่านแล้ว.

## Next Recommended Agent

Parent/closure owner หลัง operator fixture พร้อม: รัน direct verifier และ copy-only
provenance ใน authorized environment, รัน console wired suite โดย listener ได้,
ตรวจ exact bytes/hash แล้วจึงพิจารณา Task 8 closure และ Evidence แยกต่างหาก.

## Next Steps

1. รับ exact operator-supplied `test/golden` bytes + `_MANIFEST.sha256` จาก operator
   โดยไม่ให้ agent สร้างหรือแก้ bytes.
2. รัน `scripts/check-golden-manifests.sh <fixture>` และ production copy/provenance
   checks ใน environment ที่อนุญาต listener.
3. หากทุก gate ผ่าน ให้ parent เป็นผู้ตัดสินใจแก้ Evidence/flip Task 8; acceptance นี้
   ไม่ได้เปลี่ยน checkbox.
