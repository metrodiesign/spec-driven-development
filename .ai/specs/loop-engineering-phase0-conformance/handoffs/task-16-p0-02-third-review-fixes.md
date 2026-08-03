# Handoff: Task 16 P0-02 third review fixes
> From: Codex Task 16 implementation session   To: independent fresh-context reviewer   Date: 2026-07-27

## Task Summary

แก้ Task 15 findings H1 และ M1 ของ active spec
`loop-engineering-phase0-conformance` เท่านั้น ครอบ amended REQ-2.1–REQ-2.49:
ปิด exact installed-output set ของ offline dependency promotion และบังคับ one
monotonic deadline/AbortSignal ตลอด materialize-to-promote lifecycle

## Current Status

implementation และ sandbox-safe verification เสร็จแล้ว Task 2 ยังตั้งใจคง `[ ]`
เพื่อรอ independent fresh-context re-review และ external real-macOS evidence หลัง
account usage limit สิ้นสุด

## Files Changed

- `.ai/policies/security-plane.json` — edited — enumerate package-manager metadata paths และ validator identities ที่ production อนุญาต
- `console/backend/src/loop-cli.ts` — edited — parse/validate exact metadata policy แบบ fail-closed
- `console/backend/src/loop-cli.test.ts` — edited — production binding และ malformed metadata policy regressions
- `core/src/executor/command-executor.ts` — edited, shared untracked file — exact installed-output verifier, content validators และ one operation deadline/cancellation control
- `core/src/gates/frozen-tree.ts` — edited, shared untracked file — ส่ง remaining timeout/AbortSignal ผ่าน descriptor reads, Git plumbing และ materialization
- `core/src/security/amended-command-contract.test.ts` — edited, shared untracked file — RED/GREEN exact-set, metadata, descriptor/Git deadline และ lifecycle cancellation regressions
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — edited — append Third review-fix evidence โดยไม่ mark Task 2
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-16-p0-02-third-review-fixes.md` — created — handoff นี้

## Important Decisions

- diff exception สำหรับ persistent dependency output ใช้ exact path set ที่ผ่าน immutable-capture verification แล้วเท่านั้น ไม่ blanket-allow `node_modules`
- approved package files ต้องตรง path, mode, byte length และ SHA-256 จาก approved source snapshot; unexpected และ missing paths reject ทั้ง capture
- package-manager metadata ต้องถูก enumerate ใน production policy และผ่าน validator เฉพาะชนิด; copied lockfile hash ต้องตรง frozen lockfile ส่วน pnpm metadata ต้องตรง approved graph/settings และ constrained volatile fields
- deadline เริ่มก่อน approved-source traversal ใช้ `performance.now()` เป็น monotonic clock และแชร์ operation control เดียวผ่าน source capture, descriptor/Git/core children, inventory/copy/diff/evidence/promotion
- timeout และ external cancellation ใช้ typed `FrozenTreeOperationError`; child receives remaining budget plus `AbortSignal`; promotion checkpoints และ rollback ก่อน cleanup

## Constraints

- ห้าม mark Task 2 จน independent fresh-context review และ external real-macOS matrix ผ่านจริง
- ห้ามเริ่ม P0-03, commit, push, force-push หรือแก้ unrelated dirty worktree
- ห้าม retry/circumvent external real-macOS suite ก่อน recorded usage limit สิ้นสุด August 2 เวลา 11:46
- ต้องรักษา root authority byte-for-byte และห้ามแก้ old master/blueprint/archive

## Tests Run

- H1 RED exact-set focused -> `6` tests, `0` pass, `6` fail; sibling package/root file/metadata/binary ถูก promote ก่อนแก้
- H1 GREEN exact-set focused -> `6` pass, `0` fail; enumerated metadata content regression -> `1` pass, `0` fail
- M1 descriptor RED -> `3` tests, `0` pass, `3` fail; GREEN -> `3` pass, `0` fail
- M1 lifecycle cancellation RED -> `11` tests, `0` pass, `11` fail; GREEN -> `11` pass, `0` fail
- tiny shared Git deadline -> `1` pass, `0` fail พร้อม typed timeout และ empty attempt root
- `pnpm --filter core exec node --test --test-reporter spec src/security/amended-command-contract.test.ts src/gates/frozen-tree.test.ts src/security/command-runner.test.ts src/security/sandbox.test.ts src/executor/path-policy.test.ts src/executor/executor.test.ts src/gates/runner.test.ts src/audit/oob.test.ts test/fault-injection.test.ts` -> `144` tests, `136` pass, `0` fail, `8` external skips
- `pnpm --filter core test` -> `386` tests, `377` pass, `0` fail, `9` external skips
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts` -> `11` pass, `0` fail
- `pnpm --filter aal test` -> `143` pass, `0` fail
- typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- test: focused/full commands above -> pass
- `pnpm lint` -> `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh` -> pass
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria covered, EARS lint pass
- `.ai/bin/check-secrets.sh --all` and `git diff --check` -> exit `0`
- authority `cmp` -> exit `0`; SHA-256 -> `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Known Issues

- external real-macOS SBPL/descendant/offline matrix ยัง blocked ด้วย recorded account
  usage limit ถึง August 2 เวลา 11:46 และไม่ได้ retry; managed-sandbox skips ไม่ใช่
  external PASS
- known residual เดิมยังคงอยู่: descendant ที่สร้าง new session อาจรักษา CPU/process
  lifetime หลัง direct-child cleanup แต่ inherited SBPL และ disposable capture ยังจำกัด
  unauthorized durable filesystem/network effects

## Next Recommended Agent

independent fresh-context reviewer สำหรับ review-only ของ current P0-02 H1/M1 closure
ก่อนรัน external real-macOS matrix เมื่อ usage limit เปิด

## Next Steps

1. อ่าน `AGENTS.md`, shared docs, active requirements/design/tasks และ handoff Task 15/16 แล้ว reconcile `git status --short` กับ untracked shared files
2. rerun focused exact-set/deadline/cancellation tests และ inspect policy-derived exact output set, metadata validators, shared monotonic deadline, child abort/reap, promotion rollback และ cleanup paths
3. เมื่อถึงเวลาที่ usage limit เปิด ให้รัน external real-macOS SBPL/descendant/offline matrix จริง; อย่าใช้ managed-sandbox skips แทน
