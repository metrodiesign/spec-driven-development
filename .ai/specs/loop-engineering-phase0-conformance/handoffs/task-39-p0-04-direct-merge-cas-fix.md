# Handoff Note: Task 39 P0-04 Direct-Merge CAS Fix

> Schema ตาม `.ai/shared/AGENT_HANDOFF_PROTOCOL.md`

## Task Summary

แก้ High finding จาก Task 38 ใน P0-04: direct merge ต้องสร้าง merge commit จาก signed base/artifact OID แบบ immutable, ตรวจ first-parent topology และ publish `main` ด้วย compare-and-swap เพื่อไม่ overwrite concurrent advance

## Current Status

implementation และ regression tests เสร็จแล้ว ทุก focused/full/static gate ที่อยู่ในขอบเขตผ่าน Task 4 ยังคง `[ ]` เพื่อรอ independent fresh-context correctness/security review ตามคำสั่ง และไม่ได้เริ่ม P0-05

## Files Changed

- `core/src/merge/auto-merge.ts` — prepare direct merge ใน detached temporary worktree, authenticate result และ CAS `refs/heads/main` ด้วย signed base (edited)
- `core/src/merge/artifact-binding.ts` — บังคับ merge first parent ให้ตรง signed base และตรวจ signed artifact parent ทั้ง bind/final verify (edited; untracked ใน shared worktree)
- `core/src/merge/auto-merge.test.ts` — เพิ่ม deterministic concurrent-main interleaving fault และ exact parent controls (edited)
- `core/src/merge/artifact-binding.test.ts` — เพิ่ม first-parent mismatch fault ที่ปฏิเสธทั้ง bind และ final verify (edited; untracked ใน shared worktree)
- `core/src/merge/queue.test.ts` — เพิ่ม queue parent-OID parity assertions (edited)
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — เพิ่ม Task 39 Evidence โดยคง Task 4 `[ ]` (edited; spec tree untracked ใน shared worktree)
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-39-p0-04-direct-merge-cas-fix.md` — handoff นี้ (new)

## Important Decisions

- Direct merge สร้างจาก exact `baseCommitHash` และ `artifactCommitHash` ใน detached worktree; ห้าม merge mutable branch name หรือ checkout mutable main เพื่อเตรียม commit
- Publish ด้วย `git update-ref refs/heads/<mainBranch> <mergeCommit> <baseCommitHash>` เท่านั้น ถ้า ref เปลี่ยนต้องรักษา concurrent tip และจบ structured `ESCALATED` ที่ boundary `direct_merge_update`
- ตรวจและ re-sign topology ก่อน CAS จากนั้น re-verify signed merge report, current ref และ topologyก่อน `EVIDENCE_AUTHORIZED`
- First parent ต้องเท่ากับ signed base; signed artifact ต้องเป็น non-first parent ของ merge commit Direct/queue success controls ยืนยัน parent 2 เป็น exact signed artifact

## Constraints

- Task 4 ต้องคง `[ ]` จนผ่าน fresh-context review; ห้ามเริ่ม P0-05 จาก handoff นี้
- ห้าม commit หรือ push โดยไม่มี review และห้าม push ตรง `main`/`develop`
- ห้าม retry, circumvent หรืออ้าง PASS สำหรับ P0-02 external real-macOS suite ก่อน cooldown สิ้นสุด August 3, 2026 เวลา 20:18 Asia/Bangkok
- shared worktree มีงานของ Task ก่อนหน้าอยู่จำนวนมาก ห้าม revert หรือจัดรูปแบบไฟล์ที่ไม่เกี่ยวข้อง

## Tests Run

- RED: `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'Task 39|first parent is not the signed base' src/merge/auto-merge.test.ts src/merge/artifact-binding.test.ts` -> `0` pass, `2` fail ตาม fault ที่ต้องการ
- GREEN: command เดิม -> `2` pass, `0` fail
- focused merge: `pnpm --filter core exec node --test --test-reporter spec src/merge/artifact-binding.test.ts src/merge/queue.test.ts src/merge/auto-merge.test.ts` -> `29` pass, `0` fail
- deploy/OOB/human: `pnpm --filter core exec node --test --test-reporter spec src/human/api.test.ts src/deploy/stage.test.ts src/audit/oob.test.ts` -> `55` pass, `0` fail, `1` explicit external-only skip
- core: `pnpm --filter core test` -> `527` total, `518` pass, `0` fail, `9` explicit external-only skips
- backend: `pnpm --filter console-backend exec node --test --test-reporter dot 'src/**/*.test.ts' 'test/**/*.test.ts'` -> exit `0`; root outputยืนยัน `387` pass, `0` fail
- AAL: `pnpm --filter aal exec node --test --test-reporter dot 'src/**/*.test.ts' 'test/**/*.test.ts'` -> exit `0`
- root: `pnpm test` -> exit `0`
- typecheck: `pnpm typecheck` -> exit `0` ทั้ง workspace
- static: `pnpm lint`, `pnpm build`, `pnpm vendor-check`, `scripts/lessons-coverage-check.sh` -> exit `0`
- integrity: `.ai/bin/check-secrets.sh --all`, strict Evidence, `scripts/spec-trace.sh loop-engineering-phase0-conformance`, authority byte-compare/SHA และ `git diff --check` -> exit `0`; spec trace `144/144`, EARS lint ผ่าน

## Known Issues

- P0-02 external real-macOS verification ยัง blocked ด้วย recorded cooldown ถึง August 3, 2026 เวลา 20:18 Asia/Bangkok; ไม่ได้ retry หรือ bypass
- Task 4 ยังต้องผ่าน independent fresh-context correctness/security review ก่อนปิด
- root `pnpm test` ต้องรันนอก nested sandbox เพราะ backend integration bind `127.0.0.1`; sandbox run แรกให้ `listen EPERM`, privileged rerun ผ่าน

## Next Recommended Agent

fresh-context `code-reviewer` ร่วมกับ `security-reviewer` สำหรับ P0-04 Task 39

## Next Steps

1. Review direct merge preparation, topology authentication, CAS failure semantics และ event ordering โดยไม่แก้ไฟล์ก่อนรายงาน findings
2. Re-run focused Task 39 tests และตรวจว่า concurrent main OID ไม่เปลี่ยนเมื่อ CAS แพ้
3. ถ้าไม่พบ finding ให้บันทึก fresh review evidence และพิจารณาปิด Task 4; ถ้ามี finding ให้ส่งกลับด้วย exact location และ fault-first regression ที่ต้องเพิ่ม
