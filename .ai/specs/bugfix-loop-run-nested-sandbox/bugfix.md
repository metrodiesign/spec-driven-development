# Bugfix: Synthetic loop tests ต้องไม่พึ่ง nested macOS sandbox

> Status: approved 2026-08-09

แยก orchestration tests ออกจาก ambient Seatbelt capability โดยไม่ลด production security.
Real sandbox enforcement ยังคง fail-closed และมี capability-specific tests แยกอยู่.

## Current Behavior (Defect)

WHEN รัน synthetic loop test ต่อไปนี้ใน managed macOS environment ที่เปิด nested
`/usr/bin/sandbox-exec` ไม่ได้ THEN task จบ `ESCALATED` แทน `REVIEWING`.

```bash
pnpm --filter console-backend exec node --test --test-reporter spec \
  --test-name-pattern='REQ-4.3: without a task-graph option' \
  src/loop-run-graph.test.ts
```

| สิ่งที่วัด | ผลปัจจุบัน |
|---|---|
| expected final state | `REVIEWING` |
| actual final state | `ESCALATED` |
| focused duration | ประมาณ 18–19 วินาที |
| gate failure | `sandbox_unavailable` |
| sandbox stderr | `sandbox_apply: Operation not permitted` |

Approval polling scenarios ยังพบ `ECONNREFUSED 127.0.0.1:<port>` หลัง run escalate
ก่อนสร้าง approval package และปิด Human Plane server.

## Confirmed Root Cause

- `console/backend/src/loop-run.ts:1164` สร้าง gate runner โดยใช้ production default sandbox.
- `core/src/gates/runner.ts:132-140` เลือก `denyNetworkSandbox(process.platform)` เมื่อไม่มี
  command executor หรือ sandbox ที่ inject มา.
- `core/src/security/sandbox.ts:140-157` wrap command ด้วย `/usr/bin/sandbox-exec` บน Darwin.
- Managed environment ปฏิเสธ nested Seatbelt ด้วย `sandbox_apply: Operation not permitted`.
- Gate fail-closed ถูกต้อง จากนั้น repair probes ใช้ sandbox เดิมจน `hypotheses_exhausted`
  และ task จบ `ESCALATED`.
- `ECONNREFUSED` กับ dependent task `SKIPPED` เป็น downstream cascade ไม่ใช่ listener
  หรือ graph-selection root แยก.

## Expected Behavior

- F1 WHEN synthetic console/backend loop tests execute gate scenarios THE SYSTEM SHALL
  derive gate outcomes from explicit scenario inputs แทน ambient host sandbox capability.
- F2 WHEN synthetic single-task scenario กำหนดให้ gate commands ผ่าน THE SYSTEM SHALL
  finish ด้วย `REVIEWING` ตาม public loop result.
- F3 WHEN synthetic multi-task scenario กำหนดให้ root task gates ผ่าน THE SYSTEM SHALL
  execute eligible dependent tasks แทนการ mark `SKIPPED` เพราะ host sandbox เปิดไม่ได้.
- F4 WHEN synthetic approval scenario กำหนดให้ gates ผ่าน THE SYSTEM SHALL create
  approval package ก่อน Human Plane server teardown.
- F5 WHEN focused synthetic loop tests รันใน managed macOS environment ที่ nested sandbox
  ใช้ไม่ได้ THE SYSTEM SHALL exit `0`.
- F6 WHEN synthetic loop tests ไม่ได้กำหนด sandbox failure scenario THE SYSTEM SHALL NOT
  produce `sandbox_unavailable` จาก ambient host.

## Unchanged Behavior

- B1 WHEN production gate runner ไม่ได้รับ injected command capability THE SYSTEM SHALL
  CONTINUE TO use `denyNetworkSandbox(process.platform)`.
- B2 WHEN enforcing sandbox เปิดไม่ได้ใน production path THE SYSTEM SHALL CONTINUE TO
  fail closed.
- B3 WHEN enforcing sandbox เปิดไม่ได้ใน production path THE SYSTEM SHALL CONTINUE TO
  prohibit unsandboxed command execution.
- B4 WHEN T0 หรือ T1 gate fail THE SYSTEM SHALL CONTINUE TO prevent task จาก
  `REVIEWING` หรือ `COMPLETED`.
- B5 WHEN explicit real-SBPL tests รันด้วย `PHASE0_REAL_MACOS_TESTS=1` นอก nested sandbox
  THE SYSTEM SHALL CONTINUE TO exercise actual `/usr/bin/sandbox-exec` enforcement.
- B6 WHEN dependency จบด้วย state นอก `DEP_SATISFIED_STATES` THE SYSTEM SHALL CONTINUE TO
  mark dependent task `SKIPPED`.
- B7 WHEN run จบ THE SYSTEM SHALL CONTINUE TO close Human Plane server.
- B8 WHEN run จบ THE SYSTEM SHALL CONTINUE TO tombstone discovery record.
- B9 WHEN graph ไม่ผ่าน planning gate THE SYSTEM SHALL CONTINUE TO return `BLOCKED`
  ก่อน adapter dispatch.
- B10 WHEN synthetic gate scenario fail THE SYSTEM SHALL CONTINUE TO enter `FAILED`.
- B11 WHEN failed synthetic scenario ยังมี repair budget THE SYSTEM SHALL CONTINUE TO enter
  `DIAGNOSING`.
- B12 WHEN synthetic scenario ใช้ repair hypotheses ครบโดยไม่พบคำตอบ THE SYSTEM SHALL
  CONTINUE TO finish ด้วย `ESCALATED`.

## Hard Scope

ห้าม task ใดทำสิ่งต่อไปนี้:

- เปลี่ยน production sandbox policy หรือ `denyNetworkSandbox` semantics.
- fallback ไป execute production command แบบ unsandboxed.
- เปลี่ยน expected state ให้ยอมรับ `ESCALATED` เพื่อทำ test เขียว.
- ปิด gate, approval, dependency หรือ Human Plane lifecycle assertions.
- เพิ่ม dependency หรือสร้าง sandbox implementation ใหม่.

## Validation Contract

| Case | ก่อนแก้ | หลังแก้ |
|---|---|---|
| synthetic single-task บน nested-sandbox-denied host | `ESCALATED` | `REVIEWING` |
| synthetic multi-task บน host เดียวกัน | root `ESCALATED`, dependent `SKIPPED` | eligible tasks execute ตาม scenario |
| synthetic approval polling | `ECONNREFUSED` หลัง early escalation | approval package อ่านได้ก่อน teardown |
| synthetic injected gate failure | ปะปน ambient sandbox failure | deterministic failure state ตาม scenario |
| production sandbox unavailable | fail-closed | fail-closed เหมือนเดิม |
| explicit real-SBPL test | ใช้ real sandbox | ใช้ real sandbox เหมือนเดิม |

Regression tests ต้อง assert public loop result, approval API และ event state เท่านั้น ห้าม assert
private helper หรือทำ test เขียวด้วยการข้าม security path.
