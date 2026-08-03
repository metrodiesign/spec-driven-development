# Handoff: Task 45 — P0-05 acceptance re-review

- วันที่: 2026-08-02
- ผู้ตรวจ: Codex fresh-context correctness/security reviewer
- ขอบเขต: Task 44 fixes, Task 42 implementation, REQ-4.12 และ REQ-5.1–REQ-5.10
- สถานะการแก้: read-only ต่อ production/tests/requirements/design/tasks; เพิ่มเฉพาะ
  handoff นี้

## Verdict

`APPROVE_WITH_EXTERNAL_BLOCKER`

- Critical: 0
- High: 0
- Medium: 0
- Low: 0

Task 44 ปิดช่องว่างจาก Task 43 ครบทั้งสามข้อด้วย regression ที่ตรวจ observable
behavior และไม่มี production change เพิ่มเติมจาก Task 42. Task 5 ยังต้องคง `[ ]`
จน parent เป็นผู้เพิ่ม Evidence/flip checkbox ตาม approval boundary.

External blocker เป็นของ P0-02 เท่านั้น: real-macOS verification ยังอยู่ใน recorded
cooldown ถึง `2026-08-03 20:18 Asia/Bangkok`; รอบนี้ไม่ได้ retry, circumvent หรือใช้
managed-sandbox skip เป็น PASS และ blocker นี้ไม่หักล้าง P0-05 local acceptance.

## Acceptance Review

### REQ-5.1–5.3: T0 timing และ diagnostics exclusion

- `core/src/orchestrator/loop.ts:256-280` รัน authenticated T0 หนึ่งครั้งหลัง
  action batch ของ implementer/repair รวม zero-action; diagnostician proposal และ
  read-only hypothesis probes ใช้ path แยกและไม่เข้า T0 block.
- Focused sequence tests ยืนยัน WORKING/BLOCKED สองรอบได้ `T0,T0`, repair path ได้
  `T0,T0,T1`, และ diagnostician/probe round ไม่เพิ่ม T0 call.

### REQ-5.4: READY same-artifact binding

- `core/src/orchestrator/loop.ts:283-316` เรียก T1 หลัง authenticated passing T0
  เท่านั้น และเปรียบเทียบ `worktreeHash` ก่อน `gate_passed`/`review`.
- Regression ใหม่ใน `core/src/orchestrator/loop.test.ts:140-164` ป้อน T0=`tree-a`,
  T1=`tree-b` แล้วได้ `ESCALATED{why:"artifact_identity_mismatch"}` โดยไม่มี
  `PASSED`/`REVIEWING`; happy same-tree control ยังได้ `REVIEWING`.

### REQ-5.5–5.7: deterministic failure/flake behavior

- T0/T1 failure เข้า `VERIFYING -> FAILED -> DIAGNOSING`; no-claim bypass เข้าสู่
  success ไม่ได้.
- GateRunner retry behavior ถูกตรวจใน wired fault suite: fail-then-pass เป็น
  `flakySuspect:true` และ `pass:false`, stable failure ไม่ติด flaky และไม่มี
  auto-quarantine.

### REQ-5.8: authenticated GATE_RESULT hash

- `createGateRunner.publish` ลง `GATE_RESULT` ทุก tier พร้อม `gateConfigHash`.
- Existing wired evidence checks ตรวจ hash ตรงกับ SHA-256 ของ ladder bytes.

### REQ-5.9–5.10: T2/T3 stubs

- Default Phase-0 ladder กำหนด T2/T3 เป็น `not_enabled_phase0`.
- New `core/src/gates/runner.test.ts:365-394` เรียก `run('T3')` จริง และยืนยัน
  `pass:'not_enabled'`, `checks:[]`, event log tier `T3` หนึ่งรายการ และ
  `gateConfigHash` ตรงกับ config bytes; T2 stub control ยังคงผ่าน.

### Auth-before-advance

- `core/src/orchestrator/loop.ts:263-280,292-307` verify report ก่อนรับ gate
  verdict และจับ authentication error เป็น structured escalation.
- New wired fault `core/test/fault-injection.test.ts:743-776` ทำให้ T0 verifier
  throw `ReportIntegrityError(signature_mismatch)`; ผลเป็น `ESCALATED`, ไม่มี T1,
  `PASSED`, `REVIEWING` หรือ `COMPLETED`.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/orchestrator/loop.test.ts`
  -> `6` pass, `0` fail
- `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'T3 Phase-0 stub' src/gates/runner.test.ts`
  -> `1` pass, `0` fail
- `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'T0 evidence authentication failure' test/fault-injection.test.ts`
  -> `1` pass, `0` fail
- `pnpm --filter core typecheck` -> exit `0`
- `pnpm lint` -> `ESLint: No issues found`
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria
  covered, EARS lint passed
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> exit `0`
- `git diff --check` -> exit `0`

Task 44 handoff additionally records wired focused `50` pass/`0` fail/`5` explicit
external-only skips and core `526` pass/`0` fail/`9` explicit skips; this review did
not reinterpret those external-only skips as real macOS evidence.

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-45-p0-05-acceptance-review.md`
  — acceptance verdict and evidence (new)

ไม่มี production/test/spec/policy change ใน acceptance review นี้ และไม่มี commit,
push หรือ external retry.

## Constraints

- Task 5 ยัง `[ ]`; parent เป็นผู้เพิ่ม Evidence และ flip หลังอ่าน handoff นี้.
- ห้าม retry/circumvent P0-02 external suite ก่อน cooldown และห้ามอ้าง skip เป็น PASS.

## Next Recommended Agent

Parent Phase 0 coordinator เพื่อบันทึก Task 5 Evidence/checkbox; งานถัดไปต้องเคารพ
P0-02 blocker และ dependency order ก่อนเริ่ม P0-06.

## Next Steps

1. Parent ตรวจ handoff Task 44 และ acceptance นี้ พร้อม reconcile `tasks.md`.
2. หากยอมรับ verdict ให้เพิ่ม Evidence block และ flip Task 5 เป็น `[x]` ใน edit เดียว.
3. ค่อยส่งต่อ P0-06 หลัง task boundary และคง external blocker ตาม recorded cooldown.
