# Handoff: Task 23 — P0-03 fresh-context re-review

> From: Codex correctness/security review agent
> To: P0-03 remediation agent and subsequent fresh-context reviewer
> Date: 2026-07-27

## Task Summary

ตรวจ P0-03 แบบ fresh context หลัง Task 22 โดยเทียบ full current diff กับ authority
SHA-256
`ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`,
approved `requirements.md`/`design.md`/`tasks.md`, handoffs Task 01–22 และ
`REQ-3.1` ถึง `REQ-3.11` รวมทั้ง recheck Task 21 findings, `READ_FILE` descriptor
containment/event order และ P0-02 artifact-identity integration

## Current Status

Verdict: `REQUEST_CHANGES`

- Critical: 0
- High: 1
- Medium: 0
- Low: 0

Task 21 High 1–3 และ Medium 1 ปิดได้ตาม intended scenarios แต่พบ recovery gap ใหม่
ซึ่งยังทำให้ P0-03 ไม่ผ่าน `REQ-3.7` และ exactly-once audit semantics

P0-02 external real-macOS acceptance ยัง blocked ถึง 2026-08-02 11:46
Asia/Bangkok ตามหลักฐานเดิม รอบนี้ไม่ได้ retry, circumvent หรืออ้าง PASS จาก
external-only skips

## Findings

### High 1 — recovery ตรวจเฉพาะ intent ล่าสุด จึงมองข้าม dangling intent เก่าที่ถูก action สำเร็จภายหลังบัง

- Location:
  - `core/src/executor/executor.ts:1143-1157`
  - `core/src/executor/executor.ts:1290-1370`
- Dimension: Recovery correctness / audit integrity / `REQ-3.7`
- Failure scenario:
  1. `APPLY_PATCH` A crash หลัง side effect แต่ก่อน `ACTION_APPLIED` จึงเหลือ
     `ACTION_INTENT(A)` ที่ dangling
  2. ก่อนเรียก recovery มี `APPLY_PATCH` B เข้ามาและสำเร็จ จึงเกิด
     `ACTION_INTENT(B)` และ `ACTION_APPLIED(B){intentSeq}`
  3. `recoverWorktree` เลือกเฉพาะ `lastIntent` ซึ่งเป็น B, พบ terminal ของ B แล้วข้าม
     recovery block ทั้งหมด
  4. final artifact identity ตรงกับ B เพราะ hash นั้นครอบ mutation ของ A ที่ค้างอยู่ด้วย
     จึงคืน `action: none`, `log and worktree consistent`
- Evidence: safe temporary-repository probe ได้ event sequence
  `INTENT(A seq=1), INTENT(B seq=2), APPLIED(B intentSeq=2)` ทั้งก่อนและหลัง recovery;
  recovery คืน `action=none` ขณะที่ไฟล์ของ A ยังเป็นค่าหลัง patch และไม่มี terminal
  event ที่อ้าง `intentSeq=1`
- Impact: side effect ของ A คงอยู่โดยไม่มี causal terminal event ทำให้ log กับ durable
  artifact ไม่สอดคล้อง, deterministic restore-and-replay ไม่เกิด และ exactly-once
  semantics ตรวจสอบไม่ได้ การ rollback A แบบตรงไปตรงมาภายหลังก็อาจลบผลสำเร็จของ B
  ซึ่งยืนยันว่าต้องป้องกัน suffix นี้ก่อนรับ mutation ถัดไปหรือ recover ทั้ง suffix
  อย่างมีลำดับ
- Required fix:
  - ตรวจทุก intent ใน run/task และจับ terminal ด้วย exact `intentSeq`; ห้ามสรุปว่าไม่มี
    dangling intent จาก terminal ของ `lastIntent` เพียงตัวเดียว
  - ก่อน append mutating intent ใหม่ ให้ recover หรือ reject แบบ fail-closed เมื่อมี
    unmatched prior intent
  - สำหรับ log ที่มี later mutation ต่อท้าย dangling intent อยู่แล้ว ให้ fail closed
    หรือ reconstruct/replay suffix อย่าง deterministic; ห้ามคืน `log and worktree
    consistent`
  - เพิ่ม regression สำหรับ crash-after-apply A แล้ว successful mutating B ก่อน
    recovery โดยยืนยันว่า A ไม่ถูกซ่อน, ไม่มีผลสำเร็จถูกทิ้ง และทุก terminal ผูก exact
    `intentSeq`

## Verified Controls

- Task 21 High 1 ปิดแล้ว: patch Git ทุก call ใช้ fixed `/usr/bin/git` ผ่าน
  `runCoreTool`; environment ไม่ inherit caller config/PATH, ปิด system/global config,
  hooks/fsmonitor/excludes และ actual-worktree check/apply ใช้ core-owned temporary
  `GIT_DIR`/`GIT_INDEX_FILE` พร้อม explicit `GIT_WORK_TREE`; clean/smudge/process
  filter regressions ผ่าน
- Task 21 High 2 ปิดแล้ว: declared path set มาจาก forward/reverse
  `git apply --numstat -z` แบบ NUL-safe, คืน reverse record order ก่อนจับคู่ และตรวจ
  policy ทุก old/new path ก่อน target mutation รวม forbidden no-op, quoted
  Unicode/newline/tab, rename และ copy metadata
- Task 21 High 3 ปิดใน scenario เดิม: terminal หลัง intent อ้าง exact `intentSeq`;
  later same-action preflight rejection ไม่มี `intentSeq` และปิด dangling intent เดิม
  ไม่ได้
- Task 21 Medium 1 ปิดแล้ว: public operation control เริ่มหลัง schema validation แต่ก่อน
  duplicate/evidence/preflight และส่ง deadline/AbortSignal เดียวผ่าน patch Git,
  freeze/materialize, check, snapshot, apply, identity และ reconciliation
- `REQ-3.1` ถึง `REQ-3.6` และ `REQ-3.8` ถึง `REQ-3.11` ผ่าน source trace และ focused
  tests; `REQ-3.7` ยังไม่ผ่าน finding ข้างต้น
- `READ_FILE` ใช้ descriptor traversal แบบไม่ follow symlink, เก็บ content-addressed
  evidence ก่อน `ACTION_APPLIED`, ไม่สร้าง snapshot/`ACTION_INTENT` และ traversal/
  symlink escape ถูก reject
- APPLY_PATCH final result และ recovery comparison ใช้ P0-02 complete artifact identity
  ซึ่งรวม tracked/non-ignored tree และ governed ignored persistent roots

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-23-p0-03-rereview.md`
  — review verdict, finding และ verification evidence (new)

ไม่มีการแก้ production code, tests, requirements, design หรือ tasks และไม่มี commit,
push หรือการเริ่ม P0-04

## Important Decisions

- Task 21 findings ถือว่าปิด ไม่ควรถูกย้อนแก้; remediation ต้องรักษา Git isolation,
  complete declared-path authorization, exact terminal `intentSeq` และ early public
  operation control
- Finding ใหม่เป็น High เพราะ recovery รายงาน false consistency ต่อ durable mutation
  ที่ไม่มี terminal ไม่ใช่เพียง missing test
- Task 3 ต้องคง `[ ]` จนแก้ finding และผ่าน independent fresh-context re-review

## Constraints

- ห้าม mark Task 2 complete หรืออ้าง external real-macOS PASS ก่อน blocker เปิดและ
  acceptance จริงผ่าน
- ห้ามเริ่ม P0-04, revert shared dirty work, แก้ authority/requirements/design/tasks
  นอก approval gate, commit หรือ push จาก review handoff นี้
- รักษา root authority byte-identical และ SHA-256 ตามที่ระบุข้างต้น

## Tests Run

- safe inline temporary-repository recovery probe: crash-after-apply A แล้ว successful
  patch B ก่อน recovery -> reproduced High 1; recovery คืน false
  `log and worktree consistent`
- `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts`
  -> `40` tests, `40` pass, `0` fail
- test: `pnpm --filter core test` -> `440` tests, `431` pass, `0` fail, `9`
  explicit external-only skips
- typecheck: `pnpm --filter core typecheck` -> pass
- `pnpm lint` -> `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh` -> pass
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria covered;
  EARS lint pass
- `.ai/bin/check-evidence.sh --strict .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> exit `0`
- `.ai/bin/check-secrets.sh --all` -> exit `0`
- `git diff --check` -> exit `0`
- `shasum -a 256 loop-engineering-implementation-spec.md` ->
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Known Issues

- P0-03: High 1 ด้าน buried dangling intent ยัง unresolved
- P0-02: external real-macOS acceptance ยัง blocked ถึง 2026-08-02 11:46
  Asia/Bangkok; `9` skips ไม่ใช่หลักฐาน external PASS

## Next Recommended Agent

P0-03 remediation agent ที่จำกัด scope เฉพาะ recovery admission/history handling แล้วส่ง
ต่อให้ independent fresh-context correctness/security reviewer

## Next Steps

1. เพิ่ม RED regression สำหรับ dangling A ตามด้วย successful mutation B ก่อน recovery
2. ป้องกัน new mutating intent เมื่อมี unmatched prior intent และ harden recovery ให้
   ตรวจทุก exact `intentSeq` โดย fail closed ต่อ anomalous suffix
3. รัน focused `REQ-3`, full core, typecheck และ gates โดยคง external blocker เดิม
4. ทำ fresh-context re-review อีกครั้งก่อนตัดสิน Task 3; ห้ามเริ่ม P0-04
