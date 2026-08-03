# Handoff: Task 49 — P0-06 review fixes

- วันที่: 2026-08-02
- ผู้แก้: Codex implementation/fix worker
- ขอบเขต: ปิด REQUEST_CHANGES จาก Task 48 เฉพาะ P0-06 (REQ-6.1–REQ-6.10)
- สถานะ Task 6: ยังคง `- [ ]`; ยังไม่ใช่ acceptance/closure

## สิ่งที่แก้

- `core/src/orchestrator/loop.ts` บังคับ `TaskLeaseSession` เป็น required public
  contract; ไม่มี `opts.lease === undefined` success path อีกต่อไป. เมื่อ
  `releaseLease:false` จะคง heartbeat จน composition ปล่อย lease จริง.
- `core/src/state/event-log.ts` เพิ่ม atomic `appendFenced` ที่ตรวจ owner/token/TTL
  และ insert event ภายใต้ `BEGIN IMMEDIATE`; stale token ได้ `null` และไม่เขียน event.
  `LeaseFenceError` เป็น structured fail-closed signal.
- `core/src/executor/executor.ts` ผูก fenced append กับ `ACTION_INTENT` และ
  `ACTION_APPLIED` (รวม duplicate/read/recovery terminal paths); lease loss จะ
  reconcile แล้วคืน structured cancellation โดยไม่ปล่อย applied event ของ stale owner.
- `core/src/gates/runner.ts` ผูก `GATE_RESULT` กับ fenced append; gate race หลัง
  verify จะ fail closed ก่อน event commit.
- `aal/src/source.ts` รับ current lease fence จาก composition และผูก
  `PROPOSAL_INTENT` กับ atomic fenced append ก่อน adapter dispatch; stale loops
  จึงไม่สามารถทิ้ง proposal-intent event ระหว่าง verify→send race ได้.
- `core/src/merge/auto-merge.ts`, `core/src/deploy/stage.ts` และ `console/backend/src/loop-run.ts` เพิ่ม
  ownership checks ก่อน commit/merge/approval continuation/audit gate/deploy และ
  ส่ง fence เข้า post-merge audit gate และทุก deploy/rollback command. Heartbeat
  ครอบช่วง human approval/merge/deploy จน outer `finally` release.
- Human Plane approval/steering/deploy callbacks reject a lost active lease, and
  `onDeployRollback` suppresses its catch-side `DEPLOY_STATE` append when the
  failure is `LeaseFenceError`; stale owners therefore publish no un-fenced
  deploy terminal event.
- เติม test probes: loser loop จริง (proposal/action/gate/event เป็นศูนย์),
  asynchronous heartbeat, failed reacquire หลัง replacement, terminal proposal
  error release, atomic stale fenced append, และ planner fusion `taskId:null`
  pre-task scope audit test.

## หลักฐานที่รันและสังเกต

- `pnpm lint` — pass (ESLint no issues)
- `pnpm --filter core typecheck` — pass
- `pnpm --filter console-backend typecheck` — pass
- `pnpm --filter core exec node --test --test-reporter spec src/state/lease.test.ts src/orchestrator/loop.test.ts` — 22 pass, 0 fail
- `pnpm --filter console-backend exec node --test --test-reporter spec src/fusion.test.ts src/loop-run-lease.test.ts` — 11 pass, 0 fail
- `pnpm --filter aal exec node --test --test-reporter spec src/source.test.ts` — 18 pass, 0 fail
- `pnpm --filter core exec node --test --test-reporter spec src/deploy/stage.test.ts` — lease-loss fence probe pass (plus existing deploy checks; no failures observed)
- `pnpm --filter core test` — process exit 0 (full core suite; rerun after appendFenced API-surface test update)
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` — pass
- `git diff --check` — pass
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-run-graph.test.ts` — ไม่ผ่านใน environment นี้: listen `EPERM` จาก Human Plane server (11 failures; ไม่ claim เป็น pass/skip)

## ข้อจำกัด/งานถัดไป

- ห้าม flip Task 6 จนกว่า console composition happy-path จะรันบน authorized
  environment/CI ที่อนุญาต local `listen` และได้ exact aggregate pass; ห้าม retry
  หรือแปลง `EPERM` เป็น pass.
- P0-02 real-macOS external verification cooldown เดิมยังคงอยู่; รอบนี้ไม่ได้ retry.
- ไม่มี commit/push.
