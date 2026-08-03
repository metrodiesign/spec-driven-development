# Handoff Note: Task 35 P0-04 Evidence Authentication

## Task Summary

ทำ Task 4 ของ spec `loop-engineering-phase0-conformance` ให้ครบ REQ-4.1–REQ-4.13 โดยทำ evidence blob publication แบบ atomic/exclusive, เพิ่ม per-run Ed25519 authentication ด้วย Node built-in, และตรวจ dereference, content hash, frozen public-key fingerprint และ signature ทุก trust boundary ก่อน state advancement, approval, merge, audit และ completion

## Current Status

done — production path และ fault matrix ผ่าน, Task 4 ถูกทำเครื่องหมาย `[x]` พร้อม Evidence; ไม่มี commit หรือ push

## Files Changed

- `core/src/evidence/store.ts`, `core/src/evidence/store.test.ts` — hardened content-addressed store, exclusive publication, existing-byte verification, no-follow reads และ typed errors
- `core/src/evidence/auth.ts`, `core/src/evidence/auth.test.ts` — per-run Ed25519 key lifecycle, frozen metadata/fingerprint, recovery และ canonical encoding
- `core/src/gates/report-integrity.ts`, `core/src/gates/report-integrity.test.ts` — signed report envelope, content hashes, dereference/signature verification และ structured errors
- `core/src/gates/runner.ts`, `core/src/orchestrator/loop.ts`, `core/src/human/api.ts` พร้อม tests — sign gate result และ fail closed ก่อน state/approval boundaries
- `core/src/merge/queue.ts`, `core/src/merge/auto-merge.ts`, `core/src/audit/oob.ts` พร้อม tests — verify ก่อน queue, merge, audit และ completion พร้อม structured escalation
- `core/src/types.ts`, `core/src/index.ts`, `core/test/helpers/fixture.ts` — public types/exports และ authenticated test fixture
- `core/test/fault-injection.test.ts`, `core/test/repair-loop.test.ts`, `core/test/steering-loop.test.ts` — wired forged/missing/tampered faults และ fixture composition
- `aal/test/integration.test.ts`, `console/backend/src/fusion.ts`, `console/backend/src/loop-run.ts` พร้อม related tests — thread authenticator/integrity instance เดียวตลอด run และ recovery
- `core/src/executor/executor.test.ts` — ปรับ regression assertion ให้ตรวจ `EvidenceStoreError.code === 'missing_blob'`
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — Task 4 status และ Evidence
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-35-p0-04-evidence-auth.md` — handoff นี้

## Important Decisions

- ใช้ `node:crypto` Ed25519 เท่านั้นตาม REQ-4.13; ไม่มี third-party dependency
- private key อยู่ที่ run state นอก supplied worktrees, mode `0600`; metadata มี public key/fingerprint แบบ immutable mode `0444`; recovery ต้องใช้ key เดิมและตรวจคู่ public/private
- canonical signed bytes ใช้ version `canonical-json-v1`; object keys เรียงแบบ deterministic และ arrays คงลำดับ
- report signature ครอบคลุม run/task/tier/config/commit/worktree/env/verdicts, evidence refs และ SHA-256 ของ content ที่ dereference จริง
- OOB audit คง detection-only contract เดิม: append structured `ESCALATED` โดยไม่แก้ task state โดยตรง
- merge queue เป็นเจ้าของ escalation event ใน queue rejection; caller ไม่ append ซ้ำ

## Constraints

- ต้องรักษา dirty shared worktree ของ P0-02/P0-03; ห้าม revert งานของ owner อื่น
- ห้าม commit/push โดยไม่มี review และห้าม push ตรง `main`/`develop`
- ห้ามเริ่ม P0-05 ใน handoff นี้
- P0-02 external real-macOS cooldown ถูกบันทึกถึง 2026-08-03 20:18 Asia/Bangkok; ห้าม retry/circumvent ก่อนเวลาและห้ามอ้าง managed-sandbox skip เป็น PASS

## Tests Run

- RED primitives: `pnpm --filter core exec node --test --test-reporter spec src/evidence/store.test.ts src/evidence/auth.test.ts src/gates/report-integrity.test.ts` -> `3` pass, `3` fail
- GREEN primitives: command เดิม -> `13` pass, `0` fail
- REQ-4 boundary faults: `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern='REQ-4.9-4.13' src/merge/queue.test.ts src/merge/auto-merge.test.ts` -> `3` pass, `0` fail
- merge composition: `pnpm --filter core exec node --test --test-reporter spec src/merge/queue.test.ts src/merge/auto-merge.test.ts` -> `22` pass, `0` fail
- rollback regression: `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern='persistent rollback validates every evidence blob' src/executor/executor.test.ts` -> `1` pass, `0` fail
- full core: `pnpm --filter core exec node --test --test-reporter dot 'src/**/*.test.ts' 'test/**/*.test.ts'` -> exit `0`
- full AAL: `pnpm --filter aal test` -> `143` pass, `0` fail
- full console backend: `pnpm --filter console-backend test` -> exit `0`
- typecheck: `pnpm typecheck` -> pass
- lint: `pnpm lint` -> pass
- security/vendor/spec gates: `.ai/bin/check-secrets.sh --all`, `scripts/check-core-vendor-free.sh`, strict Evidence validation, `git diff --check`, `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> pass

## Known Issues

- P0-04 ไม่มี known functional issue
- P0-02 real-macOS verification ยัง blocked ด้วย cooldown ภายนอกตามบันทึกเดิม; Task 2 ต้องคง `[ ]`

## Next Recommended Agent

human review หรือ fresh-context code/security reviewer

## Next Steps

1. ตรวจ Task 35 diff และ Evidence แบบ fresh context โดยไม่แก้ shared P0-02/P0-03 worktree
2. เมื่อ review ผ่าน จึงรับ P0-05 ตาม dependency order; อย่าเริ่มก่อน explicit assignment/approval
