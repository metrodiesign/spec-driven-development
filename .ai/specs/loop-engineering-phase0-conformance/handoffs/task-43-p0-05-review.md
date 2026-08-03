# Handoff: Task 43 — P0-05 fresh-context correctness/security review

- วันที่: 2026-08-02
- ผู้ตรวจ: Codex fresh-context correctness/security reviewer
- ขอบเขต: Task 42 implementation, `core/src/orchestrator/loop.ts`, P0-05
  sequence tests, `core/src/gates/runner.ts`, และ REQ-5.1–REQ-5.10
- สถานะการแก้: read-only ต่อ production/tests/requirements/design/tasks; เพิ่มเฉพาะ
  handoff นี้

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 0
- Medium: 3
- Low: 0

Focused behavior และ production guard ที่ตรวจพบทำงานตามที่ออกแบบ แต่หลักฐานของ
REQ-5 ยังไม่ครบตาม test contract: มีช่องว่างที่ปล่อยให้ same-artifact guard,
T0 authentication boundary และ T3 stub regress ได้โดย suite ยังเขียว จึงยังไม่ควร
flip Task 5 เป็น `[x]`.

P0-02 external real-macOS verification ยังอยู่ใน recorded cooldown ถึง
2026-08-03 20:18 Asia/Bangkok; รอบนี้ไม่ได้ retry, circumvent หรือใช้ skip เป็น PASS
และ blocker นี้ไม่ใช่เหตุผลของ verdict `REQUEST_CHANGES`.

## Findings

### Medium 1 — เพิ่ม regression สำหรับ T1 artifact identity mismatch

- Location: `core/src/orchestrator/loop.ts:309-316`,
  `core/src/orchestrator/loop.test.ts:120-136`
- Dimension: correctness / same-frozen-artifact invariant / REQ-5.4
- Evidence: production loop มี guard ที่เปรียบเทียบ `t1.worktreeHash` กับ
  `t0.worktreeHash` และเรียก `ESCALATED{why:"artifact_identity_mismatch"}` เมื่อไม่ตรง
  แต่ sequence test มีเฉพาะ happy path ที่ทั้งสอง report ใช้ `same-tree`; ไม่มี fault
  ที่ส่ง T0=`tree-a`, T1=`tree-b` แล้วตรวจผลลัพธ์ observable.
- Impact: การลบ/ย้าย guard หรือ wiring ที่เปลี่ยน report hash ในภายหลังจะไม่ถูกจับโดย
  P0-05 suite; Task 5 จึงยังอ้างว่า T1 ใช้ artifact เดียวกันโดยไม่มี regression proof.
- Fix: เพิ่ม RED/GREEN test ที่ให้ T0 pass บน hash A และ T1 pass บน hash B แล้ว assert
  `finalState === "ESCALATED"`, `ESCALATED.why === "artifact_identity_mismatch"`,
  ไม่มี `REVIEWING`/`PASSED`, และ gate call order เป็น `T0,T1`.

### Medium 2 — เพิ่ม T0 evidence-authentication failure regression

- Location: `core/src/orchestrator/loop.ts:263-280`,
  `core/test/fault-injection.test.ts:696-744`
- Dimension: security / authenticated evidence before advancement / REQ-4.12,
  REQ-5.5
- Evidence: loop มี `try/catch` สำหรับ `opts.gates.verify(await ...run('T0'))`
  และ escalate ก่อน state advancement แต่ wired fault-injection ที่มีอยู่ inject
  forged/missing/tampered evidence เฉพาะ T1 (`tier !== 'T1'` ถูกปล่อยผ่าน) จึงไม่มี
  test ที่บังคับ T0 verifier ให้ throw และพิสูจน์ว่า T0 auth failure ไม่สามารถไปถึง
  `PASSED`, `REVIEWING` หรือ `COMPLETED` ได้.
- Impact: การแก้ไข catch/order ของ T0 boundary สามารถทำให้ forged/missing T0 report
  ขับ state ต่อได้โดยไม่ทำให้ suite ปัจจุบันล้มเหลว; เป็นช่องว่างที่ trust boundary
  สำคัญที่สุดของ P0-05.
- Fix: เพิ่ม wired fault ที่ให้ `verify` throw `ReportIntegrityError` สำหรับ T0,
  assert `ESCALATED` พร้อม `boundary:"state_advancement"`, ไม่มี `gate_passed`/
  `REVIEWING`/`COMPLETED`, และยืนยันว่า T1 ไม่ถูกเรียก.

### Medium 3 — เพิ่ม explicit T3 Phase-0 stub regression

- Location: `core/src/gates/runner.ts:370-373`,
  `core/src/gates/runner.test.ts:353-362`
- Dimension: tests / Phase-0 gate boundary / REQ-5.9–REQ-5.10
- Evidence: implementation มี branch T3 ที่ publish `pass: 'not_enabled'` และ
  `checks: []`; test suite มี explicit `{status}` stub test สำหรับ T2 เท่านั้น และ
  `rg "run\\('T3'\\)" --glob '*.test.ts' core console aal` ไม่พบ test ที่เรียก T3.
- Impact: T3 อาจเปลี่ยนเป็น enabled/silent pass หรือไม่ append `GATE_RESULT` ได้โดย
  ไม่มี regression signal; Task 5 handoff อ้าง logged T2/T3 stubs แต่หลักฐานจริง
  ครอบเพียง T2.
- Fix: เพิ่ม test เรียก `runner.run('T3')` กับ default Phase-0 ladder แล้ว assert
  `pass === 'not_enabled'`, `checks === []`, event log มี `GATE_RESULT` tier `T3`
  หนึ่งรายการ และ event มี `gateConfigHash` ตรงกับ config bytes.

## Verified controls

- `core/src/orchestrator/loop.ts` รัน T0 หนึ่งครั้งหลังทุก implementer/repair batch
  รวม zero-action และไม่เรียก T0 ใน diagnostician/probe path.
- READY path เรียก T1 หลัง T0 ที่ `pass === true` เท่านั้น; auth verification เกิด
  ก่อน `gate_passed`/`review` และ hash equality ถูกตรวจทันทีหลัง T1 verify.
- T0/T1 failure ทั้งสองทางเข้า `VERIFYING -> FAILED -> DIAGNOSING`; fail-then-pass
  report ที่ `flakySuspect:true` ยังคง `pass:false` และไม่ auto-quarantine.
- `createGateRunner.publish` ลง `GATE_RESULT` พร้อม `gateConfigHash`; default
  `.ai/policies/gate-ladder.json` กำหนด T2/T3 เป็น `not_enabled_phase0`.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/orchestrator/loop.test.ts`
  -> `5` pass, `0` fail
- `pnpm --filter core typecheck` -> exit `0`
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria
  covered, EARS lint passed
- `git diff --check` (reviewed P0-05 paths) -> exit `0`

ไม่ได้รัน P0-02 external real-macOS suite เพราะ cooldown ยังไม่สิ้นสุด และไม่ได้
แก้ production/tests/spec หรือ mark Task 5.

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-43-p0-05-review.md`
  — findings และ review evidence (new)

## Constraints

- Task 5 ต้องคง `[ ]` จน RED/GREEN regressions ทั้งสามข้อผ่าน fresh review.
- ห้าม retry/circumvent P0-02 external suite, ห้ามแก้ Task 2 blocker, ห้าม commit/push
  หรือ revert shared dirty worktree.

## Next Recommended Agent

P0-05 implementation owner เพื่อเพิ่ม regressions แบบ RED-first แล้วให้ fresh-context
reviewer ตรวจซ้ำ; หลัง acceptance ค่อยให้ parent ปิด Task 5.

## Next Steps

1. เพิ่ม mismatch, T0-auth-failure และ T3-stub tests ตาม fix ที่เล็กที่สุดใน findings.
2. รัน focused P0-05, wired fault, gate-runner suites และ typecheck ใหม่.
3. ให้ reviewer อิสระตรวจซ้ำก่อนเพิ่ม Evidence/checkbox ของ Task 5.
