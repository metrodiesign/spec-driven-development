# Handoff: Task 02 — Phase 0 architecture review

> From: Codex teammate `/root/phase0_arch_review`   To: lead `/root`   Date: 2026-07-27

## Task Summary

ทำ fresh-context architecture critique ของ Phase 0 โดยยึด normative source เพียงไฟล์เดียว:
`/Users/king_developer/Downloads/loop-engineering-implementation-spec.md`
(SHA-256 `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`)
และ reconcile implementation ที่ HEAD `078e039` หลัง base fast-forward

เอกสาร authority ไม่มี REQ IDs จึง map findings กับ exact section/DoD
(`§1`, `§3`, `§4.1`–`§4.6`, `§8.1`, `§9.3`, `§10`, `§11`, `§12`)
แทนการอ้าง REQ จาก spec รุ่นเก่า

## Current Status

Architecture review เสร็จแล้ว สถานะรวมคือ **REQUEST CHANGES — ยัง claim Phase 0
conformance ไม่ได้**

ผล Task 1 ส่วนใหญ่ยืนยัน แต่ finding เรื่อง lease ต้องปรับตาม filesystem ปัจจุบัน:
`078e039` เพิ่ม claim/release ใน multi-task graph composition แล้ว
(`console/backend/src/loop-run.ts:1058`–`:1111`) อย่างไรก็ตาม single-task path
(`:1159`–`:1161`) ยังไม่ claim lease, ไม่มี heartbeat/renew ระหว่าง task และ pause
ยาวกว่า TTL ยังเปิดทางให้เจ้าของใหม่เริ่มทำงานก่อนเจ้าของเดิม resume ได้ จึงยังไม่ผ่าน
§4.2/DoD#8

### Accepted / rebutted findings from Task 1

| Task-1 finding | Verdict หลัง reconcile | Rationale / exact evidence |
|---|---|---|
| `APPLY_PATCH` เป็น Phase 0 แต่ถูก reject | **ACCEPT — ยกระดับเป็น High** | Normative §4.1 บรรทัด 80–93 ระบุ Action DSL ของ Phase 0 โดยตรง; `core/src/executor/executor.ts:279`–`:285` ยังคืน `unsupported_action_phase0` พร้อมข้อความที่เลื่อนไป repair phase ซึ่งขัด source |
| `RUN_COMMAND` ข้าม role write allowlist | **ACCEPT — High** | §4.1 บรรทัด 89–93 ใช้ least privilege ตาม role กับ executor; `core/src/security/sandbox.ts:47`–`:49` อนุญาตเขียนทั้ง worktree และ `core/src/executor/executor.ts:395` ไม่ส่ง role/write roots เข้า sandbox |
| Gate command หลุด egress sandbox | **ACCEPT + EXPAND — Critical** | §4.1, §8.1 และ §12 บังคับ egress default-deny; `core/src/gates/runner.ts:84`–`:91` ใช้ `/bin/sh` ตรง นอกจากออก network ได้แล้วยังแก้ source/gate/golden ได้ถาวร |
| T0 ไม่รันทุก iteration | **ACCEPT — High** | §4.4 บรรทัด 112–120 ระบุ T0 ทุก iteration; `core/src/orchestrator/loop.ts:261`–`:265` รันเฉพาะ claim `READY_FOR_VERIFICATION`; diagnostic ปัจจุบัน WORKING → BLOCKED 2 รอบยังได้ `gateCalls:0` |
| Lease primitive ไม่ wired | **ACCEPT WITH CORRECTION — High** | Graph path มี claim/release ใหม่แล้ว แต่ single-task ไม่มี, loop ไม่มี lease dependency, ไม่มี heartbeat และ graph release อยู่รอบ `executeTask` เท่านั้น; จึงพิสูจน์ single-writer ได้เฉพาะ scheduler path บางโหมด ไม่ใช่ task lifecycle ตาม §4.2 |
| Evidence ref ไม่ re-verify ก่อน advancement | **ACCEPT + EXPAND — High** | `core/test/fault-injection.test.ts:125`–`:130` เรียกเพียง `has()`; `core/src/evidence/store.ts:58`–`:63` ตรวจแค่ว่ามีไฟล์; `runTaskLoop` รับ green report ที่ ref ไม่มีจริงแล้วไป `REVIEWING` ได้ และ unsampled auto-merge ไป `COMPLETED` โดยไม่ dereference |
| Golden operational contract / coverage ขาด | **ACCEPT — High** | §4.5 บรรทัด 125 และ §10 บรรทัด 289 บังคับ human-frozen golden, CI hash gate และอ่าน held-out pass คู่ golden coverage; ปัจจุบัน fixture สร้าง golden ใหม่ที่ runtime (`console/backend/src/loop-run.ts:225`–`:254`), root ไม่มี tracked `test/golden/_MANIFEST.sha256`, CI ไม่มี direct golden-manifest step และ `CalibrationResult` ไม่มี golden coverage |
| `costUnits` ไม่ validate | **ACCEPT — Medium** | §4.6 บรรทัด 141 และ §5.1 บรรทัด 146–149 กำหนด normalized usage + always-on backstop; `core/src/budget/budget.ts:26`–`:29` รับค่าทุก number และ `aal/src/repair.ts:88`–`:96` รวมโดยไม่ตรวจ finite/non-negative |
| Convention gate แคบกว่ารายการ prohibited | **ACCEPT IN PART — Medium** | `core/src/gates/runner.ts:53`–`:76` ตรวจแค่ literal `.only(`/`.skip(` จึง miss whitespace และ bypass pattern อื่นจริง แต่ §4.5 บรรทัด 127 จำกัด convention gate ว่า enforce ได้เฉพาะ pattern ที่เขียน rule ได้ จึงไม่ควรยัด semantic cases เช่น “weaken assertion” ลง regex; §4.6 บรรทัด 142 ยังบังคับพฤติกรรมเหล่านั้นและต้องมีกลไก provenance/frozen-RED แยก |
| Code/comments อ้าง normative รุ่นเก่า | **REBUT AS STANDALONE CONFORMANCE GAP; ACCEPT AS CLOSURE HYGIENE** | Source ไม่ได้กำหนดว่า comment ทุกบรรทัดต้องมี trace ref แต่ reference เก่าทำให้ `APPLY_PATCH` ถูกตีความผิดและไม่มี durable authority ใน repo จึงต้องแก้ในไฟล์ Phase-0 ที่แตะ หลัง pin source ตาม §11; ไม่ควรทำ repo-wide comment churn หรือใช้ old master เป็น authority |

### Coverage verdict

| Normative area | Verdict | Notes |
|---|---|---|
| §11 DoD#1 | PASS | Core ไม่เชื่อ success claim และรัน gate เอง |
| §11 DoD#2 | GAP | Direct write policy ผ่าน แต่ command/patch surfaces ยังไม่ครบ role policy |
| §11 DoD#3 | GAP | Executor command deny-network ผ่าน แต่ gate child process หลุด |
| §11 DoD#4 | GAP | Golden tamper ผ่าน แต่ evidence ref/content/signature trust boundary ไม่ผ่าน |
| §11 DoD#5 | PASS | Retry-and-flag, no silent quarantine |
| §11 DoD#6 | PASS สำหรับ shipped write/command | ต้องเพิ่ม `APPLY_PATCH` recovery เมื่อรองรับ |
| §11 DoD#7 | PASS สำหรับ shipped actions | ต้องเพิ่ม patch/read lifecycle control |
| §11 DoD#8 | GAP | Graph claim บางส่วน; single-task, heartbeat, lease-loss fencing ยังขาด |
| §11 DoD#9 | PASS สำหรับ iteration cap; GAP สำหรับ cost backstop | Negative/NaN usage ลดหรือทำลาย accumulator ได้ แต่ iteration cap ยังหยุดลูป |
| §4.4 T0/T1 | GAP | T0 timing ผิด, gate config fail-open ได้, gate command ไม่ frozen |
| §4.5 golden/convention | GAP | Library มี แต่ operational freeze/CI/coverage และ prohibited enforcement ยังไม่ครบ |
| §11 T2/T3 stubs | PASS | คืน `not_enabled` ชัดเจน; ควร log stub report เหมือน tier อื่น |
| §12 must-not-cut mechanisms | GAP | executor policy, lease, golden, budget และ egress ต่างมี partial bypass |

ไม่มี REQ IDs ใน authority ให้รายงาน “uncovered REQ”; uncovered normative clauses คือ
§3 บรรทัด 66/76, §4.1 บรรทัด 80–93, §4.2 บรรทัด 95–98, §4.4 บรรทัด
112–120, §4.5 บรรทัด 125–127, §4.6 บรรทัด 141–142, §8.1 บรรทัด
223–227, §10 บรรทัด 287–292, §11 บรรทัด 294–327 และ §12 บรรทัด 333–345

## Prioritized Findings

### Critical

#### C1 — Gate child process เป็น untrusted execution path ที่ข้ามทั้ง egress และ frozen-artifact boundary

- Location: `core/src/gates/runner.ts:84`–`:112`, `:123`–`:139`,
  `:180`–`:220`
- Normative: §1 ข้อ 1/3/4, §4.1 egress, §4.4, §8.1 deterministic controls,
  §12 evidence-first
- Evidence:
  - Gate command ใช้ `spawnSync('/bin/sh', ...)` โดยไม่ผ่าน `SandboxWrap`
  - `worktreeHash` ถูกคำนวณก่อน command แต่ไม่มี post-run comparison
  - Gate command เขียน `src/`, gate script, `_MANIFEST.sha256` หรือทั้ง golden file
    ได้ แล้ว builtin convention/golden check จึงอ่าน state ที่ command เพิ่งเปลี่ยน
  - `LadderConfig` ทุก field optional; T0/T1 ที่ไม่มี checks ให้
    `checks.every(...) === true` เป็น vacuous green
- Impact: Agent/repo content สามารถ exfiltrate, self-modify test/golden, หรือ mint green
  ที่ไม่ได้ผูก frozen artifact แม้ executor path จะ sandbox ถูก
- Concrete fix:
  1. ใช้ command-execution primitive เดียวสำหรับ executor และ gate
  2. Gate ทุกคำสั่งต้อง `network:none`, fail closed เมื่อ sandbox unavailable
  3. รัน gate บน disposable snapshot หรือ read-only product tree พร้อม policy-declared
     output roots; ห้าม durable mutation ของ tested tree และ `test/golden/`
  4. Validate required T0/T1 config shape ก่อนรัน; malformed/empty tier ต้อง explicit fail
  5. คำนวณ/ยืนยัน frozen tree หลัง execution และ log `GATE_RESULT` แม้ stub/failure

### High

#### H1 — Lease wiring ยังไม่ให้ single-writer ตลอด task lifecycle

- Location: `core/src/orchestrator/loop.ts:52`–`:80`,
  `console/backend/src/loop-run.ts:1058`–`:1111`, `:1159`–`:1161`,
  `core/test/fault-injection.test.ts:786`–`:857`
- Normative: §4.2 heartbeat+TTL+single-writer, §9.2 lease ว่างก่อน select,
  §11 DoD#8, §12 lease ห้ามตัด
- Current improvement: graph scheduler มี unique per-invocation owner, claim before
  `executeTask`, release in `finally`
- Remaining failures:
  - single-task pathเรียก `executeTask` ตรง
  - `runTaskLoop` ยังเรียกได้โดยไม่มี lease
  - ไม่มี `renew()` ใน production path
  - pause ไม่นับ wallclock; pause เกิน TTL แล้ว owner ใหม่ claim ได้ ขณะที่ owner เดิม
    resume ต่อโดยไม่ reacquire
  - override TTL อาจสั้นกว่า synchronous action/gate timeout ทำให้ lease หมดกลาง atomic action
- Concrete fix: ย้าย lease lifecycle ไป boundary ที่ครอบทุก `runTaskLoop`; claim ก่อน
  proposal แรก, renew ก่อนทุก atomic side effect/ระหว่าง async wait, validate
  `ttl > maxAtomicDuration`, reacquire/fence หลัง pause, stop cleanly เมื่อ renew สูญเสีย
  ownership และ release ทุก terminal/error path

#### H2 — Role least privilege ไม่ครอบ shell side effects

- Location: `core/src/executor/path-policy.ts:20`–`:28`,
  `core/src/security/sandbox.ts:35`–`:50`,
  `core/src/executor/executor.ts:299`–`:329`, `:390`–`:410`
- Normative: §4.1 path allowlist “ตาม role” และ out-of-policy structured feedback,
  §8.1 action-level control
- Impact: `planner`, `diagnostician`, `reviewer` ใช้ `RUN_COMMAND` เขียน `src/` ได้;
  `test_designer` เขียนนอก `test/ai-generated/` ได้
- Concrete fix: ให้ `PathPolicy` expose normalized write roots ต่อ role และให้
  sandbox profileรับ roots เหล่านั้น; planner/diagnostician/reviewer มีเพียง `/dev/null`
  หรือ approved scratch ที่ไม่อยู่ artifact; command ที่พยายามเขียนนอกสิทธิ์ต้อง
  non-zero พร้อม core-captured evidence และ structured feedback ที่รอบถัดไปใช้ได้

#### H3 — `APPLY_PATCH` ขาดทั้ง implementation และ policy/error semantics ใน Phase 0

- Location: `core/src/types.ts:11`–`:24`,
  `core/src/executor/executor.ts:156`–`:181`, `:279`–`:285`, `:378`–`:411`,
  `:413`–`:445`
- Normative: §3 path 5, §4.1, §11 Phase-0 executor
- Impact: Action DSL หลักทำงานไม่ครบ; repair path รุ่นหลังอ้าง patch plan แต่ deterministic
  executor ใช้ patch ไม่ได้
- Concrete fix: dereference+verify `diffRef`, enumerate every affected old/new path
  ผ่าน parser ที่ไม่ fail-open, apply role policy/golden deny ก่อน side effect, validate
  patchด้วย `git apply --check`, แล้วใช้ snapshot → INTENT → apply → APPLIED + result hash;
  recovery และ duplicate actionId ต้องใช้ semantics เดียวกับ WRITE/COMMAND
- Required error paths: missing/tampered ref, malformed diff, rename/delete/binary/symlink,
  absolute/traversal path, no-op patch, apply conflict และ crash before/after apply
  ต้องเป็น structured result ไม่ uncaught crash
- Related hidden gap: §4.1 บอก “ทุก action” บันทึก INTENT ก่อนรัน แต่ allowed
  `READ_FILE` ปัจจุบันไป `ACTION_APPLIED` ตรงที่ `executor.ts:331`–`:351`;
  ต้องตัดสินให้ lifecycle ตรง source หรือบันทึก explicit amendment

#### H4 — Evidence integrity ถูกตรวจเฉพาะเมื่อ caller เลือกใช้ `get()`

- Location: `core/src/evidence/store.ts:30`–`:65`,
  `core/test/fault-injection.test.ts:109`–`:132`,
  `core/src/orchestrator/loop.ts:261`–`:277`,
  `core/src/merge/auto-merge.ts:173`–`:184`, `:346`–`:357`,
  `core/src/audit/oob.ts:125`–`:177`
- Normative: §1 ข้อ 4, §3 paths 7/11 + immutable/content-addressed rule,
  §8.1 evidence core-only+sign, §11 DoD#4
- Reproduced:
  - tampered blob: `has:true`, `get()` จึงค่อย throw hash mismatch
  - injected green GateReport ที่มี nonexistent `blob://000...` ทำ
    `runTaskLoop` จบ `REVIEWING`
- Additional gaps:
  - `put()` พบ path เดิมแล้วไม่ verify ว่า bytes เดิมยังตรง hash
  - blob file ยังแก้ทับได้; ไม่มี atomic create/read-only protection
  - source ระบุ `signed`; current SHA-256 content address ให้ integrity เมื่ออ่าน
    แต่ไม่ใช่ authenticity signature
  - unsampled auto-merge ไป `COMPLETED` โดยไม่ re-run และไม่ dereference original refs
- Concrete fix: shared `verifyGateReportEvidence(report, store)` ต้องอ่านและ hashทุก ref
  ที่ trust boundary ก่อน PASSED/REVIEWING, approve/merge และ COMPLETED; harden
  `put()` เป็น atomic create + verify-on-existing; corruption ต้อง append structured
  `ERROR`/`ESCALATED` ไม่ crash
- Human decision required: source ไม่กำหนด signing key lifecycle. ตัวเลือกที่ปลอดภัยคือ
  governance-pinned signing key/public-key anchor ต่อ environment; ห้ามเรียก content hash
  ว่า signature เพื่อ claim ผ่าน §3/§8.1

#### H5 — T0 timing ไม่ตรง “ทุก iteration” และ failure flow ยังไม่มี seam ที่ชัด

- Location: `core/src/orchestrator/loop.ts:231`–`:265`, `:291`–`:323`
- Normative: §4.4 T0 every iteration, §7.3 confirmed patch → T0
- Concrete fix: หลัง action batch ของทุก implement/repair iteration ให้ core รัน T0
  เสมอ; claim `READY_FOR_VERIFICATION` เพิ่ม T1 หลัง T0 เดิม ไม่รัน T0 ซ้ำ
  และ claim `WORKING` ห้ามข้าม T0
- State seam: periodic T0 passไม่ควรผลัก state ไป PASSED; T0 failต้องเข้า deterministic
  VERIFYING → FAILED → DIAGNOSING path โดยไม่เชื่อ claim
- Ambiguity to pin in tests: diagnostician proposal/probe ที่ไม่แก้ artifactไม่นับเป็น
  “implementation iteration” สำหรับ T0; budget iteration counterควรตั้งชื่อ/วัดแยกเพื่อ
  ไม่ทำให้ assertion `T0 count == all adapter calls` ผิด

#### H6 — Golden harness ยังเป็น fixture-generated mechanism ไม่ใช่ operational human-frozen contract

- Location: `core/src/gates/golden.ts:20`–`:63`,
  `console/backend/src/loop-run.ts:225`–`:254`,
  `core/src/calibration/calibration.ts:12`–`:41`,
  `.github/workflows/ci.yml:27`–`:59`
- Normative: §3 path 1, §4.5 golden row, §10 paired metric, §11 repo structure,
  §12 golden ห้ามตัด
- Concrete fix:
  - track a human-authored target fixture whose internal path is
    `test/golden/_MANIFEST.sha256`; runtime copies fixture bytes ห้าม generate truth
  - CI เรียก manifest verifierโดยตรงทุก run ไม่หวังว่าบาง test จะผ่าน code path
  - report `goldenCoverage = golden-backed AC / all in-scope AC` คู่กับ held-out pass
    rate; task-level graph ต้อง aggregate AC IDs แบบไม่ double-count
  - goal references only `golden:true`; agent/runtime ไม่มี API regenerate manifest

### Medium

#### M1 — Invalid `costUnits` ทำลาย always-on budget backstop

- Location: `core/src/ports.ts:30`–`:40`, `core/src/budget/budget.ts:19`–`:42`,
  `aal/src/protocol.ts:42`–`:59`, `aal/src/repair.ts:83`–`:104`,
  `aal/src/source.ts:324`–`:393`
- Reproduced: charge `-100` บน cap 5 คืน `remaining:105`, `exceeded:false`;
  `NaN` ทำให้ comparisons เป็น false และ remaining เป็น `NaN`
- Concrete fix: validate every per-response usage and aggregateเป็น finite,
  non-negative number; invalid adapter responseเป็น `invalid_response` และ core boundary
  ต้อง fail closed แม้ custom `ProposalSource` ข้าม AAL; preserve iteration capเป็น
  independent backstop

#### M2 — Convention gate ต้องแยก syntactic rules ออกจาก semantic prohibited changes

- Location: `core/src/gates/runner.ts:53`–`:76`,
  `core/src/executor/path-policy.ts:20`–`:28`
- Normative: §4.5 convention hard gate แต่จำกัดที่เขียน rule ได้; §4.6 prohibited always
- Concrete fix:
  - ย้าย builtin rulesเป็น typed/config-versioned checker พร้อม paired allow/block cases
  - ครอบ focused/skipped variants, typecheck/lint/coverage bypass และ ignore ที่ไม่มีเหตุผล
  - สำหรับ delete failing test / weaken assertion / edit test to pass ห้ามใช้ regex claim:
    freeze hash ของ RED test artifact หลัง core พิสูจน์ expected failure และบังคับ
    provenance/role transition; การแก้ hash ต้องกลับ test-designer RED gate ไม่ใช่
    implementerแก้เงียบ
- Cost/feasibility: stack-neutral semantic diff classifierไม่น่าเชื่อถือและแพง;
  immutable RED checkpoint เป็น deterministic conservative option ที่เหมาะกว่า

### Low

#### L1 — Durable authority และ trace references ยังไม่อยู่ใน topology ที่ source กำหนด

- Location: normative §11 บรรทัด 294–312; current root ไม่มี
  `loop-engineering-implementation-spec.md`; references เก่าอยู่ที่
  `core/test/fault-injection.test.ts:1`, `core/src/types.ts:1`,
  `.ai/policies/gate-ladder.json:2`, `.github/workflows/ci.yml:29`,
  `scripts/check-core-vendor-free.sh:4`
- Decision: **ต้อง copy source แบบ byte-for-byte เข้า repo root ก่อน implementation**
  เพราะ §11 ระบุ path นี้เองและ spec-first workflowต้องมี versioned authority
- Guardrails:
  - verify `cmp` และ SHA-256 เท่ากับ
    `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
  - human review/approve exact copy ก่อนถือ root file เป็น authority
  - ห้ามแก้/ลบ old master/blueprint; เพียงไม่ใช้เป็น authority
  - หลัง pin แล้วแก้เฉพาะ misleading refs ใน Phase-0 files ที่แตะ ไม่ทำ repo-wide churn

## Proposed Cohesive Tasks and Dependency DAG

งานต่อไปควรมี 10 cohesive tasks สูงสุดตาม protocol และทุก taskต้องเพิ่ม fault scenario
แบบ RED ก่อน implementation ใน task เดียวกัน

```text
P0-01 durable authority
  ├─> P0-02 child-process policy
  │     ├─> P0-05 T0 iteration wiring
  │     ├─> P0-08 golden operationalization
  │     └─> P0-09 prohibited-change enforcement
  ├─> P0-03 APPLY_PATCH lifecycle ─────────────> P0-09
  ├─> P0-04 evidence integrity ──> P0-05
  ├─> P0-07 cost validation
  └─> P0-06 lease lifecycle (serialize after P0-05 because both own loop.ts)

P0-02..P0-09 ──> P0-10 conformance closure
```

### P0-01 — Pin normative authority byte-for-byte

- Goal: เพิ่ม root `loop-engineering-implementation-spec.md` exact bytes แล้วให้ human
  approve เป็น durable authority
- Likely files:
  - `loop-engineering-implementation-spec.md` (new, exact copy only)
- Verification:
  - `cmp -s /Users/king_developer/Downloads/loop-engineering-implementation-spec.md loop-engineering-implementation-spec.md`
  - SHA-256 ตรงค่าที่บันทึกด้านบน
- Scope guard: ไม่แตะ old master/blueprint

### P0-02 — Unify fail-closed child-process execution

- Goal: executor commandsและ T0/T1 commandsใช้ sandbox primitiveเดียว; gate artifact
  immutable, role writes least-privilege, config non-vacuous
- Likely files:
  - `core/src/security/sandbox.ts`
  - `core/src/security/command-runner.ts` (new)
  - `core/src/security/command-runner.test.ts` (new)
  - `core/src/executor/path-policy.ts`
  - `core/src/executor/path-policy.test.ts`
  - `core/src/executor/executor.ts`
  - `core/src/executor/executor.test.ts`
  - `core/src/gates/runner.ts`
  - `core/src/gates/runner.test.ts`
  - `core/test/fault-injection.test.ts`
  - `core/test/helpers/fixture.ts`
  - `.ai/policies/gate-ladder.json`
- Test seam: inject sandbox/command runner; production defaultต้อง fail closed

### P0-03 — Implement full Phase-0 `APPLY_PATCH` action lifecycle

- Goal: policy-safe patch parsing/apply, structured failures, idempotency and recovery
- Likely files:
  - `core/src/types.ts`
  - `core/src/executor/path-policy.ts`
  - `core/src/executor/executor.ts`
  - `core/src/executor/executor.test.ts`
  - `core/test/fault-injection.test.ts`
- Test seam: patch bytesมาจาก `EvidenceStore`; fixture asserts resulting tree + event order

### P0-04 — Make evidence integrity mandatory at trust boundaries

- Goal: atomic immutable blobs, verify-on-existing, shared report verifier,
  no state advancement on missing/tampered evidence; resolve signature decision
- Likely files:
  - `core/src/evidence/store.ts`
  - `core/src/evidence/store.test.ts`
  - `core/src/gates/report-integrity.ts` (new)
  - `core/src/gates/report-integrity.test.ts` (new)
  - `core/src/orchestrator/loop.ts`
  - `core/src/merge/auto-merge.ts`
  - `core/src/merge/auto-merge.test.ts`
  - `core/src/merge/queue.ts`
  - `core/src/audit/oob.ts`
  - `core/src/audit/oob.test.ts`
  - `core/test/fault-injection.test.ts`
- Test seam: mutate blobระหว่าง gate→loop และ REVIEWING→merge; unsampled pathต้อง refuse

### P0-05 — Run T0 exactly once per implementation/repair iteration

- Goal: WORKING roundsไม่ข้าม T0; READY roundใช้ T0 เดิมแล้วเพิ่ม T1; deterministic
  failure state/feedback
- Likely files:
  - `core/src/orchestrator/loop.ts`
  - `core/src/orchestrator/machine.ts` (เฉพาะหากต้องเพิ่ม explicit periodic-gate trigger)
  - `core/src/orchestrator/machine.test.ts`
  - `core/test/fault-injection.test.ts`
  - `core/test/repair-loop.test.ts`
  - `core/test/steering-loop.test.ts`
- Test seam: spy GateRunner + sequence tableสำหรับ WORKING/READY/BLOCKED/T0-fail

### P0-06 — Put lease claim/heartbeat/fencing around every task loop

- Goal: single-taskและ graphใช้ lifecycleเดียว; no side effect without live ownership
- Likely files:
  - `core/src/state/lease.ts`
  - `core/src/state/lease.test.ts`
  - `core/src/orchestrator/loop.ts`
  - `core/src/ports.ts`
  - `console/backend/src/loop-run.ts`
  - `console/backend/src/loop-run-graph.test.ts`
  - `console/backend/src/loop-run-graph.fault-injection.test.ts`
  - `console/backend/src/loop-run.test.ts`
  - `core/test/fault-injection.test.ts`
- Test seam: two actual loop invocations share events DB/task; loserมี zero
  `CLAIM_RECORDED`/`ACTION_INTENT`/`ACTION_APPLIED`

### P0-07 — Validate normalized usage and budget arithmetic

- Goal: finite non-negative cost at AAL and core boundaries; invalid usage degrades
  cleanlyและไม่เพิ่ม budget
- Likely files:
  - `core/src/budget/budget.ts`
  - `core/src/budget/budget.test.ts`
  - `core/src/ports.ts`
  - `core/src/orchestrator/loop.ts`
  - `aal/src/protocol.ts`
  - `aal/src/repair.ts`
  - `aal/src/repair.test.ts`
  - `aal/src/source.ts`
  - `aal/src/source.test.ts`
  - `aal/src/fusion/run.ts`
  - `aal/src/fusion/run.test.ts`
  - `core/test/fault-injection.test.ts`

### P0-08 — Operationalize human-frozen golden + paired coverage

- Goal: tracked truth fixture, direct CI manifest gate, runtime copy-only, coverage metric
- Likely files:
  - `core/src/gates/golden.ts`
  - `core/src/gates/golden.test.ts`
  - `core/src/calibration/calibration.ts`
  - `core/src/calibration/calibration.test.ts`
  - `console/backend/src/loop-run.ts`
  - `console/backend/src/loop-run.test.ts`
  - `console/backend/src/fixtures/loop-target/test/golden/expected.txt` (new)
  - `console/backend/src/fixtures/loop-target/test/golden/_MANIFEST.sha256` (new)
  - `scripts/check-golden-manifests.sh` (new)
  - `.github/workflows/ci.yml`
- Test seam: temp copy of tracked fixture; CI scriptรับ fixture root explicitเพื่อทดสอบ tamper

### P0-09 — Enforce prohibited changes without semantic regex theater

- Goal: config-versioned syntactic convention rules + immutable RED-test provenance
- Likely files:
  - `core/src/gates/convention.ts` (new)
  - `core/src/gates/convention.test.ts` (new)
  - `core/src/gates/runner.ts`
  - `core/src/executor/executor.ts`
  - `core/src/state/event-log.ts` หรือ typed event additionใน `core/src/types.ts`
  - `.ai/policies/gate-ladder.json`
  - `core/test/fault-injection.test.ts`
- Test seam: paired allow/block corpus; test hash frozenหลัง expected RED; implementer
  edit/delete/ref weaken routeถูก reject, test-designer correctionต้องกลับ RED gate
- Feasibility warning: หากไม่สร้าง RED provenance ให้บันทึก explicit non-conformance;
  regex-only solutionห้าม claimว่าครอบ “weaken assertion”

### P0-10 — Close Phase-0 conformance and traceability

- Goal: re-run DoD 9 scenariosบน actual production paths, update touched trace refs,
  prove no Phase-1+ component substitutes for Phase-0 mechanism
- Likely files:
  - `core/test/fault-injection.test.ts`
  - `.github/workflows/ci.yml`
  - `.ai/policies/gate-ladder.json`
  - `scripts/check-core-vendor-free.sh`
  - Phase-0 files touchedใน P0-02..P0-09 (comments only where misleading)
  - Phase conformance evidence/handoff artifactตาม approved spec workflow
- Exit criterion: DoD#1–#9 ผ่าน fault injection ที่ทดสอบ wired pathจริง,
  typecheck/lint/full tests/CI green, no unsupported Phase-0 action, direct golden CI pass,
  exact authority hash recorded

## Test Strategy

### Required fault matrix

| Surface | RED scenario | GREEN control |
|---|---|---|
| Gate egress | T0 lint และ T1 fullTests ต่อ raw IP; ต้อง fail + evidence/log | `true`/real testsผ่านใน sandbox |
| Gate mutation | commandแก้ `src/`, gate script, golden+manifest; ต้อง blocked/discarded และ input tree byte-identical | policy-declared scratch/outputเขียนได้แต่ไม่ mergeกลับ |
| Gate config | `{}`, missing lint/typecheck/tests, unknown tier shapeต้อง explicit fail | shipped T0/T1ครบและ hashตรง |
| Role command writes | planner/diagnostician/reviewerเขียน `src`; test designerเขียนนอก generated; implementerเขียน root/golden | implementer `src`, test designer generated |
| Patch | traversal/golden/rename/delete/malformed/tampered ref/conflict/crash/duplicate | valid implementer patchใน `src/` |
| Evidence | mutate/delete blobหลัง GATE_RESULT ก่อน advancement; fake ref; corrupt existing ref on `put()` | valid signed/hash-verified refs |
| T0 frequency | N WORKING iterations, READY, BLOCKED, repair after confirmed hypothesis | exact T0 count/ordering and T1 only on GREEN claim |
| Lease | two loops same task; single path; pause past TTL; renew loss; owner crash | one loop executes, release/reclaim after terminal |
| Budget | `-1`, `NaN`, `Infinity`, repair aggregate overflow/invalid, custom source bypass AAL | zero and finite positive cost |
| Golden | tracked file edit/delete/add/manifest rewrite, coverage 0/partial/1 | exact frozen copy + direct CI |
| Convention | whitespace `.only`/`.skip`, type/lint/coverage bypass, unexplained ignore, post-RED test edit/delete | documented ignore + legitimate pre-freeze test correction |

### Verification commands after implementation

- `pnpm --filter core typecheck`
- `pnpm --filter aal typecheck`
- `pnpm --filter console-backend typecheck`
- `pnpm --filter core exec node --test --test-reporter spec test/fault-injection.test.ts`
- `pnpm --filter core test`
- `pnpm --filter aal test`
- `pnpm --filter console-backend test`
- `pnpm lint`
- `scripts/check-core-vendor-free.sh`
- `scripts/check-golden-manifests.sh`
- `scripts/ci-test-scope.sh push develop`

RUN_COMMAND fault scenariosที่ต้องใช้ macOS `sandbox-exec` ต้องรันนอก nested managed
sandboxหรือบน CI `macos-latest`; ห้ามตี nested sandbox exit 71 ว่า implementation failure
และห้ามใช้ผล mock แทน live kernel-deny proof

## Important Decisions

- Authority เดียวระหว่าง review คือ external implementation spec SHA-256 ที่บันทึกไว้;
  old master/blueprint ไม่ถูกอ่านเป็น product behavior
- ต้อง pin exact source เข้า rootตาม §11 ก่อนแก้ code; หลัง human approve จึงใช้ root
  copy เป็น durable authority
- Lease findingไม่ถูกยกเลิกด้วย graph schedulerใหม่ เพราะ invariantต้องครอบทุก task mode
  และทั้ง lifecycle ไม่ใช่แค่ claimก่อน dispatch
- Evidence ref equalityไม่เท่ากับ integrity verification; ต้อง dereferenceทุก trust boundary
- Gate commandsเป็นการ execute untrusted repo content แม้ coreเป็นคน spawn จึงต้องใช้
  deterministic security boundaryเดียวกับ executor
- Convention regexครอบได้เฉพาะ syntax; semantic prohibited changesต้องอาศัย frozen RED
  artifact/provenance ไม่ใช่ classifier
- ไม่เสนอ mutation gate, impact map, auditor, fusion หรือ learning เป็น Phase-0 fix
- การเปลี่ยน `loop.ts` ถูก serializeตาม P0-05 → P0-06 เพื่อเลี่ยงสอง taskแก้ lifecycle
  เดียวพร้อมกัน แม้ logical concernsจะแยกกัน

## Constraints

- ห้ามใช้ old master/blueprint/archived platform specs เป็น authority
- ห้ามแก้ production code, requirements.md, design.md หรือ tasks.md ใน Task 2
- Task ต่อไปต้องผ่าน requirements → design → tasks approval gatesก่อน implementation
- ทุก fault scenarioต้อง RED ก่อน fix ตาม normative §0 ข้อ 4
- ห้าม claim full conformanceหาก evidence signing key lifecycleยังไม่ตัดสิน
- ห้ามเพิ่ม dependency เพื่อ parse patch/schemaโดยไม่ผ่าน license+maintenance review
- ห้ามลด gate, skip flaky test หรือใช้ mock sandboxเป็นหลักฐาน DoD#3
- ไม่ revert untracked Task-1 handoffหรือ edit ของ teammate; no commit/push

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-02-architecture-review.md`
  — created — architecture critique, accepted/rebutted matrix, dependency DAG และ test strategy

ไม่มี production code, tests หรือ requirements/design/tasks ถูกแก้

## Tests Run

- `git status --short --branch` -> HEAD
  `078e039`, branch `codex/loop-engineering-phase0-conformance`; spec directory untracked
- `pnpm --filter core typecheck` -> pass (`tsc -p tsconfig.json`, exit 0)
- `pnpm --filter core exec node --test --test-reporter spec src/budget/budget.test.ts src/evidence/store.test.ts src/state/lease.test.ts src/gates/runner.test.ts`
  -> 16 passed / 0 failed
- Current-code diagnostic: `noteIteration(-100)` under cap 5 ->
  `{"remaining":105,"exceeded":false}`
- Current-code diagnostic: WORKING → BLOCKED two proposals ->
  `{"finalState":"BLOCKED","proposals":2,"gateCalls":0}`
- Current-code diagnostic: tampered evidence ->
  `has:true`; `get()` throws `evidence hash mismatch`
- Current-code diagnostic: green GateReport with nonexistent evidence ref ->
  `{"finalState":"REVIEWING","evidenceRef":"blob://000...000"}`
- `shasum -a 256 /Users/king_developer/Downloads/loop-engineering-implementation-spec.md`
  -> `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

ไม่ได้ rerun full fault suiteใน Task 2 เพราะ current implementationไม่เปลี่ยนและ
RUN_COMMAND scenariosต้องออกจาก nested sandbox; Task-1 exact external runยังเป็น
18 passed / 0 failed แต่ไม่ override architecture gapsที่ suiteไม่ exercise

## Known Issues

- Evidence `sign` เป็น explicit normative requirementแต่ key lifecycle/anchorไม่ถูกกำหนด
  ใน source; ต้อง human decisionก่อนออก designสุดท้าย
- Gate isolation มี trade-off: disposable snapshotถูกต้องสุดแต่แพงเมื่อ T0 ทุก iteration;
  read-only artifact + policy-declared output rootsเบากว่าแต่ต้องพิสูจน์ no durable mutation
- `APPLY_PATCH` parserต้องรองรับ path quoting/rename/deleteอย่าง fail-closed; hand-rolled
  line regexเสี่ยง bypass
- Current graph lease testsพิสูจน์ held leaseไม่ dispatch แต่ยังไม่พิสูจน์ heartbeat,
  ownership loss หรือ single-task
- `RTK.md` และ `karpathy.md` ที่ parent AGENTS instructions อ้างไม่พบใน workspace/parent
  ที่ค้นได้ จึงไม่มีเนื้อหาจากสองไฟล์นี้ถูกใช้ตัดสิน

## Next Recommended Agent

`spec-architect`/lead สำหรับ synthesize requirements.md จาก findings นี้และ Task-1 audit
โดยยึด root-pinned implementation spec; หลัง approval ใช้ `spec-design` และให้
fresh-context reviewerตรวจ signing, gate isolation และ lease fencingเป็นพิเศษ

## Next Steps

1. Human review/approve decision ให้ copy external source exact bytesเข้า
   `loop-engineering-implementation-spec.md`
2. สร้าง/approve `requirements.md` ที่ map exact sections/DoD แทน old REQ IDs
3. สร้าง `design.md` โดยปิดสาม decision ก่อน: gate isolation model, evidence signing
   key lifecycle, lease TTL/heartbeat/fencing semantics
4. สร้าง `tasks.md` ตาม DAG P0-01..P0-10 และทำแต่ละ fault scenario RED-first
5. Implement ตาม dependency order; ปิดด้วย external macOS sandbox proof + full CI
