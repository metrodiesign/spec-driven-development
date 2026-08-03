# Handoff: Task 12 — P0-02 amended review fixes

> From: Codex teammate `/root/p0_02_amended_review_fixes`
> To: lead `/root` และ independent fresh-context reviewer
> Date: 2026-07-27
> Scope: แก้ Task 11 High findings H1–H3 เฉพาะ P0-02; ไม่มี P0-03, commit หรือ push

## Task Summary

ปิดสาม contract gaps จาก amended review: ทำ offline dependency policy ให้เป็น
non-empty operational graph ที่มี approved source bytes จริง, ปิด pathname
symlink-swap TOCTOU ใน frozen capture และรวม fixed core tooling กับ command
execution ไว้หลัง async child-process primitive เดียว

## Current Status

`IMPLEMENTATION READY FOR INDEPENDENT FRESH RE-REVIEW — TASK 2 REMAINS [ ]`

- H1–H3 มี discriminating RED/GREEN และ sandbox-safe matrix ผ่าน
- production fixture/policy เปลี่ยนจาก graph ว่างเป็น exact manifest/lock/source
  graph ที่ติดตั้งแบบ offline จริงและ persist เพื่อให้ command ถัดไปใช้ได้
- full core, full AAL, focused backend, typecheck, lint, vendor และ spec trace ผ่าน
- full console มีเฉพาะ managed-sandbox failures ที่จำแนกได้เหมือนรอบก่อน
- external real-macOS verification ยัง blocked ตาม usage limit ถึง August 2 เวลา
  11:46 และไม่ได้ retry/circumvent
- ไม่มี commit หรือ push

## Files Changed

ไฟล์ที่ Task 12 แก้โดยตรง:

- `core/src/security/command-runner.ts` — รวม fixed tool/command launch เป็น async
  `spawn()` primitive เดียว พร้อม timeout, abort, output bound, typed result และ
  process-group cleanup
- `core/src/executor/executor.ts` — เปลี่ยน Git snapshot/hash/rollback เป็น async
  shared primitive
- `core/src/gates/frozen-tree.ts` — เปลี่ยน Git plumbing เป็น async และเพิ่ม
  descriptor-relative `O_NOFOLLOW`/`fstat`/stream hash capture ผ่าน fixed
  `/usr/bin/python3`
- `core/src/gates/frozen-tree.test.ts` — ปรับ async materialization tests
- `core/src/executor/command-executor.ts` — เพิ่ม versioned source mapping,
  frozen manifest/lock graph validation, read-only source provisioning,
  installed-byte verification และ persistent `node_modules` capture/promotion
- `core/src/executor/executor.test.ts` — เปลี่ยน offline fixtures เป็น non-empty
  graph และ source-bound behavior
- `core/src/security/amended-command-contract.test.ts` — เพิ่ม RED/GREEN สำหรับ
  typed core-tool timeout/cancel, symlink swap, unsupported/missing/tampered source,
  frozen revalidation, installed-output tamper และ real offline persistence
- `console/backend/src/loop-cli.ts` — parse/validate production manifest,
  source mapping/content hash และ persistent roots; resolve source path จาก policy
  directory
- `console/backend/src/loop-cli.test.ts` — prove production fixture/policy hashes และ
  source object ตรงกัน
- `console/backend/src/loop-run.ts` — ใช้ synthetic dependency graph แบบ non-empty
- `.ai/policies/security-plane.json` — bind exact manifest/lock/source hashes และ
  hoisted offline command
- `.ai/policies/offline-sources/phase0-offline-dependency/package.json` — approved
  local source object ใหม่
- `.ai/policies/offline-sources/phase0-offline-dependency/index.js` — approved
  local source bytes ใหม่
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — append amended
  review-fix evidence โดยรักษา historical evidence และ Task 2 `[ ]`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-12-p0-02-amended-review-fixes.md`
  — handoff นี้

shared uncommitted P0-02 files อื่นจาก Task 01–11 ยังอยู่ครบและไม่ได้ revert

## Important Decisions

- policy ใช้ local `file:` source object ที่ versioned ใต้ `.ai/policies` และผูก
  SHA-256 ของ sorted file inventory; transient pnpm store ถูกสร้างจาก source bytes
  ที่ core capture และ provision แบบ read-only
- core ตรวจ exact package manifest และ exact pnpm lockfile จาก frozen workspace
  เดียวกับที่ command ใช้ ไม่ตรวจจาก mutable authoritative path ก่อน freeze
- package install อนุญาตเฉพาะ exact command ที่มี `--offline`,
  `--frozen-lockfile`, `--ignore-scripts` และ hoisted node linker; output ที่ persist
  จำกัดไว้ที่ `node_modules` และ installed package bytes ต้องตรง approved source
- Node 26 ไม่มี public `openat`/directory-fd traversal API บน macOS จึงใช้ fixed
  `/usr/bin/python3 -I` helper ผ่าน shared child primitive; helper ยึด root fd,
  เปิดทุก component ด้วย `dir_fd` + `O_NOFOLLOW`, hash ระหว่าง read และส่ง metadata
  ให้ core cross-check
- `runCoreTool` ยังเป็น package-private relative import และไม่ re-export จาก
  `core/src/index.ts`

## Constraints

- ห้ามเริ่ม P0-03
- ห้ามเปลี่ยน Task 2 เป็น `[x]` ก่อน independent re-review และ external real-macOS
  verification
- ห้าม retry/circumvent external run ก่อน usage limit เปิด และห้ามเรียก managed
  skips ว่า real-macOS PASS
- ห้าม commit/push ก่อน review; ห้าม push ตรง `main`/`develop` หรือ force push
- ห้าม revert shared uncommitted edits หรือแก้ historical Task-2 Evidence เดิม

## Tests Run

- Initial H1/H2/H3 RED:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'core tooling has typed|symlink swap|non-empty graph|missing approved source bytes|revalidated from the frozen' src/security/amended-command-contract.test.ts`
  -> `5` tests, `0` pass, `5` fail
- Operational H1 RED:
  focused `non-empty approved offline graph installs` test -> `1` fail,
  `command_failed`
- Final focused P0-02:
  `pnpm --filter core exec node --test --test-reporter spec src/security/amended-command-contract.test.ts src/gates/frozen-tree.test.ts src/security/command-runner.test.ts src/security/sandbox.test.ts src/executor/path-policy.test.ts src/executor/executor.test.ts src/gates/runner.test.ts src/audit/oob.test.ts test/fault-injection.test.ts`
  -> `114` tests, `106` pass, `0` fail, `8` explicit external skips
- Full core: `pnpm --filter core test`
  -> `356` tests, `347` pass, `0` fail, `9` explicit external skips
- Backend focused:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts`
  -> `11` pass, `0` fail
- AAL focused/full:
  `pnpm --filter aal exec node --test --test-reporter spec test/integration.test.ts`
  -> `3` pass; `pnpm --filter aal test` -> `143` pass, `0` fail
- Full console backend:
  `pnpm --filter console-backend test` and TAP count run
  -> `383` tests, `329` pass, `54` fail; `53` listener `EPERM`, remaining doctor
  failure reproduced by `node:os.uptime()` -> `uv_uptime EPERM`
- Typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- Repository gates:
  `pnpm lint`, `scripts/check-core-vendor-free.sh`,
  `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> pass;
  `144` criteria covered and EARS lint pass
- Authority:
  `cmp -s /Users/king_developer/Downloads/loop-engineering-implementation-spec.md loop-engineering-implementation-spec.md`
  -> exit `0`; SHA-256
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- External real macOS: not run; usage-limit blocker remains active until August 2
  at 11:46

## Known Issues

- real macOS SBPL/external suite ยังไม่มี fresh result เพราะ external usage limit;
  managed-sandbox skips ไม่ใช่ PASS
- full console backend จับ loopback listener ไม่ได้ใน managed sandbox และ
  `uv_uptime` ถูกปฏิเสธ; focused production composition ผ่าน
- descriptor-safe capture อาศัย system `/usr/bin/python3` บน required macOS
  platform; executable bytes อยู่ใน environment hash และ failure to launch
  fails closed
- descendant ที่จงใจสร้าง new session ยังอาจอยู่เกิน direct process-group cleanup
  ในมิติ CPU/process lifetime; inherited SBPL และ disposable workspace ยังคงจำกัด
  durable filesystem/network effects ตาม residual เดิม

## Next Recommended Agent

Independent fresh-context correctness/security reviewer สำหรับ P0-02 H1–H3

## Next Steps

1. อ่าน Task 09–12 และ review current worktree เทียบ amended REQ-2.1–REQ-2.49
2. โจมตี frozen manifest/source binding, installed-output verification,
   descriptor-relative capture และ one-spawn async architecture
3. หลัง usage limit เปิด ให้รัน external real-macOS targeted/full matrix และบันทึก
   ผลจริงโดยไม่แทนด้วย managed skips
4. ถ้า fresh re-review และ external verification ผ่าน จึงพิจารณาเปลี่ยน Task 2
   เป็น `[x]`; ถ้ายังมี finding ให้คง `[ ]`
