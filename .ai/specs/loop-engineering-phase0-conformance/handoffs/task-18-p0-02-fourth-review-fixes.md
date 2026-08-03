# Handoff: Task 18 P0-02 fourth review fixes
> From: Codex Task 18 implementation session   To: independent fresh-context acceptance reviewer   Date: 2026-07-27

## Task Summary

แก้ Task 17 acceptance findings H1, M1 และ M2 ของ active spec
`loop-engineering-phase0-conformance` เท่านั้น ครอบ amended REQ-2.1–REQ-2.49:
ผูก durable action identity/recovery กับ ignored persistent dependency outputs, reject
unsupported filesystem objects ที่ Git ไม่ enumerate และขยาย monotonic
deadline/AbortSignal ให้ครอบ public Executor lifecycle

## Current Status

implementation, RED/GREEN regressions, full core verification และ local
correctness/security review เสร็จแล้ว Task 2 ยังตั้งใจคง `[ ]` เพื่อรอ independent
fresh-context acceptance re-review และ external real-macOS evidence หลัง account usage
limit สิ้นสุด

## Files Changed

- `core/src/executor/executor.ts` — edited — complete artifact identity, persistent-root snapshot/restore, recovery invalidation, duplicate reconciliation และ public operation control
- `core/src/executor/executor.test.ts` — edited — public regressions สำหรับ persistent mutation/deletion/addition, duplicate, evidence failure, crash replay, pre-abort, tiny deadline และ post-promotion abort
- `core/src/executor/command-executor.ts` — edited, shared untracked file — รับ public-owned operation control โดย direct callers ยังคงได้ bounded internally owned control
- `core/src/gates/frozen-tree.ts` — edited, shared untracked file — descriptor/no-follow full-filesystem shape/limit audit และ reusable monotonic operation control
- `core/src/gates/frozen-tree.test.ts` — edited, shared untracked file — ignored-object independent limit regression
- `core/src/security/amended-command-contract.test.ts` — edited, shared untracked file — FIFO และ ignored socket whole-artifact rejection regressions
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — edited — append Fourth review-fix evidence โดยไม่ mark Task 2
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-18-p0-02-fourth-review-fixes.md` — created — handoff นี้

## Important Decisions

- authoritative action identity เป็น SHA-256 ของ versioned tuple ที่ประกอบด้วย exact
  frozen `treeHash`, `inventoryHash` และ sorted declared persistent roots; command diff
  hash ยังเป็น capture evidence ไม่ใช่ durable result identity
- pre-intent recovery snapshot แยก Git commit สำหรับ tracked/non-ignored state ออกจาก
  content-addressed EvidenceStore manifest ของ owned ignored roots; rollback ใช้
  `git clean -fd` แล้วลบ/restore เฉพาะ declared roots ห้ามใช้ broad `-x`
- persistent manifest รับเฉพาะ safe relative regular files, exact mode/bytes/SHA-256
  และ content ref; validate ทุก entry/blob ก่อนเปลี่ยน root เพื่อไม่ลบ good state เมื่อ
  evidence ขาดหรือเสีย
- stale `ACTION_APPLIED` ถูก invalidate ด้วย explicit event sequence metadata หลัง
  successful rollback; rejection อื่นที่ใช้ action ID เดียวกันไม่ invalidate ผลเก่า
- frozen-tree audit enumerate ทุก filesystem entry ผ่าน directory descriptors และ
  `O_NOFOLLOW`, reject unsupported shape ก่อน Git inventory และบังคับ capture limits
  กับ ignored paths ด้วย
- `RUN_COMMAND` public boundary เป็น owner ของ operation control เดียว; direct
  `CoreCommandExecutor` tests/callers ที่ไม่ส่ง control ยังได้ internal owner เพื่อคง
  compatibility; timeout-triggered rollback ใช้ bounded core-only reconciliation

## Constraints

- ห้าม mark Task 2 จน independent fresh-context acceptance review และ external
  real-macOS matrix ผ่านจริง
- ห้ามเริ่ม P0-03, commit, push, force-push หรือแก้ unrelated dirty worktree
- ห้าม retry/circumvent external real-macOS suite ก่อน recorded usage limit สิ้นสุด
  August 2 เวลา 11:46
- ต้องรักษา root authority byte-for-byte และห้ามแก้ old master/blueprint/archive

## Tests Run

- initial focused RED -> `11` tests, `1` pass, `10` fail; ignored persistent identity,
  recovery residue, public cancellation/deadline และ FIFO cases discriminated findings
- final focused acceptance subset -> `14` tests, `14` pass, `0` fail
- `pnpm --filter core exec node --test --test-reporter spec src/security/amended-command-contract.test.ts src/gates/frozen-tree.test.ts src/security/command-runner.test.ts src/security/sandbox.test.ts src/executor/path-policy.test.ts src/executor/executor.test.ts src/gates/runner.test.ts src/audit/oob.test.ts test/fault-injection.test.ts` -> `158` tests, `150` pass, `0` fail, `8` external skips
- test: `pnpm --filter core test` -> `400` tests, `391` pass, `0` fail, `9` external skips
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts` -> `11` pass, `0` fail
- `pnpm --filter aal test` -> `143` pass, `0` fail
- typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- `pnpm lint` -> exit `0`
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

independent fresh-context acceptance reviewer สำหรับ review-only ของ current P0-02
Task 17 H1/M1/M2 closure ก่อนรัน external real-macOS matrix เมื่อ usage limit เปิด

## Next Steps

1. อ่าน `AGENTS.md`, shared docs, active requirements/design/tasks และ handoff Task 15–18 แล้ว reconcile `git status --short` กับ shared untracked files
2. rerun public identity/recovery/FIFO/socket/deadline tests และ inspect content-addressed persistent manifest, exact owned-root restore, full-filesystem descriptor traversal, one public operation control, typed timeout/cancellation และ bounded reconciliation
3. เมื่อถึงเวลาที่ usage limit เปิด ให้รัน external real-macOS SBPL/descendant/offline matrix จริง; อย่าใช้ managed-sandbox skips แทน
