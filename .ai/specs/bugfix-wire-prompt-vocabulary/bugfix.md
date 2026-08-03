# Bugfix: wire prompt ไม่สอน model ครบ vocabulary จริงที่ระบบรองรับ

> Status: approved 2026-08-03

`buildProposePrompt` (`adapters/src/wire.ts`) เป็น prompt เดียวที่ส่งให้ทุก role
(implementer, diagnostician, ...) แต่ประกาศ proposal type ที่ model ใช้ได้แค่บางส่วน
ของที่ระบบรองรับจริง และไม่แยกเนื้อหาตาม role เลย ทำให้ live loop run จริง
(`.ai/goals/auth-test-loop-01.yaml`, `~/.ai/runs/RUN-1785765907560/`) จบด้วย
`ESCALATED (2 iterations)` แทนที่จะถึง `REVIEWING` — ยืนยัน root cause แล้วโดย
`bug-investigator` subagent (2026-08-03) ด้วยการอ่านโค้ดจริง + query `events.db`
จริง + เขียน repro test รันผ่าน 2/2

## Current Behavior (Defect)

WHEN `buildProposePrompt` ถูกเรียกด้วย `agentRole` ใดก็ตาม THE SYSTEM สร้าง
protocol text ที่ประกาศ proposal type ได้แค่ 2 แบบคือ `WRITE_FILE` กับ
`REQUEST_TOOL` (พร้อมประโยค "Never invent other types") ทั้งที่ `READ_FILE` เป็น
action type จริงที่ executor รองรับเต็ม (`core/src/types.ts:23`, มี
`policy.checkRead` และ execution path เต็มใน `core/src/executor/executor.ts`)
model จึงไม่มีทางรู้ว่า `READ_FILE` มีอยู่

**Repro (unit test, ไม่กิน quota)**: เพิ่ม test ใน `adapters/src/wire.test.ts`
เรียก `buildProposePrompt(fakeReq)` แล้ว assert ว่า string ที่ได้ไม่มีคำว่า
`READ_FILE` เลย — RED ตอนนี้ (fail เพราะ assertion คาดว่าต้องไม่มี ซึ่งตรงกับ
defect), จะกลับเป็น GREEN หลังแก้ F1 (มีคำนี้ปรากฏ)

WHEN `req.agentRole === 'diagnostician'` THE SYSTEM ยังคงใช้ protocol text
เดียวกันเป๊ะกับ `agentRole === 'implementer'` (byte-identical ตาม repro ที่
`bug-investigator` รันแล้ว) ไม่มีคำอธิบายเรื่อง `Hypothesis`/`HypothesisProbe`
(type มีจริงใน `core/src/types.ts` §9.3/REQ-5) เลยแม้แต่คำเดียว

**Repro**: assert ว่า prompt ของ `agentRole:'implementer'` กับ
`agentRole:'diagnostician'` (input อื่นเหมือนกัน) ให้ protocol-text block
เท่ากันทุกตัวอักษร — RED ตอนนี้ (เท่ากันจริง ซึ่งคือตัว defect), GREEN หลังแก้ F2
(ต้องต่างกัน)

**ผลจริงที่สังเกตได้จาก live run**: implementer เสนอ `WRITE_FILE` 5 ไฟล์ (เดา
golden fixture ใหม่) → โดน `ACTION_REJECTED reason:context_violation` ยกชุด
(`events.db` seq 8) → diagnostician รอบถัดมาได้ prompt generic เดียวกัน เห็นแค่
gate-failure JSON ดิบ แล้วตอบ `REQUEST_TOOL repository_read`/`test_runner`
แทนการเสนอ hypothesis (`events.db` seq 15-16, `HYPOTHESIS_PROPOSED count:0`) →
`ESCALATED reason:all_refuted why:hypotheses_exhausted` (seq 18) — signature
เดียวกันเป๊ะเคยเกิดมาแล้ว 2026-07-09 (`docs/calibration/RUNBOOK-phase4.md:103-106`)
และเคยถูก mis-triage ว่า "not an error to chase" ทั้งที่ deterministic เกิดซ้ำ
100% ทุกครั้งที่เข้า `DIAGNOSING`

WHEN `buildProposePrompt` สร้าง prompt THE SYSTEM ใส่ประโยค "If the objective,
acceptance criteria and context already determine the edit..." แต่ไม่เคย
serialize `req.taskContract.acceptanceCriteria` เข้า prompt จริงเลย (`wire.ts:51`
ใส่แค่ `req.taskContract.objective`) — model จึงถูกอ้างถึงข้อมูลที่ตัวเองไม่เคย
เห็น

**Repro**: assert ว่า prompt ไม่มีข้อความจาก `req.taskContract.acceptanceCriteria`
เลยแม้จะ populate ค่าไว้ใน fake request — RED ตอนนี้, GREEN หลังแก้ F3

## Expected Behavior

- F1  THE SYSTEM SHALL ประกาศ `READ_FILE` เป็น proposal type ที่ใช้ได้ใน
      protocol text ของ `buildProposePrompt` สำหรับทุก role (รูปแบบ
      `{"type":"READ_FILE","path":"<repo-relative path>"}` — ขอเปิดอ่านเนื้อหา
      path ที่ยังไม่อยู่ใน context bundle)
- F2  WHEN `req.agentRole === 'diagnostician'` THE SYSTEM SHALL สร้าง protocol
      block คนละแบบกับ implementer ที่อธิบาย shape ของ `Hypothesis`
      (`statement`, `probes` เป็น array ของ `{cmd, expected}` เรียงถูกสุดก่อน,
      `ifConfirmed{patchPlan, estimatedBlastRadius}` — ตาม
      `core/src/types.ts:67-80`) และสั่งให้ส่งกลับผ่าน field ระดับบนสุดชื่อ
      `hypotheses`
- F3  THE SYSTEM SHALL serialize `req.taskContract.acceptanceCriteria` (เมื่อมี
      ค่า) เข้าไปใน prompt text ของ `buildProposePrompt` เพื่อให้ประโยคที่อ้างถึง
      "acceptance criteria" มีเนื้อหาจริงรองรับ

## Unchanged Behavior

- B1  WHEN `buildProposePrompt` ถูกเรียกด้วย `opts.fenceGuard === false` THE
      SYSTEM SHALL CONTINUE TO ตัดประโยค "no markdown fences"/"raw JSON
      object" ออก แต่คง UNTRUSTED-DATA marking + ประโยค no-execution +
      vocabulary `WRITE_FILE`/`REQUEST_TOOL` ไว้ (REQ-1.3,
      `adapters/src/wire.test.ts:48-70`)
- B2  WHEN `req.agentRole === 'implementer'` THE SYSTEM SHALL CONTINUE TO
      ผลิต prompt ที่ conformance probe P1-P8 ผ่านครบเหมือน baseline
      `.ai/calibration/conformance-claude-2026-08-03T14-03-25-995Z.json`
      โดยเฉพาะ probe P5 ที่ต้องได้ `REQUEST_TOOL{name:"fusion.deliberate"}`
      กลับมา (ต้อง re-run `platform conformance --live` หลังแก้เพื่อเทียบ)
- B3  WHEN เรียกด้วย `(req, opts)` ชุดเดิม THE SYSTEM SHALL CONTINUE TO คืน
      string เดิมทุกครั้ง (pure function — `wire.ts:42` ระบุไว้, replay/manifest
      hashing พึ่งพาคุณสมบัตินี้)
- B4  WHEN prompt ถูกแก้ THE SYSTEM SHALL CONTINUE TO ขึ้นต้นด้วย objective ใน
      รูปที่ regex `/\[probe:(\w+)([^\]]*)\]/` ของ
      `adapters/src/codex-conformance.test.ts:29-30` ยังจับได้
- B5  WHEN adapter ส่ง proposal กลับมา THE SYSTEM SHALL CONTINUE TO ให้ core
      เป็นผู้ validate/execute ฝ่ายเดียว (Ring 2 ทำได้แค่ wire-format
      translation ห้ามมี business logic ตาม `wire.ts:1-4` — F2 ต้องเป็นแค่การ
      เลือกข้อความตาม role ไม่ใช่การตัดสินใจเชิง policy)
- B6  WHEN diagnostician round เกิดขึ้น THE SYSTEM SHALL CONTINUE TO ทิ้ง
      `claim`/`actionRequests` ของรอบนั้นและอ่านเฉพาะ
      `structuredResult.hypotheses` (`aal/src/source.ts:397-399`) — prompt ใหม่
      ของ F2 ต้องไม่ชวนให้ diagnostician เสนอ `WRITE_FILE` เพราะ write
      allowlist ของ role นี้ว่างเปล่า (`core/src/executor/path-policy.ts:30`)
      ข้อเสนอนั้นจะถูกทิ้งเงียบ ๆ
- B7  WHEN model ส่ง `hypotheses` ที่ shape ผิด THE SYSTEM SHALL CONTINUE TO
      validate + cap ที่ `core/src/repair/hypothesis.ts:55-79` (ข้อมูล
      untrusted — prompt ที่สอน shape ห้ามถูกใช้เป็นเหตุผลผ่อน validation
      ฝั่ง core)
- B8  THE SYSTEM SHALL CONTINUE TO บังคับ `READ_FILE` ผ่าน
      `core/src/executor/executor.ts`'s `policy.checkRead` เดิมไม่เปลี่ยนแปลง
      (F1 แก้แค่ prompt ที่บอก model ว่า type นี้มีอยู่ ไม่แตะ enforcement)
- B9  THE SYSTEM SHALL CONTINUE TO ปฏิเสธ `WRITE_FILE` ที่ path อยู่นอก context
      bundle ผ่าน context-boundary check เดิมใน `aal/src/source.ts:409-424`
      ไม่เปลี่ยนแปลง
- B10 THE SYSTEM SHALL CONTINUE TO ไม่แตะ `.ai/goals/auth-test-loop-01.yaml`
      และไฟล์ใต้ `test/golden/` — เป็น fixture ของ goal นี้ ไม่ใช่ส่วนหนึ่งของ
      bug

## Not doing (นอก scope ของ bugfix นี้)

พบระหว่างขุด root cause แต่ยืนยันว่าอยู่นอก scope ที่อนุมัติ — บันทึกไว้เป็น
ข้อมูลสำหรับ backlog ถัดไป ไม่ใช่ task ของ spec นี้:

- codex lineage ไม่สามารถส่ง `hypotheses` กลับผ่าน F2 ได้ทางกายภาพ เพราะ
  `adapters/src/codex-live.ts`'s `strictifyForCodex` บังคับ
  `additionalProperties:false` ก่อนส่งเข้า `--output-schema` — F2 ช่วยได้เฉพาะ
  claude lineage
- action ที่โดน `ACTION_REJECTED` ไม่มี feedback ส่งกลับให้ model รู้ว่าโดนอะไร
  (`aal/src/source.ts:412-424` คืน `{claim:'WORKING', actions:[]}` เฉย ๆ)
- `console/backend/src/loop-run.ts`'s synthetic fixture repo กับ `seedPaths`
  hardcode (`:1113` = `['src/impl.txt']` เท่านั้น) ไม่สอดคล้องกับ objective ของ
  goal ที่พูดถึงระบบ auth เต็มรูป — เป็นสาเหตุที่แท้จริงว่าทำไม implementer ถึง
  เดาเขียน path ผิด (ไม่ใช่เพราะขาด F1)
