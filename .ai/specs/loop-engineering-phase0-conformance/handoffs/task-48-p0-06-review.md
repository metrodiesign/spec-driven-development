# Handoff: Task 48 — P0-06 fresh-context correctness/security review

- วันที่: 2026-08-02
- ผู้ตรวจ: Codex fresh-context correctness/security reviewer
- ขอบเขต: Task 47 implementation, `core/src/state/lease.ts`,
  `core/src/state/schema.ts`, `core/src/orchestrator/loop.ts`,
  `console/backend/src/loop-run.ts`, lease/loop tests และ REQ-6.1–REQ-6.10
- สถานะการแก้: read-only ต่อ production/tests/requirements/design/tasks; เพิ่มเฉพาะ
  handoff นี้

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 3
- Medium: 3
- Low: 0

ยังไม่ควร flip Task 6 เป็น `[x]`. มีช่องโหว่ production path ที่เปิด no-lease
overload, หยุด heartbeat ก่อน post-loop approval/merge/deploy และใช้ ownership check
แบบ non-atomic ก่อน side effect; ทั้งสามข้อขัดกับ single-writer/fencing contract
โดยตรง. หลักฐาน test ของ two-loop, heartbeat, resume-loss และ terminal/error release
ยังไม่ครบตาม Verify ของ Task 6.

P0-02 external real-macOS verification ยังอยู่ใน recorded cooldown ถึง
`2026-08-03 20:18 Asia/Bangkok`; รอบนี้ไม่ได้ retry, circumvent หรือใช้ managed-sandbox
skip เป็น PASS และ blocker นี้ไม่ใช่เหตุผลหลักของ verdict `REQUEST_CHANGES`.

## Findings

### High 1 — `runTaskLoop` ยังเปิด no-lease bypass

- Location: `core/src/orchestrator/loop.ts:81-105`,
  `.ai/specs/loop-engineering-phase0-conformance/design.md:594-608`
- Dimension: correctness / security / architecture / REQ-6.1, REQ-6.2, REQ-6.5,
  REQ-6.6, REQ-6.8
- Evidence: `LoopOptions.lease` เป็น optional และ `requireOwnership()` คืน `true`
  เมื่อไม่มี session (`opts.lease === undefined`). ดังนั้น caller ใด ๆ ที่เรียก
  `runTaskLoop` โดยไม่ส่ง lease สามารถ request proposal, execute action และ run gate
  ได้โดยไม่ claim/heartbeat/fence เลย. Design ระบุชัดว่า loop ต้อง require
  `TaskLeaseSession` และห้ามมี unsafe no-lease overload; comment ที่บอกว่าเว้นไว้สำหรับ
  legacy harnesses เป็นการคง bypass ไว้ใน public core contract.
- Impact: production caller ใหม่หรือ regression ที่ลืมส่ง lease จะยัง compile และทำงาน
  เหมือนสำเร็จ ทำลาย invariant ว่า single-task และ graph-task ทุก loop เป็น single-writer.
- Fix: ทำ `lease: TaskLeaseSession` เป็น required ใน public loop options และย้าย
  harness เก่าไปสร้าง real test lease (หรือแยก pure sequence helper ที่ไม่สามารถ execute
  production actions ได้); ลบ `opts.lease === undefined` success path และ assertions
  conditional ทั้งหมด.

### High 2 — หยุด heartbeat เมื่อ core loop จบ ทั้งที่ composition ยังถือ lease

- Location: `core/src/orchestrator/loop.ts:87-95`,
  `console/backend/src/loop-run.ts:1021-1053,1063-1067,1161-1181,1261-1283`
- Dimension: correctness / fencing / error handling / REQ-6.4–REQ-6.6,
  REQ-6.9–REQ-6.10
- Evidence: `runTaskLoop` เรียก `opts.lease?.stopHeartbeat()` ใน `finally` เสมอ แม้
  `releaseLease:false`. Composition ส่ง `releaseLease:false` เพื่อเก็บ lease ผ่าน
  post-REVIEWING approval/merge/deploy แล้วตรวจ ownership เพียงครั้งเดียวที่
  `post_loop`. หลังจากนั้น approval wait (`await waitForApprovalDecision(timeoutMs)`),
  `runApprovedMerge` และ deploy executor สามารถใช้เวลานานกว่า TTL โดยไม่มี renewal
  หรือ ownership check ก่อน side effect/gate. Owner อื่นจึง reclaim ได้ แต่ stale
  invocation ยัง merge, run audit gate หรือ deploy ต่อได้.
- Impact: ใช้ TTL ที่ valid ตาม REQ-6.3 ก็ยังหมดอายุระหว่าง human wait/merge และ
  เปิด double-writer/stale side effects ใน production composition.
- Fix: แยก `stopHeartbeat` ออกจาก loop return; เมื่อ `releaseLease:false` ให้ session
  heartbeat ต่อจน outer task lifecycle ปิดจริง. เพิ่ม fenced ownership checks ก่อน
  commit, approval decision continuation, merge/T2/audit gate และ deploy command; เมื่อ
  check ล้มเหลวให้ structured `lease_lost` และไม่ทำ side effect ต่อ.

### High 3 — ownership check กับ action/gate ไม่เป็น atomic fence

- Location: `core/src/orchestrator/loop.ts:104-115,294-313`,
  `core/src/executor/executor.ts:1585-1636`,
  `.ai/specs/loop-engineering-phase0-conformance/design.md:603-608`
- Dimension: correctness / security / fencing / REQ-6.2, REQ-6.5, REQ-6.6,
  REQ-6.10
- Evidence: `requireOwnership()` ทำเพียง SELECT verify แล้วจึงเรียก
  `executor.execute()` หรือ `gates.run()` แยกกัน. ถ้า lease หมดและ owner ใหม่ reclaim
  ระหว่างสองคำสั่ง stale loop ยังเริ่ม action/gate ได้. ยิ่งกว่านั้นเมื่อ lease หาย
  ระหว่าง `performApply`, executor ยังสามารถ append `ACTION_INTENT` และ
  `ACTION_APPLIED` ได้ก่อน loop ตรวจ `action_result`; post-check หยุดเพียง gate ถัดไป
  แต่ลบ side effect/event ที่เกิดไปแล้วไม่ได้.
- Impact: race window ทำให้ losing loop มี applied-action หรือ gate event หลัง fencing
  token ถูกแทนที่ — ตรงข้ามกับ “no later side effect” และทำให้การ audit event log
  single-writer เชื่อถือไม่ได้.
- Fix: ทำ core-owned fenced operation primitive ที่ตรวจ `{taskId, ownerId,
  fencingToken}` แบบ atomic ใน transaction ก่อน `ACTION_INTENT`/gate start และ
  ส่ง cancellation/lease-loss callback เข้า executor เพื่อ kill active child เมื่อทำได้,
  rollback unfinished mutation และป้องกัน `ACTION_APPLIED` append ของ token เก่า.

### Medium 1 — “two loops” test ไม่ได้รัน loser loop จริง

- Location: `core/src/orchestrator/loop.test.ts:278-313`
- Dimension: tests / REQ-6.1–REQ-6.2
- Evidence: test เริ่ม `runTaskLoop` เพียง winner (`owner-a`) แล้วให้ contender
  เรียกแค่ `acquireTaskLease(...)` และ assert `null`; ไม่มี second `runTaskLoop`,
  proposal source, executor หรือ gates ของ loser. `logA`/`logB` เปิด DB เดียวกันด้วย
  ดังนั้น event assertions ไม่สามารถพิสูจน์ว่า loser ไม่ถูกเรียกหรือไม่ปล่อย event.
- Impact: การ wiring ที่สร้าง loser loop ก่อน/หลัง claim, หรือ loop ที่ดำเนินต่อแม้ claim
  แพ้ ยังอาจเขียวได้โดยไม่มี regression signal.
- Fix: สร้างสอง production-shaped loop/composition invocations against one DB, block
  both proposal sources at a deterministic barrier, let one claim win, assert loser
  source/action/gate call counts เป็นศูนย์ และ event types `PROPOSAL_INTENT`,
  `ACTION_INTENT`, `ACTION_APPLIED`, `GATE_RESULT` ของ loser เป็นศูนย์.

### Medium 2 — ไม่มี fault probes สำหรับ heartbeat/loss/release ครบ lifecycle

- Location: `core/src/state/lease.test.ts:68-129`,
  `core/src/orchestrator/loop.test.ts:323-414`
- Dimension: tests / REQ-6.4, REQ-6.6–REQ-6.10
- Evidence: มี token replacement, async proposal loss และ pause expiry/reacquire
  control แต่ไม่มี test ที่รัน heartbeat จริงระหว่าง asynchronous wait, ให้ competitor
  reclaim ระหว่าง pause แล้ว assert `lease_unavailable_after_pause`, หรือโยน error จาก
  proposal/executor/gate แล้วตรวจว่า lease ถูก release และ owner ใหม่ claim ได้.
  ไม่มี loss ระหว่าง executor/T0/T1/post-loop action ด้วย.
- Impact: heartbeat timer อาจหยุด/renew ไม่ทัน, terminal/error path อาจ leak lease,
  หรือ stale action/gate อาจผ่านโดย suite ยังเขียว.
- Fix: เพิ่ม RED/GREEN probes ตามแต่ละ boundary: short real timer + advancing clock,
  competitor takeover while paused, thrown proposal/executor/gate, and loss during an
  in-flight action/gate; assert structured outcome, no later events, and reclaimability.

### Medium 3 — production console happy paths ยังไม่มีผลทดสอบใน environment นี้

- Location: `console/backend/src/loop-run-graph.test.ts` (all runnable graph/single
  composition cases)
- Dimension: tests / REQ-6.1–REQ-6.10
- Evidence: `pnpm --filter console-backend exec node --test --test-reporter spec
  src/loop-run-graph.test.ts` ได้ `1` pass และ `11` fail; ทุก failure เป็น
  `listen EPERM: operation not permitted 127.0.0.1` จาก Human Plane server. จึงไม่มี
  observed console evidence สำหรับ single-task lease claim, graph loser, release,
  pause หรือ post-loop ownership.
- Impact: เป็น environment blocker ไม่ใช่ implementation PASS; Task 6 ยังไม่มี wired
  composition proof จนกว่าจะรัน outside nested sandbox หรือบน CI ที่อนุญาต local listen.
- Fix: รัน command เดิมบน authorized environment/CI macOS runner และบันทึก exact
  pass/fail aggregate; ไม่ mark EPERM เป็น skip/pass และเพิ่ม no-listen composition seam
  ได้ก็ต่อเมื่อยังตรวจ production wiring เดิมจริง.

## Verified controls

- `core/src/state/lease.ts` ใช้ SQLite `BEGIN IMMEDIATE`, monotonic fencing token,
  token-aware renew/verify/release และ pause reacquire; exact expiry boundary ยังถูก
  pin ไว้ที่ `leaseUntil` inclusive ตาม existing DoD#8 semantics.
- `core/src/orchestrator/loop.ts` ตรวจ ownership ก่อน proposal/action/gate และมี
  structured `lease_lost`/`lease_unavailable_after_pause` paths เมื่อ check สังเกตได้.
- `console/backend/src/loop-run.ts` ตรวจ TTL ก่อน adapter/branch/task creation และ
  invalid-TTL test ยืนยันไม่มี `LEASE_CLAIMED` หรือ `CLAIM_RECORDED`.
- Existing focused tests green แต่ยังไม่ครอบ race/lifecycle gaps ด้านบน.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/state/lease.test.ts src/orchestrator/loop.test.ts`
  -> `15` pass, `0` fail
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-run-lease.test.ts`
  -> `1` pass, `0` fail
- `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-run-graph.test.ts`
  -> `1` pass, `11` fail; all 11 are `listen EPERM` environment failures
- `pnpm --filter core typecheck` -> exit `0`
- `pnpm --filter console-backend typecheck` -> exit `0`
- `git diff --check` -> exit `0`

ไม่ได้ retry/circumvent console `listen EPERM` และไม่ได้รัน P0-02 external real-macOS
suite ระหว่าง cooldown. Task 6 ยังคง `[ ]`; ไม่มี production/test/spec checkbox edit,
commit หรือ push.

## Next Recommended Agent

Task 47 implementation owner เพื่อปิด High findings และเพิ่ม RED/GREEN lifecycle
probes; จากนั้นให้ fresh-context reviewer ตรวจซ้ำและรัน console composition suite
นอก nested sandbox ก่อน acceptance.

## Next Steps

1. ทำ lease session เป็น required และรักษา heartbeat ผ่าน post-loop lifecycle.
2. เพิ่ม atomic fenced action/gate boundary หรือ cancellation/rollback ที่ป้องกัน stale
   token side effects.
3. เติม two-real-loop, heartbeat, failed-reacquire, terminal/error-release และ
   in-flight-loss regressions.
4. รัน focused/core/console suites ใหม่; คง Task 6 `[ ]` จน wired evidence ครบ.
