# Handoff: Task 32 — P0-03 descriptor transaction race fixes

## Task Summary

ปิด Task 31 High สองข้อใน shared mutation primitive: final component ที่เปลี่ยนหลัง
batch prevalidation ถูก overwrite และ backup cleanup ลบ rollback source ก่อนพ้น
failure boundary ทำให้ recovery batch คืน pre-call state ไม่ครบ

## Current Status

implementation, local correctness/security review และ safe local verification เสร็จแล้ว
ไม่มี known functional blocker แต่ Task 3 ยังคงเป็น `[ ]` เพื่อรอ independent
fresh-context acceptance re-review และยังไม่ได้เริ่ม P0-04

## Files Changed

- `core/src/executor/mutation-path.ts` — เพิ่ม descriptor-relative CAS/no-replace,
  sibling quarantine, safe identity-aware rollback และ typed post-commit cleanup
  outcome (edited, shared untracked fileเดิม)
- `core/src/executor/mutation-path.test.ts` — focused transaction race, kind matrix,
  safe restore, recovery-prune และ cleanup-residue regressions (new)
- `core/src/executor/executor.test.ts` — public recovery-prune rollback/restart/no-op
  regression (edited shared file)
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — เพิ่ม
  `Descriptor-transaction race fix evidence (awaiting fresh re-review)` ใต้ Task 3
  โดยคง `[ ]` (edited shared untracked spec)
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-32-p0-03-transaction-race-fixes.md`
  — handoff นี้ (new)

## Important Decisions

- Existing final ถูก atomically ย้ายจาก held parent descriptor ไป unique backup ใน
  sibling quarantine ด้วย no-replace ก่อน inspect exact expected; CAS จึงมี
  linearization point ที่ final component จริง ไม่ใช้ prevalidation เก่าเป็น authority
- Desired final ติดตั้งด้วย no-replace และ verify object identity/bytes/mode/target
  พร้อม revalidate held parent; concurrent create หรือ replacement ไม่ถูก overwrite
- Rollback ลบเฉพาะ installed/temporary ที่ inode และ desired identity ยังตรง และคืน
  backup เฉพาะเมื่อ target absent ด้วย no-replace; หาก concurrent final ครองชื่ออยู่
  จะคงทั้ง concurrent final และ captured backup พร้อม typed residue
- Backup ทุกชิ้นคงอยู่จนผ่าน commit point ทั้งชุด จากนั้น Node cleanup sibling
  quarantine เป็น post-commit phase; cleanup failure คืน `MutationBatchOutcome` แบบ
  `committed + residue` และห้ามย้อนเข้า rollback ที่ backup อาจถูกลบบางส่วนแล้ว
- Directory delete ตีความ expected directory เป็น empty ที่ operation CAS point;
  unmodeled child จึงทำให้ batch reject/rollback แทนการถูกลบหลัง commit
- Low-level child อาจเห็น deadline abort เป็น `cancelled`; mutation boundary ต้องถาม
  shared operation checkpoint ก่อน map reason เพื่อรักษา public `timed_out` contract
- Test-only pause/cleanup seams อยู่ใน package-internal moduleและไม่มี core package
  export; production callersไม่ส่ง seams เหล่านี้

## Constraints

- ห้าม mark Task 3 complete ก่อน independent fresh-context acceptance re-review
- ห้ามเริ่ม P0-04, commit, push, force push หรือ revert shared dirty work
- ห้าม retry, circumvent หรืออ้าง PASS ของ P0-02 external real-macOS suite เพราะ
  recorded cooldown ยังมีผลถึง August 3, 2026 เวลา 20:18 Asia/Bangkok
- repository มี shared uncommitted workจำนวนมาก; ต้อง preserve changes ของ agent อื่น

## Tests Run

- initial RED: focused concurrent replacement/create -> `2` tests, `0` pass,
  `2` fail; ทั้งคู่ resolve แทน `MutationPathError`
- focused mutation final -> `6` pass, `0` fail
- Task 30 parent/symlink/no-partial-event suite -> `14` pass, `0` fail
- Task 32 public recovery/restart -> `1` pass, `0` fail
- combined focused Task 30/32/identity -> `21` pass, `0` fail
- broad REQ-3 รอบแรก -> `91` total, `89` pass, `2` counted failจาก parent+child
  deadline caseเดียว (`cancelled` แทน `timed_out`); หลัง fix isolated
  cancellation/deadline -> `3` pass, `0` fail และ full core final ผ่าน
- full core: `pnpm --filter core test` -> `498` tests, `489` pass, `0` fail,
  `9` explicit external-only skips
- backend production composition:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts`
  -> `11` pass, `0` fail
- full AAL: `pnpm --filter aal test` -> `143` pass, `0` fail
- typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- lint: `pnpm lint` -> `ESLint: No issues found`
- repository gates: vendor scan, spec trace (`144` criteria + EARS lint), full-tree
  secret scan, authority `cmp`/SHA-256 และ `git diff --check` ผ่าน
- root scope: `scripts/ci-test-scope.sh push develop` เลือก full suiteและจบ
  non-zero เฉพาะ known managed-sandbox console-backend limitations เดิม
  (`listen EPERM 127.0.0.1` และ `node:os.uptime()`/`uv_uptime` EPERM); web
  `74/74`, core transaction/recovery, AAL และ adapters ผ่าน; focused backend
  composition `11/11` ผ่าน
- authority SHA-256:
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Known Issues

- P0-02 external real-macOS verification ยัง blocked ถึง August 3, 2026 เวลา
  20:18 Asia/Bangkok และไม่ได้รัน, retry, circumvent หรืออ้าง PASS ใน Task 32
- Task 3 ยังต้องมี independent fresh-context acceptance re-review
- Root full backend รันใน managed sandbox ไม่ได้เพราะ loopback/uptime `EPERM`;
  focused production composition ผ่าน แต่ environment failure นี้ไม่ถูกอ้างเป็น PASS

## Next Recommended Agent

fresh-context correctness/security reviewer สำหรับ P0-03 REQ-3 acceptance

## Next Steps

1. อ่าน Task 31 findings, Task 32 evidence/handoff และ review
   `mutation-path.ts` โดย trace CAS, nested rollback, cleanup residue และ callers แบบ
   fresh context
2. rerun focused mutation 6 tests, Task 30/32 public regressions และ safe gates ตาม
   ความเหมาะสม โดยไม่รัน external macOS ก่อน cooldown
3. หากไม่เหลือ finding จึงค่อยพิจารณาปิด Task 3; ห้ามเริ่ม P0-04 ก่อน acceptance gate
