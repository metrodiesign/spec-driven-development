# Implementation Tasks: Confirmed repository audit defects

> Status: approved 2026-07-23

> ทุก task เป็น cohesive behavior slice ใช้ regression test ที่ RED ก่อน fix และ GREEN หลัง fix
> โดยไม่เพิ่ม dependency หรือแก้ reported-only candidates

- [x] 1. Guard normalization — เพิ่ม adversarial regression cases สำหรับ quoted, escaped และ
     absolute-path `git` executable; ตรวจทุก `DELETE FROM` span แยกกัน; แก้ root cause ใน
     `check-bypass.sh` และ `check-destructive.sh` โดยคง allow/block behavior เดิม
     Satisfies: F1, F2, B1, B2, B3.
     Verify: `bash .claude/hooks/tests/hook-bypass-guard.test.sh` และ
     `bash .claude/hooks/tests/destructive-guard.test.sh`
     Evidence:
       - test: tests-only RED — `bash .claude/hooks/tests/hook-bypass-guard.test.sh` -> 94 passed / 12 failed; `bash .claude/hooks/tests/destructive-guard.test.sh` -> 152 passed / 2 failed; หลังแก้ GREEN — destructive -> 154 passed / 0 failed; bypass รอบแรก -> 106 passed / 0 failed; review regression สำหรับ split-quoted/quoted-absolute `git -n` RED 106/4 แล้ว final GREEN 110/0
       - viewports: n/a — logic-only Bash guards
       - deviations: none

- [x] 2. Sequence-aware consent diff — เพิ่ม reorder และ duplicate-count regression cases;
     เปลี่ยน `jsonDiffPreview` เป็น deterministic sequence diff ที่คง `{ removed, added }` API
     และ exact-content consent token
     Satisfies: F3, F4, B4, B5.
     Depends on: 1.
     Verify: `node --test --test-reporter spec console/backend/src/surfaces.test.ts`
     Evidence:
       - test: tests-only RED — verify command -> 7 passed / 2 failed; หลัง LCS sequence fix GREEN -> 9 passed / 0 failed; review resource-bound regression RED 9/1 แล้ว bounded flat-matrix/full-replacement fix GREEN 10/0; `CI=true ./node_modules/.bin/tsc -p console/backend/tsconfig.json --noEmit` -> exit 0
       - viewports: n/a — logic-only deterministic line diff
       - deviations: none

- [x] 3. Fail-closed auth boundaries/config — เพิ่ม exact-expiry tests สำหรับ session, OIDC JWT
     และ pending cookie; เพิ่ม mode `0600`, empty required value และ downstream startup tests;
     แก้ comparators และ config loader โดยไม่เปลี่ยน generic rejection หรือ issuer pin
     Satisfies: F5, F6, F7, F8, F9, F10, B6, B7, B8, B9, B10.
     Depends on: 2.
     Verify: `node --test --test-reporter spec console/backend/src/auth/provider.test.ts console/backend/src/auth/oidc.test.ts console/backend/src/security.test.ts`
     Evidence:
       - test: tests-only RED — auth provider/OIDC command -> 21 passed / 5 failed; หลัง comparator + `0600` + non-empty validation fix GREEN — verify command -> 38 passed / 0 failed; `CI=true ./node_modules/.bin/tsc -p console/backend/tsconfig.json --noEmit` -> exit 0
       - viewports: n/a — logic-only auth verification/config/startup gate
       - deviations: no secret entropy/minimum-length policy added; scope requires non-empty only

- [x] 4. Repository policy alignment — ทำ full lint ไม่อ่าน `.claude/worktrees/**`; เพิ่ม
     blocking production audit ระดับ `high` ใน CI; แก้ CI/security documentation ให้ตรง manifests,
     runtime dependencies และ lint จริง; เพิ่ม policy regression checks
     Satisfies: F11, F12, F13, B11, B12, B13.
     Depends on: 3.
     Verify: `pnpm lint` และ `bash .claude/hooks/tests/repo-policy-alignment.test.sh`
     Evidence:
       - test: tests-only RED — policy test -> 10 passed / 5 failed; full ESLint -> 1 parsing error จาก ignored worktree; หลังแก้ GREEN — policy test -> 17 passed / 0 failed รวม clean-verify-job-safe check ที่ไม่ import dependencies; `CI=true rtk proxy pnpm lint` -> exit 0
       - viewports: n/a — repository config/CI policy/docs
       - deviations: local `pnpm audit --prod --audit-level high` ยืนยันผล advisory ไม่ได้ เพราะ sandbox DNS `ENOTFOUND` และ network escalation ถูกปฏิเสธ; command ถูก wire เป็น blocking CI step และต้องพิสูจน์จาก PR check

- [x] 5. Null-byte cleanup + full assembly — เปลี่ยน source sentinel ให้ไม่มี literal NUL โดยคง
     permission glob semantics; เพิ่ม no-warning regression; รัน spec trace, full shell suite,
     vendor check, install, typecheck, lint, workspace tests, lessons coverage และ secret scope;
     ตรวจ diff ไม่แตะ reported-only behavior, manifests หรือ lockfile
     Satisfies: F14, B14, B15, B16, B17.
     Depends on: 4.
     Verify: `scripts/spec-trace.sh bugfix-confirmed-repo-audit` และ full success-criteria suite
     Evidence:
       - test: tests-only RED — `bash .claude/hooks/tests/null-byte-secret-scan.test.sh` -> 1 passed / 1 failed; หลัง escaped-source sentinel fix GREEN — command เดิม -> 2 passed / 0 failed; `node --test --test-reporter spec console/backend/src/govern.test.ts` -> 6 passed / 0 failed; `bash .claude/hooks/tests/secrets-guard.test.sh` -> 33 passed / 0 failed
       - test: full gates หลัง review fixes — `scripts/check-core-vendor-free.sh` -> OK; `CI=true rtk proxy pnpm install --frozen-lockfile` -> 311 packages reused, lockfile current; `CI=true rtk proxy pnpm typecheck` -> 6 workspace projects passed; `CI=true rtk proxy pnpm lint` -> exit 0; `CI=true rtk proxy pnpm -r test` -> 6 workspace projects passed, 0 failed รวม console/backend 344/0 และ console/web 74/0; full `.claude/hooks/tests/*.test.sh` sweep -> 14 files passed; `scripts/lessons-coverage-check.sh` -> OK; `scripts/ci-secret-scope.sh push develop` -> exit 0 without warning; tracked shell `bash -n` sweep -> exit 0
       - review: code/security review รอบแรกพบ 3 blockers — clean verify job dependency, unbounded LCS allocation และ split-quoted short-flag bypass; แก้พร้อม regression tests แล้ว review รอบสองไม่พบ actionable finding
       - viewports: n/a — logic/config/CI changes only
       - deviations: `scripts/spec-trace.sh` exits 0 แต่ประกาศ skip bugfix specs; supplemental stable-ID audit พบ F/B IDs 31/31 อยู่ใน `Satisfies:` ครบ ไม่มี missing; local dependency audit result ยังรอ PR CI ตาม Task 4

## Suggested execution batch

Tasks 1-5 เป็น audit bugfix batch เดียว ใช้ shared regression corpus และ full verification:
`/spec-implement all`
