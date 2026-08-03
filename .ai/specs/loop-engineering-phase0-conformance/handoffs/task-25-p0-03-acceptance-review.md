# Handoff: Task 25 — P0-03 fresh-context acceptance re-review

> From: Codex correctness/security acceptance reviewer
> To: P0-03 remediation agent and subsequent fresh-context reviewer
> Date: 2026-07-27

## Task Summary

ตรวจ P0-03 แบบ fresh context หลัง Task 24 โดยเทียบ full current implementation กับ
authority SHA-256
`ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`,
approved `requirements.md`/`design.md`/`tasks.md`, handoffs Task 01–24 และ
`REQ-3.1` ถึง `REQ-3.11`

ขอบเขตรวมการยืนยัน Task 23 High เรื่อง ordered multi-intent recovery, Task 21
High 1–3/Medium 1, Git patch isolation/declared paths, `READ_FILE`, exact
`intentSeq`, P0-02 complete artifact identity, causal replay/failure invalidation,
multiple dangling generations, duplicate action IDs, rejection history และ repeated
restart โดยไม่แก้ production code, tests, requirements, design หรือ tasks

## Current Status

Verdict: `REQUEST_CHANGES`

- Critical: 0
- High: 1
- Medium: 0
- Low: 0

Task 23 High ปิดได้ใน intended multi-intent scenarios แต่พบ admission-integrity gap
ใหม่: mutation ที่ใช้ `actionId` ใหม่สามารถฝัง authoritative state ที่ไม่ตรงกับ
`ACTION_APPLIED` ล่าสุด แล้วทำให้ recovery ภายหลังรายงาน false consistency

P0-02 external real-macOS acceptance ยัง blocked ถึง 2026-08-02 11:46
Asia/Bangkok ตามหลักฐานเดิม รอบนี้ไม่ได้ retry, circumvent หรืออ้าง PASS จาก
external-only skips

## Findings

### High 1 — mutation ใหม่ไม่ reconcile `ACTION_APPLIED` identity จึงฝัง state ที่ถูก tamper และรายงาน false consistency

- Location:
  - `core/src/executor/executor.ts:865-879`
  - `core/src/executor/executor.ts:881-920`
  - `core/src/executor/executor.ts:1543-1623`
  - `core/src/executor/executor.test.ts:826-916`
- Dimension: Recovery correctness / artifact integrity / audit integrity /
  P0-02 identity integration
- Failure scenario:
  1. `APPLY_PATCH` A สำเร็จและบันทึก `ACTION_APPLIED(A){resultHash=H1}`
  2. authoritative worktree ถูกเปลี่ยนภายนอกหลัง A โดยไม่มี dangling intent
  3. ส่ง `APPLY_PATCH` B ด้วย `actionId` ใหม่
  4. public mutation admission ตรวจเฉพาะ `danglingMutatingIntents`; เมื่อไม่มี
     dangling จึงไม่เรียก `recoverWorktree`
  5. duplicate-only identity branch ก็ไม่ทำงานเพราะ B ไม่ใช่ `actionId` เดิม
  6. B snapshot และ apply บน state ที่ถูก tamper แล้วบันทึก
     `ACTION_APPLIED(B){resultHash=H2}` ซึ่ง H2 ครอบ tamper นั้น
  7. recovery รอบถัดไปเทียบ worktree กับ H2 และคืน
     `action: none, detail: "log and worktree consistent"`
- Evidence: safe temporary Git probe ด้วย public executor จริงให้ผล A
  `status=applied`, tamper `src/a.txt`, B `status=applied`, recovery คืน
  `action=none`; หลัง recovery `src/a.txt` ยังเป็น `TAMPERED\n` และ
  `src/b.txt` เป็น `B\n` โดย log มี causal
  `INTENT(A), APPLIED(A,H1), INTENT(B), APPLIED(B,H2)` ครบ จึงไม่มี dangling
  เหลือให้รอบหลังตรวจย้อนกลับ
- Impact: state ที่ไม่ได้เกิดจาก accepted action ถูกทำให้กลายเป็นส่วนหนึ่งของ trusted
  `resultHash` รุ่นใหม่ ทำลาย append-only audit provenance และขัด authority
  `loop-engineering-implementation-spec.md:98` ซึ่งกำหนดให้ replay log แล้วเทียบ
  worktree กับ `ACTION_APPLIED` ล่าสุดก่อนทำต่อ ระบบไม่เพียงพลาดตรวจ tamper แต่ยัง
  เปลี่ยนมันให้เป็น false-consistent accepted history ที่ recovery ภายหลังแก้ไม่ได้
- Existing-test gap: tests ที่ `core/src/executor/executor.test.ts:826-916` พิสูจน์
  identity mismatch เฉพาะเมื่อผู้เรียกเรียก `recoverWorktree` โดยตรงหรือ resubmit
  `actionId` เดิม จึงไม่ครอบ distinct new-action admission
- Required fix:
  - ให้ public admission ของ mutating action ทุกตัวทำ reconciliation กับ complete
    active history และ last non-blob `ACTION_APPLIED.resultHash` ก่อน
    duplicate/preflight/snapshot/new `ACTION_INTENT` ไม่ใช่เฉพาะเมื่อมี dangling
  - รับ action ใหม่ต่อได้เฉพาะหลัง recovery คืน authoritative artifact สู่ state ที่
    coherent แล้ว; หาก reconciliation ทำไม่ได้ให้ reject แบบ fail closed
  - ห้าม snapshot หรือสร้าง `resultHash` ใหม่บน mismatched state
  - เพิ่ม public regression:
    `APPLY_PATCH A -> external tamper -> distinct APPLY_PATCH B` โดยยืนยันว่า B
    ไม่ฝัง tamper, recovery ไม่รายงาน false consistency, causal log ไม่อ้าง state
    ที่ถอนแล้ว และ recovery รอบสองเป็น no-op

## Verified Controls

- Task 23 High ปิดแล้ว:
  - `mutatingIntentHistory` สแกน ordered mutation history ทั้ง run/task
  - terminal ผูกด้วย exact `(actionId,intentSeq)`
  - recovery หา earliest dangling generation แล้ว prevalidate/replay suffix ตาม
    causal order
  - accepted generation ทุกตัวต้องสร้าง exact logged `resultHash`
  - causal rejection ถูกคงไว้โดยไม่ replay
  - missing evidence หรือ replay mismatch rollback boundary, terminally reject
    dangling generations และ invalidate accepted suffix แบบ fail closed
  - recovered terminals append เฉพาะ dangling generations หลัง suffix ผ่านทั้งก้อน
  - A/B/C, multiple dangling, duplicate action IDs ข้าม generations, causal rejection,
    missing evidence, crash-after-intent/apply และ repeated restart tests ผ่าน
- Task 21 High 1 ปิดแล้ว: patch Git ใช้ fixed `/usr/bin/git`, isolated config และ
  core-owned temporary `GIT_DIR`/`GIT_INDEX_FILE`; target clean/smudge/process filters
  ไม่รัน
- Task 21 High 2 ปิดแล้ว: declared forward/reverse paths มาจาก NUL-delimited Git
  output และ policy ตรวจทุก old/new path รวม forbidden no-op, quoted Unicode,
  rename และ copy metadata ก่อน target mutation
- Task 21 High 3 ปิดแล้ว: later same-action rejection ที่ไม่มี exact `intentSeq`
  ปิด older dangling generation ไม่ได้
- Task 21 Medium 1 ปิดแล้ว: public operation control เริ่มก่อน patch evidence,
  preflight, freeze/materialize, snapshot, intent, apply และ final identity พร้อม
  typed timeout/cancellation
- `REQ-3.1` ถึง `REQ-3.6` และ `REQ-3.8` ถึง `REQ-3.11` ผ่าน source trace และ
  focused tests; `REQ-3.7` multi-intent remediation ผ่าน แต่ overall recovery
  acceptance ยังถูก High 1 บล็อก
- `READ_FILE` ใช้ descriptor-relative no-follow traversal, เก็บ content-addressed
  evidence ก่อน `ACTION_APPLIED`, ไม่มี snapshot/`ACTION_INTENT` และ reject traversal/
  symlink escape
- RUN_COMMAND suffix reconstruction รันคำสั่ง accepted ซ้ำเฉพาะหลัง rollback
  authoritative boundary; production path ยังคง network-denied และ disposable
  artifact workspace จึงไม่พบ independently durable external side effect ซ้ำ
  final authoritative effect ปรากฏครั้งเดียวและ exact result identity ถูกตรวจ

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-25-p0-03-acceptance-review.md`
  — acceptance verdict, finding และ verification evidence (new)

ไม่มีการแก้ production code, tests, requirements, design หรือ tasks และไม่มี commit,
push, revert shared dirty work หรือเริ่ม P0-04

## Important Decisions

- Task 23 High และ Task 21 High 1–3/Medium 1 ถือว่าปิด ไม่ควรถูกย้อนแก้
- High 1 ใหม่เป็น acceptance blocker เพราะสร้าง false-consistent durable history
  ไม่ใช่เพียง test coverage gap
- Task 3 ต้องคง `[ ]` จนแก้ finding และผ่าน independent fresh-context re-review
- Verdict เป็น `REQUEST_CHANGES` ไม่ใช่ `APPROVE_WITH_EXTERNAL_BLOCKER` เพราะมี
  actionable local High นอกเหนือจาก external P0-02 blocker

## Tests Run

- safe inline temporary-repository probe:
  `APPLY_PATCH A -> external tamper -> distinct APPLY_PATCH B -> recoverWorktree`
  -> reproduced High 1; A และ B เป็น `applied`, recovery คืน false
  `log and worktree consistent`, tampered A ยังอยู่
- focused recovery:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3\\.7|DoD#6' src/executor/executor.test.ts test/fault-injection.test.ts`
  -> `14` tests, `14` pass, `0` fail
- full REQ-3:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3\\.' src/executor/executor.test.ts test/fault-injection.test.ts`
  -> `47` tests, `47` pass, `0` fail
- full core:
  `pnpm --filter core test`
  -> `447` tests, `438` pass, `0` fail, `9` explicit external-only skips
- `pnpm --filter core typecheck` -> pass
- `pnpm lint` -> `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh` -> pass
- `scripts/spec-trace.sh loop-engineering-phase0-conformance`
  -> `144` criteria covered; EARS lint pass
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> exit `0`
- `.ai/bin/check-secrets.sh --all` -> exit `0`
- `git diff --check` -> exit `0`
- authority external/root `cmp` -> exit `0`
- `shasum -a 256 loop-engineering-implementation-spec.md`
  -> `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Known Issues

- P0-03: High 1 ด้าน distinct-action admission บน stale artifact identity ยัง
  unresolved
- P0-02: external real-macOS acceptance ยัง blocked ถึง 2026-08-02 11:46
  Asia/Bangkok; `9` skips ไม่ใช่หลักฐาน external PASS

## Next Recommended Agent

P0-03 remediation agent ที่จำกัด scope เฉพาะ shared mutation admission identity
reconciliation และ regression test แล้วส่งต่อให้ independent fresh-context
correctness/security reviewer

## Next Steps

1. เพิ่ม RED public regression สำหรับ applied A, external tamper และ distinct
   mutating B
2. reconcile complete active artifact identity ก่อนรับ mutating action ทุกตัว โดย
   fail closed ก่อน snapshot/intent เมื่อ state ยังไม่ coherent
3. รักษา ordered multi-intent suffix replay, exact `intentSeq`, Task 21 patch
   isolation/path/cancellation controls และ duplicate behavior เดิม
4. รัน focused `REQ-3`, full core, typecheck และ static gates แล้วทำ fresh-context
   acceptance re-review อีกครั้ง
5. ห้าม mark Task 2/3 complete, เริ่ม P0-04 หรืออ้าง external real-macOS PASS จน
   blockers ที่เกี่ยวข้องถูกปิดจริง

ไฟล์ `RTK.md` และ `karpathy.md` ที่ root instructions อ้างถึงไม่พบใน repository หรือ
ตำแหน่ง parent ที่ตรวจแบบจำกัด ซึ่งสอดคล้องกับ handoffs ก่อนหน้า จึงใช้ shared
authority และ Codex adapter ที่มีอยู่เป็นฐาน review
