# Handoff: Task 59 — P0-08 review fixes
> From: Codex implementation worker  To: parent / fresh-context acceptance owner  Date: 2026-08-02

## ขอบเขต

แก้ High/Medium findings จาก `task-58-p0-08-review.md` โดยคง Task 8 ใน
`tasks.md` เป็น `[ ]` และไม่สร้าง operator golden bytes ใหม่:

- operational fixture/CLI ไม่สร้างหรือใช้ synthetic golden truth โดยปริยายอีกต่อไป;
  ต้องส่ง `operatorGoldenFixtureDir` และ fail closed ด้วย `operator_golden_fixture_missing`;
- synthetic fixture ถูกแยกเป็น `makeSyntheticFixtureRepoForTests()` และต้องเปิดผ่าน
  `syntheticGoldenFixtureForTests: true` ใน test seam เท่านั้น;
- `LoopRunResult.goldenFixture` และ event `GOLDEN_FIXTURE_PROVISIONED` ผูก source,
  `sourceHash`, `manifestHash`, attribution และ evidence ref เข้ากับ production run;
- CLI เพิ่ม `--operator-golden-fixture <path>` และแสดง provenance report.

## ไฟล์ที่แก้

- `console/backend/src/loop-run.ts`
- `console/backend/bin/platform.ts`
- `core/src/types.ts`
- `console/backend/src/golden.fixture.test.ts`
- test seams ใน `console/backend/src/{loop-run,loop-run-graph,loop-run-graph.fault-injection,loop-run-lease,fusion,loop-cli}.test.ts`

## Evidence

- `pnpm --filter core exec node --test --test-reporter spec src/gates/golden.test.ts src/calibration/calibration.test.ts` — 24 passed, 0 failed; direct script tamper/edit/delete/add/symlink cases pass.
- `pnpm --filter core test` — 564 tests, 555 passed, 0 failed, 9 explicit skips.
- `pnpm --filter aal test` — 148 passed, 0 failed.
- `pnpm typecheck` — all workspace typechecks passed; `pnpm lint` — no issues; `git diff --check` — clean.
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` — exit 0.
- `scripts/check-golden-manifests.sh` with no configured fixture — exit 2, `operator_golden_fixture_missing` (expected blocker).
- `pnpm --filter console-backend typecheck` — exit 0.
- Focused `console/backend/src/golden.fixture.test.ts` — provenance result/event and missing-fixture blocker tests pass.
- Focused console golden/provenance suites pass. The broader console loop integration run was attempted (80 tests: 38 passed, 42 failed at the existing Human Plane listener with `listen EPERM`); those environment-blocked cases are not treated as pass.

## คงค้าง / acceptance

- ยังไม่มี operator-supplied golden fixture bytes; ห้าม flip Task 8 หรืออ้าง Phase 0 conformance complete.
- Parent fresh-context acceptance ต้องรัน full core/AAL/console suites, typechecks, lint,
  Evidence gate และ diff review ใน environment ที่อนุญาต listener.
- ห้าม commit/push จาก handoff นี้.
