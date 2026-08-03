# Handoff: Task 22 — P0-03 review fixes

> From: Codex implementation agent
> To: P0-03 fresh-context re-review agent
> Date: 2026-07-27

## Task Summary

แก้ P0-03 ตาม Task 21 findings ทั้ง High 1–3 และ Medium 1 โดยจำกัดขอบเขตที่
`APPLY_PATCH`, public executor operation lifecycle และ recovery causal identity เท่านั้น
ไม่เริ่ม P0-04 และไม่เปลี่ยน authority, requirements หรือ design

## Current Status

Implementation และ local verification เสร็จแล้ว แต่ Task 3 ยังคง `[ ]` ตาม approval gate
เพื่อรอ independent fresh-context re-review ไม่มี actionable finding ค้างจาก local
correctness/security review

P0-02 external real-macOS acceptance ยัง blocked ด้วย recorded account usage limit ถึง
2026-08-02 11:46 Asia/Bangkok รอบนี้ไม่ได้ retry, circumvent หรืออ้าง PASS จาก managed
sandbox skip

## Files Changed

- `core/src/executor/patch.ts` — แยก Git inspection ออกจาก target config, เพิ่ม
  NUL-safe declared old/new path discovery, effective classification และ operation-aware
  check/apply (new, untracked shared P0-03 file)
- `core/src/executor/executor.ts` — สร้าง public operation control ก่อน patch preflight
  และผูก terminal lifecycle/recovery ด้วย exact `intentSeq` (edited, shared P0-02/P0-03)
- `core/src/executor/executor.test.ts` — เพิ่ม RED/GREEN probes สำหรับ hostile filters,
  forbidden mixed no-op paths, causal recovery และ pre-aborted preflight (edited,
  shared P0-02/P0-03)
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — เพิ่ม
  `Review-fix evidence (awaiting fresh re-review)` ใต้ Task 3 โดยคง `[ ]` (untracked
  active spec)
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-22-p0-03-review-fixes.md`
  — handoff นี้ (new, untracked active spec)

ไฟล์ dirty อื่นใน worktree เป็น shared P0-02/P0-03 work จาก task ก่อนหน้าและถูกเก็บไว้
ทั้งหมด ไม่มีการ revert หรือขยายไป P0-04

## Important Decisions

- Git ที่ parse/check/apply patch ใช้ fixed `/usr/bin/git` ผ่าน `runCoreTool` พร้อม
  operation deadline/AbortSignal; actual-worktree check/apply ใช้ temporary core-owned
  `GIT_DIR`/`GIT_INDEX_FILE` และ explicit `GIT_WORK_TREE` เพื่อไม่โหลด target local
  `filter.*` config
- Complete declared paths มาจาก Git parser เท่านั้น: จับคู่ NUL-delimited forward
  `git apply --numstat -z` กับ reverse records หลังคืนลำดับ เพื่อเก็บ source และ
  destination ของ rename/copy รวมถึง no-op/quoted/Unicode paths
- Policy ตรวจ declared old/new paths ก่อนพิจารณา semantic no-op/copy และก่อนแตะ target
  inode; effective raw diff ใช้แยกต่างหากเพื่อจำแนกผลจริง
- `ACTION_APPLIED` และ terminal rejection หลัง intent อ้าง `intentSeq`; preflight
  rejection ของ attempt ภายหลังไม่มี sequence และจึงปิด dangling intent เก่าไม่ได้
- Operation control เดียวครอบ evidence read, patch parsing, freeze/materialization,
  policy/check, snapshot, apply, final identity และ reconciliation; patch Git child
  timeout/cancel ถูกยกเป็น typed `FrozenTreeOperationError`
- ไม่มี dependency หรือ policy change และไม่มี commit/push ตาม scope correction จาก
  parent task

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

- RED focused command เดิม -> `8` tests, `0` pass, `8` fail ตาม Task 21 ทั้งสี่ finding
- GREEN focused command เดิม -> `8` pass, `0` fail
- `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts` -> `40` pass, `0` fail
- `pnpm --filter core test` -> `440` tests, `431` pass, `0` fail, `9` explicit external-only skips
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts` -> `11` pass, `0` fail
- `pnpm --filter aal test` -> `143` pass, `0` fail
- typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- test/gates: `pnpm lint` -> `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh` -> pass
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria covered; EARS lint pass
- `.ai/bin/check-evidence.sh --strict .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit `0`
- `.ai/bin/check-secrets.sh --all` -> exit `0`
- `git diff --check` -> exit `0`
- authority external/root `cmp` -> exit `0`
- `shasum -a 256 loop-engineering-implementation-spec.md` ->
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Known Issues

- P0-03 ยังรอ independent fresh-context re-review เท่านั้น
- P0-02 real-macOS acceptance ยัง blocked ถึง 2026-08-02 11:46 Asia/Bangkok
- `9` full-core skips เป็น explicit external-only cases และไม่ใช่หลักฐานว่า real-macOS
  acceptance ผ่าน

## Next Recommended Agent

fresh-context correctness/security reviewer ที่อ่าน authority, approved
requirements/design/tasks และ handoffs Task 01–22 ก่อนตรวจ โดยไม่แก้ production code

## Next Steps

1. Re-run focused Task 22 probes และ REQ-3 suite จาก clean reviewer context
2. ตรวจ source-to-sink ของ Git config/filter isolation, declared/effective path split,
   exact `intentSeq` terminal matching และ public operation cleanup
3. หากไม่พบ finding ให้บันทึก acceptance evidence และให้ผู้มี authority ตัดสิน Task 3
   checkbox; ห้ามเริ่ม P0-04 จาก review task
4. คง P0-02 external blocker จนถึงเวลาที่บันทึกไว้และรัน real-macOS acceptance จริง

ไฟล์ `RTK.md` และ `karpathy.md` ที่ root instructions อ้างถึงไม่พบใน repository หรือ
ตำแหน่ง parent ที่ตรวจแบบจำกัด ซึ่งสอดคล้องกับ handoffs ก่อนหน้า จึงใช้ shared authority
และ Codex adapter ที่มีอยู่เป็นฐาน
