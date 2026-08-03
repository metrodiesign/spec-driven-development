# Handoff: Task 57 — P0-08 golden truth + paired coverage implementation
> From: Codex implementation worker  To: parent / fresh-context reviewer  Date: 2026-08-02

## Task Summary

เริ่ม implementation ของ Task 8 (P0-08) ใน `loop-engineering-phase0-conformance`
สำหรับ REQ-8.1–REQ-8.11: verifier ของ `_MANIFEST.sha256` ทุก configured root,
direct CI invocation, copy-only operator fixture, unique-AC paired coverage,
source/hash provenance และ explicit missing-fixture blocker. Task 8 ยังคง `[ ]`
เพราะยังไม่มี operator-supplied golden bytes ใน repo/working tree.

## Current Status

`IMPLEMENTED — READY FOR FRESH REVIEW`, แต่ยังไม่ปิด task. RED tests ถูกเขียนก่อน
production implementation และ GREEN focused suites ผ่านแล้ว. Verifier ตรวจ set ของ
ไฟล์/bytes/manifest formatting; optional trusted manifest hash และ direct CI script
จับการ rewrite manifest ได้ด้วย baseline จาก git เมื่อ fixture ถูก track. Runtime
ไม่มี public `computeGoldenManifest` export; `copyOperatorGoldenFixture` validate
operator bytes แล้ว copy manifest/file bytes แบบ exact เท่านั้น. ไม่มี fixture bytes
ใหม่ถูกสร้างขึ้นเพื่อปิดงานนี้.

## Files Changed

- `core/src/gates/golden.ts` — edited — strict root/multi-root verifier, trusted
  manifest-hash check, copy-only provisioner, provenance/error types.
- `core/src/gates/golden.test.ts` — edited — RED/GREEN manifest edit/delete/add,
  trusted manifest rewrite, exact copy, source/hash, missing operator blocker, direct
  CI script tests.
- `core/src/calibration/calibration.ts` — edited — `GoldenCoverage`, unique-ID
  numerator/denominator calculator, `CalibrationResult.goldenCoverage`.
- `core/src/calibration/calibration.test.ts` — edited — duplicate/out-of-scope/zero
  denominator paired coverage cases.
- `core/src/index.ts` — edited — export verifier/provisioner/coverage APIs; removed
  `computeGoldenManifest` from public core surface.
- `console/backend/src/loop-run.ts` — edited — optional operator fixture path and
  copy-only provenance in `makeFixtureRepo`; run calibration now passes contract/graph
  AC IDs; `requireOperatorGoldenFixture` emits explicit blocker error.
- `console/backend/src/golden.fixture.test.ts` — created — composition exact-byte and
  missing-fixture tests.
- `scripts/check-golden-manifests.sh` — created executable — direct configured-root
  verifier, tracked-manifest baseline check, source/hash report, missing blocker.
- `.github/workflows/ci.yml` — edited — unconditional direct golden-manifest step.

## Important Decisions

- The existing synthetic `makeFixtureRepo()` default remains only for pre-P0-08 CI
  harness compatibility and is explicitly labeled synthetic in comments. Operational
  callers pass `operatorGoldenFixtureDir`; that path never regenerates a manifest.
- `copyOperatorGoldenFixture` refuses missing/invalid source or non-empty target with
  typed `GoldenFixtureError`; it reports `source`, tree `sourceHash`, manifest hash,
  file count and `attribution: operator-supplied`.
- Local verifier accepts an optional trusted manifest hash because a mutable actor can
  rewrite both file and manifest. The shell CI gate additionally compares tracked
  manifest bytes to `HEAD`; a rewritten manifest therefore fails even when its content
  agrees with current files.
- `computeGoldenCoverage` intersects/deduplicates golden IDs with unique in-scope IDs;
  zero denominator returns `{rate: 0}`. `heldOutPassRate` remains paired beside this
  object without deriving denominator from executed task count.
- CI invocation is intentionally unconditional. With no operator fixture it exits `2`
  and prints `operator_golden_fixture_missing`, preserving the required blocker rather
  than accepting an empty truth set.

## Constraints

- Keep Task 8 checkbox `[ ]`; do not add Evidence/close until operator supplies exact
  golden bytes and a fresh-context review/acceptance authorizes closure.
- Do not fabricate, regenerate, weaken, or label synthetic bytes as human/operator
  truth. Do not retry external P0-02 macOS verification or touch its blocker.
- No dependency, lockfile, authority, or secret changes. Do not commit or push.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/gates/golden.test.ts src/calibration/calibration.test.ts` -> `24` passed, `0` failed.
- `pnpm --filter console-backend exec node --test --test-reporter spec src/golden.fixture.test.ts` -> `3` passed, `0` failed.
- `pnpm --filter core typecheck` -> exit `0`.
- `pnpm --filter console-backend typecheck` -> exit `0`.
- `pnpm lint` -> `ESLint: No issues found`.
- `scripts/check-core-vendor-free.sh` -> `OK: core/ and aal/ are vendor-name-free (INV-7)`.
- `pnpm --filter aal test` -> `148` passed, `0` failed.
- `pnpm --filter core test` (after main implementation; final symlink/test-only hardening
  was then rerun in the focused suite) -> `560` tests, `551` passed, `0` failed, `9`
  explicit external-only skips.
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria covered; EARS lint passed.
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit `0`.
- `scripts/check-golden-manifests.sh` (repo default with no operator fixture) -> exit `2`,
  `BLOCKED: operator_golden_fixture_missing` (expected explicit blocker).
- Temporary operator root through `scripts/check-golden-manifests.sh <root>` -> valid
  manifest exit `0`; byte tamper exit `1` with `golden_manifest_mismatch`.
- `git diff --check` -> exit `0` for the P0-08 edits.
- Console loop integration tests remain environment-blocked by `listen EPERM` in the
  managed sandbox as recorded by prior handoffs.

## Known Issues

- No operator golden fixture exists yet, so direct CI and P0-08 closure are intentionally
  blocked. This is a requirement outcome, not a test failure to bypass.
- `makeFixtureRepo()` synthetic default remains for historical tests; a follow-up should
  migrate those callers to an operator fixture or an explicitly labeled non-operational
  harness before P0-10 closure.
- Fresh correctness/security review is still required, including manifest path/symlink
  edge cases, expected-hash trust-anchor use, script shell portability, and composition
  calibration coverage on graph subsets.

## Next Recommended Agent

Fresh-context correctness/security reviewer for P0-08, followed by an acceptance owner
only after operator fixture bytes are supplied. Do not mark Task 8 complete from this
handoff alone.

## Next Steps

1. Re-read this handoff, REQ-8/design golden sections, and current Task 8 block; inspect
   `git status --short --untracked-files=all`.
2. Run focused core/console tests and review `scripts/check-golden-manifests.sh` in an
   isolated git fixture for edit/delete/add and manifest rewrite paths.
3. Obtain exact operator golden directory + manifest bytes; run copy/provenance and
   direct CI checks in an authorized environment, then decide whether Task 8 can close.
