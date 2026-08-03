# Handoff: Task 50 — P0-06 acceptance review

- วันที่: 2026-08-02
- ผู้ตรวจ: Codex fresh-context acceptance reviewer
- ขอบเขต: ตรวจซ้ำ Task 49 fixes และ REQ-6.1–REQ-6.10 ทั้ง `core`, `aal` และ
  `console/backend`; read-only ต่อ production/tests/specs; เพิ่มเฉพาะ handoff นี้

## Verdict

`APPROVE_WITH_EXTERNAL_BLOCKER`

- Critical: 0
- High: 0
- Medium: 0
- Low: 0

ไม่พบ actionable correctness/security finding ใน source ปัจจุบันหลัง Task 49 และ
final hardening. Lease session เป็น required, fenced append ตรวจ owner/token/TTL
แบบ atomic, และ single/graph composition ส่ง lease/fence ผ่าน proposal, action,
gate, merge และ deploy paths แล้ว

ยังไม่ควร flip Task 6 เป็น `[x]` เพราะ wired console graph/single composition suite
ยังรัน Human Plane local listener ไม่ได้ใน nested sandbox: ทุก failure เป็น
`listen EPERM: operation not permitted 127.0.0.1`. นี่เป็น external environment
blocker ไม่ใช่ PASS หรือ skip; ต้องรัน command เดิมใน authorized environment/CI ที่
อนุญาต local `listen` แล้วบันทึก exact aggregate ก่อนปิด Task 6

P0-02 real-macOS cooldown เดิมยังคงถึง `2026-08-03 20:18 Asia/Bangkok`; รอบนี้ไม่ได้
retry หรือ circumvent

## Verified controls

- `TaskLeaseSession` เป็น required ใน `runTaskLoop`; `releaseLease:false` คง
  heartbeat จน outer composition release จริง
- `EventLog.appendFenced` ใช้ `BEGIN IMMEDIATE` ตรวจ `{taskId, ownerId,
  fencingToken}` และ TTL ก่อน insert event; stale token ได้ `null`
- `PROPOSAL_INTENT`, `ACTION_INTENT`, `ACTION_APPLIED` และ `GATE_RESULT` ใช้ fenced
  append; lease loss fail-closed ด้วย `LeaseFenceError`
- console single/graph ใช้ lease manager เดียวกัน, planner pre-task ใช้ `taskId:null`
  จึงไม่ claim task lease ก่อน task loop; invalid TTL ปฏิเสธก่อน adapter/branch/task
  events
- ownership checks ครอบ human approval/steering/deploy callbacks, branch hygiene,
  merge, audit gate, deploy/rollback และ stale deploy terminal-event suppression
- two-loop loser, heartbeat, pause/reacquire, terminal error release, atomic stale
  append และ planner pre-task scope มี regression probes แล้ว

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/state/lease.test.ts src/orchestrator/loop.test.ts`
  → 22 pass, 0 fail
- `pnpm --filter core test` → 549 total, 540 pass, 0 fail, 9 explicit
  external-only skips
- `pnpm --filter aal exec node --test --test-reporter spec src/source.test.ts src/fusion/run.test.ts`
  → 31 pass, 0 fail
- `pnpm --filter console-backend exec node --test --test-reporter spec src/fusion.test.ts src/loop-run-lease.test.ts`
  → 11 pass, 0 fail
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-run-graph.test.ts`
  → 1 pass, 11 fail; ทุก failure เป็น `listen EPERM` จาก Human Plane (environment
  blocker; ไม่ claim เป็น pass/skip)
- `pnpm typecheck` → workspace projects ทั้ง 6 ผ่าน
- `pnpm lint` → ESLint: No issues found
- `git diff --check` → pass
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  → pass

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-50-p0-06-acceptance.md`
  — เพิ่ม handoff นี้เท่านั้น; ไม่มี production/spec/task checkbox edit

## Constraints

- ห้าม flip Task 6 จนกว่า authorized console graph/single composition evidence จะ
  ได้ exact pass aggregate
- คง P0-02 cooldown และไม่ retry ใน managed sandbox
- ไม่มี commit หรือ push จาก acceptance session นี้

## Next Recommended Agent

Closure/acceptance owner: รัน `src/loop-run-graph.test.ts` และ single composition
cases ใน environment ที่อนุญาต local listener, บันทึก exact evidence ลง tasks.md,
แล้วค่อย flip Task 6 เป็น `[x]` หากผ่านทุก gate

