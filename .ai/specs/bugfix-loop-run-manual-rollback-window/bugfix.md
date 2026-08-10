# Bugfix: Loop Run Manual Rollback Window

> Status: approved 2026-08-10

แก้ race ระหว่าง operator request กับ real-time deploy windows ใน `loop-run` โดยให้ manual
rollback ที่รับแล้วปิด remaining window แบบ event-driven โดยไม่ลด production safety contract.

## Current Behavior (Defect)

WHEN test client ถูกพักเกิน `approval.timeoutMs` หลังอ่าน `PENDING_APPROVAL` หรือเกิน
`deploy.expandedWindowMs` หลังอ่าน `EXPANDED` THEN `runSupervisedLoop` ปิด Human Plane server
ตาม timer ก่อน request ถัดไป และ test ล้มด้วย `TypeError: fetch failed` ซึ่งมี cause
`ECONNREFUSED` แทนการตรวจ rollback terminal state.

Reproduction ที่รันจริงบน commit `a06246f`:

1. เพิ่ม delay 6,000 ms หลัง `waitForDeployState(..., 'PENDING_APPROVAL')` ใน manual rollback
   test ที่ใช้ `approval.timeoutMs: 5000`.
2. รันคำสั่งนี้:

   ```bash
   node --test --test-reporter spec \
     --test-name-pattern='manual rollback at EXPANDED runs rollback_cmd' \
     src/loop-run.test.ts
   ```

3. ผลจริง: fail ใน 25.5 วินาทีด้วย `ECONNREFUSED 127.0.0.1:62325`.
4. อีก repro เพิ่ม delay 1,000 ms หลังเห็น `EXPANDED` ใน test ที่ใช้
   `expandedWindowMs: 500`; focused command fail ใน 39.6 วินาทีด้วย
   `ECONNREFUSED 127.0.0.1:63051`.
5. GitHub Actions run `31397010176` พบ failure เดียวกันใน test
   `manual rollback whose rollback_cmd FAILS...` หลัง 57.8 วินาที; backend ผ่าน 435 จาก 436 tests.

Root cause อยู่ที่ test/runtime handshake ใช้ wall-clock window สั้น 5,000 ms และ 500 ms
ขณะที่ `server.close()` ทำงานทันทีหลัง run resolve. `fetchRetry` retry transport error รวมเพียง
75 ms และไม่สามารถกู้ listener ที่ปิดถาวรได้. เอกสาร commit ไม่แตะ path นี้; focused test เดิม
ผ่าน local และ remote run ก่อนหน้าบน runtime source เดียวกัน.

## Expected Behavior

- F-1 WHEN `POST /deploy/rollback` ถูกยอมรับขณะ `DEPLOY_STATE` เป็น `EXPANDED` THE SYSTEM
  SHALL end remaining manual-rollback window without waiting for `expandedWindowMs` to expire.
- F-2 WHILE accepted manual rollback is still running THE SYSTEM SHALL keep Human Plane server
  open until rollback settles and `DEPLOY_WINDOW_CLOSED` is durably appended.
- F-3 WHEN accepted manual rollback command exits non-zero THE SYSTEM SHALL resolve the task run
  as `COMPLETED`, record terminal deploy state `ESCALATED` with trigger `rollback_failed`, and
  append exactly one `DEPLOY_WINDOW_CLOSED` event.
- F-4 WHEN manual rollback is accepted with a configured window longer than test execution THE
  SYSTEM SHALL settle the run before that configured window expires.

## Unchanged Behavior

- B-1 WHEN `DEPLOY_STATE` reaches `EXPANDED` and no manual rollback or kill arrives THE SYSTEM
  SHALL CONTINUE TO keep Human Plane server open for full `expandedWindowMs`, append one
  `DEPLOY_WINDOW_CLOSED`, then close the server.
- B-2 IF `POST /deploy/rollback` arrives in any state other than `EXPANDED` THEN THE SYSTEM SHALL
  CONTINUE TO return HTTP 409 without starting `rollback_cmd`.
- B-3 WHEN accepted manual rollback command exits zero THE SYSTEM SHALL CONTINUE TO record
  `ROLLING_BACK` then `ROLLED_BACK`, audit `deploy_manual_rollback`, and leave task result
  `COMPLETED`.
- B-4 WHEN kill arrives during deploy approval, stage, or expanded-window wait THE SYSTEM SHALL
  CONTINUE TO release the corresponding wait without leaving a live timer that pins the process.
- B-5 WHEN a Human Plane helper receives an HTTP response of any status THE TEST HARNESS SHALL
  CONTINUE TO return that response without retrying or masking its status assertion.
- B-6 WHEN no manual rollback is accepted THE SYSTEM SHALL CONTINUE TO use the production default
  manual-rollback window of 10 minutes.

## Scope Constraints

- Allowed files: `console/backend/src/loop-run.ts`, `console/backend/src/loop-run.test.ts` และ
  artifacts ใต้ `.ai/specs/bugfix-loop-run-manual-rollback-window/`.
- Do not modify `core/src/human/api.ts` route/auth/status contract, `fetchRetry`, sandbox behavior,
  PR quality decision logic, provider adapters หรือ production default 10-minute window.
- Temporary diagnostic delays and `[DEBUG-ci-window]` instrumentation must not remain in commit.
