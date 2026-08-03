# Task 15 — P0-02 Final Fresh-context Re-review

> วันที่: 2026-07-27  
> ขอบเขต: review-only ของ current P0-02 worktree หลัง Task 14 เทียบ authority,
> approved/amended REQ-2.1–REQ-2.49, design, tasks และ findings จาก Task 11/13  
> ข้อจำกัด: ไม่แก้ production/test/spec/tasks, ไม่ mark Task 2, ไม่ commit/push,
> ไม่เริ่ม P0-03 และไม่ retry/circumvent external real-macOS suite

## Verdict

`REQUEST_CHANGES`

Task 14 ปิด M2 และปิด byte-mutation case เดิมของ H1 รวมทั้งเพิ่ม file/byte bounds
ของ M1 ได้ แต่ immutable verifier ยังตรวจเฉพาะ subtree ของ package ที่ approve
ขณะที่ diff policy อนุญาตทุก path ใต้ `node_modules` จึงมี stable late-write
ที่เพิ่ม package ใหม่แล้วถูก promote ได้จริง นอกจากนี้ configured
`captureTimeoutMs` ยังไม่ถูกส่งเข้า descriptor child ทำให้ approved-source read
หนึ่งครั้งรอ fixed timeout 120 วินาทีได้ก่อนตรวจ deadline ซ้ำ

external real-macOS suite ยังคงเป็น blocker แยกต่างหากตาม account usage limit
ถึง 2026-08-02 เวลา 11:46; review นี้ไม่ได้ retry และไม่ได้อ้าง managed-sandbox
skip ว่าเป็น real-macOS PASS

## Finding Count

- Critical: 0
- High: 1
- Medium: 1
- Low: 0

## Findings

### High

#### H1 — Immutable verifier ไม่ปิด installed package set แต่ diff อนุญาตทั้ง `node_modules`

**Location**

- `core/src/executor/command-executor.ts:481`
- `core/src/executor/command-executor.ts:486`
- `core/src/executor/command-executor.ts:488`
- `core/src/executor/command-executor.ts:1198`
- `core/src/executor/command-executor.ts:1224`
- `core/src/executor/command-executor.ts:1230`

**Evidence**

`verifyCapturedInstalledApprovedSources()` วนเฉพาะ `approvedSourceSnapshots` และ
filter entry ด้วย prefix `node_modules/<approved package>/` ดังนั้น entry ของ
package อื่นไม่เข้าสู่ comparison เลย แต่ `dependencyOutputAllowed` ยอมรับทุก
change ที่เท่ากับหรืออยู่ใต้ persistent root ซึ่ง production กำหนดเป็น
`node_modules`

safe local probe ใช้ approved package ที่ตรง source ทุก byte แล้ว inject stable
`node_modules/rogue-package/package.json` ที่ `pre_inventory` หลัง live
verification ผลจริงคือ:

```text
{
  "status": "promoted",
  "roguePromoted": true,
  "rogueContents": "{\"name\":\"rogue-package\",\"version\":\"9.9.9\"}\n",
  "attemptsEmpty": true
}
```

pre/post/captured inventories ตรงกัน, immutable verifier เห็น approved subtree
เดิมครบ และ blanket persistent-root exception ทำให้ rogue package ถูก promote
ไป authoritative worktree

**Failure scenario**

descendant ที่หลุด process group ผ่าน known new-session residual หรือ race/fault
หลัง live installed verification เพิ่ม package, `.bin` executable หรือไฟล์อื่น
ใต้ `node_modules` แล้วหยุดเขียนก่อน `pre_inventory` bytes ชุดนั้นจะถูก capture
อย่างสม่ำเสมอและผ่าน promotion แม้ไม่อยู่ใน approved package graph

**Impact**

installed package set/identity ไม่ได้ผูกกับ approved offline graph ที่ core ใช้
promote จริง ผิด trust boundary ของ REQ-2.16–2.19, REQ-2.33–2.34 และ
REQ-2.42–2.45 Task 13 H1 จึงปิดเฉพาะการเปลี่ยน bytes ภายใน approved subtree
แต่ยังปิด installed-set boundary ไม่ครบ

**Required fix**

ตรวจ exact installed output set จาก immutable capture ก่อน diff/promotion:
อนุญาตเฉพาะ approved package roots และ package-manager metadata ที่กำหนดรูปแบบ/
identity ไว้อย่างชัดเจน ห้าม blanket-allow path อื่นใต้ `node_modules` และผูก
ทุก package/binary ที่ persist กับ frozen approved graph เพิ่ม regression ที่
เพิ่ม sibling package หรือ `.bin` หลัง live verification แล้วต้องได้
`capture_rejected`, promote ศูนย์ไฟล์ และ cleanup ครบ

### Medium

#### M1 — Approved-source deadline ไม่ครอบ in-flight descriptor read

**Location**

- `core/src/executor/command-executor.ts:366`
- `core/src/executor/command-executor.ts:371`
- `core/src/executor/command-executor.ts:933`
- `core/src/executor/command-executor.ts:945`
- `core/src/gates/frozen-tree.ts:419`
- `core/src/gates/frozen-tree.ts:429`
- `core/src/security/amended-command-contract.test.ts:1329`

**Evidence**

deadline เริ่มก่อน approved-source traversal แล้วและ `ensureTime()` ถูกเรียกก่อน/
หลัง `await readRegularFileByDescriptor()` แต่ helper ไม่มี deadline หรือ
`AbortSignal` parameter และเรียก shared child ด้วย
`timeoutMs: CORE_TOOL_TIMEOUT_MS` ซึ่งเป็นค่าคงที่ 120,000 ms การตรวจหลัง await
จึงบอกว่าเกินเวลาได้ แต่ไม่บังคับ configured limit ระหว่างที่ child กำลังรัน

deadline regression ปัจจุบัน inject clock ให้ call ที่สองคืน 10 ms จึง reject
ก่อน descriptor read แรก และไม่พิสูจน์ in-flight deadline

**Failure scenario**

เมื่อ policy ตั้ง `captureTimeoutMs: 5` และ descriptor helper ช้าหรือค้าง
approved-source preflight สามารถรอได้ถึง 120 วินาทีก่อนคืน structured rejection
แทนที่จะถูกยกเลิกตาม versioned 5 ms deadline

**Impact**

file-count และ aggregate byte caps ทำงานแล้ว แต่ capture-time limit ของ REQ-2.41
ยังไม่ใช่ enforced limit จริงบน I/O boundary จึงเหลือ availability/resource-bound
gap ใน Task 13 M1

**Required fix**

ส่ง absolute deadline/remaining milliseconds และ `AbortSignal` ผ่าน
`captureApprovedSource()` ไป `readRegularFileByDescriptor()` แล้ว cap child
timeout ด้วย `min(remaining, CORE_TOOL_TIMEOUT_MS)` หรือ abort shared child เมื่อ
deadline หมด เพิ่ม injectable slow-reader regression ที่เริ่ม read ได้จริงแล้ว
ยืนยัน bounded elapsed time, typed rejection, no spawn ของ package command และ
cleanup ครบ

## Closure Matrix

### Task 13

- H1: ปิด byte mutation ภายใน approved package แล้ว แต่ยังไม่ปิด extra installed
  package/path set ตาม High finding ข้างต้น
- M1: ปิด iterative traversal, aggregate `maxFiles`, `maxSingleFileBytes`,
  `maxTotalBytes` และเริ่ม clock ก่อน source preflight แล้ว แต่ in-flight deadline
  ยังไม่ปิดตาม Medium finding
- M2: ปิดแล้ว `command-scratch-*` อยู่ใต้ outer `try/finally` ครอบ wrap-stage และ
  post-child evidence exceptions; focused regression ผ่าน

### Task 11

- H1: production policy เป็น non-empty operational graph จริง, exact
  manifest/lock/source hashes, lifecycle scripts disabled, `network: none`,
  production composition fail-closed และ real local offline install/persistence
  regression ผ่าน แต่ overall installed-set closure ยังติด High finding ใหม่
- H2: ปิดแล้ว descriptor-relative traversal ยึด root fd, ใช้ `O_NOFOLLOW` ทุก
  component/final file, ตรวจ pre/post `fstat`, streamed bytes/hash และ Node-side
  metadata cross-check; symlink-swap regression ผ่าน
- H3: ปิดแล้ว executor/gate/frozen-tree child launches รวมที่ async
  `runChildProcess()` ซึ่งมี production `spawn()` จุดเดียวใน
  `core/src/security/command-runner.ts:147`; timeout/cancel/output cap/group reap
  เป็น typed path เดียว

### Public surface และ production composition

- `core/package.json` export เฉพาะ `.`, `./ports`, `./types`
- package root export `createCoreCommandExecutor` แต่ไม่ export
  `createCommandRunner`, `runCoreTool` หรือ `denyNetworkSandbox`
- `.ai/policies/security-plane.json` มี approved source จริงหนึ่ง package,
  persistent root `node_modules`, exact command
  `pnpm install --offline --frozen-lockfile --ignore-scripts --config.node-linker=hoisted`
- `console/backend/src/loop-cli.ts` parse/validate source relative to policy file;
  `console/backend/bin/platform.ts` โหลดก่อน fake/live adapter construction และ
  `console/backend/src/loop-run.ts` bind policy เข้า core executor
- authority SHA-256 ตรง
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Tests and Probes Run

- rogue-package immutable-capture probe:
  `promoted`, `roguePromoted:true`, attempt cleanup ผ่าน — ยืนยัน High finding
- targeted Task 14 H1/M1:
  `5` tests, `5` pass, `0` fail
- targeted Task 14 M2:
  `3` tests, `3` pass, `0` fail
- full core:
  `364` tests, `355` pass, `0` fail, `9` explicit external skips
- focused backend production policy:
  `11` tests, `11` pass, `0` fail
- full console backend: exit `1` จาก managed environment; failures ที่เห็นเป็น
  `listen EPERM: operation not permitted 127.0.0.1`/known restricted host
  behavior ไม่ได้ใช้เป็น P0-02 PASS หรือเป็น finding ของ diff นี้
- `pnpm typecheck`: workspace ทั้ง 6 projects ผ่าน
- `pnpm lint`: `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh`: ผ่าน
- `scripts/spec-trace.sh loop-engineering-phase0-conformance`: 144 criteria,
  EARS lint ผ่าน
- strict Evidence และ full-tree secret scan: ผ่าน
- `git diff --check`: ผ่าน
- authority local copy comparison และ SHA-256: ผ่าน

## External Blocker

ไม่ได้รัน external real-macOS SBPL/descendant/offline matrix เพราะ recorded account
usage limit ยังมีผลถึง 2026-08-02 เวลา 11:46 ไม่มีการ retry, workaround หรือ
นำ managed-sandbox skips มาแทน external evidence ดังนั้นถึงแก้ findings ด้านบน
แล้ว Task 2 ยังต้องคง `[ ]` จนมี fresh real-macOS result จริง

## Recommended Next Step

แก้ High installed-output set boundary และ Medium deadline propagation พร้อม
discriminating regressions จากนั้นให้ fresh reviewer ตรวจซ้ำเฉพาะ current P0-02
และเมื่อ usage limit เปิดจึงรัน external real-macOS matrix ก่อนพิจารณาปิด Task 2
