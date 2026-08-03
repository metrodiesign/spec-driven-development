# Handoff: Task 14 — P0-02 second review fixes

> From: Codex teammate `/root/p0_02_second_review_fixes`
> To: lead `/root` และ independent fresh-context reviewer
> Date: 2026-07-27
> Scope: แก้ Task 13 H1, M1 และ M2 เฉพาะ P0-02; ไม่มี P0-03, commit หรือ push

## Task Summary

ปิดสาม finding จาก Task 13 โดยตรวจ installed dependency อีกครั้งจาก immutable
capture ก่อน promotion, ทำ approved-source capture ให้มี finite aggregate
file/byte/time bounds ตั้งแต่ preflight และทำ `command-scratch-*` cleanup ให้ครอบ
exception จาก evidence persistence ทุกช่วงหลังสร้าง scratch

## Current Status

`IMPLEMENTATION READY FOR INDEPENDENT FRESH RE-REVIEW — TASK 2 REMAINS [ ]`

- H1, M1 และ M2 มี discriminating RED/GREEN ครบ
- focused P0-02, full core, focused backend, focused/full AAL, typecheck, lint,
  vendor, spec trace/EARS, strict Evidence, secret scan, diff hygiene และ authority
  check ผ่าน
- local correctness/security review ไม่พบ actionable finding ใหม่ในขอบเขตนี้
- external real-macOS verification ยัง blocked ตาม usage limit ถึง August 2 เวลา
  11:46 และไม่ได้ retry/circumvent
- ไม่มี dependency, policy, commit หรือ push

## Files Changed

ไฟล์ที่ Task 14 แก้โดยตรง:

- `core/src/executor/command-executor.ts` — เพิ่ม immutable-capture installed-source
  verification, aggregate approved-source capture budgets และเริ่ม deadline ก่อน
  approved-source preflight
- `core/src/security/amended-command-contract.test.ts` — เพิ่ม H1 late stable
  mutation regression และ M1 file-count/total-bytes/deadline regressions
- `core/src/security/command-runner.ts` — ย้าย scratch lifecycle ทั้งก้อนไว้ใต้
  outer `try/finally`
- `core/src/security/command-runner.test.ts` — เพิ่ม throwing evidence regressions
  ที่ wrap และ post-child stages
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — append heading
  `Second review-fix evidence (awaiting fresh re-review)` โดยรักษา Task 2 `[ ]`
  และ historical Evidence เดิม
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-14-p0-02-second-review-fixes.md`
  — handoff นี้

shared uncommitted work จาก Task 01–13 ยังคงอยู่ครบและไม่ได้ revert

## Important Decisions

- live installed-source verification ยังคงเป็น early rejection แต่ไม่ใช่ trust
  boundary สุดท้าย; หลัง pre/post/capture inventories ตรงกันและ capture destination
  ถูกทำ immutable แล้ว core เปรียบเทียบ exact relative path set, normalized file
  mode, byte length และ SHA-256 กับ approved source snapshot ก่อนคำนวณ diff
- approved source, installed source และ provisioned source ใช้ limit set เดียวกับ
  versioned `CommandArtifactPolicy`; budget รวมข้ามทุก source ในแต่ละ traversal set
  เพื่อไม่ให้หลาย package แยกกันหลบ `maxFiles` หรือ `maxTotalBytes`
- capture deadline เริ่มทันทีหลัง offline-policy validation และก่อนอ่าน approved
  source byte แรก จึงครอบ source preflight ด้วย
- source-limit failure ก่อนสร้าง attempt workspace คืน
  `preflight_rejected/offline_dependency_unavailable`; ไม่มี child spawn,
  `node_modules` promotion หรือ temporary attempt ค้าง
- `command-scratch-*` มีเจ้าของ lifecycle เดียวผ่าน outer `try/finally`; exception
  จาก wrap-stage evidence หรือ post-child evidence ถูก propagate ตามเดิมแต่ scratch
  ถูกลบเสมอ

## Constraints

- ห้ามเริ่ม P0-03
- ห้ามเปลี่ยน Task 2 เป็น `[x]` ก่อน independent re-review และ external real-macOS
  verification
- ห้าม retry/circumvent external run ก่อน usage limit เปิด และห้ามเรียก managed
  skips ว่า real-macOS PASS
- ห้าม commit/push ก่อน review; ห้าม push ตรง `main`/`develop` หรือ force push
- ห้าม revert shared uncommitted edits หรือแก้ historical Task-2 Evidence เดิม

## RED Evidence

- H1:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'frozen installed bytes are revalidated' src/security/amended-command-contract.test.ts`
  -> `1` test, `0` pass, `1` fail; stable mutation หลัง live verification ถูก
  capture และ promote
- M1:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'approved source capture obeys' src/security/amended-command-contract.test.ts`
  -> `4` tests, `0` pass, `4` fail across parent และสาม subcases:
  file-count, total-bytes, deadline
- M2:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'evidence failures at wrap and post-child' src/security/command-runner.test.ts`
  -> `3` tests, `0` pass, `3` fail across parent และสอง subcases; แต่ละ case
  เหลือ `command-scratch-*` หนึ่ง directory

## GREEN and Validation Evidence

- H1 focused -> `1` pass, `0` fail
- M1 focused -> `4` pass, `0` fail
- M2 focused -> `3` pass, `0` fail
- combined H1/M1/M2 plus existing capture/promotion lifecycle and non-empty offline
  persistence controls -> `11` tests, `11` pass, `0` fail
- focused final P0-02:
  `pnpm --filter core exec node --test --test-reporter spec src/security/amended-command-contract.test.ts src/gates/frozen-tree.test.ts src/security/command-runner.test.ts src/security/sandbox.test.ts src/executor/path-policy.test.ts src/executor/executor.test.ts src/gates/runner.test.ts src/audit/oob.test.ts test/fault-injection.test.ts`
  -> `122` tests, `114` pass, `0` fail, `8` explicit external real-macOS skips
- full core: `pnpm --filter core test`
  -> `364` tests, `355` pass, `0` fail, `9` explicit external real-macOS skips
- backend focused:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts`
  -> `11` pass, `0` fail
- AAL focused/full:
  `pnpm --filter aal exec node --test --test-reporter spec test/integration.test.ts`
  -> `3` pass, `0` fail;
  `pnpm --filter aal test` -> `143` pass, `0` fail
- root typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- lint: `pnpm lint` -> `ESLint: No issues found`
- vendor: `scripts/check-core-vendor-free.sh`
  -> `OK: core/ and aal/ are vendor-name-free (INV-7)`
- spec trace/EARS:
  `scripts/spec-trace.sh loop-engineering-phase0-conformance`
  -> `144` criteria covered, EARS lint passed
- strict Evidence:
  `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> exit `0`
- secret scan: `.ai/bin/check-secrets.sh --all` -> exit `0`
- diff hygiene: `git diff --check` -> exit `0`
- authority:
  `cmp -s /Users/king_developer/Downloads/loop-engineering-implementation-spec.md loop-engineering-implementation-spec.md`
  -> exit `0`;
  `shasum -a 256 loop-engineering-implementation-spec.md`
  -> `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Review Result

local correctness/security review หลัง GREEN ไม่พบ unresolved actionable finding ใน
H1/M1/M2 scope:

- immutable-capture comparison ปิด stable late-mutation promotion path และยืนยัน
  package identity ผ่าน exact approved `package.json` bytes
- iterative source traversal บังคับ aggregate file/byte bounds ก่อนสะสม content
  และ deadline ถูกตรวจระหว่าง traversal/read
- outer scratch cleanup ครอบ wrap, child result handling และ evidence exception;
  existing command-executor lifecycle regressionsยังครอบ capture/promotion cleanup
- ไม่มี secret, dependency หรือ policy widening

## Known Issues

- real macOS SBPL/external suite ยังไม่มี fresh result เพราะ external usage limit;
  managed-sandbox skips ไม่ใช่ PASS
- full console backend ไม่ได้ rerun เพราะคำขอนี้กำหนด sandbox-safe relevant suite
  และ known managed environment ปฏิเสธ loopback/uptime; focused production
  composition ผ่าน `11/11`
- descendant ที่จงใจสร้าง new session ยังเป็น residual เดิมด้าน CPU/process
  lifetime; inherited SBPL และ disposable capture ยังคงจำกัด durable
  filesystem/network effects

## Next Recommended Agent

Independent fresh-context correctness/security reviewer สำหรับ current P0-02
worktree โดยเริ่มจาก Task 13 findings และ Task 14 regressions

## Next Steps

1. อ่าน Task 09–14 และ review current worktree เทียบ amended REQ-2.1–REQ-2.49
2. โจมตี late installed-output mutation ระหว่าง live verification กับ immutable
   capture, approved-source resource exhaustion และ evidence-store exception paths
3. หลัง usage limit เปิด ให้รัน external real-macOS targeted/full matrix และบันทึก
   ผลจริงโดยไม่แทนด้วย managed skips
4. ถ้า fresh re-review และ external verification ผ่าน จึงพิจารณาเปลี่ยน Task 2
   เป็น `[x]`; ถ้ายังมี finding ให้คง `[ ]`
