# Handoff: Task 28 — P0-03 full artifact identity fix

> From: Codex implementation agent
> To: independent fresh-context correctness/security reviewer
> Date: 2026-07-27

## Task Summary

แก้ Task 27 High ที่ artifact identity, pre-intent snapshot และ rollback เห็นเฉพาะ
Git-visible paths กับ ignored bytes ใต้
`offlineDependencyPolicy.persistentOutputRoots` ทำให้ ignored durable bytes ที่เหลือ
ไม่เปลี่ยน `ACTION_APPLIED.resultHash`, ไม่ trigger admission reconciliation และถูก
distinct mutator รุ่นถัดไป seal เข้า accepted state ได้

ขอบเขตจำกัดที่ authoritative worktree capture, executor snapshot/rollback/recovery,
public regressions และ Task 28 durable evidence โดยรักษา P0-02 command capture,
exact dependency-output set, P0-03 patch isolation, ordered multi-intent causality,
duplicate behavior และ `READ_FILE` non-mutating exception

## Current Status

Implementation และ local verification เสร็จแล้ว รอ independent fresh-context
acceptance re-review

- Task 27 High ถูกแก้ใน local shared worktree
- local correctness/security review ไม่เหลือ actionable finding ในขอบเขต Task 28
- Task 3 ยังคง `[ ]`
- P0-04 ยังไม่เริ่ม
- ไม่มี commit หรือ push

## Files Changed

- `core/src/gates/frozen-tree.ts` — เพิ่ม authoritative full-worktree capture mode,
  descriptor-safe symlink read, fixed exclusions และ stable two-inventory/content
  verification; คง default `git_visible` semantics รวม tracked deletion (edited,
  shared untracked file)
- `core/src/executor/executor.ts` — เพิ่ม finite artifact identity policy, manifest
  รุ่น 2, full result identity, exact snapshot restore, legacy compatibility และ
  structured failure/reconciliation (edited)
- `core/src/executor/executor.test.ts` — เพิ่ม initial RED และ full
  WRITE/APPLY/RUN, add/delete/mutate, denied/quoted/mode/symlink/race/special/bounds,
  cancellation/deadline และ crash/restart regressions (edited)
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — เพิ่ม
  `Full artifact identity-fix evidence (awaiting fresh re-review)` ใต้ Task 3 โดยไม่
  เปลี่ยน checkbox (edited)
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-28-p0-03-full-identity-fix.md`
  — handoff นี้ (new)

ไฟล์อื่นใน shared dirty worktree เป็นงานเดิมจาก Tasks 01–27 และไม่ได้ revert หรือ
ถือสิทธิ์เป็นงาน Task 28

## Important Decisions

- authoritative artifact domain ครอบ stable regular files และ safe symlinks ทุก
  tracked/untracked/ignored path ไม่ว่าปัจจุบัน role จะเขียนได้หรือ denied; exclude
  แบบ fixed เฉพาะ `.git` และ run-state `.ai/runs`
- full identity ใช้ shared `freezeWorkingTree` mode
  `authoritative_worktree` ซึ่งทำ descriptor-relative `O_NOFOLLOW` traversal/read,
  ตรวจ inventory และ content ซ้ำก่อนรับ snapshot และ bind mode/path/bytes/SHA-256
- pre-intent manifest รุ่น 2 เป็น content-addressed exact set พร้อม `resultHash`;
  intent ใหม่เก็บ `artifactSnapshotRef` และ alias ที่
  `persistentSnapshotRef` เพื่อ compatibility กับ audit/tests เดิม
- rollback prevalidate manifest และทุก blob ก่อนลบ current inventory, prune empty
  parents, restore regular/executable/symlink entries แล้ว recapture ยืนยัน exact
  identity; corrupt evidence ไม่ลบ good state
- identity policy มี finite file/single/total/time bounds และใช้ public action
  `AbortSignal` เดียวกัน; rollback cleanup ใช้ separate finite core ceiling เพราะ
  post-effect state อาจเป็นสาเหตุที่ action policy bound ถูกเกิน
- legacy intents ที่ไม่มี `artifactSnapshotRef` ยังใช้ Git snapshot +
  persistent-root manifest เดิม; `snapshotRef` ยังคงเป็น Git object เพื่อ audit และ
  compatibility
- P0-02 `freezeWorkingTree` default command input/capture,
  descriptor-safe two-inventory validation และ exact dependency-output set ไม่ถูก
  เปลี่ยนเป็น full executor policy โดยปริยาย

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
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'Task 27/REQ-3\\.6-3\\.8' src/executor/executor.test.ts`
  -> `1` test, `0` pass, `1` fail; ignored content สองค่าได้ hash เดียวกัน
  `54c45d1bdbfa909bc0661904887a656288dd06f6db6a2a8b693b6eaa7d66d120`
- exact initial GREEN: command เดิม -> `1` pass, `0` fail
- focused Task 28:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'Task 28' src/executor/executor.test.ts`
  -> `16` tests, `16` pass, `0` fail
- focused review regressions: abort-after-promotion, WRITE/APPLY/RUN ignored
  post-effect hash, unsafe symlink และ symlink parent swap -> `4` pass, `0` fail
- full core: `pnpm --filter core test` -> `477` tests, `468` pass,
  `0` fail, `9` explicit external-only skips
- focused backend:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts`
  -> `11` pass, `0` fail
- AAL: `pnpm --filter aal test` -> `143` pass, `0` fail
- root workspace gate: `scripts/ci-test-scope.sh push develop` เลือก full suite;
  web `74/74`, core `468` pass/`0` fail/`9` external-only skips, AAL `143/143`
  และ adapters `39/39` ผ่าน; command จบ non-zero เฉพาะ known managed-sandbox
  console-backend `listen 127.0.0.1`/`uv_uptime` EPERM ขณะที่ focused backend ผ่าน
- typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- lint: `pnpm lint` -> `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh` ->
  `OK: core/ and aal/ are vendor-name-free (INV-7)`
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria
  covered และ EARS lint pass
- `.ai/bin/check-secrets.sh --all` -> exit `0`
- `git diff --check` -> exit `0`
- authority external/root `cmp` -> exit `0`; SHA-256 ตรงค่าด้านบน

## Known Issues

- ไม่มี known functional issue ที่ยังค้างใน Task 27 High หลัง local review
- Task 3 ยังต้องผ่าน independent fresh-context acceptance re-review
- external P0-02 real-macOS acceptance ยัง blocked ถึงเวลาที่ระบุและไม่ได้ retry
- root full workspace gate ใน managed sandbox ยังมี known console-backend
  loopback/`uv_uptime` EPERM limitation จาก handoffs เดิม; focused backend,
  full core และ full AAL ผ่าน

## Next Recommended Agent

independent fresh-context correctness/security reviewer สำหรับ P0-03 full artifact
identity, snapshot/rollback, admission และ causal recovery

## Next Steps

1. อ่าน authority, approved spec, handoffs Task 01–28 และตรวจ current full diff แบบ
   fresh context
2. reproduce direct ignored hash กับ external add/delete/mutate ก่อน distinct
   WRITE/APPLY/RUN ผ่าน public executor และยืนยัน no sealed tamper
3. ตรวจ fixed exclusions, denied/quoted/mode/symlink/special/bounds/deadline,
   content-addressed manifest prevalidation และ legacy-intent compatibility
4. recheck ordered multi-intent/reused-actionId/rejection causality กับ repeated
   recovery no-op
5. รัน focused/full core และ static gates แล้วคง Task 3 `[ ]` หากยังมี actionable
   finding หรือ external blocker
