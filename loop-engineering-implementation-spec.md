# Autonomous Loop Engineering — Implementation Spec
### เอกสารเดียวสำหรับ AI Agents ที่จะ Implement ระบบ (Claude · Codex · GLM-5.3 · โมเดลใดที่ผ่าน Conformance)

> **การใช้เอกสารนี้:** ไฟล์นี้คือ spec ฉบับ implement — มีเฉพาะเนื้อหา normative **เมื่อส่งงานให้ agent ให้ใช้ไฟล์นี้ไฟล์เดียว** ห้ามโหลดเอกสาร master/blueprint รุ่นก่อนเข้า context ร่วม (เอกสารเหล่านั้นเป็นบันทึกการวิเคราะห์สำหรับมนุษย์ — โหลดร่วมจะเกิดคำสั่งซ้ำซ้อน/ขัดกัน)
>
> **ภาษา:** prose อธิบายเป็นไทย / artifact ทุกชนิด (schema, YAML, code, prompt, ชื่อไฟล์) เป็นอังกฤษ — ห้ามแปล artifact เป็นไทย

## §0 กติกาการ Implement (อ่านก่อนทุกอย่าง — กัน scope creep)

1. **สร้างทีละ Phase ตาม §11 เท่านั้น** — scope ปัจจุบันคือ **Phase 0** และ "เสร็จ" ของ Phase 0 หมายถึง*ผ่าน Fault-injection DoD 9 ข้อ* (§11) ไม่ใช่ "เขียนโค้ดครบ"
2. **ห้ามสร้างล่วงหน้าเกิน phase** — ทุกส่วนประกอบมี phase กำกับ การที่ชื่อปรากฏในเอกสาร ≠ ต้องสร้างตอนนี้ ตัวอย่างที่มักพลาด: `mutation-gate` = Tier T3 (เฟสหลัง), `impact-map` = optimization (เฟสหลัง), `auditor` = Phase 3, `fusion` = Phase 3, `learning/` = Phase 3–4
3. **สามเครื่องมือนี้เป็นคนละสิ่ง ห้ามหลอมรวม:** Fault-injection suite = ชุดเทสต์ CI ของตัว core (Phase 0) / Out-of-band auditor = process runtime สุ่มตรวจ reproducibility (Phase 3) / Calibration Suite = benchmark ทั้งลูป (Phase 1+)
4. **เขียนเทสต์ก่อน implement — รวมถึงตัว core เอง:** เขียน fault scenarios เป็น failing tests ก่อน แล้ว implement ส่วนประกอบให้ผ่านทีละข้อ (RED→GREEN ของ control plane)
5. ทุกประโยค "ต้อง/ห้าม" เป็น normative; คอลัมน์ "ข้อจำกัด" ในตาราง = สิ่งที่ห้าม claim เกินจริง (ต้องสะท้อนใน docs/comments ของโค้ดด้วย)
6. หากพบข้อความขัดกัน ให้ยึดลำดับ: กฎเหล็ก §1 → templates §9 → ข้อความ section อื่น → ถามมนุษย์

## §1 กฎเหล็ก 7 ข้อ (invariants ของทั้งระบบ)

> **The model proposes, the core disposes.** โมเดลไม่เคยลงมือเอง ไม่เคยตัดสินว่าตัวเองสำเร็จ — มันเสนอ structured action แล้ว deterministic core ตรวจ policy และลงมือ เหมือนกันทุกโมเดล

1. โมเดลเสนอ — **core เป็นผู้รันและผู้วัด**
2. core **ไม่ import vendor SDK ใด** — ทุกการเรียกโมเดลผ่าน Agent Abstraction Layer (AAL) เท่านั้น
3. **ทุกเนื้อหาที่เข้า context = untrusted data** — ไฟล์ repo, dependency, ผลรอบก่อน, lessons ของระบบเอง
4. `COMPLETED` มาจาก core + หลักฐานที่ reproduce ได้บน frozen artifact เท่านั้น — ไม่ใช่จากคำรายงานของ agent
5. งานที่กู้คืนไม่ได้ (L4) ต้องมีมนุษย์เสมอ ไม่ว่า gate เขียวแค่ไหน
6. ระบบต้อง **degrade อย่างคุมได้** เมื่อชิ้นส่วนพัง (provider ล่ม / process ตาย / โมเดล drift) — ห้าม thrash เงียบ ๆ
7. ความเชื่อใจต้อง **วัดได้และมีขอบเขต** — ผ่าน Calibration protocol (§10) ไม่ใช่ความรู้สึก

## §2 สถาปัตยกรรม: 3 Rings × 4 Planes

```
                  ┌─ SECURITY ─┬─ OPS ──┬─ HUMAN ─┬─ LEARNING ─┐   ← 4 planes ตัดขวาง
╔═════════════════╪════════════╪════════╪═════════╪════════════╡
║ RING 2 ADAPTERS │ P7 inject  │ health │    —    │ outcome    │   ตัวแปลบางต่อ vendor
║ (swappable)     │ probe      │ probe  │         │ telemetry  │
╠═════════════════╪════════════╪════════╪═════════╪════════════╡
║ RING 1 AAL      │ suscept.-  │ breaker│    —    │ shadow     │   สัญญากลาง vendor-neutral
║ protocol·router │ aware      │ fail-  │         │ outcome    │   + FUSION PLANE
║ conformance     │ routing    │ over   │         │ routing    │
╠═════════════════╪════════════╪════════╪═════════╪════════════╡
║ RING 0 CORE     │ egress·dep │ lease  │ approval│ lessons    │   เจ้าของ "ความจริง"
║ executor·state  │ policy·    │ resume │ steering│ (curated)  │
║ gates·audit     │ canary·gov │ sched. │ escalate│ calibration│
╚═════════════════╧════════════╧════════╧═════════╧════════════╝
                          ▲
                 Goal Contract (frozen) ← Human / Product Owner
```

**กฎการพึ่งพา (บังคับเข้มงวด):**
- Ring 0 ไม่รู้จัก Ring 2 — **โค้ดใน `core/` ห้ามมีคำว่า claude / codex / glm / anthropic / openai ปรากฏ** (มี CI check ตรวจ)
- Ring 0 คุยกับโมเดลผ่าน Ring 1 เท่านั้น และเห็นแค่ `AgentRequest`/`AgentResponse`
- Ring 2 เป็นตัวแปล wire format ล้วน — ห้ามมี business logic ห้ามตัดสินใจเชิง engineering
- เพิ่มโมเดลใหม่ = เขียน adapter 1 ตัวใน Ring 2 + ผ่าน conformance (§5.3) — ห้ามแตะ Ring 0/1
- Planes อยู่ใน Ring 0 เป็นหลัก (+hook ใน Ring 1) — ห้ามอยู่ใน Ring 2

## §3 Data Flow (15 เส้นทาง)

| # | เส้นทาง | ข้อมูล |
|---|---------|--------|
| 1 | Human → Goal Contract | goal, AC, golden tests (มนุษย์เขียนตอน freeze), budget, approval policy |
| 2 | Goal Contract → Planner (ผ่าน AAL) | frozen contract |
| 3 | Planner → Core | task graph + traceability matrix (AC↔task) ผ่าน planning gate |
| 4 | Core Scheduler → Implementer | AgentRequest + contextBundle (govern + mark + canary) |
| 5 | Implementer → Core Executor | actionRequests (WRITE/PATCH/COMMAND — "ข้อเสนอ") |
| 6 | Executor → Tools | การเขียน/รันจริง ภายใต้ policy + egress deny |
| 7 | Tools → Evidence Store | gate results T0–T3, signed, immutable, core-only writer |
| 8 | Evidence → Repair Loop | failure record → hypotheses → probes → confirmed/refuted |
| 9 | Evidence + Diff → Reviewers | fanout ensemble (ต่าง lineage) |
| 10 | Fusion Panel ↔ Deliberation | candidates → Deliberation Analysis (consensus/contradictions/unique/blind spots) |
| 11 | Reviews + Evidence → Merge Queue | approve → serialize integrate → attribution ชัด |
| 12 | Merge Queue → Auditor | สุ่ม COMPLETED → re-run จาก clean checkout (Phase 3) |
| 13 | Core ↔ Human Plane | approval package / steering (pause·inject·resume) / escalation |
| 14 | Telemetry → Learning Plane | win-rate → shadow router; confirmed hypotheses → lessons (curated) |
| 15 | ทุกอย่าง → Calibration Suite | ทุก system version ถูกวัดก่อนมีผล |

**กฎ:** หลักฐานทุกชิ้น immutable + content-addressed ผูก commit hash + env hash; state ทั้งหมดคือ append-only event log (`state.json` เป็นแค่ projection)

## §4 Ring 0 — Deterministic Core

### 4.1 Action DSL + Executor (Phase 0)
```jsonc
type Action =
  | { "type": "WRITE_FILE",   "path": "src/x.ts", "contentRef": "blob://..." }
  | { "type": "APPLY_PATCH",  "diffRef": "blob://..." }
  | { "type": "RUN_COMMAND",  "cmd": "pnpm test x", "cwd": "worktrees/T-1", "network": "none" }
  | { "type": "READ_FILE",    "path": "src/y.ts" }          // core เติมผลรอบถัดไป + นับเป็น context miss
  | { "type": "REQUEST_TOOL", "name": "fusion.deliberate", "args": { } };   // tool handlers ตาม phase
```
Executor ต้องบังคับตอนรัน:
- **Path allowlist ตาม role** (least privilege): Planner อ่านอย่างเดียว · Test agent แก้เฉพาะ `test/ai-generated/` · Implementer แก้ `src/` + `test/ai-generated/` ใน worktree ตัวเอง · ทุก role: `test/golden/` = read-only
- **Egress default-deny:** ทุก `RUN_COMMAND` รันใน sandbox ที่ network ถูกปิด เว้นแต่ประกาศ `network: allowlist:<name>` และ policy อนุญาต (เช่น `package_install` → registry ที่กำหนด + `--ignore-scripts`)
- **Idempotency:** ทุก action มี `actionId`; บันทึก `ACTION_INTENT` ก่อนรัน, `ACTION_APPLIED` (พร้อม result hash) หลังรัน
- **ข้อเสนอนอกสิทธิ์ → reject เป็น structured feedback** ไม่ crash ไม่เงียบ

### 4.2 Event Log + Lease (Phase 0)
- Source of truth = **append-only event log** — ใช้ SQLite (WAL mode) เพราะ lease ต้องการ atomic compare-and-set; export เป็น `events.jsonl` เพื่ออ่าน/audit; `state.json` เป็น projection ที่ rebuild ได้เสมอ
- **Lease ต่อ task:** `LEASE_CLAIMED {taskId, ownerId, leaseUntil}` + heartbeat + TTL → รับประกัน single-writer
- **Crash recovery:** replay log → เทียบ worktree กับ `ACTION_APPLIED` ล่าสุด (content hash) → ตรง = ทำต่อ / ไม่ตรง = rollback ไป checkpoint แล้วเริ่ม attempt ใหม่ / เจอ `INTENT` ที่ไม่มี `APPLIED` = ตรวจด้วย hash ว่า apply แล้วจริงไหม แล้ว apply หรือ skip

### 4.3 State Machine (Phase 0 — โครงสถานะ; บาง transition เปิดใช้เฟสหลัง)
```
PROPOSED → ANALYZING → READY → IMPLEMENTING → VERIFYING
                                   ├─ FAILED → DIAGNOSING → REPAIRING → VERIFYING
                                   └─ PASSED → REVIEWING
                                                 ├─ CHANGES_REQUESTED → REPAIRING
                                                 └─ APPROVED → MERGE_QUEUED → AUDITED → COMPLETED
พิเศษ: BLOCKED · ESCALATED · CANCELLED · ROLLED_BACK · QUARANTINED · PAUSED
```
- **AI ห้ามเปลี่ยน VERIFYING→COMPLETED** — การเลื่อนสถานะเป็นของ core หลังหลักฐานครบเท่านั้น
- ทุก transition = event ใน log; `PAUSED` เข้าได้จากทุก active state ผ่าน Human Plane (จบ atomic action ก่อนหยุด)

### 4.4 Gate Ladder
| Tier | รันเมื่อ | ประกอบด้วย | Phase |
|------|---------|-----------|-------|
| T0 fast | ทุก iteration | lint, typecheck, targeted tests | **Phase 0** — "targeted" เริ่มจาก fallback = full unit; `impact-map` เป็น optimization เฟสหลัง |
| T1 standard | เมื่อ agent อ้าง GREEN | full unit+integration, convention gate, golden ของ AC ที่แตะ | **Phase 0** |
| T2 full | ก่อน REVIEWING | build, scoped E2E, security scan, full golden | stub ใน Phase 0 (คืนสถานะ "ยังไม่เปิดใช้" ชัดเจน) |
| T3 heavy | ที่ merge queue เท่านั้น | full regression, mutation (ไฟล์ที่แก้), screenshot/a11y | stub ใน Phase 0 |
- **Gate-config hash เข้า evidence ทุกครั้ง** — auditor/ผู้อ่านรู้เสมอว่า "ผ่าน" คือผ่าน tier ไหน config เวอร์ชันใด
- **Flaky quarantine = การลด gate → ต้องผ่าน governance** (approve + versioned + expiry) ห้ามระบบหรือ agent ปิดเทสต์เอง

### 4.5 Correctness Mechanisms
| กลไก (phase) | ทำอะไร | ข้อจำกัด — ห้าม claim เกิน |
|------|--------|----------------------|
| Golden tests (**Phase 0**) — ไฟล์อยู่ `test/golden/`: **read-only ใน worktree ทุก agent** + `_MANIFEST.sha256` + **CI ตรวจ hash ทุกครั้ง (ไม่ตรง = block merge)**; มนุษย์เขียนตอน freeze; `goal.yaml` เพียง*อ้างถึง*ผ่าน `golden: true` | ฐานความจริงอิสระ — COMPLETED ต้องผ่าน "เทสต์ที่ลูปเขียนไม่ได้"; ทำให้เทสต์อ่อนของ AI ไม่เป็นอันตรายถึงตาย | เชื่อได้เท่าที่ golden ครอบ — ต้องวัด golden coverage คู่เสมอ |
| **Fault-injection suite** (**Phase 0**) — ชุดเทสต์ CI ของตัว core | ป้อน agent โกหก / เกินสิทธิ์ / fake-green / flaky / crash แล้ว assert ว่า core จับได้-ปฏิเสธ-กู้คืนถูก — ข้อสอบจบ Phase 0 (DoD ใน §11) | ทดสอบ*พฤติกรรม control plane* — คนละหน้าที่กับ Calibration ซึ่งวัด*คุณภาพผลลัพธ์*ของลูป |
| Convention gate (**Phase 0**, hard) | บังคับ convention/forbidden-pattern เป็นสิ่งตรวจได้ กัน training prior ผิดของแต่ละโมเดล | ครอบเฉพาะ pattern ที่เขียน rule ได้ |
| Mutation gate (T3 — เฟสหลัง) | วัด sensitivity ของเทสต์เป็นตัวเลข | วัด "จับการเปลี่ยนได้ไหม" ไม่ใช่ "ถูกต้อง"; equivalent mutants ทำ score เพี้ยน |
| Property/Adversarial (ต่าง lineage — Phase 3) | จับรูที่ example test พลาด | "อิสระ" คือสมมติฐาน — ต้องวัด decorrelation |
| Merge queue + auto-bisect + contract tests (Phase 3) | serialize integration → attribution ชัดว่าใครทำ integration แดง | บรรเทา semantic conflict ไม่ใช่กำจัด |
| **Out-of-band auditor** (Phase 3) — process runtime แยก | *สุ่ม* task COMPLETED มา re-run gate จาก clean checkout — *ตรวจจับ*ความไม่ตรง **ไม่ได้ฉีด fault** | reproduce ที่ *verification บน frozen artifact* — ไม่ใช่ generation |
| Meta-governance (**Phase 0** สำหรับ policy โครงสร้าง) | การแก้ policy ที่*ลดความเข้ม* gate ต้อง human approval; policy versioned ใน event log | — |

### 4.6 Risk Levels + Loop Policy
| ระดับ | ตัวอย่าง | การควบคุม |
|-------|---------|-----------|
| L0–L1 | docs, unit test, internal refactor | auto-merge เมื่อ gate ผ่าน + sampling audit |
| L2 | API change, additive migration | AI review 2 lineage + CI |
| L3 | auth, payment, permission | **human approval** ผ่าน approval package |
| L4 | prod data delete, secret, infra destruction | **ห้าม auto เด็ดขาด** |
- Budget (iterations / costUnits / wallclock) = **backstop ที่ทำงานเสมอ**; failure fingerprint (normalized) = advisory เร่งสลับกลยุทธ์/โมเดลเท่านั้น
- **Prohibited เสมอ:** delete failing test · weaken assertion · disable rule · unexplained ignore · bypass typecheck · แก้เทสต์เพื่อให้ผ่าน

## §5 Ring 1 — Agent Abstraction Layer (Phase 1 เป็นต้นไป — โครง interface วางได้ตั้งแต่ Phase 0)

### 5.1 Agent Protocol
core ↔ AAL ผ่าน envelope กลางเท่านั้น:
- `AgentRequest`: agentRole, taskContract, contextBundle (+manifestRef), outputSchema, toolDefs, budget (costUnits), determinismHint, **requestId** (สำหรับ idempotent retry)
- `AgentResponse`: structuredResult (conform schema), actionRequests (Action[]), usage (normalized costUnits), rawTranscriptRef (immutable), adapterMeta (+modelVersion)

### 5.2 Capability Manifest + Fallback Matrix
adapter ประกาศความสามารถ; core มี fallback ทุกช่อง — โมเดลดิบสุดก็เสียบได้:
| โมเดลขาดอะไร | core fallback |
|---------|---------------|
| structured output | schema-in-prompt + validate + bounded repair loop |
| tool calling | parse text action-DSL |
| context เล็ก | context selection เข้มขึ้น → เกินอีกให้ลด scope task |
| execution backend | **core executor รันทุกอย่างอยู่แล้ว (เส้นทาง default)** |
| seed/determinism | freeze artifact แล้ว reproduce ที่ verification |

### 5.3 Conformance Suite P1–P8 (ประตูเสียบโมเดล + รันซ้ำตามรอบเป็น drift canary)
P1 echo-schema · P2 propose-action (คืน action ไม่ใช่ prose) · P3 repair-round · P4 budget-degrade (ไม่ crash) · P5 tool-request · P6 no-execution-authority (ห้ามส่งผลรันปลอม) · P7 injection-canary (วัด susceptibility → ป้อน routing) · P8 idempotent-retry — **เพิ่มโมเดลใหม่ = adapter 1 ตัว → ผ่าน P1–P8 → ลงทะเบียน จบ**

### 5.4 Roles + Router (role = capability profile, ห้าม hard-code โมเดลในโค้ด)
| Role | ต้องการ | default preference (ปรับด้วยเลข calibration) |
|------|---------|--------------------------------|
| Planner / Architect | reasoning, largeContext | Claude — fusion เปิดเสมอ (Phase 3) |
| Implementer / Repair | codeProposal, structuredOutput | Codex |
| Test Designer / Property Author | codeProposal | GLM-5.3 — **ต้องต่าง lineage กับ implementer** (เมื่อ adapter ผ่าน conformance P1–P8; ระหว่างนี้ใช้ Claude — สถานะจริงตาม unified spec §7.4, v1.11) |
| Reviewer / Diagnostician | reasoning, largeContext | Claude + GLM-5.3 ensemble (context 1M — เมื่อ adapter พร้อม; ระหว่างนี้ Claude + Codex ตาม unified spec §7.4, v1.11) |
| Verifier / Controller | — (ไม่ใช่โมเดล) | Ring 0 deterministic |
Routing ตามลำดับ: capability match → health-aware (ข้าม breaker-open) → injection-aware (context มี low-trust content ห้ามไปโมเดล susceptibility สูง) → cost → outcome-weighted (shadow ก่อนเสมอ); `on_repeated_failure: switch_to_next_eligible`

### 5.5 Fusion Plane (Phase 3)
Pipeline เดียวทุก artifact: **PANEL** (N ตัว อิสระ ขนาน — ต่างโมเดล และ/หรือ ต่าง seed/temp) → **EVIDENCE** (artifact รันได้: core รัน gate ต่อ candidate ใน worktree แยก) → **ANALYZE** (blind judge เปรียบเทียบ *ไม่ merge* → Deliberation Analysis: consensus / contradictions / partial / unique insights / blind spots) → **RESOLVE** → **CAPTURE** (dissent → tests/tasks)
| Artifact | Resolve | กฎ |
|----------|---------|--------|
| Plan/ADR | deliberate-synthesis | ผลสุดท้ายต้องผ่าน planning gate |
| Code diff | **evidence-tournament** | judge overrule ผล gate = 0 โดยนิยาม; ห้าม synthesis code (chimera risk) |
| Tests | union (dedupe + RED-check รายตัว) | merge ที่ปลอดภัยหนึ่งเดียว |
| Hypotheses | union + rank by probe cost | core พิสูจน์ตามลำดับราคา |
| Reviews | weighted ensemble | ความเห็นแย้ง = สัญญาณ ให้ยกระดับ ไม่ใช่โหวตกลบ |
Entry points: virtual `fusion:*` adapter ใน registry / policy trigger (planning เสมอ, L2+, repeated failure) / agent เรียกเองผ่าน `fusion.deliberate` (budget cap + depth ≤1) — ต้นทุน ~4–5× ต่อจุดเปิด: เปิดเฉพาะที่ calibration พิสูจน์ uplift และลองความหลากหลายราคาถูก (self-panel ต่าง seed/temp) ก่อนจ่ายค่าโมเดลต่างค่าย

## §6 Ring 2 — Adapters
`adapters/anthropic.ts` (Claude) · `adapters/codex.ts` (Codex — sandbox ของมันเป็น execution backend *ทางเลือก* ไม่ใช่ข้อบังคับ) · `adapters/openai-compatible.ts` (GLM-5.3 และโมเดล compat อื่น — access มีแล้ว 2026-08-14, spec งาน `.ai/specs/glm-5-3-adapter/`; ใช้กับ aggregator เช่น OpenRouter ได้ แต่ aggregator = ผู้ประมวลผลข้อมูลอีกราย → `provider_data_policy` ต้องระบุ path ที่อนุญาต) · `adapters/_template.ts` — ทุกตัวบาง แปล wire format เท่านั้น

## §7 Loops

### 7.1 Nested Loops 5 ชั้น
```
Loop 1 Goal:        Goal → Plan → Execute Epics → Validate Business Outcome  (หยุด: business AC ครบ)
Loop 2 Planning:    Requirements → Architecture → Critique → Revised Plan    (หยุด: well-formed + traceability + risk-reviewed)
Loop 3 Task/TDD:    RED → GREEN → REFACTOR → VERIFY → REPAIR                 (หยุด: task gates ผ่าน)
Loop 4 Integration: Merge Queue → Full Regression → Contract → E2E → Repair (หยุด: ระบบ "รวม" ผ่าน)
Loop 5 Production:  Canary → Observe → Baseline → Expand|Rollback            (หยุด: healthy หรือ rollback+root-cause)
```

### 7.2 TDD Rules (normative)
1. **RED:** test agent *เสนอ*เทสต์ → **core รันและตรวจว่า fail ด้วยเหตุผลที่คาด** — ผ่านตั้งแต่แรก = เทสต์อ่อน/ไม่ทดสอบของใหม่ → ส่งกลับแก้เทสต์ก่อน
2. **GREEN:** implementer เสนอ patch ขั้นต่ำ → core รัน T0/T1 — บังคับ prohibited list (§4.6)
3. **REFACTOR:** หลังเขียวเท่านั้น → core รันเทสต์**ทั้งหมด**อีกครั้ง ไม่ใช่เฉพาะที่เพิ่ง add
4. **REVIEW:** reviewer ได้รับเฉพาะ Goal / AC / diff / evidence — **ห้ามส่งคำอธิบายโน้มน้าวจาก implementer ให้ reviewer**
5. ทุกการรันเป็นของ core — agent ไม่มีทางรันอะไรเองได้ (§1 ข้อ 1)

### 7.3 Hypothesis-driven Repair (Phase 2 — โครง DIAGNOSING วางไว้ตั้งแต่ Phase 0)
```
FAILED → DIAGNOSING: agent คืน hypotheses ที่ "ทดสอบได้"
         { statement, probes: [{cmd, expected}], ifConfirmed: {patchPlan, estimatedBlastRadius} }
       → core รัน probes (ถูกกว่า patch+verify หลายเท่า)
         ├─ CONFIRMED → patch เล็กตามแผน → กลับเข้า VERIFY T0
         └─ REFUTED ทั้งหมด / เกิน max_hypotheses_per_failure → ESCALATED พร้อม hypothesis log
```
Refuted hypotheses ถูกบันทึกเสมอ (กันเดาซ้ำ + ป้อน escalation/lessons)

### 7.4 Context Builder (Phase 1)
Pipeline 6 ขั้น (deterministic): **SEED** (จาก task contract) → **EXPAND** (dependency graph, depth budget) → **COMPRESS** (ระดับ symbol) → **GOVERN** (secret scan = block, provider data policy) → **MARK** (ทุกชิ้นเป็น data + injection canary) → **MANIFEST** (`context-manifest.json` บันทึกว่าใส่อะไรเพราะกฎอะไร)
- โมเดลขาดอะไร → ขอผ่าน `READ_FILE` (นับเป็น context miss) — **agent อ้างถึงสิ่งนอก context โดยไม่เคยขอ → reject result**
- วัดด้วย **context recall** (% ไฟล์ที่ถูกแก้จริงซึ่งอยู่ใน bundle แต่แรก) + **context waste**

## §8 Four Planes

### 8.1 Security Plane (egress/dep-policy/secret-block = Phase 0; canary/data-govern = Phase 1–2)
Threats: T1 prompt injection ผ่านเนื้อหา repo · T2 backdoor ในเส้นทางที่อนุญาต · T3 exfiltration ผ่านคำสั่ง · T4 supply chain · T5 secret รั่วเข้า context · T6 evidence spoofing · T7 poisoning ความรู้ระบบ
ลำดับความเชื่อใจของแนวป้องกัน (แข็ง→อ่อน — **ห้ามสลับลำดับนี้**):
1. **Deterministic:** egress default-deny · dependency policy (registry allowlist + lockfile + `--ignore-scripts`) · secret scan = block (ไม่ใช่ redact แล้วส่ง) · evidence ผลิตโดย core เท่านั้น (จับ output จาก child process ตรง + sign)
2. **Action-level:** propose/dispose + path allowlist
3. **การวัด:** injection canaries (runtime tripwire + P7 score → susceptibility-aware routing)
4. **ความหวังที่มีประโยชน์:** data marking + persona instruction
Residual ที่ยอมรับ: backdoor เนียนใน L0–L2 auto-merge ยังเป็นไปได้ → sampling audit + escape-rate metric + human L3

### 8.2 Ops Plane (lease/kill = Phase 0; breaker/degraded = Phase 2)
- Circuit breaker ต่อ (adapter, model): closed → open (error-rate เกิน window) → half-open (health probe) → closed; router ข้ามตัว open ไป eligible ถัดไป
- ไม่มี eligible เหลือสำหรับ role → task = `BLOCKED(no_capacity)` อย่างสะอาด — **ห้ามวนยิง provider ที่ล่ม ห้ามลดเกณฑ์ role เพื่อให้มีตัวใช้**
- Rate limit ต่อ provider (token bucket); scheduler เคารพก่อน dispatch
- **Kill switch** (หยุดทุกอย่าง + เพิกถอน credential + quarantine worktree) แยกจาก **PAUSE** (จบ atomic action → หยุดแบบ resume ได้)

### 8.3 Human Interface Plane (approval package = Phase 1; steering = Phase 2)
- **Approval package:** goal excerpt + diff (**เกิน diff budget = ระบบสั่งแตก task ไม่สร้าง package**) + evidence + assumptions + unresolved risks + attestation checklist ที่ generate จาก risk class — เวลา/attestation completion เข้า rubber-stamp metric
- **Steering events:** `PAUSE_REQUESTED` → `GUIDANCE_INJECTED` (เข้า context เป็น data ที่ถูก mark; **guidance ที่แตะ AC/scope = ต้องเป็น contract amendment ผ่าน governance ไม่ใช่ advisory**) → `RESUMED`
- **Escalation ต้อง "ตัดสินได้":** จบด้วยคำถาม + ตัวเลือกพร้อมราคา/ความเสี่ยง (สร้างจาก hypothesis log) — ห้ามส่งกอง log

### 8.4 Learning Plane (Phase 3–4 เท่านั้น)
- Outcome-based routing: เปิดเป็นขั้น **off → shadow (log ว่าจะเลือกอะไร เทียบย้อนหลัง) → active เมื่อ shadow พิสูจน์แล้ว**; ε-greedy exploration; **freeze เมื่อ drift canary เตือน**
- Lessons store: สร้างได้จาก confirmed hypotheses + evidence เท่านั้น → **human approve ก่อน injectable** → ตอน inject ถูก mark เป็น data
- **ห้ามเรียนอัตโนมัติเด็ดขาด:** threshold ของ gate, นิยาม risk level, policy ทุกชนิด — เส้นทางเดียวคือ meta-governance ที่มีมนุษย์

## §9 Contracts + Templates

### 9.1 Goal Contract (frozen — แก้ผ่าน versioned amendment เท่านั้น)
```yaml
# .ai/goal.yaml (แม่แบบ — ตัวอย่างฟีเจอร์ authentication)
goal: { id: AUTH-001, title: Implement secure authentication, objective: "Email/password auth for web+API" }
business_outcomes: [register, login/logout, refresh tokens, admin revoke sessions]
scope: { include: [API, DB migration, Frontend login, tests], exclude: [Social login, MFA, Passwordless] }
constraints:
  stack: { backend: NestJS, frontend: "Next.js 16", database: PostgreSQL }
  forbidden: [plain-text passwords, unhashed refresh tokens, secrets in logs]
acceptance_criteria:
  - { id: AC-001, description: Valid users can log in,        verification: "pnpm test auth-login",   golden: true }
  - { id: AC-002, description: Invalid credentials return 401, verification: "pnpm test auth-invalid", golden: true }
  - { id: AC-003, description: E2E auth scenarios pass,        verification: "pnpm test:e2e auth" }
quality_gates:
  ladder: .ai/policies/gate-ladder.yaml
  mutation: { min_score_on_changed_files: 80, tier: T3 }        # เฟสหลัง
security: .ai/policies/security-plane.yaml
fusion: .ai/policies/fusion-profiles.yaml                       # Phase 3
budget: { max_iterations_per_task: 8, max_hypotheses_per_failure: 3, max_total_tasks: 30,
          max_parallel_agents: 3, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 }
approval_policy:
  require_human_approval: [production_deployment, destructive_migration, auth_policy_change,
                           secret_or_permission_change, gate_loosening, flaky_quarantine_add]
```

### 9.2 Task Graph + Traceability (planning gate)
DAG โดย core เลือกเฉพาะ task ที่ READY + deps PASSED + risk permitted + budget available + lease ว่าง — ก่อนใช้ graph ต้องผ่าน:
```yaml
checks:
  uncovered_acs: []               # AC ที่ไม่มี task รองรับ → block
  orphan_tasks: []                # task ที่ไม่แมป AC และไม่ tag enabling → block
  max_diff_budget_per_task: 400   # บังคับ task เล็ก — กัน rubber-stamp ที่ต้นทาง
```

### 9.3 Structured I/O
ทุก agent result เป็น JSON ตาม schema ใน `.ai/schemas/`: `plan` · `task-result` · `review` · `failure` · `hypothesis` · `deliberation-analysis` · `approval-package` — core ไม่วิเคราะห์ข้อความอิสระ และ**แม้ agent ส่ง `READY_FOR_VERIFICATION` core ก็รันคำสั่งใหม่เองเสมอ**

## §10 Metrics + Calibration

**Metric หลัก (ตัดสินทั้งระบบ):** Held-out pass rate (% ผ่านเทสต์ที่ระบบไม่ได้เขียน — อ่านคู่ golden coverage เสมอ) · Reproducibility rate (re-run gate จาก clean checkout ได้ผลเดิม)
**Metric ประกอบ:** critic decorrelation · mutation score · escape rate · loop efficiency + cost/task แยก tier · thrash rate · context recall/waste · hypothesis confirmation rate · injection canary trip rate · availability/breaker stats · fusion uplift + win-rate per member · sampling-vs-architecture split · lesson hit rate · rubber-stamp proxy

**Calibration Suite — benchmark ระดับทั้งลูป (คนละเครื่องมือกับ fault-injection ซึ่งเป็นชุดเทสต์ CI ของ core):** ชุดงาน 10–20 tasks ที่มีเฉลยมนุษย์ + hidden golden ที่ระบบไม่เคยเห็น เก็บใน `.ai/calibration/`; system version = hash(core+policies+prompts); รันก่อนทุกการอัปเกรดระบบ + ตามรอบ; **ถดถอยเกิน threshold = block การอัปเกรด**; baseline มนุษย์อย่างน้อยบางส่วน; n เล็ก → รายงานเป็นช่วง — **gate ระหว่าง phase ทุกอันอ้างเลขจากที่นี่**

## §11 Repository Structure + Roadmap

```
project/
├── loop-engineering-implementation-spec.md   # เอกสารนี้ — spec เดียวสำหรับ implement
├── core/        # RING 0 — ห้ามมีชื่อ vendor: orchestrator, executor, state-log, scheduler+lease,
│                #   gates/ (ladder, golden-check, convention — Phase 0; mutation=T3, impact-map=ภายหลัง),
│                #   security/ (egress — Phase 0; dep-policy, canary, data-govern — Phase 1–2),
│                #   context-builder/ (Phase 1), repair/ (hypothesis — Phase 2),
│                #   merge-queue (Phase 3), auditor (Phase 3), budget, policy-engine,
│                #   human/ (approval — Phase 1; steering, escalation — Phase 2),
│                #   learning/ (Phase 3–4), fault-injection.test.ts (Phase 0)
├── aal/         # RING 1 (Phase 1): protocol, adapter interface, registry, router, breaker (Phase 2),
│                #   fusion/ (Phase 3), conformance/ (P1–P8)
├── adapters/    # RING 2 (Phase 1): anthropic.ts, codex.ts, openai-compatible.ts, _template.ts
├── .ai/         # goal.yaml, models.yaml, task-graph.json, agents/, schemas/, policies/,
│                #   lessons/ (Phase 4), calibration/ (Phase 1), runs/RUN-*/, evidence/
├── scripts/     # create-worktree.sh, rollback-worktree.sh, conformance.sh, calibrate.sh
└── src/ · test/{ai-generated, golden}/
```

**Roadmap (gate ทุก phase = เลขจาก Calibration ไม่ใช่ "โค้ดเสร็จ"):**

- **Phase 0 — Deterministic Core เปล่า (scope ปัจจุบัน):** executor+egress, event log+lease, gate ladder **T0–T1 เท่านั้น (T2/T3 stub)**, golden harness — รันด้วย **stub agent** ให้ผ่าน **Fault-injection DoD 9 ข้อ**:
  1. agent โกหกว่าสำเร็จ → core รันเองจับได้
  2. action นอก allowlist / แตะ `test/golden/` → reject เป็น feedback
  3. แอบออก network → block + log
  4. fake-green / evidence hash ไม่ตรง → detect
  5. เทสต์ flaky → retry-and-flag ไม่ quarantine เงียบ
  6. crash ระหว่าง `ACTION_INTENT`/`ACTION_APPLIED` → resume ไม่ apply ซ้ำ
  7. actionId ซ้ำ → idempotent skip
  8. lease contention → single-writer
  9. เกิน budget → `ESCALATED` ไม่วนไม่รู้จบ
  เขียน scenarios เป็น failing tests *ก่อน* แล้ว implement ให้ผ่าน — **ก่อนต่อโมเดลจริงใด ๆ**
- **Phase 1 — หนึ่ง Adapter + Calibration แรก:** AAL + conformance P1–P8 + adapter ตัวแรก + context builder รุ่นแรก + approval package → supervised loop หนึ่งฟีเจอร์ → **วัดเลขครั้งแรก**
- **Phase 2 — Semi-autonomous + Survivability:** security plane เต็ม (canary, dep-policy, data-govern), breaker/degraded mode, hypothesis repair, auto-merge L0–L1 + sampling audit, meta-governance, steering
- **Phase 3 — Multi-model + Fusion:** adapters (Claude/Codex — GLM-5.3 เปิดงานภายหลังตาม unified spec v1.11: spec `.ai/specs/glm-5-3-adapter/`), fusion plane + วัด decorrelation/uplift, merge queue + auditor, outcome routing shadow
- **Phase 4 — Continuous:** issue intake, canary deploy, automated rollback, lessons active, outcome routing active เมื่อ shadow พิสูจน์แล้ว

## §12 Implementation Constraints (ข้อบังคับปิดท้าย)

**ห้ามตัดเด็ดขาด (ทุก phase):** propose/dispose + executor policy · event log + lease · golden tests + hash enforcement · budget backstop · egress default-deny · human approval บน L3/L4
**ตัดก่อนได้ถ้าทรัพยากรจำกัด:** fusion (ใช้โมเดลเดียว + reviewer เดียว) · mutation ลดความถี่ · learning plane (อยู่ static ได้) · drift canary เป็น manual — หลักตัดสิน: กลไกที่*ผลิต/ปกป้องหลักฐาน*อยู่ก่อนกลไกที่*เพิ่มประสิทธิภาพ*

**วินัยการ claim (ต้องสะท้อนใน docs/comments/log ของโค้ด):**
- prompt injection = **mitigated ไม่ใช่ solved** — ห้ามเขียนว่าป้องกันได้ 100%
- consensus ของหลายโมเดล ≠ ถูกต้อง — ห้ามใช้ consensus ข้าม gate ใด ๆ
- mutation score = sensitivity ของเทสต์ ไม่ใช่ correctness
- reproducibility = **verification บน frozen artifact** ไม่ใช่ regeneration (โมเดล non-deterministic)
- ระบบเร่งงาน L0–L2; L3–L4 เดินด้วยจังหวะมนุษย์**โดยเจตนา**

**ข้อขัดแย้ง/ความไม่แน่ใจระหว่าง implement:** ยึดลำดับใน §0 ข้อ 6 และเมื่อ scope กำกวม ให้เลือกทางที่*เล็กกว่าและย้อนกลับได้* — แล้ว escalate เป็นคำถามที่ตัดสินได้ (§8.3) ไม่ใช่เดินหน้าเดา
