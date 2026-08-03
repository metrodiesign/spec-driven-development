# Handoff: Task 24 — P0-03 multi-intent recovery fix

> From: Codex implementation agent
> To: P0-03 fresh-context re-review agent
> Date: 2026-07-27

## Task Summary

แก้ Task 23 P0-03 High finding ที่ `recoverWorktree` ตรวจเฉพาะ dangling intent ล่าสุด
จน history แบบ `INTENT(A), INTENT(B), APPLIED(B)` สามารถทิ้ง A ค้างและรายงาน no-op
ทั้งที่ authoritative event history ยังไม่ครบ

งานนี้จำกัดอยู่ที่ full ordered mutating history, public mutation admission,
rollback/replay, causal terminal identity และ regression tests เท่านั้น ไม่เริ่ม P0-04
และไม่เปลี่ยน authority, requirements, design, dependency หรือ policy

## Current Status

Implementation และ local verification เสร็จแล้ว แต่ Task 3 ยังคง `[ ]` ตาม approval
gate เพื่อรอ independent fresh-context re-review ไม่มี actionable finding ค้างจาก local
correctness/security review

P0-02 external real-macOS acceptance ยัง blocked ด้วย recorded account usage limit ถึง
2026-08-02 11:46 Asia/Bangkok รอบนี้ไม่ได้ retry, circumvent หรืออ้าง PASS จาก managed
sandbox skip/EPERM

## Files Changed

- `core/src/executor/executor.ts` — สร้าง ordered intent generations, causal
  terminal lookup, earliest-dangling suffix recovery, prevalidated rollback/replay,
  accepted-state invalidation และ mutation admission recovery
- `core/src/executor/executor.test.ts` — เพิ่ม public RED/GREEN probe และ component
  matrix สำหรับ legacy multi-intent history, A/B/C, RUN_COMMAND, duplicate generation,
  causal rejection, missing evidence, restart และ log ordering
- `core/test/fault-injection.test.ts` — เพิ่ม wired `DoD#6c/REQ-3.7` ที่ยืนยันว่า
  later accepted patch ฝัง earlier dangling generation ไม่ได้
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — เพิ่ม
  `Multi-intent recovery-fix evidence (awaiting fresh re-review)` ใต้ Task 3 โดยคง
  checkbox `[ ]`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-24-p0-03-multi-intent-fix.md`
  — handoff นี้

ไฟล์ dirty อื่นใน worktree เป็น shared P0-02/P0-03 work จาก task ก่อนหน้าและถูกเก็บไว้
ทั้งหมด ไม่มีการ revert, commit, push หรือขยายไป P0-04

## Important Decisions

- Recovery แบ่ง mutation history เป็น generation จาก `ACTION_INTENT` และยอมรับ terminal
  เฉพาะ `ACTION_APPLIED`/`ACTION_REJECTED` ที่อยู่ภายหลังและอ้าง exact
  `(actionId,intentSeq)` เดียวกัน
- Boundary คือ earliest dangling generation ไม่ใช่ intent ล่าสุด จากนั้น rollback
  pre-intent snapshot ของ boundary แล้ว reconstruct suffix ตาม original intent order
- ทุก suffix generation ตรวจ action schema, exact action ID, role, snapshot และ evidence
  ที่ต้องใช้ก่อนเปลี่ยน worktree; accepted terminal ต้องมี usable artifact `resultHash`
- Causal `ACTION_REJECTED` เป็น terminal ที่สมบูรณ์และไม่ถูก replay ส่วน accepted
  generation ถูก replay เพื่อ reconstruct artifact แต่ไม่ append terminal ซ้ำ
- Dangling generation ที่ replay สำเร็จหรือถูก structured-reject จะสะสม terminal ไว้
  ก่อน และ append ตาม intent order หลัง suffix replay ทั้งก้อนสำเร็จ
- Accepted replay ทุก generation ต้องสร้าง exact logged `resultHash`; final authoritative
  tree ต้องตรง last replayed identity มิฉะนั้น rollback boundary, reject dangling และ
  invalidate accepted suffix
- `activeAppliedEvents` เรียงตาม causal `intentSeq` ก่อน event append sequence เพราะ
  recovered A terminal อาจถูก append หลัง B terminal แม้ A เกิดก่อน B
- Public mutation admission เรียก recovery ก่อน duplicate/preflight/new intent และ
  refuse แบบ fail-closed หากยังมี dangling generation
- RUN_COMMAND ยังคงใช้ disposable artifact workspace, network deny และ role-scoped
  writable roots เดิม จึงไม่มี durable side effect นอก authoritative artifact ที่ต้อง
  replay; rollback-before-replay ทำให้ผลสุดท้ายปรากฏครั้งเดียว

## Constraints

- คุยและสรุปเป็นภาษาไทย; code, command, path และ technical term คงต้นฉบับ
- ห้าม mark Task 3 complete โดยไม่มี independent fresh-context acceptance re-review
- ห้าม mark Task 2 complete หรืออ้าง external real-macOS PASS ก่อน blocker เปิดและ
  รัน acceptance จริง
- ห้ามเริ่ม P0-04, revert shared dirty work, แก้ authority/old master/blueprint/archive,
  push ตรง `main`/`develop`, force push หรือ commit โดยไม่มี review
- authority root ต้องคง byte-identical กับ
  `/Users/king_developer/Downloads/loop-engineering-implementation-spec.md`

## Tests Run

- Initial RED:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'a dangling patch intent is recovered before a later accepted mutation' src/executor/executor.test.ts`
  -> `1` test, `0` pass, `1` fail; actual history เป็น
  `INTENT(A), INTENT(B), APPLIED(B)`
- Focused GREEN:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3\\.7|DoD#6' src/executor/executor.test.ts test/fault-injection.test.ts`
  -> `4` pass, `0` fail
- REQ-3 regression:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts`
  -> `47` pass, `0` fail
- Full public executor file -> `70` tests, `69` pass, `0` fail, `1` explicit
  external-only skip
- `pnpm --filter core test` -> `447` tests, `438` pass, `0` fail, `9` explicit
  external-only skips
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts`
  -> `11` pass, `0` fail
- `pnpm --filter aal test` -> `143` pass, `0` fail
- `pnpm typecheck` -> all `6` workspace projects pass
- `pnpm lint` -> `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh` -> pass
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria
  covered; EARS lint pass
- `.ai/bin/check-evidence.sh --strict .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> exit `0` ก่อน final evidence append และถูก rerun หลัง append
- `.ai/bin/check-secrets.sh --all` -> exit `0`
- `git diff --check` -> exit `0`
- authority external/root `cmp` -> exit `0`
- `shasum -a 256 loop-engineering-implementation-spec.md` ->
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

Root workspace gate:

- `scripts/ci-test-scope.sh push develop` เลือก full suite
- web -> `74` pass, `0` fail
- adapters -> `39` pass, `0` fail
- core และ AAL ผ่านใน run
- command จบ non-zero เฉพาะ full console-backend managed-sandbox limitation เดิม:
  `383` tests, `329` pass, `54` environment failures โดย `53` เป็น
  `listen EPERM: operation not permitted 127.0.0.1` และอีก `1` เป็น
  `node:os.uptime()`/`uv_uptime` EPERM
- focused production composition ผ่าน จึงไม่พบ Task 24 functional regression จาก
  root gate failure นี้

## Review Result

Local correctness review ตรวจ generation binding, earliest boundary, suffix
rollback/replay, exact result identity, append order, failure invalidation, duplicate
compatibility, second restart และ error cleanup แล้ว ไม่พบ actionable finding

Local security reviewตรวจ event-log trust boundary, action/role/evidence validation,
snapshot containment, patch authorization, RUN_COMMAND network/filesystem sandbox,
rollback-before-replay และ fail-closed behavior แล้ว ไม่พบ actionable finding

## Known Issues

- P0-03 ยังรอ independent fresh-context re-review เท่านั้น
- Full console-backend และ root full workspace command รันผ่าน loopback/uptime tests
  ไม่ได้ใน managed sandbox; failure signature ตรงกับ baseline เดิมและ focused
  production composition ผ่าน
- P0-02 real-macOS acceptance ยัง blocked ถึง 2026-08-02 11:46 Asia/Bangkok
- `9` full-core skips เป็น explicit external-only cases และไม่ใช่หลักฐานว่า real-macOS
  acceptance ผ่าน

## Next Recommended Agent

fresh-context correctness/security reviewer ที่อ่าน authority, approved
requirements/design/tasks และ handoffs Task 01–24 ก่อนตรวจ โดยไม่แก้ production code

## Next Steps

1. Re-run exact focused Task 24 probes และ REQ-3 suite จาก fresh context
2. ตรวจ `mutatingIntentHistory`, `activeAppliedEvents`, mutation admission และ
   `recoverWorktree` โดย trace history
   `INTENT(A), INTENT(B), APPLIED(B)` รวมถึง A/B/C และ failure branch
3. ยืนยันทุก intent มี causal terminal ไม่เกินหนึ่ง event, accepted suffix reconstruct
   ตาม order, final tree identity ตรง history และ second recovery ไม่เพิ่ม log
4. หากไม่พบ finding ให้บันทึก acceptance evidence และให้ผู้มี authority ตัดสิน Task 3
   checkbox; ห้ามเริ่ม P0-04 จาก review task
5. คง P0-02 external blocker จนถึงเวลาที่บันทึกไว้และรัน real-macOS acceptance จริง

ไฟล์ `RTK.md` และ `karpathy.md` ที่ root instructions อ้างถึงไม่พบใน repository หรือ
ตำแหน่ง parent ที่ตรวจแบบจำกัด ซึ่งสอดคล้องกับ handoffs ก่อนหน้า จึงใช้ shared authority
และ Codex adapter ที่มีอยู่เป็นฐาน
