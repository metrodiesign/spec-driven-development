# Handoff: Task 11 — P0-02 amended implementation review

> From: Codex teammate `/root/p0_02_amended_review_recovery`
> To: lead `/root` และผู้แก้ไข P0-02 รอบถัดไป
> Date: 2026-07-27
> Scope: independent read-only correctness/security review ของ P0-02 amended implementation

## Task Summary

ตรวจ implementation ปัจจุบันกับ authority
`loop-engineering-implementation-spec.md`, approved amended
`requirements.md`, `design.md`, `tasks.md` และ handoff 01–10 โดยเน้น
REQ-2.1–REQ-2.49, shared child boundary, disposable command workspace,
capture/promotion, resource limits, typed evidence, environment hash,
production offline policy และ package exports

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 3
- Medium: 0
- Low: 0

P0-02 ยังปิดไม่ได้ แม้ sandbox-safe regression ทั้งหมดผ่าน เพราะยังมี contract
gap ที่ทำให้ offline dependency authorization fail open, capture รับ bytes จาก
path race ได้ และ workspace-preparation child ไม่ได้ผ่าน async primitive เดียวตาม
approved design

## Findings

### Critical

ไม่พบ

### High

#### H1 — Offline dependency authorization ไม่มี source provisioning และ fail open เมื่อ dependency ไม่มี `integrity`

**Location**

- `core/src/executor/command-executor.ts:55`
- `core/src/executor/command-executor.ts:246`
- `core/src/executor/command-executor.ts:305`
- `core/src/executor/command-executor.ts:317`
- `core/src/executor/command-executor.ts:539`
- `core/src/executor/command-executor.ts:575`
- `core/src/executor/command-executor.ts:586`
- `core/src/security/command-runner.ts:176`
- `.ai/policies/security-plane.json:3`
- `console/backend/src/loop-cli.ts:90`
- `core/src/security/amended-command-contract.test.ts:922`
- `core/src/executor/executor.test.ts:611`

**Evidence**

- `OfflineDependencyPolicy` ระบุได้เพียง `approvedSourceHashes` แต่ไม่มี
  core-owned source object/store path หรือ mapping จาก hash ไป bytes ที่
  pre-provision แล้ว
- validator อ่านเฉพาะค่า `integrity:` ที่ regex จับได้ แล้ววนตรวจเฉพาะรายการที่พบ
  ถ้า lockfile มี external/local source ที่ไม่มี `integrity` รายการ
  `requestedSourceHashes` จะว่างและ preflight ผ่าน
- validator ไม่อ่าน `package.json` จึงไม่เปรียบ requested dependency graph กับ
  exact lockfile ก่อน spawn
- validator ตรวจ lockfile จาก authoritative worktree ก่อน `freezeWorkingTree`;
  ไม่มีการตรวจซ้ำกับ lockfile ใน frozen disposable workspace จึงมีช่อง
  validate-before-freeze race
- package path สร้างเพียง `node_modules` ว่าง ขณะที่ command runner บังคับ
  `pnpm_config_store_dir` ไปยัง transient store ใหม่ที่ว่าง ไม่มี code ใด copy/mount
  approved source bytes เข้า workspace/store
- production policy และ real package test ใช้ dependency graph ว่างพร้อม
  `approvedSourceHashes: []` จึงผ่านแบบ vacuous; component test ใช้ fake runner ที่
  เขียน `src/installed.txt` เอง ไม่ได้พิสูจน์ package source
- probe ที่สร้าง `package.json` ขอ `foo@1.0.0` และ lockfile source ไม่มี
  `integrity` พร้อม `approvedSourceHashes: []` ได้
  `{"calls":1,"status":"no_changes"}` แปลว่า shared runner ถูกเรียกแทนที่จะ reject
  ก่อน spawn

**Failure scenario**

คำขอ non-empty dependency graph อาจผ่าน preflight โดยไม่มี approved content hash
ถ้า source ไม่มีรูปแบบ `integrity` ที่ regex จับได้ หรือ package manifest ไม่ตรงกับ
lockfile จากนั้น package manager จึงเป็นผู้พบปัญหาหลัง spawn ส่วน graph ที่มี
approved hash จริงก็ไม่มี approved source bytes/store ให้ใช้ใน disposable command
จึงไม่สามารถทำ offline install ได้อย่าง operational

**Impact**

ไม่เป็นไปตาม REQ-2.14, REQ-2.31, REQ-2.33 และ REQ-2.34 และยังไม่มีหลักฐาน
production-wired GREEN ของ non-empty offline graph ตาม required regression matrix
การมี `--offline --frozen-lockfile --ignore-scripts` ยังไม่ทดแทน pre-spawn
graph/source verification ที่ core ต้องเป็นเจ้าของ

**Required fix**

1. ขยาย versioned policy ให้ระบุ core-owned pre-provisioned source/store objects
   และผูกแต่ละ object กับ verified content hash
2. parse manifest + exact frozen lockfile แบบ fail closed; dependency/source ทุก
   รายการที่ต้องใช้ต้องมี supported content identity และอยู่ใน approved policy
3. freeze ก่อน แล้วตรวจ manifest/lockfile/source identity จาก frozen workspace
   เดียวกับที่ command จะใช้
4. materialize หรือ mount approved store/source แบบ read-only ก่อน spawn และ reject
   ทันทีเมื่อ object ใดหายหรือ hash ไม่ตรง
5. เพิ่ม RED/GREEN สำหรับ non-empty real offline dependency, missing `integrity`,
   unmatched manifest/lockfile, missing store object และ tamper ระหว่าง validation
   กับ freeze

#### H2 — Frozen capture มี symlink-swap TOCTOU เพราะอ่านด้วย pathname แทน held descriptor

**Location**

- `core/src/gates/frozen-tree.ts:331`
- `core/src/gates/frozen-tree.ts:346`
- `core/src/gates/frozen-tree.ts:347`
- `core/src/gates/frozen-tree.ts:365`
- `core/src/gates/frozen-tree.ts:366`
- `core/src/executor/command-executor.ts:700`
- `core/src/executor/command-executor.ts:707`

**Evidence**

regular file ถูกอ่านเป็น `lstatSync(source) -> readFileSync(source) ->
lstatSync(source)` โดย pathname ทั้งสามครั้ง ไม่มี held root directory descriptor,
no-follow open หรือ `fstat` บน file descriptor เดียวตาม `design.md:482-495`

**Failure scenario**

new-session descendant ที่ยังมี write authority ใน disposable workspace สามารถ
rename regular file เดิมเก็บไว้, วาง symlink ชั่วคราวไปยัง readable path อื่นระหว่าง
`lstat` กับ `readFileSync`, แล้วคืน inode เดิมก่อน `lstat` หลังอ่านได้
ถ้าทำซ้ำใน pre/post inventory ด้วย bytes เดียวกัน inventory ทั้งสองและ capture
inventory จะตรงกัน แม้ bytes ที่ยอมรับไม่เคยมาจาก regular file ที่ `lstat` ตรวจ
จากนั้น path ที่ role อนุญาตอาจถูก promote ด้วย bytes จากนอก source path

**Impact**

ข้าม invariant ของ REQ-2.16–REQ-2.19 และทำให้ proof ของ REQ-2.42/REQ-2.43
ไม่เพียงพอ การเทียบ inode/size/mtime หลัง pathname read ไม่ผูก bytes กับ object ที่
ตรวจไว้ และ implementation ขัดกับ approved no-follow/`fstat` protocol โดยตรง

**Required fix**

ใช้ traversal ที่ยึด root directory descriptor, เปิดแต่ละ component/file แบบ
no-follow, ตรวจ shape/metadata ด้วย `fstat` บน descriptor เดียว, stream bytes จาก
descriptor นั้นเข้า destination ที่สร้างแบบ exclusive และ hash ระหว่าง stream
จากนั้นเทียบ pre/post/capture inventories ตามเดิม เพิ่ม adversarial regression ที่
สลับ regular file กับ symlink ระหว่างทุก read edge และต้อง reject โดยไม่ promote

#### H3 — Workspace preparation ใช้ synchronous child runner คนละ primitive กับ command runner

**Location**

- `core/src/security/command-runner.ts:5`
- `core/src/security/command-runner.ts:83`
- `core/src/security/command-runner.ts:97`
- `core/src/security/command-runner.ts:104`
- `core/src/security/command-runner.ts:355`
- `core/src/security/command-runner.ts:364`
- `core/src/gates/frozen-tree.ts:96`
- `core/src/executor/executor.ts:147`
- `core/src/security/amended-command-contract.test.ts:223`

**Evidence**

`runCoreTool` เรียก `execFileSync` โดยตรง ขณะที่ agent/gate command ใช้ async
`spawn` อีก implementation หนึ่ง `runCoreTool` ไม่มี timeout, cancellation,
process-group cleanup หรือ typed direct-result evidence การวาง import ทั้งสองไว้ใน
ไฟล์เดียวไม่ทำให้เป็น shared execution primitive เดียว และ static test ตรวจเพียงว่า
production caller files ไม่มี `node:child_process`; test จึงผ่านแม้ boundary module
มี runner สองชุด

Approved design ระบุชัดว่า preparation/capture helpers ต้องเรียก
`SandboxedSpawn` ด้วย core-minted purpose และ shared runner ใช้ async API เพื่อไม่
หยุด lease heartbeat/cancellation (`design.md:440-449`)

**Failure scenario**

Git child ระหว่าง snapshot/freeze/materialize ค้างหรือ block ทำให้ event loop,
lease heartbeat และ cancellation หยุดตาม `execFileSync`; `maxBuffer` จำกัดเพียง
output ไม่ใช่เวลา ไม่มี typed command result/evidence หรือ bounded reap เหมือน
command path

**Impact**

ไม่เป็นไปตาม REQ-2.1 และทำให้ finite capture-time claim ของ REQ-2.41 ไม่ได้ถูก
enforce ระหว่าง synchronous Git/materialization step แม้ clock จะถูกตรวจที่ phase
boundary ภายหลัง

**Required fix**

รวม fixed control-plane tools และ sandboxed commands ไว้หลัง internal async child
primitive เดียว โดยใช้ core-minted purpose/policy สำหรับ control-plane invocation
เพิ่ม timeout, abort, bounded output, process-group cleanup และ typed evidence/result
ให้ทุก mode แล้วเปลี่ยน architecture test ให้ตรวจว่าไม่มี second spawn/exec
implementation ภายใน boundary module

### Medium

ไม่พบ finding แยกต่างหาก; availability impact ของ capture timeout รวมอยู่ใน H3

### Low

ไม่พบ

## Verified Areas

จาก source review และ regression ที่ผ่าน ไม่พบ actionable gap เพิ่มในรายการต่อไปนี้:

- agent/gate command ใช้ disposable workspace และ core-owned promotion orchestration
- non-zero artifact command กลายเป็น `command_failed` และไม่ promote
- role/golden diff policy, unsupported changed shapes และ capture destination แยกจาก
  sandbox writable roots
- typed result/evidence ระบุ macOS capability limitation อย่างตรงไปตรงมา
- environment hash ผูก policy hash และ content hash ของ resolved toolchain bytes
- production CLI โหลดและ bind offline policy object เข้าสู่ executor
- package exports ไม่เปิด `createCommandRunner`, `runCoreTool` หรือ sandbox wrapper
  เป็น public export

รายการเหล่านี้ไม่หักล้าง High findings ด้าน operational source provisioning,
pathname capture race และ shared primitive

## Verification Evidence

- `pnpm --filter core test`
  - `350` tests, `341` pass, `0` fail, `9` explicit skips
- focused amended/P0-02 run ใน review session
  - `78` tests, `75` pass, `0` fail, `3` explicit skips
- `pnpm --filter core typecheck`
  - pass
- `pnpm --filter console-backend typecheck`
  - pass
- `scripts/spec-trace.sh loop-engineering-phase0-conformance`
  - pass: `144` criteria referenced และ EARS lint ผ่าน
- custom missing-integrity preflight probe
  - observed `{"calls":1,"status":"no_changes"}`; ควรเป็น pre-spawn rejection

ไม่ได้ retry real macOS suite ตามข้อจำกัดภายนอกที่บันทึกไว้จนถึง
2026-08-02 11:46 Asia/Bangkok และไม่ได้อ้างว่า suite นั้นผ่าน

## Files Changed by This Review

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-11-p0-02-amended-review.md`

ไม่มีการแก้ production code, tests, requirements, design, tasks, Task 2 checkbox,
commit, push หรือ P0-03

## Next Steps

1. คง Task 2 เป็น `[ ]`
2. แก้ H1–H3 พร้อม adversarial RED/GREEN ตาม required fix
3. รัน focused P0-02, full core, console composition checks, typecheck, lint,
   spec-trace และ external real macOS suite เมื่อ blocker หมด
4. ให้ fresh-context reviewer ใหม่ตรวจอีกครั้งก่อนปิด P0-02
