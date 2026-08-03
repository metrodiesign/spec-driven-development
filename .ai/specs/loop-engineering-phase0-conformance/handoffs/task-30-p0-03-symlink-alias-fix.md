# Handoff: Task 30 — P0-03 symlink-alias fix

## Task Summary

ปิด Task 29 High ที่ lexical role path ใต้ `src/**` สามารถตาม pre-existing safe
symlink ไป mutate `docs`, `test/golden`, `.ai/runs` หรือ `.git` และทำให้ excluded
mutation ไม่อยู่ใน authoritative `resultHash`/recovery

## Current Status

implementation และ local verification เสร็จแล้ว ไม่มี known functional blocker
แต่ Task 3 ยังเป็น `[ ]` เพื่อรอ independent fresh-context acceptance re-review

## Files Changed

- `core/src/executor/mutation-path.ts` — descriptor-relative no-follow mutation
  transaction สำหรับ regular file, delete, safe-symlink restore และ directory
  reconciliation (new)
- `core/src/executor/patch.ts` — apply Git patch ใน disposable core-owned tree แล้ว
  สร้าง exact descriptor-safe promotion operations (edited, untracked shared file)
- `core/src/executor/command-executor.ts` — promote captured RUN artifacts ผ่าน
  mutation transaction เดียวกัน (edited, untracked shared file)
- `core/src/executor/executor.ts` — WRITE preflight/commit, artifact/persistent
  rollback/replay และ legacy fail-closed routing (edited)
- `core/src/executor/path-policy.ts` — แก้ contract comment ให้ตรง no-follow commit
  boundary (edited)
- `core/src/executor/executor.test.ts` — Task 30 public executor regressions (edited)
- `core/src/security/amended-command-contract.test.ts` — RUN promotion parent-swap
  regression (edited, untracked shared file)
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — เพิ่ม
  `Symlink-alias fix evidence (awaiting fresh re-review)` ใต้ Task 3 โดยคง `[ ]`
  (edited, untracked shared spec)
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-30-p0-03-symlink-alias-fix.md`
  — handoff นี้ (new)

## Important Decisions

- Mutation authorization ไม่อาศัย lexical check หรือ `realpath` check เพียงอย่างเดียว:
  ทุก target mutation เปิดจาก held authoritative root descriptor และ reject symlink
  ทุก parent/final component ที่ action จะตาม
- Hard-denied roots คือ `.git`, `.ai/runs` และ `test/golden`; role write roots ยังเป็น
  authority สำหรับ action promotion ส่วน rollback ระบุ exact reconciled roots/path
  แต่ใช้ hard-deny ชุดเดิม
- `APPLY_PATCH` ไม่เรียก Git กับ target worktree อีกต่อไป; Git ทำงานเฉพาะ frozen
  materialization ใน core temporary และผลถูกแปลงเป็น exact regular write/delete ops
- Safe symlink ยังคงเป็น authoritative artifact ที่ capture/restore ได้ แต่ไม่ขยาย
  write authority และไม่ถูก traverse ที่ mutation boundary
- Legacy intent ที่ไม่มี version-2 artifact manifest ไม่ใช้ `git reset`/`git clean`;
  หาก tracked tree ไม่ตรง snapshot จะ fail closed แทนการทำ unsafe target mutation

## Constraints

- ห้าม mark Task 3 complete ก่อน fresh-context acceptance re-review
- ห้ามเริ่ม P0-04, commit, push, force push หรือแตะ shared changes ที่ไม่อยู่ใน scope
- ห้าม retry/circumvent/อ้าง PASS ของ P0-02 external real-macOS suite ก่อน
  2026-08-02 11:46 Asia/Bangkok
- repository มี shared uncommitted work จำนวนมาก; ห้าม revert หรือ cleanup งานผู้อื่น

## Tests Run

- initial RED: Task 30 exact alias probe -> `4` tests, `0` pass, `4` fail
- Task 30 final -> `14` pass, `0` fail
- Task 30 + Task 28 + cancellation regression -> `31` pass, `0` fail
- focused REQ-3 -> `90` pass, `0` fail
- full core -> `491` tests, `482` pass, `0` fail, `9` external-only skips
- console backend production composition -> `11` pass, `0` fail
- full AAL -> `143` pass, `0` fail
- typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- lint: `pnpm lint` -> `ESLint: No issues found`
- repository gates: vendor scan, spec trace, full-tree secret scan และ
  `git diff --check` ผ่าน
- root scope: web `74/74`, core, AAL `143/143` และ adapters `39/39` ผ่าน;
  command จบ non-zero เฉพาะ full console-backend managed-sandbox limitation เดิม
  (`53` loopback `listen EPERM` และ `1` `node:os.uptime()`/`uv_uptime` EPERM);
  focused backend composition `11/11` ผ่าน
- authority: external/root `cmp` -> exit `0`; SHA-256
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Known Issues

- P0-02 external real-macOS verification ยังถูกบล็อกตาม cooldown ถึง
  2026-08-02 11:46 Asia/Bangkok และไม่ได้รันใน Task 30
- Task 3 ยังต้องมี independent fresh-context acceptance re-review

## Next Recommended Agent

fresh-context correctness/security reviewer สำหรับ P0-03 REQ-3 acceptance

## Next Steps

1. อ่าน Task 29 finding, Task 30 evidence/handoff และ inspect mutation boundary แบบ
   fresh context
2. rerun exact Task 30, focused REQ-3 และ full safe gates ตามความเหมาะสม
3. หากไม่มี finding คงค้าง จึงค่อยพิจารณาปิด Task 3; ห้ามเริ่ม P0-04 ก่อน gate นี้
