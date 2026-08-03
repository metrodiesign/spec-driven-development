# Task 13 — P0-02 Amended Independent Re-review

> วันที่: 2026-07-27  
> ขอบเขต: fresh-context correctness/security re-review ของ current P0-02 worktree หลัง Task 12 เทียบ authority, approved/amended REQ-2.1–REQ-2.49, design และ tasks เท่านั้น  
> ข้อจำกัด: review-only; ไม่แก้ production/test/spec/tasks, ไม่ mark Task 2, ไม่ commit/push และไม่เริ่ม P0-03

## Verdict

`REQUEST_CHANGES`

Task 12 ปิด H2 และ H3 เดิมได้ และทำให้ offline graph เป็น non-empty operational
graph จริง แต่ยังมี High finding ใน trust boundary ของ installed dependency:
การตรวจ approved bytes เกิดก่อน frozen capture จึงมีช่วงที่ stable late mutation
ถูก capture และ promote ได้ นอกจากนี้ยังพบ Medium สองรายการด้าน resource bounds
และ cleanup

external real-macOS suite ยังเป็น blocker แยกต่างหาก และไม่ได้ retry หรืออ้างว่า
ผ่าน: account usage limit เดิมเปิดอีกครั้งวันที่ 2026-08-02 เวลา 11:46

## Finding Count

- Critical: 0
- High: 1
- Medium: 2
- Low: 0

## Findings

### High

#### H1 — Installed dependency ถูกตรวจบน live workspace ก่อน freeze จึง promote bytes ที่ไม่ approved ได้

**Location**

- `core/src/executor/command-executor.ts:1036`
- `core/src/executor/command-executor.ts:1043`
- `core/src/executor/command-executor.ts:1059`
- `core/src/executor/command-executor.ts:1091`
- `core/src/executor/command-executor.ts:1131`

**Evidence**

`verifyInstalledApprovedSources()` ตรวจ `node_modules/<package>` ที่
`core/src/executor/command-executor.ts:1036-1041` แล้ว core ยัง revalidate/remove
provisioned source และเรียก `pre_inventory` ก่อนเริ่ม frozen capture
จากนั้น `node_modules` ทั้ง root ผ่าน policy ด้วย `dependencyOutputAllowed`
ที่ `:1131-1142` โดยไม่มีการตรวจ approved installed bytes ซ้ำจาก immutable
capture destination

safe probe ใช้ fake command runner สร้าง installed package ที่ตรง approved source
ทุก byte แล้ว mutate `node_modules/probe-dep/index.js` ที่ failpoint
`pre_inventory` หลัง verification ผลจริงคือ:

```text
{"resultStatus":"promoted","resultDetail":null,"outputExists":true,"promoted":"module.exports = \"tampered-after-verification\";\n"}
```

mutation คงที่ตลอด pre-copy/post-copy/capture inventory จึงผ่าน consistency checks
ทั้งหมดและถูก promote ไป authoritative worktree

**Failure scenario**

หลัง package command return และ live installed-byte verification ผ่าน
descendant ที่ยังอยู่, external race หรือ fault ที่เกิดก่อน `pre_inventory`
เปลี่ยนไฟล์ใต้ `node_modules` แล้วหยุดเปลี่ยน bytes ชุดใหม่นี้ไม่ตรง approved
source hash แต่ถูก frozen อย่างสม่ำเสมอ จึงผ่านสอง inventories และ promote
ในฐานะ persistent dependency output

**Impact**

ผิด REQ-2.16–2.19, REQ-2.33–2.34 และ frozen-copy trust boundary ของ
REQ-2.42–2.45 เพราะ content-hash approval ไม่ได้ผูกกับ bytes ที่ core ใช้ promote
จริง Task 11 H1 จึงยังไม่ปิดครบ แม้ happy-path install/persistence และ
manifest/lock/source validation จะทำงานแล้ว

**Required fix**

ตรวจ installed source set อีกครั้งจาก core-owned immutable capture destination
หลัง pre/post/capture hashes ตรงกันและก่อนคำนวณ/อนุญาต promotion โดยเปรียบเทียบ
exact path set, file bytes/hash และ package identity กับ approved source snapshots
การตรวจ live workspace ก่อน capture อาจคงไว้เป็น early rejection ได้ แต่ห้ามใช้แทน
frozen-copy validation เพิ่ม regression ที่ mutate installed output หลัง live
verification แต่ก่อน `pre_inventory` แล้วต้องได้ `capture_rejected`, promote
ศูนย์ไฟล์ และ cleanup ครบ

### Medium

#### M1 — Approved source traversal ไม่อยู่ใต้ file-count, total-byte หรือ capture-time limits

**Location**

- `core/src/executor/command-executor.ts:285`
- `core/src/executor/command-executor.ts:306`
- `core/src/executor/command-executor.ts:325`
- `core/src/executor/command-executor.ts:375`
- `core/src/executor/command-executor.ts:851`
- `core/src/executor/command-executor.ts:877`

**Evidence**

`captureApprovedSource()` รับเฉพาะ `maxSingleFileBytes`; มัน recurse ทุก directory,
สะสม path ทุกไฟล์ แล้วเก็บทุก content เป็น `Buffer` ไม่มี `maxFiles`,
`maxTotalBytes` หรือ deadline การเรียกนี้เกิดที่ `:851-870` ก่อนตั้ง
`startedAt` ที่ `:877` ดังนั้น `captureTimeoutMs` ไม่ครอบคลุมขั้นนี้

**Failure scenario**

approved source path ถูกแทนด้วย tree ที่มีไฟล์เล็กจำนวนมากหรือ total bytes สูง
แต่แต่ละไฟล์ไม่เกิน single-file ceiling Core จะ traverse และ buffer ทั้งหมดก่อน
คำนวณ hash mismatch และก่อนเริ่ม capture deadline

**Impact**

ทำให้ offline-source preflight ใช้ memory/time แบบไม่ bounded และอาจ OOM หรือค้าง
แทน structured fail-closed result แม้ output artifact path จะมี limits ตาม
REQ-2.27/2.41 แล้ว

**Required fix**

ส่ง versioned limit set และ deadline เข้า source capture/installed verification
นับ file count และ cumulative bytes ระหว่าง traversal/read ก่อนสะสม content
ใช้ iterative traversal หรือ bounded recursion และเริ่ม deadline ก่อน capture
approved sources เพิ่ม fault tests สำหรับ file count, total bytes และ time ที่
source preflight โดยยืนยัน structured rejection, no spawn และไม่มี temporary
artifact ค้าง

#### M2 — `command-scratch-*` ไม่ cleanup เมื่อ evidence persistence โยน exception

**Location**

- `core/src/security/command-runner.ts:530`
- `core/src/security/command-runner.ts:543`
- `core/src/security/command-runner.ts:615`
- `core/src/security/command-runner.ts:626`

**Evidence**

normal path สร้าง `transientRoot` ที่ `:530`, เขียน evidence ที่ `:615-625`
แล้วจึงลบที่ `:626` โดยไม่มี outer `finally`; wrapping-error path ก็เขียน evidence
ก่อน cleanup เช่นกัน Probe ที่ inject `EvidenceStore.put()` ให้ throw หลัง child
จบให้ผล:

```text
{"thrown":"injected evidence failure","leftovers":["command-scratch-ncRjSC"]}
```

probe ลบ temporary root ของตนเองหลังตรวจแล้ว

**Failure scenario**

evidence directory เต็ม, permission เปลี่ยน หรือ evidence store failure เกิดหลัง
command จบ `run()` throw และทิ้ง HOME/cache/store scratch ของ command ไว้
การ retry ทำให้สะสม directory เพิ่ม

**Impact**

ผิด cleanup guarantee ของ REQ-2.28 สำหรับ core-owned temporary artifact และเปิด
availability/disk-exhaustion risk บน failure path ที่ test ปัจจุบันไม่ inject

**Required fix**

ครอบ lifecycle หลังสร้าง `transientRoot` ด้วย `try/finally` ที่ลบ root เสมอ
รวม sandbox-wrap, child run, observation และ evidence persistence เพิ่ม regression
ที่ evidence put โยนทั้ง wrap-error และ post-child paths แล้ว assert ไม่มี
`command-scratch-*` เหลือ

## Closure of Task 11 Findings

### H1 เดิม — ปิดบางส่วน แต่ยังติด H1 ใหม่ข้างต้น

- production policy/fixture เป็น non-empty graph จริง
- manifest hash `0dd7803340af156b05ee20470ff07b5730682f96f91cf469658f84abae728b24`
- lock hash `88975c06ba94873fd4435ccf8c9ca66ee27b8351394b95c28de6eb936f3c10b1`
- approved source inventory hash
  `4491463319ea7693f44b010ee19354206601b211b117ef22d7cdd7137b583e2f`
- exact manifest/lock graph, source identity, read-only provisioning, installed
  package bytes และ later read-only consumption มี operational regression ผ่าน
- `console/backend/bin/platform.ts` โหลดและ validate policy ก่อน adapter construction
  แล้วส่งเข้า production executor
- ส่วนที่ยังไม่ปิดคือ approved installed bytes ไม่ถูก revalidate จาก frozen bytes
  ที่ใช้ promote

### H2 เดิม — ปิด

`core/src/gates/frozen-tree.ts:78-155` ใช้ fixed `/usr/bin/python3 -I`, ยึด root
directory fd, เปิดทุก component แบบ descriptor-relative ด้วย `O_NOFOLLOW`,
ตรวจ `fstat` regular file และ identity ก่อน/หลัง read พร้อม hash ระหว่าง stream
Node cross-check metadata, size และ digest อีกชั้น Symlink-swap regression ผ่าน

portability เป็น fail-closed dependency บน `/usr/bin/python3` ของ required macOS
platform และ executable bytes รวมใน toolchain environment hash; external macOS
verification ยัง pending ตาม blocker

### H3 เดิม — ปิด

production scope มี `spawn()` implementation เดียวที่
`core/src/security/command-runner.ts:147`; ทั้ง `runCoreTool()` และ sandboxed
command delegate เข้า `runChildProcess()` เดียวกัน มี async timeout,
AbortSignal cancellation, bounded stdout/stderr, typed terminal result และ
process-group reap Executor/gate/frozen-tree ไม่มี direct child-process import
หรือ second spawn implementation Low-level runner และ sandbox wrapper ไม่ถูก
re-export จาก package root

## Additional Review Notes

- authority SHA-256 ตรงค่าที่อนุมัติ:
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- normal non-zero artifact command กลายเป็น `command_failed` และไม่เข้า capture/
  promotion ตาม REQ-2.48–2.49
- production macOS backend รายงาน capability อย่างซื่อสัตย์:
  `direct_only`, containment `false`, descendant termination
  `unproven_new_session`, และไม่ fabricate `sandbox_violation`
- public package root มี orchestration contract เดียวสำหรับ direct
  `RUN_COMMAND`; `createCommandRunner`, `runCoreTool` และ `denyNetworkSandbox`
  ไม่ถูก export
- ไม่มี dependency ใหม่ และ source/policy hashes ตรง fixture ที่ production test ใช้

## Tests and Probes Run

- Focused amended contract/frozen tree/command runner/sandbox:
  `node --test --test-reporter spec --test-name-pattern='REQ-2\.(1|25|26|27|28|30|31|32|33|34|35|36|37|38|39|40|41|42|43|44|45|46|47|48|49)' core/src/security/amended-command-contract.test.ts core/src/gates/frozen-tree.test.ts core/src/security/command-runner.test.ts core/src/security/sandbox.test.ts`
  -> `24` pass, `0` fail
- Full core:
  `pnpm --filter core test`
  -> `356` tests, `347` pass, `0` fail, `9` explicit external skips
- Production policy:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts`
  -> `11` pass, `0` fail
- `pnpm --filter core typecheck`
  -> exit `0`
- `pnpm --filter console-backend typecheck`
  -> exit `0`
- `pnpm lint`
  -> `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh`
  -> `OK: core/ and aal/ are vendor-name-free (INV-7)`
- `git diff --check`
  -> exit `0`
- Late installed-byte mutation probe
  -> `promoted` พร้อม tampered bytes ตาม H1
- Evidence-write cleanup probe
  -> พบ `command-scratch-*` ค้างตาม M2; probe cleanup root ของตนเองแล้ว

## External Verification

ไม่ได้ retry หรือพยายาม circumvent external real-macOS suite เพราะ account usage
limit เดิมยังไม่เปิดจนถึง 2026-08-02 เวลา 11:46 Managed-sandbox skips ทั้ง 9 รายการ
ไม่ใช่ real-macOS PASS และห้ามใช้แทนหลักฐานดังกล่าว

## Next Steps

1. แก้ H1 ด้วย frozen installed-source-set revalidation และเพิ่ม discriminating
   RED/GREEN regression
2. แก้ M1/M2 พร้อม bound/failure cleanup regressions
3. ทำ independent re-review รอบใหม่โดยคง Task 2 เป็น `[ ]`
4. เมื่อ usage limit เปิด ให้รัน external real-macOS targeted/full matrix จริง
5. พิจารณา mark Task 2 ได้ต่อเมื่อ review ไม่มี unresolved finding และ external
   required suite ผ่านจริงเท่านั้น
