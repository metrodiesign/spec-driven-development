# Handoff: Task 26 — P0-03 admission reconciliation fix

> From: Codex implementation agent
> To: independent fresh-context correctness/security reviewer
> Date: 2026-07-27

## Task Summary

แก้ Task 25 High ที่ public mutating admission รับ distinct `actionId` บน
authoritative artifact ซึ่งไม่ตรงกับ latest active `ACTION_APPLIED.resultHash` แล้ว
สร้าง snapshot/intent/result identity รุ่นใหม่ที่ seal external tamper จน recovery
ภายหลังรายงาน false consistency

ขอบเขตจำกัดที่ `createExecutor.execute`, `recoverWorktree`, executor recovery tests
และ durable evidence ของ Task 26 โดยรักษา Task 21 patch isolation/path/cancellation,
Task 23 ordered multi-intent recovery, duplicate idempotency และ `READ_FILE`
non-mutating exception

## Current Status

Implementation และ local verification เสร็จแล้ว รอ independent fresh-context
acceptance re-review

- Task 25 High ถูกแก้ใน local worktree
- local code review ไม่เหลือ actionable finding ในขอบเขต Task 26
- Task 3 ยังคง `[ ]`
- P0-04 ยังไม่เริ่ม
- ไม่มี commit หรือ push

## Files Changed

- `core/src/executor/executor.ts` — เพิ่ม unconditional mutating admission
  reconciliation, complete artifact identity check, restore/replay/fail-closed report
  และ shared timeout/cancellation control (edited)
- `core/src/executor/executor.test.ts` — เพิ่ม RED/GREEN distinct-action admission,
  ignored-root/mutator matrix, fast path, duplicate, timeout/cancellation,
  reconciliation failure/restart และ legacy dangling-snapshot regressions (edited)
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — เพิ่ม
  `Admission reconciliation-fix evidence (awaiting fresh re-review)` ใต้ Task 3 โดย
  ไม่เปลี่ยน checkbox (edited)
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-26-p0-03-admission-reconcile-fix.md`
  — handoff นี้ (new)

ไฟล์อื่นใน shared dirty worktree เป็นงานเดิมจาก Tasks 01–25 และไม่ได้ revert หรือ
ถือสิทธิ์เป็นงาน Task 26

## Important Decisions

- ทุก action ที่ไม่ใช่ `READ_FILE`/`REQUEST_TOOL` ถูกถือเป็น mutating admission
  และต้อง reconcile ก่อน duplicate, policy/preflight, snapshot และ
  `ACTION_INTENT`
- public action หนึ่งครั้งใช้ `FrozenTreeOperationControl` เดียวครอบ identity
  capture, rollback/replay, preflight, snapshot, apply และ final identity เพื่อให้
  deadline/cancellation ไม่รีเซ็ตกลางทาง
- no-dangling mismatch ย้อนกลับไป exact intent ของ latest active non-blob
  `ACTION_APPLIED`, replay accepted/rejected suffix ตาม causal `intentSeq` และรับ B
  ต่อเมื่อทุก accepted hash กับ final authoritative identity ตรง
- dangling recovery ย้อน boundary เพิ่มถึง preceding active applied generation เพื่อ
  ไม่เชื่อ legacy snapshot ที่อาจดูด external tamper ก่อน intent
- recovery failure rollback earliest boundary, invalidate accepted suffix และปิด
  dangling generation ก่อน reject current admission โดยไม่สร้าง current intent หรือ
  side effect
- ordinary coherent duplicate ยังคง `skipped_duplicate`; stale duplicate หลัง
  identity mismatch ถูก restore แล้ว refuse ตาม behavior ที่ Task 18 ยืนยันไว้

## Constraints

- ห้าม mark Task 3 complete ก่อน independent fresh-context acceptance re-review
- ห้ามเริ่มหรือรวม P0-04 ใน review นี้
- ห้าม commit, push ตรง `main`/`develop`, force push หรือ revert shared work
- external P0-02 real-macOS suite ยัง blocked ถึง 2026-08-02 11:46
  Asia/Bangkok; ห้าม retry/circumvent ก่อนเวลานั้นและห้ามอ้าง managed skips/EPERM
  เป็น real-macOS PASS
- authority ต้องคง byte-identical SHA-256
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Tests Run

- exact initial RED:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'admission restores the last applied artifact before accepting a distinct mutation' src/executor/executor.test.ts`
  -> `1` test, `0` pass, `1` fail; A ยังคง `external tamper\n`
- exact initial GREEN: command เดิม -> `1` pass, `0` fail
- review-edge RED:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'dangling recovery replays the preceding accepted identity' src/executor/executor.test.ts`
  -> `1` test, `0` pass, `1` fail; legacy B snapshot คง tampered A
- review-edge GREEN กับ multi-intent regressions -> `5` pass, `0` fail
- focused REQ-3:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts`
  -> `60` tests, `60` pass, `0` fail
- full executor: `83` tests, `82` pass, `0` fail, `1` explicit external-only skip
- fault injection: `24` tests, `19` pass, `0` fail,
  `5` explicit external-only skips
- full core: `pnpm --filter core test` -> `460` tests, `451` pass,
  `0` fail, `9` explicit external-only skips
- focused backend:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts`
  -> `11` pass, `0` fail
- AAL: `pnpm --filter aal test` -> `143` pass, `0` fail
- typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- lint: `pnpm lint` -> exit `0`
- `scripts/check-core-vendor-free.sh` -> pass
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria
  covered และ EARS lint pass
- `.ai/bin/check-secrets.sh --all` -> exit `0`
- `git diff --check` -> exit `0`
- root gate: `scripts/ci-test-scope.sh push develop` เลือก full suiteและจบ non-zero
  เฉพาะ known managed-sandbox console-backend `listen 127.0.0.1`/`uv_uptime`
  `EPERM`; focused backend และ full core ผ่าน
- authority external/root `cmp` -> exit `0`; SHA-256 ตรงค่าด้านบน

## Known Issues

- ไม่มี known functional issue ที่ยังค้างใน Task 25 High หลัง local review
- Task 3 ยังต้องผ่าน independent fresh-context acceptance re-review
- external P0-02 real-macOS acceptance ยัง blocked ถึงเวลาที่ระบุ และไม่ได้ retry

## Next Recommended Agent

independent fresh-context correctness/security reviewer สำหรับ P0-03 admission,
artifact identity, causal recovery และ audit integrity

## Next Steps

1. อ่าน authority, approved spec, handoffs Task 01–26 และตรวจ full current diff แบบ
   fresh context
2. reproduce exact A/tamper/distinct B probe ผ่าน public executor และตรวจว่า A ถูก
   restore ก่อน B, B ไม่ seal tamper, causal log coherent และ recovery ซ้ำเป็น no-op
3. ตรวจ ignored-root mutation/deletion/addition, mutator ทั้งสามชนิด, no-tamper
   fast path, duplicate, timeout/cancellation, fail-closed และ legacy dangling
   boundary
4. รัน focused/full core และ static gates แล้วคง Task 3 `[ ]` หากยังมี actionable
   finding หรือ external blocker
