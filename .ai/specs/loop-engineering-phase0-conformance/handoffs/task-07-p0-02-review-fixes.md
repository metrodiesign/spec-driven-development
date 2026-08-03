# Handoff: Task 07 — P0-02 review fixes

> From: Codex teammate `/root/p0_02_review_fixes`
> To: lead `/root`
> Date: 2026-07-27
> Scope: แก้เฉพาะ P0-02 review findings จาก `task-06-p0-02-review.md`

## Task Summary

แก้ P0-02 ตาม fresh-context review ครบ 6 High และ 3 Medium findings ด้วย TDD:
เขียน regression tests ให้ RED ก่อน เปลี่ยน shared child boundary, frozen gate tree,
recovery, environment/package-install policy และ OOB classification แล้วพิสูจน์ด้วย
macOS SBPL จริงและ full regression suites โดยไม่เริ่ม P0-03

## Current Status

`DONE`

Task 2 เปิดกลับก่อนแก้ production และปิดอีกครั้งหลัง focused/full suites,
typecheck, lint, vendor scan, spec trace และ diff hygiene ผ่านทั้งหมด

## Finding-to-Fix Traceability

1. Git filters/hooks/user config ระหว่าง materialization:
   `core/src/gates/frozen-tree.ts` สร้าง isolated repository/index/object database ผ่าน
   fixed `/usr/bin/git` plumbing, ปิด system/global config, hooks, fsmonitor และ
   excludes; อ่าน blob แบบ `--no-filters`; ไม่แตะ caller index และไม่ register
   worktree มี regression ที่ filter marker ต้องไม่เกิด, executable/symlink mode ต้อง
   คงเดิม และ unsafe symlink/gitlink ต้อง fail closed
2. child output ปลอมหรือซ่อน sandbox denial:
   `CommandRunner` ไม่ parse child output แล้ว SBPL deny rules ใช้
   enforcement-owned `SIGKILL`; benign denial text จึงผ่าน แต่ hidden forbidden write
   ถูก structured reject พร้อม evidence
3. built-in checks อ่าน mutable authoritative tree:
   `GateRunner` ส่งทั้ง commands, convention, manifest และ full-golden checks ไปยัง
   frozen materialization เดียวกัน มี regression mutate authoritative tree หลัง freeze
   ทั้งสองทิศ
4. recovery ข้าม task/run และ missing/invalid role:
   terminal/replay identity bind ด้วย `runId + taskId + actionId`; role ที่หายหรือ
   invalid fail closed และ rollback แทน fallback เป็น implementer
5. PATH/environment/package install ใช้งานจริงไม่ได้:
   runner สร้าง sanitized PATH ที่รวม active toolchain, bind toolchain/base environment
   เข้า stable `environmentHash`, และสร้าง per-command HOME/TMP/cache/store;
   governed install ได้เฉพาะ `node_modules`, exact lockfile/staging และ ephemeral
   package-manager roots มี real frozen-lockfile install regression
6. descendant อยู่ต่อหลัง parent สำเร็จ:
   process group ถูก terminate/reap ใน completion ทุกทาง รวม normal exit, timeout,
   cancellation และ output cap มี delayed background-writer regression
7. timeout ไม่มี validation/ceiling/cancellation:
   invalid, non-integer, non-finite, non-positive และมากกว่า 300000 ms ถูก reject
   ก่อน snapshot/INTENT; `AbortSignal` ยกเลิก command และ cleanup group
8. SBPL path interpolation:
   encoder escape `\` และ `"` อย่างถูกต้อง, รองรับ Unicode และ reject control
   characters ก่อน spawn พร้อม regression ทั้ง allowed และ protected paths
9. mixed hard failure กับ flake:
   `classifyOobChecks` ให้ deterministic hard failure มี precedence เหนือ flake;
   pure และ wired integration regressions ครอบคลุม mixed report

## Files Changed

- `core/src/security/command-runner.ts` — shared async runner, bounded byte evidence,
  environment identity, cancellation และ process-group lifecycle (edited)
- `core/src/security/command-runner.test.ts` — denial attribution, toolchain, byte cap,
  cancellation และ cleanup regressions (new)
- `core/src/security/sandbox.ts` — enforcement signal, safe SBPL encoding และ narrow
  package-manager grants (edited)
- `core/src/security/sandbox.test.ts` — SBPL encoding/signal/package-root tests (new)
- `core/src/gates/frozen-tree.ts` — core-owned frozen tree materializer (new)
- `core/src/gates/runner.ts`, `core/src/gates/runner.test.ts` — route all checks to one
  isolated snapshot and cover hostile Git metadata/index/modes/symlinks (edited)
- `core/src/executor/executor.ts`, `core/src/executor/executor.test.ts` — timeout,
  recovery identity/role และ governed-install lifecycle (edited)
- `core/src/types.ts` — structured rejection reasons (edited)
- `core/src/audit/oob.ts`, `core/src/audit/oob.test.ts` — hard-failure precedence
  (edited)
- `core/test/fault-injection.test.ts` — DoD#3 structured enforcement expectation
  (edited)
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — preserve prior Evidence,
  append amended Evidence และปิดเฉพาะ Task 2 (edited)

## Important Decisions

- ใช้ SBPL enforcement signal เป็น control channel แทนการอนุมานจาก stdout/stderr
  เพราะ child redirect หรือปลอม output ได้
- frozen tree ไม่ใช้ `git checkout`/`worktree add`; materialization ต้องไม่มี process
  จาก target-controlled filter/config และต้องไม่เปลี่ยน staged state
- package-install grant ไม่เปิด workspace root; อนุญาต exact output/staging paths และ
  core-owned ephemeral scratch เท่านั้น
- `environmentHash` bind deterministic environment/toolchain template ไม่ bind
  per-command random scratch path
- output limit เป็น encoded bytes และ cleanup เกิดก่อน resolve result

## Constraints

- ห้ามเริ่ม P0-03 ใน handoff นี้
- ห้าม commit, push, force-push หรือแก้ `main`/`develop` ตรง
- real `sandbox-exec` verification ต้องรันนอก nested managed sandbox ตาม D-003
- ต้องรักษา P0-02 Evidence เดิมไว้เมื่อเพิ่มผล review-fix

## Tests Run

- review RED focused suite -> `57` tests, `30` pass, `27` fail; `22`
  discriminating failures และ `5` expected nested-sandbox refusals
- focused GREEN outside managed sandbox:
  `pnpm --filter core exec node --test --test-reporter spec src/security/command-runner.test.ts src/security/sandbox.test.ts src/executor/executor.test.ts src/gates/runner.test.ts src/audit/oob.test.ts`
  -> `58` passed, `0` failed
- test: `pnpm --filter core test` outside managed sandbox -> `325` passed, `0` failed
- test: `pnpm --filter console-backend test` outside managed sandbox -> `381` passed,
  `0` failed
- typecheck: `pnpm --filter core typecheck` -> exit `0`
- typecheck: `pnpm --filter console-backend typecheck` -> exit `0`
- lint: `pnpm lint` -> exit `0`
- vendor scan: `scripts/check-core-vendor-free.sh` -> pass
- spec trace: `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `107`
  criteria covered, EARS pass
- diff hygiene: `git diff --check` -> exit `0`

## Review Result

Code/correctness และ security self-review หลัง GREEN ไม่พบ actionable finding ใหม่ใน
scope P0-02 ทั้งเก้า finding มี regression proof และ source-to-sink closure ตามรายการ
ข้างต้น

## Known Issues

- enforcement-owned `SIGKILL` ทำให้ child ที่ self-terminate ด้วย signal เดียวกันถูก
  reject แบบ fail closed; เป็น availability false-positive แต่ไม่สร้าง false success
- descendant ที่ตั้งใจเรียก `setsid` สามารถออกจาก process group ก่อน cleanup ได้;
  SBPL ยังจำกัด file/network operations แต่ CPU-only daemon อาจอยู่จน process/OS
  cleanup นี่เป็น residual policy สำหรับ hardening ภายหลัง ไม่ควรอ้างว่า group cleanup
  ครอบคลุม session escape
- `COREPACK_HOME` เป็น read-only toolchain input จึงต้องมี package-manager cache ที่
  provision ไว้ใน environment; identity ถูก bind ใน `environmentHash`
- non-darwin platform ยัง fail closed เป็น `sandbox_unavailable` ตาม Phase 0 contract
- residual จาก review เดิมเรื่อง caller staged index, registered worktree, character-
  based output cap และ output-derived network proof ถูกปิดแล้วด้วย isolated plumbing,
  byte cap และ real macOS DoD#3 enforcement test

## Next Recommended Agent

fresh-context human/security review หรือ lead `/root` เพื่อรับ P0-02 และเลือกเริ่ม
P0-03 ใน turn ถัดไป

## Next Steps

1. ตรวจ diff และ Evidence/handoff นี้แบบ fresh context
2. หากรับ P0-02 แล้ว ให้เริ่ม P0-03 ตาม spec workflow โดยเขียน RED ก่อน
