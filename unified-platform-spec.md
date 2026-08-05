# Autonomous Engineering Platform on Claude — Unified Implementation Spec

> **v1.9 (Unified) — source of truth หลักสำหรับ implement** (กฎเรื่องเอกสารสเปกอื่น/derived spec ดู §0.1) · v1.1 = interactive surface เป็น 100% CLI parity ผ่าน PTY (INV-17, §4.1) · v1.2 = sync สถานะส่งมอบ Phase 0–2 + rescope Phase 3 · v1.3 = sync สถานะส่งมอบ Phase 3 + rescope Phase 4 (ดูด backlog ค้างจาก Phase 3 เข้า scope + เพิ่ม DoD; GLM-5.2 ยังไม่มี access — เลื่อนต่อแบบมีเงื่อนไข ดู §14, §17) · v1.4 = sync สถานะส่งมอบ Phase 4 + เพิ่ม **Phase 5 — SDD Integration** (spec ↔ Goal Contract binding: generator/schema/provenance/task-graph/evidence-backflow — ดู §14, §17) · v1.5 = Phase 5 Stage 2 ส่งมอบ (`goal.schema.json` + typed contract เต็ม, retire root `.ai/goal.yaml` — ดู §17) · v1.6 = Phase 5 Stage 3 ส่งมอบ (provenance sha256-anchor + drift detection advisory + Console read-only display — ดู §14, §17) · v1.7 = Phase 5 Stage 4 ส่งมอบ (task graph + planning gate + multi-task scheduler แบบ sequential — ดู §14, §17) · v1.8 = ปิดช่องว่างระหว่าง §6.1 กับ §9.4 — SEED ของแต่ละรอบสะสม path ที่ agent เคยขอผ่าน `READ_FILE` (ไม่ใช่ roadmap stage ใหม่ — เป็นการแก้ให้ implementation ตรงสัญญาเดิมของ §6.1; ดู §9.4, §17) · v1.9 = provenance gate ฝั่ง write แยก "สร้างไฟล์ใหม่" ออกจาก "เขียนทับไฟล์ที่โมเดลไม่เคยเห็น" — `WRITE_FILE` ไป path ที่ไม่มี entry ในขอบ worktree ผ่าน gate ได้ ส่วนการเขียนทับไฟล์ที่มีอยู่แต่ไม่เคยอยู่ใน context ยัง reject ทั้งก้อนเหมือนเดิม (ดู §9.4, §17)
> **ภาษา:** prose อธิบายเป็นไทย · artifact ทุกชนิด (schema, YAML, code, prompt, ชื่อไฟล์, endpoint) เป็นอังกฤษ — ห้ามแปล artifact เป็นไทย
> **บริบท:** แพลตฟอร์มรันบนเครื่องเจ้าของบัญชี **Claude Max 20x subscription** (auth ผ่าน `claude login` — ไม่ใช่ API plan) · single-operator

---

## §0 กติกาการ Implement (อ่านก่อนทุกอย่าง)

1. **สเปกเดียว:** ไฟล์นี้เป็น source of truth หลักสำหรับภาพรวม/roadmap ของงานนี้ — **ข้อยกเว้นเดียว:** `.ai/specs/platform-phase*/{requirements,design,tasks}.md` เป็น derived spec ของแต่ละ phase (ผลิตตาม spec workflow ปกติของ repo นี้ ตาม CLAUDE.md — ดู pointer ที่ §17) ให้อ่านประกอบกัน ไม่ใช่แข่งกัน · ไฟล์สเปก/blueprint อื่นนอกเหนือจากสองแหล่งนี้ที่พบใน repo ให้ถือว่าล้าสมัยและไม่นำมาใช้ (กันคำสั่งขัดกัน)
2. **Normative:** "ต้อง/ห้าม" = ข้อบังคับ · "ควร" = default ที่เปลี่ยนได้เมื่อมีเหตุผลและบันทึกใน `docs/DEVIATIONS.md` · คอลัมน์ "ข้อจำกัด/ห้าม claim" ในตาราง = สิ่งที่ห้ามอ้างเกินจริง ต้องสะท้อนใน docs/comments ของโค้ด
3. **สร้างทีละ Phase ตาม §14 เท่านั้น** — ชื่อที่ปรากฏในเอกสาร ≠ ต้องสร้างตอนนี้ ทุกส่วนมี phase กำกับ · "เสร็จ" ของแต่ละเฟส = ผ่าน DoD (fault-injection + calibration + security checklist) ไม่ใช่ "เขียนโค้ดครบ"
4. **เขียนเทสต์ก่อน implement** รวมถึงตัว core เอง (RED→GREEN ของ control plane)
5. **ห้ามหลอมรวมสองโหมดการรัน** (§4) — Interactive และ Autonomous ใช้ substrate ร่วมกันแต่มี execution model คนละแบบโดยเจตนา
6. เมื่อสเปกขัดกับพฤติกรรมจริงของ Claude Code/SDK เวอร์ชันที่ติดตั้ง: เชื่อของจริง → ตรวจเอกสารทางการของ Claude Code / Agent SDK → บันทึก `docs/DEVIATIONS.md` — ห้ามละเมิด Invariants (§2)
7. ลำดับเมื่อข้อความขัดกัน: **Invariants §2 → templates §11 → section อื่น → ถามมนุษย์** · เมื่อ scope กำกวมให้เลือกทางที่*เล็กกว่าและย้อนกลับได้* แล้ว escalate เป็นคำถามที่ตัดสินได้ (§10.3)
8. ห้ามคัดลอกโค้ดจากโปรเจกต์ภายนอก (เหตุผลด้าน license) — เขียนใหม่จากสเปกนี้

---

## §1 แพลตฟอร์มคืออะไร + การตัดสินใจหลอมรวม

### 1.1 ภาพเดียว

แพลตฟอร์ม self-hosted หนึ่งตัว รันบนเครื่องผู้ใช้ ทำสองอย่างบน **substrate เดียว** (Claude Code + credentials + โควตา Max 20x):

- **Interactive mode** — **binary `claude` ตัวจริงรันผ่าน PTY แล้วสตรีมขึ้น terminal บนเว็บ = 100% CLI parity** (ทุก slash command, keybinding, plan/vim mode, การ render, และฟีเจอร์ใหม่ที่ CLI จะออกในอนาคต ได้มาฟรีเพราะเป็น CLI ตัวเดียวกัน) · Claude Code ลงมือเอง ใต้ permission system, อนุมัติราย tool-call **ผ่าน prompt ของ CLI เองใน terminal** · สำหรับงานที่มนุษย์นำ · Console เสริม structured views (Sessions/Usage) เป็น superset ทับบน CLI
- **Autonomous mode** — ระบบ engineering แบบ propose/dispose: โมเดลเสนอ structured action, deterministic core ลงมือในsandbox + ตรวจด้วย golden tests, มนุษย์อนุมัติที่ระดับ task/risk · สำหรับงานที่รันเองไม่มีคนเฝ้า

ทั้งสองโหมด**ใช้ร่วมกัน**: ความจุ Claude, การนับโควตา, session storage, config governance และ Console เป็น operator surface เดียว — **แต่ approval แยกตามโหมด** (§4.1: interactive อนุมัติแบบ CLI-native ใน terminal, autonomous อนุมัติผ่าน approval package บน Console)

### 1.2 การตัดสินใจหลอมรวม (เหตุผลที่เอกสารนี้มีรูปแบบนี้)

การหลอมรวมสองระบบเป็นเนื้อเดียว **คงสองสิ่งไว้เป็นสถาปัตยกรรมภายใน** เพราะการละลายทิ้งจะทำลาย safety properties:

| สิ่งที่คงไว้ | ทำไมละลายไม่ได้ |
|---|---|
| **propose/dispose invariant** (โมเดลไม่เคยลงมือ/ตัดสินว่าตัวเองสำเร็จ ใน autonomous mode) | คือ safety model ทั้งหมดของ autonomous engineering — ถ้าให้ Claude Code execute เองในโหมดนี้ = ไม่มีทางรับประกัน COMPLETED บน frozen artifact |
| **`core/` ปลอด vendor name** (Ring 0 ห้ามมีคำว่า claude/anthropic/codex/glm — CI ตรวจ) | ทำให้ core testable ด้วย stub agent + รักษา **quota-survivability**: เมื่อโควตา Claude หมด router หลบไป lineage อื่นได้ (ดู §5.4) — Claude-only จะเสีย escape hatch นี้ |

**การตัดสินใจ vendor abstraction:** คงไว้ (ไม่ใช่ Claude-only) เพราะต้นทุนการเก็บต่ำมากแต่ให้ quota-survivability ที่จำเป็นบนแผน subscription ที่มีเพดาน — Claude เป็น **primary/default adapter** ส่วน Codex/GLM เป็น fallback ที่เปิดใช้ตาม phase · **หากผู้ใช้ตัดสินใจไป Claude-only จริง** ให้บันทึกใน DEVIATIONS.md และยอมรับผลว่าเมื่อโควตา Max หมด autonomous loop จะ `BLOCKED(no_capacity)` จนกว่า window reset (ไม่มี fallback)

### 1.3 Out of Scope — ห้ามสร้าง

- ระบบผู้ใช้หลายคน / เชิญผู้ใช้ / roles — แพลตฟอร์มเป็น **single-operator** ของเจ้าของบัญชี (เงื่อนไข ToS แผนส่วนบุคคล) — ใช้กับทั้งสองโหมด
- การแสดง/export/เก็บ OAuth token หรือไฟล์ credentials ของ Claude ในทุกรูปแบบ
- การ bridge subscription auth ไปยังเครื่องมือ/ผลิตภัณฑ์อื่นนอก Claude Code และ Agent SDK
- Messaging gateway ในตัว (แจ้งเตือนภายนอกใช้ hooks/handlers ยิงออก) · Mobile app แยก · แก้ไข session/event history (append-only)
- UI ต้องมี disclaimer ว่าเป็นเครื่องมือ third-party ไม่ใช่ผลิตภัณฑ์ของ Anthropic

---

## §2 Invariants (INV-1 … INV-17) — ห้ามละเมิดในทุก phase

รวมกฎเหล็กของทั้งสองระบบเป็นชุดเดียว จัดกลุ่มตามหน้าที่:

**Autonomous safety (จากหลัก propose/dispose):**
- **INV-1** โมเดลเสนอ — **core เป็นผู้รันและผู้วัด** (autonomous mode); ใน interactive mode Claude Code execute เองได้แต่ใต้ permission gates เท่านั้น
- **INV-2** `COMPLETED` มาจาก core + หลักฐานที่ reproduce ได้บน frozen artifact เท่านั้น — ไม่ใช่คำรายงานของ agent · AI ห้ามเปลี่ยน VERIFYING→COMPLETED
- **INV-3** **ทุกเนื้อหาที่เข้า context ของ agent = untrusted data** (ไฟล์ repo, dependency, ผลรอบก่อน, lessons ของระบบเอง)
- **INV-4** งานที่กู้คืนไม่ได้ (L4) ต้องมีมนุษย์เสมอ ไม่ว่า gate เขียวแค่ไหน
- **INV-5** ระบบต้อง **degrade อย่างคุมได้** เมื่อชิ้นส่วนพัง (provider ล่ม/โควตาหมด/process ตาย/โมเดล drift) — ห้าม thrash เงียบ
- **INV-6** ความเชื่อใจต้อง **วัดได้และมีขอบเขต** ผ่าน Calibration (§12) ไม่ใช่ความรู้สึก

**Architecture boundary:**
- **INV-7** `core/` (Ring 0) **ห้ามมีคำว่า claude/codex/glm/anthropic/openai** — คุยกับโมเดลผ่าน AAL (Ring 1) เห็นแค่ `AgentRequest`/`AgentResponse` (CI ตรวจ)
- **INV-8** Ring 2 adapters เป็นตัวแปล wire format ล้วน — ห้าม business logic; เพิ่มโมเดล = adapter 1 ตัว + ผ่าน conformance §7.3 ห้ามแตะ Ring 0/1
- **INV-9** สองโหมด (§4) ห้ามหลอมรวม execution model; autonomous mode **ห้ามใช้ tool execution ของ Claude Code** เป็นกลไก (รวมถึงห้ามใช้ `bypassPermissions` เป็นกลไกของ core)

**State & evidence:**
- **INV-10** State ทั้งหมด = **append-only event log** (source of truth); `state.json`/projection rebuild ได้เสมอ · หลักฐานทุกชิ้น immutable + content-addressed ผูก commit hash + env hash + gate-config hash · **core เป็นผู้ผลิต evidence เท่านั้น**
- **INV-11** No shadow state ของ Claude Code: Console อ่าน config/sessions ของ Claude Code สด ไม่เก็บสำเนา; แพลตฟอร์มเก็บได้เฉพาะ domain data ของตัวเอง (event log, jobs, alerts, audit, index) ที่ rebuild ได้

**Substrate (Claude Max 20x):**
- **INV-12** **Auth ผ่าน credential chain ของ Claude Code เท่านั้น** — แพลตฟอร์มไม่แตะ/ไม่เก็บ/ไม่ proxy token (§5.1)
- **INV-13** **Quota-aware:** ทุกจุดที่ spawn run แสดงสถานะโควตาโดยประมาณ; automation มี quota guards; ตัวเลขเชิงเงินทุกที่ติดป้าย "มูลค่าเทียบราคา API — ไม่ใช่บิลจริง"

**Security & governance:**
- **INV-14** **Egress default-deny** ทุก `RUN_COMMAND` ใน autonomous mode · **secret scan = block** (ไม่ใช่ redact แล้วส่ง) · **Redaction** ครอบทุก response/log ของ Console + path ของ credential files
- **INV-15** **Fail-closed:** Console bind non-loopback โดยไม่มี auth provider → ปฏิเสธการ start (§13.1); `--insecure` ห้ามเป็น default · **Single-operator:** ไม่มี endpoint สร้างผู้ใช้เพิ่ม
- **INV-16** **Governance บังคับ:** การแก้ policy/threshold/risk-level ที่*ลดความเข้ม* + flaky quarantine + gate loosening ต้อง human approval + versioned ใน event log · **Prohibited เสมอ:** delete failing test · weaken assertion · disable rule · bypass typecheck · แก้เทสต์เพื่อให้ผ่าน · **ห้ามเรียน policy อัตโนมัติ**

**Interactive parity:**
- **INV-17** Interactive surface = **binary `claude` ตัวจริงผ่าน PTY** (100% CLI parity — นิยามเต็ม §4.1); ห้ามใช้ SDK-reimplementation เป็นทางหลักของ interactive · interactive approval เป็น **CLI-native ใน terminal** ไม่ใช่ web dialog · PTY เป็นของ backend (attach/detach) · **remote ต้องผ่าน auth ทุกกรณีรวม `--insecure`** (surface เสี่ยงสูงสุด)

---

## §3 สถาปัตยกรรม: 3 Rings × 4 Planes + Console

```
        Goal Contract (frozen) ← Human / Product Owner
                     │
   ┌─ SECURITY ─┬─ OPS ───┬─ HUMAN ──────┬─ LEARNING ─┐   ← 4 planes ตัดขวาง
╔══╪════════════╪═════════╪══════════════╪════════════╡
║R2│ P7 inject  │ health  │      —       │ outcome    │  ADAPTERS (swappable)
║  │ probe      │ probe   │              │ telemetry  │  anthropic(primary)/codex/glm
╠══╪════════════╪═════════╪══════════════╪════════════╡
║R1│ suscept.-  │ breaker │      —       │ shadow     │  AAL: protocol·router·
║  │ aware route│ failover│              │ routing    │  conformance + FUSION
╠══╪════════════╪═════════╪══════════════╪════════════╡
║R0│ egress·dep │ lease   │ approval·    │ lessons    │  CORE: executor·state·
║  │ policy·    │ resume  │ steering·    │ (curated)· │  gates·audit
║  │ canary·gov │ sched   │ escalate     │ calibration│  เจ้าของ "ความจริง"
╚══╧════════════╧═════════╧══════════════╧════════════╝
              │                    ▲ Human Plane API (local, vendor-neutral)
              ▼                    │
   ┌──────────────────────────────┴─────────────────────────┐
   │ CONSOLE (Claude-specific operator surface — web SPA)    │
   │ • Interactive Terminal — real `claude` CLI (100% parity)│
   │ • Approvals: autonomous task/risk (F-Loop)             │
   │   └ interactive approvals = ใน terminal (CLI-native)   │
   │ • Governance: Settings·Permissions·Hooks·MCP·Memory    │
   │ • Observability: Projects·Sessions·Usage&Quota·Loop    │
   └────────────────────┬────────────────────────────────────┘
                        ▼
   Claude Code CLI + credentials (`claude login`, Max 20x)
   ← substrate เดียวที่ Console, adapter, และ interactive mode แตะร่วมกัน
```

**กฎการพึ่งพา (บังคับเข้มงวด — INV-7/8/9):**
- Ring 0 ไม่รู้จัก Ring 2 และไม่รู้จัก Console · Ring 2 เป็นตัวแปล wire format ล้วน · Planes อยู่ใน Ring 0 เป็นหลัก (+hook ใน Ring 1)
- **Console เป็น client ของ Ring 0 ผ่าน Human Plane API เท่านั้น** — ไม่ own state ของ core (INV-11); Console รู้จัก Claude (มันคือ operator surface ของ substrate) แต่ **โค้ด Console ไม่อยู่ใน `core/`**
- Claude capacity เข้าระบบผ่าน **`adapters/anthropic.ts`** (autonomous, SDK `query()`) และผ่าน **Console F-Term (PTY → `claude` binary ตัวจริง)** (interactive) — สองเส้นทางนี้แยกกัน (INV-9/INV-17)

---

## §4 สองโหมดการรัน (หัวใจของการหลอมรวม)

| มิติ | Interactive mode | Autonomous mode |
|---|---|---|
| กลไก | **PTY spawn `claude` ตัวจริง → xterm.js** (100% CLI parity) | Agent SDK `query()` แบบ propose-only |
| ใครลงมือ | Claude Code CLI ตัวจริง (ทุก tool/slash command) ใต้ permission | **Core executor เท่านั้น**; โมเดลเสนอ Action |
| ใครอนุมัติ | **prompt ของ CLI เองใน terminal** (เหมือน CLI เป๊ะ) | มนุษย์ ที่ระดับ task/risk (approval package) — L3/L4 |
| ใครวัดว่าสำเร็จ | มนุษย์ (ดูผลเอง) | Core + golden tests + reproduce บน frozen artifact (INV-2) |
| Context ของโมเดล | settings/CLAUDE.md/skills/hooks ของเครื่อง (ปกติของ Claude Code) | Context Builder ของ core เท่านั้น (§9.4) — config เครื่องห้ามรั่ว |
| Source of truth | Claude Code JSONL (SDK อ่าน) — Console อ่านสด | Event log + evidence store ของ core (INV-10) |
| เหมาะกับ | สำรวจ, debug, งานครั้งเดียวที่มนุษย์นำ | ฟีเจอร์ที่รันเองยาว, TDD loop, งานขนาน |
| Vendor | Claude เท่านั้น (คือ Claude Code) | vendor-neutral — Claude primary + fallback |

### 4.1 CLI Parity Decision (INV-17) — Interactive surface ต้องเป็น binary จริง

**ข้อกำหนด:** interactive + observability ของ Console ต้อง **เท่ากับ Claude Code CLI 100%** โดยเป็นเวอร์ชันเว็บ · **ทางเดียวที่ทำได้คือรัน `claude` binary จริงหลัง PTY** — ประกอบ chat UI จาก SDK เองไม่มีวันเป็น 100% เพราะต้องไล่สร้าง slash command/keybinding/render/ฟีเจอร์ใหม่เองตลอด นี่เป็น **INV-17: interactive surface = real binary via PTY; ห้ามใช้ SDK-reimplementation เป็นทางหลักของ interactive**
- **สิ่งที่ได้ฟรีจากการรัน binary จริง:** ทุก slash command (`/model /clear /compact /context /cost /status /doctor /mcp /agents /hooks /permissions /resume` ฯลฯ), plan mode, vim mode, extended thinking display, keybindings, และ**ฟีเจอร์ใหม่ทุกอย่างที่ CLI จะออก** — โดยไม่ต้องแก้ Console
- **Terminal = shell session ที่ cwd ของโปรเจกต์ที่เลือก** (ให้รัน `claude`, `claude --resume`, `claude mcp …`, `claude config …`, `claude doctor` ได้ครบ = observability parity) · ตัวเลือกลดความเสี่ยง: โหมด "claude-only" ที่ PTY spawn `claude` ตรง ๆ (รัน arbitrary shell ไม่ได้) เป็น default, "full shell" เป็น opt-in
- **Approval ใน interactive = prompt ของ CLI เอง** (render ใน terminal) ไม่ใช่ web dialog — เพราะนั่นคือ parity; ส่วน SDK `canUseTool` **สงวนไว้ให้ autonomous adapter เท่านั้น** ไม่ใช้กับ interactive
- **PTY เป็นของ backend ไม่ผูกกับ tab:** ปิด browser แล้ว session ยังอยู่ กลับมา attach ต่อได้; หลาย terminal พร้อมกัน (หลายโปรเจกต์) ได้; reap สะอาดเมื่อปิดจริง
- **Cross-platform:** POSIX ผ่าน pty; **Windows ผ่าน ConPTY** (node-pty รองรับ) — verify พฤติกรรมจริงต่อเวอร์ชัน
- **นัยความปลอดภัย (ยกระดับ):** terminal บนเว็บ = การเข้าถึง shell/tool execution ของเครื่องเต็มรูปแบบ = surface เสี่ยงสูงสุด → fail-closed gate (INV-15) + **ห้าม expose ผ่าน remote โดยไม่มี auth เด็ดขาดทุกกรณี รวม `--insecure`** + single-operator + audit ทุก PTY spawn + rate-limit
- **Observability parity:** terminal ให้ทุก observability command ของ CLI แบบ native + Console เสริม structured views (Sessions browser, Usage graphs, Effective settings) เป็น **superset** ที่ดีกว่า text output ของ CLI

**กฎเชื่อมสองโหมด:**
- โหมดเดียวกันไม่มีทาง execute ข้ามกลไกของอีกโหมด (INV-9) — autonomous run ที่ต้องการ Claude เรียกผ่าน adapter ที่ `allowedTools: []` (§5.2) เท่านั้น ไม่มีทางไปเรียก Claude Code execution ของ interactive
- **โควตาใช้ร่วมกัน:** ทั้งสองโหมดกินโควตา Max เดียวกัน — Quota HUD (§8) นับรวมและ automation ต้อง yield ให้ interactive (§10.2 guards)
- **Governance ใช้ร่วมกัน:** Permissions/deny rules ที่ตั้งผ่าน Console ปกป้อง `test/golden/**` และ `worktrees/` จาก interactive session มนุษย์ด้วย (interactive อยู่นอกอำนาจ core executor — ต้องกันที่ชั้น permission)
- **Approval แยกตามโหมด (parity requirement):** interactive อนุมัติ**ใน terminal ด้วย prompt ของ CLI เอง** (เหมือน CLI ทุกอย่าง); autonomous approval packages ไปที่ Console F-Loop — สองที่ คนละกลไก คนละ level โดยเจตนา (การรวม interactive approval ขึ้น web dialog จะทำลาย 100% parity — INV-17)

---

## §5 Substrate: Claude Max 20x

### 5.1 Auth (INV-12)

- ผู้ใช้ login ด้วย `claude login` (บัญชี Max 20x) — ทั้ง Console (interactive) และ `adapters/anthropic.ts` (autonomous ผ่าน SDK) ใช้ credential เดียวกันอัตโนมัติ ไม่ต้องมี API key
- ลำดับ precedence โดยประมาณ: cloud creds → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → subscription login — **ถ้า `ANTHROPIC_API_KEY` อยู่ใน env มันชนะ subscription เงียบ ๆ** (= จ่ายเงิน API ทั้งที่มี Max) → Console ต้องตรวจและเตือนแดง (§8 F-Auth), ชี้ตัวแปรที่ต้อง unset, **ห้ามลบให้เองเงียบ ๆ** — การตรวจนี้ครอบ run ของ autonomous ด้วยโดยอัตโนมัติ
- Service/container ที่ไม่มี interactive login: ทางการคือ `claude setup-token` → token อายุ 1 ปี ตั้ง `CLAUDE_CODE_OAUTH_TOKEN` (scope inference) — แพลตฟอร์มแสดง "วิธีทำ" เท่านั้น ห้ามรับ/เก็บ/แสดงค่า token

### 5.2 `adapters/anthropic.ts` — primary adapter (Ring 2, Phase 1)

จุดเดียวที่โค้ด autonomous รู้จัก Claude:
1. ห่อ `@anthropic-ai/claude-agent-sdk` (pin version); บิลเข้า Max ผ่าน credential chain อัตโนมัติ
2. **ปิด execution ทั้งหมด:** `allowedTools: []`, ไม่ต่อ MCP, ไม่ส่ง tool definitions ของ Claude Code — ทุก action เป็นข้อเสนอใน `structuredResult` ให้ core (INV-1/INV-9); เงื่อนไขผ่าน conformance **P6**
3. **ตัดขาดจาก config เครื่อง:** `settingSources: []` เสมอ + system prompt ของ core เอง (ไม่ใช้ preset `claude_code`) — กัน CLAUDE.md/settings/skills/hooks ของ Console รั่วเข้า context (ละเมิด Context Builder §9.4 + MARK-as-data)
4. **cwd = โฟลเดอร์คงที่** (`.ai/runs/agent-sessions/`) ไม่ใช่ worktree ของ task — adapter ไม่ต้องเข้าถึงไฟล์ (context มากับ contextBundle) + รวม transcript ไว้ bucket เดียว
5. **Idempotency:** map `requestId` ของ AAL → retry ปลอดภัย (P8)
6. **Usage:** แปลง usage ของ SDK → `costUnits` + ส่ง raw usage เข้า telemetry
7. **Transcript เป็นหลักฐานเสริม:** copy เข้า evidence store เป็น `rawTranscriptRef` (immutable) เพราะ `~/.claude/projects/` อาจถูก prune ตาม retention
8. **Tag:** `tagSession(id, "loop:<runId>")` ให้ Console กรอง/ซ่อนใน Sessions ได้
9. **429/limit → สัญญาณ breaker** ของ AAL; ห้าม retry-วนเอง (INV-5)
10. run ของ adapter ทั้งหมด = **non-interactive usage** (นโยบาย credit ที่กำลังเปลี่ยน — §5.3)

### 5.3 โควตา Max 20x (INV-13)

- สองชั้น: **rolling 5-hour window** (เริ่มนับจาก prompt แรก) + **weekly caps สองตัว** (รวมทุกโมเดล และเฉพาะ Sonnet) reset ตามเวลาประจำบัญชี · pool ใช้ร่วมระหว่าง chat กับ Claude Code · **ทั้งสองโหมดของแพลตฟอร์มกินจาก pool เดียวกันนี้**
- Anthropic ไม่เผยแพร่เพดานตายตัวและปรับได้ — **ห้าม hardcode เพดาน**
- ตัวเลขทางการ: `/usage` และ Settings > Usage — ไม่มี API สาธารณะเสถียร → แพลตฟอร์ม **ประเมินจาก transcript ในเครื่อง** (จัดกลุ่ม window 5 ชม. จาก timestamp + สะสม weekly ตามรอบ reset ที่ผู้ใช้กรอก) · ติดป้าย "ค่าประมาณ" + deep-link แหล่งทางการ + calibration ให้ผู้ใช้กรอก % จริง
- Usage credits (จ่ายต่อที่ API rate หลังชนเพดาน) เป็น optional ฝั่งบัญชี — ถ้าเปิด ความหมาย alert เปลี่ยนจาก "จะโดนบล็อก" เป็น "จะเริ่มมีค่าใช้จ่าย"
- นโยบาย non-interactive usage (SDK/headless บน subscription) อยู่ระหว่างเปลี่ยน (มีแผน monthly credit แยก) → **ติดป้ายทุก run ว่า interactive/non-interactive ตั้งแต่วันแรก** + ออกแบบ Quota page ให้เพิ่ม pool แยกได้ภายหลัง · ทบทวนประกาศทางการก่อนเริ่ม Phase 1 และก่อนเปิด Fusion (§7.5)

### 5.4 Quota-survivability (ทำไม vendor abstraction คุ้มที่จะเก็บ)

Autonomous mode ผูกกับโควตา Max — loop ยาว/ขนาน (`max_parallel_agents`) และ **Fusion (~4–5× ต่อจุดเปิด)** ชนเพดานเร็ว · design รองรับผ่าน §10.2: 429/limit → breaker open → router ไป lineage อื่น (Codex/GLM) → ไม่มี eligible = `BLOCKED(no_capacity)` อย่างสะอาด · **ลำดับทางออกเมื่อชนเพดาน:** router กระจายไป fallback lineage → เปิด Usage credits → พิจารณา API key เฉพาะเส้นทาง Claude เมื่องานโตเกินการใช้ส่วนบุคคล (ต้องย้ายตาม ToS)

---

## §6 Ring 0 — Deterministic Core (Phase 0)

### 6.1 Action DSL + Executor

```jsonc
type Action =
  | { "type": "WRITE_FILE",   "path": "src/x.ts", "contentRef": "blob://..." }
  | { "type": "APPLY_PATCH",  "diffRef": "blob://..." }
  | { "type": "RUN_COMMAND",  "cmd": "pnpm test x", "cwd": "worktrees/T-1", "network": "none" }
  | { "type": "READ_FILE",    "path": "src/y.ts" }          // core เติมผลรอบถัดไป + นับ context miss
  | { "type": "REQUEST_TOOL", "name": "fusion.deliberate", "args": {} };   // tool handlers ตาม phase
```
Executor บังคับตอนรัน:
- **Path allowlist ตาม role** (least privilege): Planner อ่านอย่างเดียว · Test agent แก้เฉพาะ `test/ai-generated/` · Implementer แก้ `src/` + `test/ai-generated/` ใน worktree ตัวเอง · ทุก role: `test/golden/` = read-only
- **Egress default-deny (INV-14):** ทุก `RUN_COMMAND` ใน sandbox ที่ network ปิด เว้นแต่ประกาศ `network: allowlist:<n>` + policy อนุญาต (เช่น `package_install` → registry ที่กำหนด + `--ignore-scripts`)
- **Idempotency:** ทุก action มี `actionId`; บันทึก `ACTION_INTENT` ก่อนรัน, `ACTION_APPLIED` (พร้อม result hash) หลังรัน
- **ข้อเสนอนอกสิทธิ์ → reject เป็น structured feedback** ไม่ crash ไม่เงียบ

### 6.2 Event Log + Lease
- Source of truth = **append-only event log** (INV-10) — SQLite (WAL) เพราะ lease ต้องการ atomic compare-and-set; export `events.jsonl` เพื่อ audit; `state.json` = projection rebuild ได้
- **Lease ต่อ task:** `LEASE_CLAIMED {taskId, ownerId, leaseUntil}` + heartbeat + TTL → single-writer
- **Crash recovery:** replay log → เทียบ worktree กับ `ACTION_APPLIED` ล่าสุด (content hash) → ตรง = ทำต่อ / ไม่ตรง = rollback ไป checkpoint / เจอ `INTENT` ไม่มี `APPLIED` = ตรวจ hash ว่า apply จริงไหม แล้ว apply หรือ skip

### 6.3 State Machine (โครงสถานะ; บาง transition เปิดใช้เฟสหลัง)
```
PROPOSED → ANALYZING → READY → IMPLEMENTING → VERIFYING
                                   ├─ FAILED → DIAGNOSING → REPAIRING → VERIFYING
                                   └─ PASSED → REVIEWING
                                                 ├─ CHANGES_REQUESTED → REPAIRING
                                                 └─ APPROVED → MERGE_QUEUED → AUDITED → COMPLETED
พิเศษ: BLOCKED · ESCALATED · CANCELLED · ROLLED_BACK · QUARANTINED · PAUSED
```
- **AI ห้ามเปลี่ยน VERIFYING→COMPLETED** (INV-2) · ทุก transition = event · `PAUSED` เข้าได้จากทุก active state ผ่าน Human Plane (จบ atomic action ก่อนหยุด)

### 6.4 Gate Ladder

| Tier | รันเมื่อ | ประกอบด้วย | Phase |
|------|---------|-----------|-------|
| T0 fast | ทุก iteration | lint, typecheck, targeted tests | **Phase 0** — "targeted" เริ่มจาก fallback = full unit; `impact-map` = optimization เฟสหลัง |
| T1 standard | เมื่อ agent อ้าง GREEN | full unit+integration, convention gate, golden ของ AC ที่แตะ | **Phase 0** |
| T2 full | ก่อน REVIEWING | build, scoped E2E, security scan, full golden | stub ใน Phase 0 (คืนสถานะ "ยังไม่เปิดใช้" ชัด) |
| T3 heavy | ที่ merge queue | full regression, mutation (ไฟล์ที่แก้), screenshot/a11y | stub ใน Phase 0 |

- **Gate-config hash เข้า evidence ทุกครั้ง** (INV-10) — ผู้อ่านรู้เสมอว่า "ผ่าน" คือ tier ไหน config ใด
- **Flaky quarantine = ลด gate → ต้องผ่าน governance** (INV-16)

### 6.5 Correctness Mechanisms

| กลไก (phase) | ทำอะไร | ห้าม claim เกิน |
|------|--------|----------------|
| Golden tests (**Phase 0**) — `test/golden/`: read-only ทุก agent + `_MANIFEST.sha256` + CI ตรวจ hash (ไม่ตรง = block merge); มนุษย์เขียนตอน freeze | ฐานความจริงอิสระ — COMPLETED ต้องผ่านเทสต์ที่ลูปเขียนไม่ได้ | เชื่อได้เท่าที่ golden ครอบ — วัด golden coverage คู่เสมอ |
| **Fault-injection suite** (**Phase 0**) — เทสต์ CI ของ core | ป้อน agent โกหก/เกินสิทธิ์/fake-green/flaky/crash แล้ว assert core จับได้-ปฏิเสธ-กู้คืนถูก (DoD §14) | ทดสอบ control plane — คนละหน้าที่กับ Calibration ที่วัดคุณภาพผลลัพธ์ |
| Convention gate (**Phase 0**, hard) | บังคับ convention/forbidden-pattern เป็นสิ่งตรวจได้ กัน training prior ผิด | ครอบเฉพาะ pattern ที่เขียน rule ได้ |
| Mutation gate (T3 — เฟสหลัง) | วัด sensitivity ของเทสต์เป็นตัวเลข | วัด "จับการเปลี่ยนได้ไหม" ไม่ใช่ "ถูกต้อง" |
| Property/Adversarial (ต่าง lineage — Phase 3) | จับรูที่ example test พลาด | "อิสระ" คือสมมติฐาน — ต้องวัด decorrelation |
| Merge queue + auto-bisect + contract tests (Phase 3) | serialize integration → attribution ชัด | บรรเทา semantic conflict ไม่ใช่กำจัด |
| **Out-of-band auditor** (Phase 3) — process runtime แยก | สุ่ม COMPLETED มา re-run gate จาก clean checkout — *ตรวจจับ* ไม่ฉีด fault | reproduce ที่ verification บน frozen artifact ไม่ใช่ generation |
| Meta-governance (**Phase 0** สำหรับ policy โครงสร้าง) | การแก้ policy ที่ลดความเข้ม gate ต้อง human approval; versioned ใน event log | — |

### 6.6 Risk Levels + Loop Policy

| ระดับ | ตัวอย่าง | การควบคุม |
|-------|---------|-----------|
| L0–L1 | docs, unit test, internal refactor | auto-merge เมื่อ gate ผ่าน + sampling audit |
| L2 | API change, additive migration | AI review 2 lineage + CI |
| L3 | auth, payment, permission | **human approval** ผ่าน approval package (Console) |
| L4 | prod data delete, secret, infra destruction | **ห้าม auto เด็ดขาด** (INV-4) |

- Budget (iterations/costUnits/wallclock) = **backstop ที่ทำงานเสมอ**; failure fingerprint = advisory เร่งสลับกลยุทธ์/โมเดล
- **Prohibited เสมอ:** ตาม INV-16

---

## §7 Ring 1 AAL + Ring 2 Adapters (Phase 1; interface วางได้ตั้งแต่ Phase 0)

### 7.1 Agent Protocol
core ↔ AAL ผ่าน envelope กลาง:
- `AgentRequest`: agentRole, taskContract, contextBundle (+manifestRef), outputSchema, toolDefs, budget (costUnits), determinismHint, **requestId**
- `AgentResponse`: structuredResult (conform schema), actionRequests (Action[]), usage (normalized costUnits), rawTranscriptRef (immutable), adapterMeta (+modelVersion)

### 7.2 Capability Manifest + Fallback Matrix
adapter ประกาศความสามารถ; core มี fallback ทุกช่อง:

| โมเดลขาดอะไร | core fallback |
|---------|---------------|
| structured output | schema-in-prompt + validate + bounded repair loop |
| tool calling | parse text action-DSL |
| context เล็ก | context selection เข้มขึ้น → เกินอีกให้ลด scope task |
| execution backend | **core executor รันทุกอย่างอยู่แล้ว (default)** |
| seed/determinism | freeze artifact แล้ว reproduce ที่ verification |

### 7.3 Conformance P1–P8 (ประตูเสียบโมเดล + drift canary)
P1 echo-schema · P2 propose-action · P3 repair-round · P4 budget-degrade · P5 tool-request · P6 no-execution-authority · P7 injection-canary (→ susceptibility routing) · P8 idempotent-retry — **เพิ่มโมเดล = adapter → ผ่าน P1–P8 → ลงทะเบียน จบ**

### 7.4 Roles + Router (role = capability profile — INV-8, ห้าม hard-code โมเดล)

| Role | ต้องการ | default preference (ปรับด้วยเลข calibration) |
|------|---------|--------------------------------|
| Planner/Architect | reasoning, largeContext | Claude — fusion เปิดเสมอ (trigger อัตโนมัติของ role นี้ = §14 Phase 4; Phase 3 ส่งมอบเฉพาะ seam `fusion.deliberate` ที่ agent เรียกเอง) |
| Implementer/Repair | codeProposal, structuredOutput | Codex |
| Test Designer/Property | codeProposal | Claude — **ต้องต่าง lineage กับ implementer** (default เดิม GLM-5.2 — deferred ต่อ ยังไม่มี access (v1.3); กลับมาเมื่อ adapter พร้อมตามเงื่อนไข §14/§17) |
| Reviewer/Diagnostician | reasoning, largeContext | Claude + Codex ensemble (เดิม GLM-5.2 — deferred ต่อ ยังไม่มี access, v1.3) |
| Verifier/Controller | — (ไม่ใช่โมเดล) | Ring 0 deterministic |

Routing: capability match → health-aware (ข้าม breaker-open + **quota-aware ผ่าน probe §5.4**) → injection-aware (low-trust content ห้ามไปโมเดล susceptibility สูง) → cost → outcome-weighted (shadow ก่อนเสมอ); `on_repeated_failure: switch_to_next_eligible`

### 7.5 Fusion Plane (Phase 3)
Pipeline เดียวทุก artifact: **PANEL** (N ตัวอิสระขนาน — ต่างโมเดล และ/หรือ ต่าง seed/temp) → **EVIDENCE** (core รัน gate ต่อ candidate ใน worktree แยก) → **ANALYZE** (blind judge เปรียบเทียบ *ไม่ merge* → Deliberation: consensus/contradictions/partial/unique/blind spots) → **RESOLVE** → **CAPTURE** (dissent → tests/tasks)

| Artifact | Resolve | กฎ |
|----------|---------|--------|
| Plan/ADR | deliberate-synthesis | ผลสุดท้ายต้องผ่าน planning gate |
| Code diff | **evidence-tournament** | judge overrule ผล gate = 0; ห้าม synthesis code (chimera risk) |
| Tests | union (dedupe + RED-check รายตัว) | merge ปลอดภัยหนึ่งเดียว |
| Hypotheses | union + rank by probe cost | core พิสูจน์ตามลำดับราคา |
| Reviews | weighted ensemble | ความเห็นแย้ง = สัญญาณยกระดับ ไม่ใช่โหวตกลบ |

Entry: virtual `fusion:*` adapter / policy trigger (planning เสมอ, L2+, repeated failure) / agent เรียกเอง `fusion.deliberate` (budget cap + depth ≤1) — **~4–5× ต่อจุดเปิด** (กระทบโควตา §5.4): เปิดเฉพาะที่ calibration พิสูจน์ uplift + ลองความหลากหลายราคาถูก (self-panel ต่าง seed/temp) ก่อนจ่ายค่าโมเดลต่างค่าย

### 7.6 Adapters (Ring 2 — phase ตาม §14)
`adapters/anthropic.ts` (Claude — primary, §5.2 — Phase 1, ส่งมอบแล้ว) · `adapters/codex.ts` (Codex — Phase 3; sandbox เป็น execution backend *ทางเลือก*) · `adapters/openai-compatible.ts` (GLM-5.2 + compat — **deferred จนกว่าจะมี access** (v1.3 ยังไม่มี — ดู §14/§17); aggregator เช่น OpenRouter = ผู้ประมวลผลข้อมูลอีกราย → `provider_data_policy` ต้องระบุ path ที่อนุญาต) · `adapters/_template.ts` — ทุกตัวบาง แปล wire format เท่านั้น

---

## §8 Console — Operator Surface (Claude-specific)

Console คือ SPA เดียวที่เป็นทั้ง interactive workspace, governance surface และหน้าต่างเข้า autonomous loop · รันด้วยคำสั่ง `platform console` (default `127.0.0.1:9119`; flags `--port/--host/--no-open/--insecure`) · **ทุกความสามารถบน UI มี REST endpoint รองรับ** (Console เป็น client หนึ่ง)

หลักการ Console: **Deep-linkable** (`?project=` ทุกหน้า, `/terminal?project=…&resume=<id>` เปิด session เก่าใน F-Term) · **Background ops** (งาน >5s = action + poll `GET /api/actions/{id}/status`) · **Apply-timing สื่อสารทุก save** · **Write safety** (validate schema → optimistic concurrency mtime/hash → atomic rename)

**สถานะส่งมอบ (v1.2):** แถวที่ Phase ≤ 2 ส่งมอบแล้วทั้งหมด (Phase 2 merged เข้า develop ผ่าน PR #45) · Phase 3–4 = งานอนาคตตาม roadmap §14 (ตาราง §14 เป็น authoritative เมื่อขัดกัน — §0.3)

| ID | หน้า | หน้าที่ | Priority | Phase |
|---|---|---|---|---|
| F-Status | Status | เวอร์ชัน CLI, doctor ย่อ, active runs (ทั้งสองโหมด), การ์ด auth + quota ย่อ | P0 | 1 |
| F-Proj | Projects | registry จาก `~/.claude/projects/` + register cwd; **banner "loop-managed" เมื่อพบ `.ai/goal.yaml`** | P0 | 1 |
| F-Sess | Sessions | list/read/rename/tag/fork/export/prune ผ่าน SDK; **filter `loop:*`** แยก transcript ของ adapter; full-text search (FTS5) | P0 | 1(+search 2) |
| **F-Term** | **Terminal (interactive — 100% CLI parity)** | **PTY spawn `claude` ตัวจริง → xterm.js** (§4.1): ทุก slash command/keybinding/plan+vim mode ได้ฟรี · shell ที่ cwd โปรเจกต์ (default "claude-only", opt-in "full shell") · **PTY เป็นของ backend** (attach/detach, หลาย terminal, reap สะอาด) · resume ผ่าน `claude --resume`/`--continue` · ConPTY บน Windows · **remote ต้องผ่าน auth เสมอ** + audit ทุก spawn | **P0** | 1 |
| F-Chat | Chat (SDK — enhanced view, **ไม่ใช่ parity**) | **optional**: `query()` streaming + tool cards + web `canUseTool` approvals + fork — surface แบบการ์ดสำหรับคนที่ชอบมากกว่า TUI ดิบ · **ต้องติดป้ายว่าไม่ครบเท่า CLI** (slash commands/plan mode ไม่มี) · SDK ที่เหลือสงวนให้ autonomous adapter | P3 | 4 |
| F-Set | Settings | multi-scope editor (user/project/local; managed read-only) + **Scope Picker บังคับ** + **Effective View** (`resolveSettings` + provenance) + schema validate | P0 | 2 |
| F-Perm | Permissions | builder `allow/deny/ask` + autocomplete + merged view ข้าม scope + **simulator** + **ติดตั้ง deny rules ปกป้อง `test/golden/**` + `worktrees/`** (§4) | P1 | 2 |
| F-Auth | Auth & Env | active auth method ต่อโปรเจกต์ + **เตือนแดงเมื่อ env shadow subscription** (§5.1) + `env` redacted + คู่มือ setup-token (ไม่รับ token) | P0 | 1(ตรวจ)+2 |
| F-Mem | Memory | editor CLAUDE.md ทุกระดับ + preview + คำอธิบาย guidance vs enforcement | P1 | 2 |
| F-MCP | MCP | จัดการ 3 ชั้น (user/project/managed-ro) + add stdio/HTTP + test connection + enable/disable + OAuth | P1 | 2 |
| F-Hook | Hooks | **builder/validator ทุก event + 5 handler types** (TUI `/hooks` เป็น read-only — Console คือที่แก้) + scope + `disableAllHooks` + **consent gate** | P1 | 2 |
| F-Sub | Subagents/Commands | CRUD (Markdown+frontmatter) + test run | P2 | 2 |
| F-Skill | Skills & Plugins | จัดการ skills + `enabledPlugins` + marketplace | P2 | 2 |
| F-Usage | Usage & Quota | **Quota HUD** (window 5h + weekly all/Sonnet + reset + Opus/Sonnet breakdown) + indexer ราย วัน/โปรเจกต์/โมเดล + calibration + **alerts** (threshold, interactive/non-interactive label) | **P0** | 1(ย่อ)+2(เต็ม) |
| F-Act | Activity Feed | one-click ติดตั้ง/ถอน HTTP hooks → `/api/events/ingest` → WS; hooks ต้อง **fail-open** + timeout สั้น + ถอน one-click | P2 | 2 |
| F-Loop | **Loop Console** | อ่าน autonomous loop read-only ผ่าน Human Plane API (§10.3): task graph + state machine + calibration ล่าสุด + **approval packages** → ปุ่ม Approve/Reject/Steer/Kill (ยิงกลับผ่าน API) — Console เป็น client ไม่ own state (INV-11) | P0(สำหรับ autonomous) | 3 |
| F-Sched | Scheduler | **เฉพาะ start/stop กระบวนการ loop หรือรันสคริปต์ opaque** (`calibrate.sh`) + quota guards — **ห้ามทำ task scheduling/lease** (นั่นเป็นของ core §6.2) | P2 | 3 |
| F-Sys | System & Retention | doctor เต็ม, update, host stats, retention (`cleanupPeriodDays`, ลบ transcript + คำเตือนข้อมูลอ่อนไหว) | P2 | 2 |

**Approval แยกตามโหมด (parity):** interactive → prompt ของ CLI ใน F-Term (CLI-native, ไม่ใช่ web dialog); autonomous → approval package ใน F-Loop (§10.3) — คนละกลไกโดยเจตนา (INV-17)

---

## §9 Loops + TDD + Context + Repair (autonomous mode)

### 9.1 Nested Loops 5 ชั้น
```
Loop 1 Goal:        Goal → Plan → Execute Epics → Validate Business Outcome  (หยุด: business AC ครบ)
Loop 2 Planning:    Requirements → Architecture → Critique → Revised Plan    (หยุด: well-formed + traceability + risk-reviewed)
Loop 3 Task/TDD:    RED → GREEN → REFACTOR → VERIFY → REPAIR                 (หยุด: task gates ผ่าน)
Loop 4 Integration: Merge Queue → Full Regression → Contract → E2E → Repair (หยุด: ระบบ "รวม" ผ่าน)
Loop 5 Production:  Canary → Observe → Baseline → Expand|Rollback            (หยุด: healthy หรือ rollback+root-cause)
```

### 9.2 TDD Rules (normative)
1. **RED:** test agent เสนอเทสต์ → **core รันและตรวจว่า fail ด้วยเหตุผลที่คาด** — ผ่านตั้งแต่แรก = เทสต์อ่อน → ส่งกลับแก้เทสต์ก่อน
2. **GREEN:** implementer เสนอ patch ขั้นต่ำ → core รัน T0/T1 — บังคับ prohibited list (INV-16)
3. **REFACTOR:** หลังเขียวเท่านั้น → core รันเทสต์**ทั้งหมด**อีกครั้ง
4. **REVIEW:** reviewer ได้รับเฉพาะ Goal/AC/diff/evidence — **ห้ามส่งคำอธิบายโน้มน้าวจาก implementer**
5. ทุกการรันเป็นของ core (INV-1)

### 9.3 Hypothesis-driven Repair (Phase 2 — โครง DIAGNOSING วางตั้งแต่ Phase 0)
```
FAILED → DIAGNOSING: agent คืน hypotheses ที่ทดสอบได้
         { statement, probes: [{cmd, expected}], ifConfirmed: {patchPlan, estimatedBlastRadius} }
       → core รัน probes (ถูกกว่า patch+verify)
         ├─ CONFIRMED → patch เล็กตามแผน → กลับเข้า VERIFY T0
         └─ REFUTED ทั้งหมด / เกิน max_hypotheses → ESCALATED พร้อม hypothesis log
```
Refuted hypotheses บันทึกเสมอ (กันเดาซ้ำ + ป้อน escalation/lessons)

### 9.4 Context Builder (Phase 1)
Pipeline 6 ขั้น (deterministic): **SEED** → **EXPAND** (dependency graph, depth budget) → **COMPRESS** (symbol level) → **GOVERN** (secret scan = block, provider data policy) → **MARK** (ทุกชิ้นเป็น data + injection canary) → **MANIFEST** (`context-manifest.json`)
- โมเดลขาดอะไร → ขอผ่าน `READ_FILE` (นับ context miss) — **อ้างถึงสิ่งที่ "มีอยู่จริง" นอก context โดยไม่เคยขอ → reject result** (v1.9) — เกณฑ์คือ *ของนั้นมีอยู่ให้ทับไหม* ไม่ใช่ *อยู่ใน manifest ไหม*: `WRITE_FILE` ไป path ที่ไม่มี entry ในขอบ worktree = **การสร้างไฟล์ใหม่ในพื้นที่ที่ role เขียนได้อยู่แล้ว ไม่ใช่การอ้างถึงสิ่งนอก context** จึงผ่าน gate ได้โดยไม่ต้อง `READ_FILE` ก่อนหนึ่งรอบ ส่วนการเขียนทับไฟล์ที่มีอยู่แต่ไม่เคยอยู่ใน bundle และไม่เคยถูกขอ ยัง reject ทั้งผลลัพธ์เป็น `context_violation` ทุกตัวอักษรเดิม (all-or-nothing ไม่เปลี่ยน) · การจำแนกเป็น **fail-closed**: นับว่า "ไม่มีอยู่" เฉพาะเมื่อ path normalize เป็น worktree-relative ได้ **และ** `lstat` ตอบ `ENOENT` เท่านั้น — absolute, `..`, symlink (รวม dangling — `lstat` ไม่ตาม link จึงเห็น entry ที่ `existsSync` จะพลาด), directory, หรือ stat error อื่นใด ถือว่า "มีอยู่" ทั้งหมด · การผ่อนนี้ครอบเฉพาะ `WRITE_FILE` และ **ไม่แตะด่านที่ปกป้องจริง**: `checkWrite` (write root ของ role, `test/golden/`, frozen RED), `resolveContained` และ `checkMutationPaths` (`regular_or_absent`) ยังตัดสินทุกการเขียนหลังผ่าน gate นี้ · supersede Phase-1 REQ-5.4 บางส่วน (ดู §17 v1.9)
- **SEED ของแต่ละรอบ = `seedPaths` ของ composition ∪ path ที่ role เคยขอผ่าน `READ_FILE` ในรอบก่อนหน้า** (v1.8) — normalize ให้อยู่ในขอบ worktree ก่อนเสมอ (path ที่ absolute หรือหลุดด้วย `..` ถูกคัดออก) + cap ที่ 20 path ล่าสุดโดย `seedPaths` ไม่ถูกไล่ออก · นี่คือกลไกที่ทำให้สัญญาของ §6.1 (`core เติมผลรอบถัดไป`) เป็นจริง — ก่อน v1.8 ผล `READ_FILE` ถูกเก็บเข้า evidence แล้วไม่เคยกลับถึงโมเดล · **เนื้อถูกอ่านใหม่จาก worktree ทุกรอบ ไม่ cache ข้ามรอบ** bundle จึงสะท้อนสถานะล่าสุดเสมอโดยโครงสร้าง · **containment บังคับที่ขอบการอ่านจริงของ builder ไม่ใช่แค่ที่ caller** — ทุก path ที่จะถูกอ่านไม่ว่ามาจาก SEED หรือ EXPAND ต้อง resolve แล้วยังอยู่ใต้ worktree (`realpathSync` เทียบ root + เปิดไฟล์ด้วย `O_NOFOLLOW`) มิฉะนั้นถูกข้ามโดยไม่ล้ม bundle; ด่าน normalize ฝั่ง caller เหลือสถานะ defense-in-depth ไม่ใช่ด่านเดียว
- **GOVERN เจอ secret แยกสามทางตามที่มาของ piece** (v1.8): piece จาก `seedPaths` = ล้ม bundle ทั้งก้อน + escalate `secret_in_context` (เดิมทุกประการ; ถ้า path อยู่ทั้งใน seed และในชุดสะสม ให้ seed ชนะ) · piece จาก path ที่สะสม = block รายชิ้น (`ERROR {reason: 'accumulated_secret_evicted'}`) แล้ว build ใหม่ **วนต่อจนสำเร็จหรือชนเพดาน** (bounded drain — เพดานคือจำนวน path ใน **หน้าต่าง cap** ของรอบนั้น `min(ชุดสะสม, 20)` ไม่ใช่ชุดสะสมทั้งหมด เพราะ evict แต่ละครั้งทำให้หน้าต่างเลื่อนดูด path เก่ากว่าเข้ามา; แต่ละรอบถอดอย่างน้อยหนึ่ง path ลูปจึงจบเสมอ และการชนเพดานเป็น fail-safe คือ escalate ไม่ใช่ leak — ต้องมี false positive เกิน 20 ไฟล์ในรอบเดียวจึงจะชน; retry ครั้งเดียวไม่พอเพราะ hit เกาะกลุ่มตามหัวข้อ hit ที่สองในรอบเดียวกันจะปิด run ถาวร) · **piece ที่ถูกข้ามทุกกรณี (secret ทาง EXPAND และ containment) ต้องคืน signal ให้ caller ใส่ลง `CONTEXT_BUILT`** ในรูปเดียวกับ `lessonsBlocked`/`planBlocked` โดยมีแค่ path/จำนวน/เหตุผล **ห้ามมีเนื้อไฟล์ใน payload** (block ไม่ใช่ redact ยังบังคับ) · piece ที่เข้ามาเพราะ EXPAND ล้วน (ไม่อยู่ใน `seedPaths` ที่ส่งเข้า build รอบนั้น) = **ข้าม piece นั้นรายชิ้นใน GOVERN ไม่ throw ไม่ล้ม bundle** เพราะ valve eviction ไม่ครอบทางนี้ (ไฟล์ที่โมเดลไม่เคยขอ ไม่มีอะไรให้ evict) ปล่อยไว้จะจบทั้ง run · การแยกสามทางบังคับสองชั้นตามข้อมูลที่แต่ละชั้นมี: builder รู้ว่าไฟล์อยู่ใน `seedPaths` หรือไม่ จึงรับผิดชอบทาง EXPAND ส่วน caller รู้ `seedPaths`/ชุดสะสมแยกกันจึงรับผิดชอบสองทางแรก · **ตัวตัดสินของ builder ต้องเป็น membership ห้ามใช้ inclusion reason** — `visit()` กันเดินซ้ำด้วย `collected.has()` ทำให้ literal seed ที่ถูก import จาก seed ตัวก่อนหน้าค้าง `reason='expand:depth-1'` ถาวร ตัดสินด้วย reason จะ skip secret ใน seed จริงแบบเงียบ = กลับด้าน REQ-7.3 โดยไม่ตั้งใจ — **block ไม่ใช่ redact ทั้งสามทาง** (INV-14) · supersede Phase-1 REQ-7.3 บางส่วน, precedent = Phase-4 REQ-12.3 (ดู §17 v1.8)
- วัดด้วย **context recall** + **context waste** · **config ของเครื่อง (settings/CLAUDE.md/hooks ของ Console) ห้ามเข้า pipeline นี้** (§5.2 ข้อ 3) · **หมายเหตุ v1.8:** `context waste` สูงขึ้นโดยกลไกหลังเปิดการสะสม (path ที่สะสมไว้แต่รอบนั้นไม่ได้แตะนับเป็น unused ทุกตัว) — **ไม่ใช่ regression**

---

## §10 Four Planes

### 10.1 Security Plane (egress/dep-policy/secret-block = Phase 0; canary/data-govern = Phase 1–2)
Threats: T1 prompt injection ผ่าน repo · T2 backdoor ในเส้นทางที่อนุญาต · T3 exfiltration ผ่านคำสั่ง · T4 supply chain · T5 secret รั่วเข้า context · T6 evidence spoofing · T7 poisoning ความรู้ระบบ
ลำดับความเชื่อใจแนวป้องกัน (แข็ง→อ่อน — **ห้ามสลับ**):
1. **Deterministic:** egress default-deny · dependency policy (registry allowlist + lockfile + `--ignore-scripts`) · secret scan = block · evidence ผลิตโดย core เท่านั้น (จับ output จาก child process ตรง + sign)
2. **Action-level:** propose/dispose + path allowlist
3. **การวัด:** injection canaries (runtime tripwire + P7 → susceptibility-aware routing)
4. **ความหวังที่มีประโยชน์:** data marking + persona instruction
Residual: backdoor เนียนใน L0–L2 auto-merge ยังเป็นไปได้ → sampling audit + escape-rate metric + human L3

**Console remote security (INV-15) — ชั้นเสริมของ substrate:** เมื่อเปิด Console ให้เข้าจากภายนอก ทั้งหมดต้องผ่าน gate §13; นี่คือคนละชั้นกับ execution security ของ core แต่รวมอยู่ใน security plane เดียว

### 10.2 Ops Plane (lease/kill = Phase 0; breaker/degraded = Phase 2)
- Circuit breaker ต่อ (adapter, model): closed → open (error-rate เกิน window) → half-open (probe) → closed; router ข้าม open ไป eligible ถัดไป
- **Quota-aware (§5.4):** สำหรับ Claude adapter, probe อ่านสถานะโควตา → เกิน threshold = unhealthy → หลบก่อนชนเพดานจริง
- ไม่มี eligible เหลือ → `BLOCKED(no_capacity)` อย่างสะอาด — **ห้ามวนยิง provider ที่ล่ม/หมดโควตา ห้ามลดเกณฑ์ role**
- Rate limit ต่อ provider (token bucket); scheduler เคารพก่อน dispatch
- **Kill switch** (หยุดทุกอย่าง + เพิกถอน credential + quarantine worktree) แยกจาก **PAUSE** (จบ atomic action → resume ได้) · ทั้งคู่เรียกได้จาก F-Loop ผ่าน Human Plane API
- **Automation guards (INV-13):** F-Sched และ scheduled autonomous run ต้อง yield ให้ interactive — ไม่ start เมื่อ window/weekly เกิน threshold (default 85%) + option "เลื่อนหลัง reset" + default model งานอัตโนมัติ = Sonnet (เก็บ Opus ให้ interactive)

### 10.3 Human Interface Plane (approval package = Phase 1; steering = Phase 2)
- **Human Plane API (local, vendor-neutral):** HTTP localhost + token file — `GET /approvals` · `POST /approvals/{id}` · `POST /steering/{pause·inject·resume}` · `POST /kill` · `GET /events?since=` · **F-Loop ของ Console เป็น client** (API ไม่รู้จักว่า client คือ Console → ไม่ละเมิด INV-7)
- **Approval package:** goal excerpt + diff (**เกิน diff budget = ระบบสั่งแตก task ไม่สร้าง package**) + evidence + assumptions + unresolved risks + attestation checklist (generate จาก risk class) — เวลา/completion เข้า rubber-stamp metric
- **Steering:** `PAUSE_REQUESTED` → `GUIDANCE_INJECTED` (เข้า context เป็น data ที่ mark; **guidance ที่แตะ AC/scope = ต้องเป็น contract amendment ผ่าน governance ไม่ใช่ advisory**) → `RESUMED`
- **Escalation ต้องตัดสินได้:** จบด้วยคำถาม + ตัวเลือกพร้อมราคา/ความเสี่ยง (จาก hypothesis log) — ห้ามส่งกอง log

### 10.4 Learning Plane (Phase 3–4 เท่านั้น)
- Outcome routing: **off → shadow (log ว่าจะเลือกอะไร เทียบย้อนหลัง) → active เมื่อ shadow พิสูจน์**; ε-greedy; **freeze เมื่อ drift canary เตือน**
- Lessons: จาก confirmed hypotheses + evidence เท่านั้น → **human approve ก่อน injectable** → ตอน inject ถูก mark เป็น data
- **ห้ามเรียน policy อัตโนมัติเด็ดขาด** (INV-16): threshold, risk level, policy ทุกชนิด — เส้นทางเดียวคือ meta-governance ที่มีมนุษย์

---

## §11 Contracts + Templates

### 11.1 Goal Contract (frozen — แก้ผ่าน versioned amendment)

Canonical path = `.ai/specs/<feature>/goal.yaml` ต่อ feature (draft จาก generator =
`goal.draft.yaml` โฟลเดอร์เดียวกัน; **promotion = human rename draft → `goal.yaml`
เมื่ออนุมัติ** — Console loop-managed banner และ loop CLI อ่านเฉพาะ `goal.yaml`).
Root `.ai/goal.yaml` เดิม **retired** ตั้งแต่ v1.5 (ไม่เคยมีไฟล์จริง — Phase 5 Stage 2).
Shape ถูกบังคับสองชั้น: `goal.schema.json` (`.ai/schemas/`, strict — unknown key =
reject ที่ edge) + `freezeContract` (semantics + cross-field + hash).

```yaml
# .ai/specs/<feature>/goal.yaml
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
  fusion: .ai/policies/fusion-profiles.yaml                     # Phase 3
budget: { max_iterations_per_task: 8, max_hypotheses_per_failure: 3, max_total_tasks: 30,
          max_parallel_agents: 3, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 }
risk: L2            # L0..L4; ไม่ใส่ = default L2 ตอน freeze, ค่าอื่น = reject (v1.5)
approval_policy:
  require_human_approval: [production_deployment, destructive_migration, auth_policy_change,
                           secret_or_permission_change, gate_loosening, flaky_quarantine_add]
provenance:                                            # optional, generator-stamped — read-only (v1.6)
  spec_path: .ai/specs/auth/requirements.md             # repo-root-relative; metadata only, never resolved
  requirements_commit: a1b2c3d                          # git HEAD at generate time, or "unknown"; metadata only
  requirements_sha256: "3f5c9e...b7"                    # sha256 of requirements.md bytes — the drift anchor
  generated_at: "2026-07-12T00:00:00Z"
```

### 11.2 Task Graph + Traceability (planning gate)
DAG โดย core เลือกเฉพาะ task ที่ READY + deps PASSED + risk permitted + budget available + lease ว่าง — ก่อนใช้ต้องผ่าน:
```yaml
checks:
  uncovered_acs: []               # AC ที่ไม่มี task รองรับ → block
  orphan_tasks: []                # task ที่ไม่แมป AC และไม่ tag enabling → block
  max_diff_budget_per_task: 400   # บังคับ task เล็ก — กัน rubber-stamp ที่ต้นทาง
```

### 11.3 Structured I/O
ทุก agent result เป็น JSON ตาม schema ใน `.ai/schemas/`: `plan` · `task-result` · `review` · `failure` · `hypothesis` · `deliberation-analysis` · `approval-package` — core ไม่วิเคราะห์ข้อความอิสระ และ**แม้ agent ส่ง `READY_FOR_VERIFICATION` core ก็รันคำสั่งใหม่เองเสมอ** (INV-1)

---

## §12 Metrics + Calibration

**Metric หลัก (ตัดสินทั้งระบบ):** Held-out pass rate (% ผ่านเทสต์ที่ระบบไม่ได้เขียน — อ่านคู่ golden coverage) · Reproducibility rate (re-run gate จาก clean checkout ได้ผลเดิม)
**Metric ประกอบ:** critic decorrelation · mutation score · escape rate · loop efficiency + cost/task แยก tier · thrash rate · context recall/waste · hypothesis confirmation · injection canary trip · availability/breaker · fusion uplift + win-rate · lesson hit rate · rubber-stamp proxy · **quota surprise rate + billing-correctness** (จาก substrate)

**Calibration Suite (คนละเครื่องมือกับ fault-injection):** ชุดงาน 10–20 tasks + เฉลยมนุษย์ + hidden golden ที่ระบบไม่เคยเห็น ใน `.ai/calibration/`; system version = hash(core+policies+prompts); รันก่อนทุกอัปเกรด + ตามรอบ; **ถดถอยเกิน threshold = block อัปเกรด**; n เล็ก → รายงานเป็นช่วง — **gate ระหว่าง phase ทุกอันอ้างเลขจากที่นี่**

---

## §13 Security ของ Console (remote access — INV-15)

### 13.1 Auth Gate
```
bind ∈ {127.0.0.1, ::1, localhost}                → gate OFF
bind อื่น และไม่มี --insecure                      → gate ON
gate ON + ไม่มี provider                           → ปฏิเสธการ start + error ชี้วิธีแก้
รัน interactive + ไม่มี provider                    → เสนอ setup ทันที (basic/OIDC)
รัน non-interactive (service/Docker/CI)             → fail-closed เสมอ
--insecure                                          → ปิด gate + พิมพ์คำเตือน
```

### 13.2 Providers (pluggable; ผู้ใช้เดียว — INV-15)
Basic (scrypt hash + stateless HMAC session token + rate-limit + generic 401; signing secret คงที่) · OIDC (discovery + public PKCE S256 + verify pin iss/aud + refresh/revocation) · OAuth portal (เมื่อจำเป็น)

### 13.3 Hardening & Release Checklist (ตรวจก่อน release ทุกเฟส)
- [ ] Default bind `127.0.0.1`; `--insecure` ไม่เป็น default (INV-15)
- [ ] Non-loopback + ไม่มี provider → ไม่ start (มี test)
- [ ] Redaction ครอบทุก response/log + path credential files (INV-14, มี test)
- [ ] Cookies `HttpOnly`+`SameSite=Lax`+`Secure` เมื่อ HTTPS; login rate-limited + generic error
- [ ] Host-header validation + peer-IP guard บน loopback; CORS จำกัด localhost+dev+พอร์ตจริง
- [ ] WS single-use ticket + close codes 4401/4403
- [ ] Audit log (JSON, redacted) ครอบ auth events + ทุก run ที่ spawn (สองโหมด) + ทุกการแก้ hooks/permissions + webhook trigger + ทุก approval/steer/kill
- [ ] Consent gates (hooks, bypassPermissions — INV-16) ทำงาน
- [ ] ไม่มี endpoint/หน้าจอแสดงหรือ export token/credentials (INV-12)
- [ ] Single-operator: ไม่มี endpoint สร้างผู้ใช้ (INV-15)
- [ ] Endpoint spawn run (`/api/runs`, `/api/jobs`, `/hooks/in/*`) + Human Plane API มี rate limit + token
- [ ] F-Sched + autonomous automation เปิดครั้งแรกผ่านหน้ายืนยัน quota guards
- [ ] **F-Term (surface เสี่ยงสูงสุด — INV-17):** remote ต้องผ่าน auth ทุกกรณีรวม `--insecure`; PTY spawn ทุกครั้ง audited + rate-limited; WS ใช้ single-use ticket; "full shell" เป็น opt-in ไม่ใช่ default; PTY reap เมื่อปิด (ไม่มี zombie)
- [ ] `core/` ผ่าน CI check ปลอด vendor name (INV-7); autonomous run ไม่เรียก Claude Code execution (INV-9); interactive approval เป็น CLI-native ไม่ใช่ web dialog (INV-17)

---

## §14 Repo Structure + Unified Roadmap

```
platform/
├── unified-platform-spec.md          # เอกสารนี้ — spec เดียว
├── core/        # RING 0 — ปลอด vendor name (INV-7): orchestrator, executor, state-log,
│                #   scheduler+lease, gates/ (ladder,golden-check,convention — P0; mutation=T3),
│                #   security/ (egress — P0; dep-policy,canary,data-govern — P1–2),
│                #   context-builder/ (P1), repair/ (P2), merge-queue+auditor (P3),
│                #   budget, policy-engine, human/ (approval+API — P1; steering,escalate — P2),
│                #   learning/ (P3–4), fault-injection.test.ts (P0)
├── aal/         # RING 1 (P1): protocol, adapter-interface, registry, router, breaker (P2),
│                #   fusion/ (P3), conformance/ (P1–P8)
├── adapters/    # RING 2: anthropic.ts(primary — P1), codex.ts (P3), openai-compatible.ts (GLM — deferred, access-conditional v1.3), _template.ts
├── console/     # OPERATOR SURFACE (Claude-specific — รู้จัก Claude ได้, แต่ไม่อยู่ใน core/):
│                #   backend (Fastify/Hono + Agent SDK), web (React SPA), F-* features §8
├── .ai/         # goal.yaml, models.yaml, task-graph.json, agents/, schemas/, policies/,
│                #   lessons/ (P4), calibration/ (P1), runs/RUN-*/, evidence/
├── scripts/     # create-worktree.sh, rollback-worktree.sh, conformance.sh, calibrate.sh
└── src/ · test/{ai-generated, golden}/
```

**Roadmap (gate ทุก phase = เลขจาก Calibration + fault-injection DoD + security checklist §13.3, ไม่ใช่ "โค้ดเสร็จ"):**

**Phase 0 — Deterministic Core + Console Foundation** *(สองงานขนานได้; ยังไม่ต่อ Claude เข้า autonomous)* — **ส่งมอบแล้ว** (PR #41)
- Core: executor+egress, event log+lease, gate ladder **T0–T1 (T2/T3 stub)**, golden harness — รันด้วย **stub agent** ผ่าน **Fault-injection DoD 9 ข้อ** (เขียน scenarios เป็น failing tests *ก่อน*):
  1. agent โกหกว่าสำเร็จ → core รันเองจับได้ · 2. action นอก allowlist/แตะ golden → reject เป็น feedback · 3. แอบออก network → block+log · 4. fake-green/hash ไม่ตรง → detect · 5. flaky → retry-and-flag ไม่ quarantine เงียบ · 6. crash ระหว่าง INTENT/APPLIED → resume ไม่ apply ซ้ำ · 7. actionId ซ้ำ → idempotent skip · 8. lease contention → single-writer · 9. เกิน budget → ESCALATED ไม่วนไม่รู้จบ
- Console: `platform console` launcher, F-Proj, F-Sess (read), F-Auth (ตรวจ+เตือน shadowing), F-Usage การ์ดย่อ, F-Status
- **DoD:** fault-injection 9 ข้อผ่านครบ **ก่อนต่อโมเดลจริง** + Console เปิดเห็นโปรเจกต์/sessions/quota-ประมาณ + เตือนแดงเมื่อ set `ANTHROPIC_API_KEY` ทดสอบ

**Phase 1 — Claude Adapter + AAL + Calibration แรก + Console Interactive/Governance** — **ส่งมอบแล้ว** (PR #42/#43)
- Autonomous: AAL + conformance P1–P8 + `adapters/anthropic.ts` (§5.2) + context builder รุ่นแรก + approval package + Human Plane API → supervised loop หนึ่งฟีเจอร์ → **วัดเลขครั้งแรก**
- Console: **F-Term (100% CLI parity — interactive surface หลัก, §4.1)** + F-Set + F-Perm + F-Auth เต็ม + F-Mem + F-Usage เต็ม + F-Act + F-Sess search
- **DoD:** conformance P1–P8 ผ่าน + spike billing + **spike PTY parity (§15)** ผ่าน + F-Term รัน slash command/plan mode/`--resume` ได้เท่า CLI + ปิด tab แล้ว attach PTY กลับได้ + supervised loop จบหนึ่งฟีเจอร์โดย core รันวัดเอง + ตั้ง permission ลง scope ถูก + Effective View ยืนยัน

**Phase 2 — Semi-autonomous + Survivability + Console Extensions** — **ส่งมอบแล้ว** (merged เข้า develop, PR #45)
- security plane เต็ม (canary, dep-policy, data-govern), breaker/degraded + **quota-aware routing (§5.4)**, hypothesis repair, auto-merge L0–L1 + sampling audit, meta-governance, steering
- Console: F-MCP, F-Hook (consent gate), F-Sub, F-Skill, F-Sys + automation guards
- **DoD:** loop รัน L0–L1 auto พร้อม sampling audit + breaker หลบเมื่อโควตา/provider ล้ม + สร้าง hook/MCP/subagent ผ่าน Console โดยไฟล์ valid

**Phase 3 — Multi-model + Fusion + Loop Console + Remote** — **ส่งมอบแล้ว** (PR #47; follow-up #48/#49 — backlog ค้าง 3 รายการถูกดูดเข้า Phase 4 ตาม v1.3)
- adapter ที่สอง: **Codex เท่านั้น** (Claude+Codex = 2 lineages — เพียงพอต่อ fusion decorrelation; Codex CLI ติดตั้งแล้วบนเครื่องนี้) · **GLM-5.2 deferred ไป Phase 4 แบบมีเงื่อนไข access** (ยังไม่มี access — เลื่อนแบบบันทึกไว้ ไม่ตัดเงียบ) · fusion + วัด decorrelation/uplift — **gate ก่อนเปิด fusion: ทบทวนนโยบาย non-interactive usage ของ Anthropic ตาม §5.3 และบันทึกผล** · merge queue + เปิดใช้ gate T2 (§6.4) + out-of-band auditor · outcome routing shadow
- Console: **F-Loop** (อ่าน loop + approve/steer/kill ผ่าน API), F-Sched (start/stop process เท่านั้น — B: ห้าม task scheduling), remote auth §13 (gate + Basic→OIDC + hardening)
- **DoD:** fusion แสดง uplift จาก calibration + auditor จับ non-repro ได้ + F-Loop อนุมัติ approval package จากเว็บ + security checklist §13.3 ครบ + login/approve จากเครื่องอื่นจริง

**Phase 4 — Continuous + Polish** *(rescope v1.3 — ดูด backlog ค้างจาก Phase 3 เข้า scope: บันทึกเดิมอยู่ที่ `.ai/specs/platform-phase3/tasks.md` + `docs/calibration/RUNBOOK-phase3.md`)* — **ส่งมอบแล้ว** (PR #50, squash-merged เข้า develop 2026-07-10 + console hardening ใน commit เดียวกัน)
- Carried จาก Phase 3: **approval pipeline production wiring** (populate approvals เมื่อ auto-merge decline → รอ human decision, timeout → ESCALATED → approve แล้ว pipeline ต่อเอง merge_queued→audited→COMPLETED / reject → CHANGES_REQUESTED) · **planner-role fusion auto-routing** (§7.5 policy trigger "planning เสมอ" — CI พิสูจน์ trigger ด้วย fake, live คุมด้วย `fusionActive`) · **fusion uplift number จริง** (live `code_diff`/`tests` activation + single-model baseline — รายงานเป็นช่วง, n เล็ก ตาม §12)
- Continuous: **issue intake → Goal Contract** (§11.1 — local-only: Console form + `.ai/issues/`; เนื้อ issue = untrusted data ทุกชั้น (INV-3); human approve ก่อนเป็น draft goal.yaml; ห้าม auto-start run; GitHub webhook = นอก scope เพราะเป็น unauthenticated remote ingress ขัด §13.3) · **canary deploy + automated rollback** (Loop 5 §9.1 — deploy เป็นคำสั่ง per-goal ใน contract: canary/observe/expand/rollback ที่ core executor รันเอง + จับ evidence; อยู่หลัง approval package `production_deployment` ตาม §11.1; observe รุ่นแรก = health probe ตาม exit code เทียบ threshold; **ทั้งหมดเป็น command-level บน target repo ไม่ใช่ production rollout จริง — ติดป้ายตรงตาม §16**) · **lessons active** (§10.4 — confirmed hypotheses + evidence → pending lesson → human approve ผ่าน governance เดิม → injectable โดย mark เป็น data + injection canary; เป็นคนละ artifact กับ process lessons ที่มนุษย์ดูแลนอก loop) · **outcome routing active** (§10.4 — เปิดเมื่อ shadow พิสูจน์: `shadowProven()` เป็น pure predicate บน SHADOW_ROUTE log ผลิต*หลักฐาน*ให้ **มนุษย์อนุมัติ activation ผ่าน governance** — INV-16 ห้าม auto-flip; ε-greedy แบบ deterministic hash ให้ replay ได้; freeze กลับ static เมื่อ drift canary เตือน)
- GLM-5.2 adapter (`adapters/openai-compatible.ts`) — **ยังไม่มี access (v1.3) → deferred ต่อแบบมีเงื่อนไข ไม่อยู่ใน scope Phase 4** (เลื่อนแบบบันทึกไว้ ไม่ตัดเงียบ); เมื่อมี access จริงค่อยเพิ่มตาม INV-8 (adapter 1 ตัว + conformance P1–P8, ห้ามแตะ Ring 0/1)
- Console: **F-Chat เต็ม** (SDK enhanced view — non-parity, ติดป้ายบังคับ: `query()` streaming + tool cards + web `canUseTool` approvals + fork; §15 ข้อ 3 อนุญาต path นี้โดยเจตนา — ไม่แตะ INV-17 ซึ่ง scope ที่ F-Term) · themes (dark/light) · responsive/mobile · **i18n TH/EN** (แปลเฉพาะ UI chrome — string ที่ backend/CLI ผลิตคงเดิม)
- **DoD:** approval package จาก run จริง → approve จากเครื่องที่สอง (tailnet) → pipeline ต่อเองจน COMPLETED และเส้น reject → CHANGES_REQUESTED · fault-injection: canary observe fail → rollback + `ROLLED_BACK` + root-cause event / rollback fail → ESCALATED / lesson ที่ไม่ approve ไม่มีทางเข้า context + lesson ที่ inject ถูก mark เป็น data และมี canary / drift canary เตือน → routing freeze กลับ static / issue ที่มี injection payload ไม่กลายเป็น goal.yaml โดยไม่มี human approve · calibration: fusion uplift **interval** จาก ≥1 `code_diff`/`tests` activation + single-model baseline บน corpus task เดียวกัน + outcome-routing activation ตัดสินโดยมนุษย์พร้อมเลข shadow (n, agreement, divergence outcomes) · security checklist §13.3 ครบรวม endpoint ใหม่ (issues/chat/deploy) · F-Chat แสดงป้าย non-parity · Console ผ่าน mobile viewport + สลับ TH/EN ครบ UI chrome

**Phase 5 — SDD Integration: spec ↔ Goal Contract binding** *(ใหม่ v1.4 — เชื่อมชั้น SDD spec artifacts (`.ai/specs/<feature>/{requirements,design,tasks}.md`) กับ Goal Contract §11.1 เป็น traceability สองทาง; INV ทุกตัวคงผลบังคับเดิม; derived specs ของ phase นี้ = `.ai/specs/platform-phase5-stage*/` ตาม glob ใน §0.1)*
- **Stage 1 — spec-to-goal generator** (tooling, one-way, human-gated): `scripts/spec_to_goal.py` + wrapper แปลง requirements.md ที่ `Status: approved` เท่านั้น + `Verify:` lines จาก tasks.md → `.ai/specs/<feature>/goal.draft.yaml` — AC ต่อ criterion (`AC-N.M`, description = EARS text, verification = `Verify:` ของ task ที่ Satisfies แบบ unique ไม่งั้น `TODO`), budget scaffold ตาม intake, **ห้าม mark `golden`** (มนุษย์ตัดสินตอน freeze — §6.5) · ตาม precedent issue intake: draft รันไม่ได้จนมนุษย์เติม, **ห้าม auto-start** (INV-3/INV-16)
- **Stage 2 — `goal.schema.json` + typed contract** — **ส่งมอบแล้ว** (spec: `.ai/specs/platform-phase5-stage2/`): JSON Schema draft-07 ครอบ §11.1 เต็ม (รวม `risk`, budget ครบ 6 field, `provenance` จาก stage 3) ใน `.ai/schemas/` + embed copy + parity test ตาม convention เดิม · `freezeContract` เลิกทิ้ง field เงียบ: enforce `max_hypotheses_per_failure`/`max_total_tasks`/`max_parallel_agents` + `risk` เป็น typed field (default L2) · ชะตา convention `.ai/goal.yaml`: **retired** — canonical ต่อ feature + promotion rename (ดู §11.1 + changelog v1.5)
- **Stage 3 — provenance + drift detection** — **ส่งมอบแล้ว** (spec: `.ai/specs/platform-phase5-stage3/`): contract field optional `provenance: {spec_path, requirements_commit, requirements_sha256, generated_at}` (4 field — `requirements_sha256` เพิ่มจากดราฟต์เดิม 3 field) — generator stamp, core validate shape · drift check เทียบ **sha256 ของเนื้อ `requirements.md` ปัจจุบัน** กับ `requirements_sha256` ที่ stamp ไว้ตอน generate — **ไม่ใช่ git commit** (squash merge ของ repo นี้ทำ commit ที่ stamp ไว้ unreachable ถาวรหลัง merge; `requirements_commit` เหลือเป็น metadata ให้คนอ่านเท่านั้น) → เตือน (advisory ก่อน exit 0 เสมอ, `--strict` พลิก exit 1 เมื่อพิสูจน์) · Console แสดง provenance ใน approval package (read-only)
- **Stage 4 — Task Graph + planning gate (§11.2)** — **ส่งมอบแล้ว** (spec: `.ai/specs/platform-phase5-stage4/`): multi-task contract + `task-graph.json` (DAG) + gate `uncovered_acs`/`orphan_tasks`/`max_diff_budget_per_task` · scheduler เลือก task ที่ READY + deps PASSED + risk permitted + budget + lease · ยก single-task ceiling ที่ documented ใน planner fusion · generator ขยาย emit task entries จาก tasks.md (`Satisfies:` → AC coverage ต่อ task) · fault-injection ต่อ task ตาม DoD มาตรฐานของ core · **รูปที่ส่งมอบจริง:** canonical ต่อ feature = `.ai/specs/<feature>/task-graph.json`, promotion = human rename จาก `task-graph.draft.json` (precedent goal.yaml เป๊ะ — draft ไม่มีทาง start run, INV-3/INV-16) · **opt-in ต่อ feature: ไม่มีไฟล์ที่ promote แล้ว = single-task path เดิมทุก byte** (ไม่มี migration บังคับ) · execution เป็น **sequential** (select → lease claim → branch hygiene → execute → release ต่อ task) · gate เป็น deterministic บน artifact ก่อน dispatch ใด ๆ และบันทึกผลลง event log (`TASK_GRAPH_FROZEN`/`TASK_GRAPH_REJECTED`) · **ceilings ที่บันทึกไว้ (ไม่ตัดเงียบ):** task-level parallelism ไม่ได้สร้าง (sequential โดยเจตนา — clause "Stage 4: task workers" ของ Stage-2 REQ-4.2 ยังไม่ถูก exercise) · drift check ระหว่าง `tasks.md` ↔ task-graph เลื่อนเป็น backlog · `deploy` + multi-task ถูก reject ที่ planning gate (semantics per-goal ยังไม่นิยามสำหรับหลาย task) · graph piece ของ planner fusion ยังไม่มีเส้น production — รายละเอียดครบใน §17 v1.7
- **Stage 5 — Evidence backflow**: ผล run (AC ผ่าน + evidence ref) ไหลกลับเป็น `Evidence:` block ใต้ task ที่เกี่ยวข้องใน tasks.md ของ spec ต้นทาง — **core เป็นผู้เขียนเท่านั้น ไม่ใช่ agent** (INV-1/INV-2 analog; agent ไม่มีเส้นทางเขียน spec file), เนื้อหาจาก evidence store (command + result + hash), เขียนหลัง COMPLETED + ผ่าน approval เท่านั้น · ทางเลือก design (เขียนตรง vs sidecar report ให้มนุษย์ apply) ตัดสินใน requirements phase ของ stage นี้
- ลำดับ stage = dependency; stage 1–3 ส่งมอบแยกได้และใช้กับ feature ขนาด single-task ได้ทันทีโดยไม่รอ stage 4–5
- **DoD:** generator ผลิต draft จาก archived spec จริง โดย draft ที่ยังมี `TODO` ถูก `freezeContract` ปฏิเสธ (พิสูจน์ human gate) และเมื่อเติมครบ freeze ผ่าน · schema parity test + budget/risk enforcement มี test ยืนยัน · drift check จับการแก้ requirements.md หลัง generate ได้ · fault-injection ของ task graph: uncovered AC → block, orphan task → block, dep ordering ถูก, agent fake-green ต่อ task ถูกจับ · multi-task calibration fixture รันถึง REVIEWING · Evidence block ที่ core เขียนผ่าน `check-evidence.sh --strict` + `spec_trace.py` เขียว และ fault-injection ยืนยันว่าไม่มีเส้นทางที่ agent เขียน spec file · CI เดิมเขียวทุก stage (vendor check INV-7, guard regression, spec trace)

---

## §15 Verification: Spikes ก่อน Phase 1

1. `listSessions` + `getSessionMessages` กับข้อมูลจริง (Console observability path)
2. **PTY parity proof (gate ของ §4.1/INV-17):** node-pty spawn `claude` ตัวจริง → เชื่อม xterm.js บนเว็บ → ยืนยันว่า (ก) slash command เช่น `/model` `/context` ทำงานเท่า CLI (ข) `claude --resume` เปิด session เก่าได้ (ค) permission prompt render ใน terminal และตอบด้วยการพิมพ์ได้ (ง) ปิด browser แล้ว PTY ฝั่ง backend ยังอยู่ attach กลับได้ (จ) ผ่าน `/usage` เห็นว่าคิดกับโควตา Max ไม่มีบิล API — **ไม่ผ่าน = interactive ไม่ใช่ 100% parity ห้ามไปต่อ**
3. `query()` streaming 1 turn + `canUseTool` (สำหรับ SDK enhanced view/autonomous เท่านั้น — ไม่ใช่ interactive parity path)
4. **Subscription billing proof (gate ของ §5.1/INV-12):** unset ตัวแปร auth ทั้งหมด (อย่างน้อย `ANTHROPIC_API_KEY`) → รัน spike 2/3 → สำเร็จด้วย credential จาก `/login` → เช็ก `/usage` ก่อน–หลังว่าโควตาขยับ ไม่มีบิล API — **ไม่ผ่าน ห้ามไปต่อ**
5. **Adapter isolation proof (gate ของ §5.2/INV-9):** เรียก `query()` แบบ `allowedTools: []` + `settingSources: []` → ยืนยันว่าโมเดล**คืนข้อเสนอ ไม่ execute** และ context ไม่มี CLAUDE.md/settings ของเครื่อง — คือ P6 + Context Builder isolation ในรูปแบบ spike

---

## §16 Implementation Constraints + Claim Discipline

**ห้ามตัดเด็ดขาด (ทุก phase):** propose/dispose + executor policy · event log + lease · golden tests + hash enforcement · budget backstop · egress default-deny · human approval L3/L4 · fail-closed Console gate · redaction · single-operator · **adapter `allowedTools:[]`+`settingSources:[]`** · **`core/` ปลอด vendor name** · **interactive = real `claude` binary via PTY (INV-17), remote ต้องมี auth เสมอ**
**ตัดก่อนได้ถ้าทรัพยากรจำกัด:** fusion (โมเดลเดียว + reviewer เดียว) · mutation ลดความถี่ · learning plane (static ได้) · drift canary manual · vendor fallback (ยอมรับ Claude-only + เสีย quota-survivability §1.2) · F-Loop advanced views — หลักตัดสิน: กลไกที่*ผลิต/ปกป้องหลักฐาน*และ*ความปลอดภัย*อยู่ก่อนกลไกที่*เพิ่มประสิทธิภาพ*

**วินัยการ claim (สะท้อนใน docs/comments/log ของโค้ด):**
- prompt injection = **mitigated ไม่ใช่ solved** — ห้ามเขียนว่าป้องกัน 100%
- consensus ของหลายโมเดล ≠ ถูกต้อง — ห้ามใช้ consensus ข้าม gate ใด ๆ
- mutation score = sensitivity ของเทสต์ ไม่ใช่ correctness
- reproducibility = **verification บน frozen artifact** ไม่ใช่ regeneration (โมเดล non-deterministic)
- quota numbers = **ค่าประมาณจาก transcript** ไม่ใช่ตัวเลขทางการ; cost = "มูลค่าเทียบราคา API" ไม่ใช่บิลจริง
- ระบบเร่งงาน L0–L2; L3–L4 เดินด้วยจังหวะมนุษย์**โดยเจตนา**

---

## §17 Changelog + จุดเริ่มงาน

**จุดเริ่ม (v1.10):** Phase 0–4 ส่งมอบแล้ว; Phase 5 stage 1–4 ส่งมอบแล้ว; v1.10 = role allowlist gate สำหรับ `RUN_COMMAND` ก่อน spawn (executor อนุญาต implementer/diagnostician) + เปิด prompt vocabulary ให้ implementer เท่านั้น (ไม่ใช่ stage ใหม่ ไม่ขยับ roadmap เช่นเดียวกับ v1.8/v1.9 ก่อนหน้า) → งานถัดไป = **stage 5 (Evidence backflow) ตาม §14 ตามเดิม** · เมื่อพบความไม่ตรงกับพฤติกรรมจริงของ Claude Code/SDK: บันทึก `docs/DEVIATIONS.md` ตาม §0.6

**Changelog:**
- **v1.10** — **`RUN_COMMAND` ได้ role allowlist gate ก่อน spawn (executor อนุญาต `implementer`/`diagnostician`) + เปิด prompt vocabulary ให้ `implementer` เท่านั้นเสนอได้โดยชอบ** (spec: `.pipeline/run-command-prompt-contract/`) — ไม่ใช่ roadmap stage ใหม่ · **อาการที่พิสูจน์แล้ว:** `protocolBlock` (`adapters/src/wire.ts`) ไม่เคยโฆษณา `RUN_COMMAND` ให้ role ใดเลย (dispatch มีแค่ diagnostician / else ทั้งคู่ปิดท้ายด้วย "Never invent other types") โมเดลจึงเสนอไม่ได้โดยชอบ และเมื่อ hallucinate ขึ้นมา (PR #134) ถูกปฏิเสธด้วยข้อความเรื่อง `network` ที่ทำตามไม่ได้ · ระหว่างสำรวจพบรูใหญ่กว่า: `RUN_COMMAND` ที่ `network:'none'` ผ่าน `validate()` แล้วถูกส่งเข้า `coreCommandExecutor.execute(...)` ตรง ๆ **ไม่มี role-permission gate ก่อนรัน** แบบที่ `WRITE_FILE` มี (`checkWrite`) — permission ถูกบังคับ *หลังรัน* ด้วยการตรวจ mutation diff เทียบ `writeRoots(role)` เท่านั้น คำสั่งที่อ่านข้อมูลหรือเผา CPU โดยไม่เขียนไฟล์จึงไม่ถูกจับ และ role อย่าง planner/reviewer ที่ไม่ควรสั่งอะไรเลยก็สั่งได้ · **รูปที่ส่งมอบ:** เพิ่ม `checkCommand(role)` เป็น **required method** บน `PathPolicy` (`core/src/executor/path-policy.ts`) — อนุญาตเฉพาะ implementer/diagnostician, role อื่นคืน reason ใหม่ `command_role_denied`; `executor.ts` เรียก gate นี้เป็นด่านแรกใน block `RUN_COMMAND` **ก่อน network check และก่อน spawn** (ลำดับสำคัญ: role ที่อนุญาต + `allowlist:x` ยังได้ `network_grant_unavailable` เหมือนเดิม gate ไม่กลับด้าน) · **prompt vocabulary:** `protocolBlock` เพิ่มบรรทัด `RUN_COMMAND` (shape เต็ม รวม `"network":"none"` literal + `cwd` optional repo-relative) ให้เห็นเฉพาะ **implementer เท่านั้น** — **ไม่โฆษณา `allowlist:<name>`** เพราะไม่มีทาง grant ได้จริงตั้งแต่ Phase 0 (สอนไป = เชิญเผารอบกับ `network_grant_unavailable`); planner/test_designer/reviewer **และ diagnostician** ไม่เห็น `RUN_COMMAND` เลย · **prompt กับ executor gate ไม่สมมาตรโดยเจตนา — ห้าม "แก้โค้ดให้ตรง spec" แล้วใส่บรรทัด `RUN_COMMAND` กลับเข้า prompt ของ diagnostician:** gate ฝั่ง executor (`checkCommand`) *ต้อง* อนุญาต `diagnostician` เพราะ hypothesis probe (`repair/hypothesis.ts`) และ deploy stage (`deploy/stage.ts`) ส่ง role นี้เข้า `executor.execute(...)` จริง แต่ prompt *ต้องไม่* โฆษณาให้ diagnostician เพราะ `aal/src/source.ts:482-483` คืน `actions: []` ทิ้ง `actionRequests` ของ role นี้ทั้งก้อนแบบเงียบ — ถ้าสอน `RUN_COMMAND` ให้ diagnostician model จะใส่ probe ผิดช่อง (`actionRequests` แทน `hypotheses`) แล้วได้ `hypotheses` ว่าง → `hypotheses_exhausted` → escalate จบ run โดยไม่มี feedback; role นี้สั่งคำสั่งได้อยู่แล้วผ่าน hypothesis probes ที่ core รันให้ · **fail-closed ที่ระดับ type:** required method ไม่ใช่ optional — implementation ที่ลืมใส่ compile ไม่ผ่าน ไม่กลายเป็น fail-open ซึ่งเป็นสิ่งที่งานนี้กำลังปิดพอดี · **supersede เจตนา design เดิมของ `.ai/specs/loop-engineering-phase0-conformance/`** (`design.md:438-441`, `:449-450`, regression matrix REQ-2 ที่ `:828`) ที่ตั้งใจให้ **ทุก role ส่ง `RUN_COMMAND` ได้** แล้วให้ core จำกัดด้วย per-role write-root + core-classified `read_only_probe` ไม่ใช่ hard role-allowlist — assertion เดิม "planner retains read-only command access" จึงมาจากเจตนานั้น · **supersede `requirements.md` REQ-2.4 บางส่วน** (durable write ถูกจำกัด "ตาม role ที่กำลังรัน" โดยนัยว่า *ทุก* role รันได้แล้วค่อยจำกัดปลายทาง) → planner/test_designer/reviewer ไม่ถึงจุดรันเลย ถูกตัดก่อน spawn ไม่ใช่ตอนตรวจ mutation diff, และ **REQ-2.25/2.26** (read-only test/probe รันโดยไม่เข้า promotion path พร้อมคง exit/output contract) — "read-only" ไม่เป็นข้ออนุญาตให้ role นอก allowlist สั่งได้อีกต่อไป · **ส่วนที่ไม่ขยับ:** implementer/diagnostician รันเหมือนเดิมทุกประการ, mutation-diff / `writeRoots(role)` / `read_only_probe` classification ที่ Ring 0 ไม่ถูกแตะสักบรรทัด — งานนี้เพิ่มชั้นปฏิเสธก่อน spawn ไม่ได้ลดชั้นป้องกันเดิม · **เหตุผล:** เดิม gate ปกป้องเฉพาะ *การเขียน* ปล่อยให้ role ที่ไม่ควรสั่งอะไรรันคำสั่งอ่าน/เผา CPU ได้ฟรี — role allowlist ปิดช่องนั้นที่ต้นทาง และทำให้ prompt vocabulary ตรงกับสิ่งที่ executor ยอมรับจริง (ก่อนหน้านี้ prompt เงียบ executor ก็ปฏิเสธเงียบ) · **เหตุผลที่เปิด `RUN_COMMAND` ให้ implementer:** เพื่อให้ loop วัดผลจริงจากเครื่อง ไม่ใช่เดาจากโค้ด — implementer รัน test/build เองได้ในรอบเดียวกับที่แก้ แทนที่จะรอผลจาก gate ladder รอบถัดไป · **ceiling ที่บันทึกไว้ (ตาม §16 ไม่ตัดเงียบ):** `aal/src/source.ts` (จุดรับ proposal) ยังไม่กรอง `type` ของ action ตาม role — `RUN_COMMAND` ที่ hallucinate จาก role ที่ถูกปฏิเสธผ่าน gate ของ source (ตรวจเฉพาะ write-provenance) ไปถูกปฏิเสธที่ executor การป้องกันจึงเป็น defense-in-depth ชั้นเดียวที่ executor; ปิดชั้นที่สองที่ source = backlog แยก
- **v1.9** — **provenance gate ฝั่ง write แยกสองเคสที่เคยถูกปฏิบัติเหมือนกัน** (spec: `.pipeline/write-provenance/`) — ไม่ใช่ roadmap stage ใหม่ · **อาการที่พิสูจน์แล้ว:** `RUN-1785857687452` round 3 — implementer เสนอ `WRITE_FILE` ครบ 5 ไฟล์ถูกต้อง แต่ 2 path เป็นไฟล์ใหม่ที่ยังไม่มีบนดิสก์ จึงถูกทิ้ง **ทั้ง batch** เป็น `context_violation` (all-or-nothing) แล้ววน explore จนหมด budget ปิดท้ายด้วย `ESCALATED` โดยไม่เคยถึง `REVIEWING` (หลักฐาน: `.pipeline/context-accumulation/tests.md:270,311`) · **รูปที่ส่งมอบ:** gate ถาม `lstat` หนึ่งครั้งต่อ `WRITE_FILE` ที่ไม่อยู่ใน `bundle ∪ readRequested` — ไม่มี entry = **เคส A สร้างไฟล์ใหม่ ปล่อยผ่าน**, มี entry = **เคส B เขียนทับของที่โมเดลไม่เคยเห็น ปฏิเสธทั้งก้อนเหมือนเดิม** · helper ตัวเดียว `worktreeEntryExists` อยู่ใน `core/src/context/builder.ts` ข้าง `readWithinWorktree` เพื่อให้ "path นี้มีอะไรอยู่ไหม" มีนิยามเดียว (`lstatSync` ตัวที่สองใน Ring 1 = นิยามที่สองของกฎเดียวกัน พร้อม drift) · **fail-closed ทุกทาง**: normalize ไม่ผ่าน / symlink (รวม dangling — จุดที่ `existsSync` พลาด) / directory / stat error ที่ไม่ใช่ `ENOENT` / path ที่ `ENOENT` เพราะหลุดออกนอก worktree ผ่าน **directory symlink** กลางทาง ไม่ว่า symlink นั้นจะ resolve ได้หรือ **dangling** (`src/link/new.ts` ใต้ `src/link` -> นอก worktree — `lstat` ไม่ตาม component สุดท้ายแต่ตาม component ก่อนหน้า จึงต้องเช็ค realpath ของ directory ลึกสุดที่มีอยู่จริง แบบเดียวกับ `readWithinWorktree`; และก่อนเดินขึ้นจาก probe ที่ realpath ตอบ `ENOENT` ต้อง `lstat` probe นั้นก่อน — dangling symlink ให้ `ENOENT` จาก realpath เหมือน dir ที่ยังไม่ถูกสร้างเป๊ะ ถ้าเดินข้ามไป escape จะถูกตัดสินด้วย directory ที่ไม่ได้อยู่บนเส้นทางของ path นั้นเลย) = ถือว่ามีอยู่ · `WRITE_FILE` ที่ `path` หายหรือไม่ใช่ string ถูกตัดสินเป็น violation **ที่ Ring 1 ก่อนเรียก helper** (field นี้ UNTRUSTED และ outputSchema จริงบน production หยุดที่ `actionRequests: {type:'array'}` ไม่มี item schema — ส่งต่อให้ helper = `TypeError` หลุดออกจาก `propose()` โดยไม่มีใครรับตลอดสาย) · เพิ่มประโยคกฎใน `protocolBlock` (`adapters/src/wire.ts`) และ `detail` ของ `context_violation` ระบุ path ที่ผิด + วิธีแก้ (เดิมเป็นข้อความคงที่ที่โมเดลเอาไปทำอะไรต่อไม่ได้) โดย **แยกข้อความตามชนิดของความผิด**: มี entry จริง = ให้ `READ_FILE` ก่อน, normalize ไม่ผ่าน = บอกว่าอยู่นอก worktree **ไม่แนะนำ `READ_FILE`** (`checkRead` ปฏิเสธ `path_outside_allowlist` อยู่แล้ว คำแนะนำนั้นทำตามไม่ได้จริงและเสียรอบเปล่า), ไม่มี `path` = บอกว่าต้องมี `path` · **supersede Phase-1 REQ-5.4 บางส่วน เฉพาะ `WRITE_FILE` ไป path ที่ไม่มี entry จริง** — ส่วนที่เหลือของ REQ-5.4 ไม่ขยับแม้แต่ตัวอักษรเดียว: เคส B ยัง reject ทั้งผลลัพธ์, all-or-nothing ยังคงอยู่ (มติเจ้าของระบบ), action ชนิดอื่นคงตรรกะเดิม · **เหตุผล:** ในเคส A **gate ไม่ได้ปกป้องอะไรเลย** — ไม่มีเนื้อหาเดิมให้หาย และการบังคับ `READ_FILE` ไฟล์ที่ไม่มีอยู่ก่อนหนึ่งรอบเป็นพิธีกรรมที่เปลี่ยนแค่สถานะภายในของ `readRequested` ขณะที่ด่านซึ่งปกป้องจริง (`checkWrite` write root/`test/golden/`/frozen RED, `resolveContained`, `checkMutationPaths` `regular_or_absent`) อยู่ที่ Ring 0 และ **ไม่ถูกแตะสักบรรทัด** — งานนี้จึงไม่ลดชั้นป้องกันใด ลดแค่การจ่ายรอบเปล่า · **precedent = ceiling ข้อ 2 ของ v1.8** ("path จาก EXPAND ได้สิทธิ์เขียนตามไปด้วย" ยอมรับได้เพราะ `checkWrite` ยังจำกัดอยู่) — v1.9 ใช้เหตุผลตัวเดียวกันเป๊ะ ไม่ได้สร้างบรรทัดฐานใหม่ และ **ceiling ข้อนั้นยังคงอยู่ไม่เปลี่ยน** (path ที่เข้ามาทาง EXPAND ล้วนยังเขียนได้ผ่านชุด `allowed` เหมือนเดิม) · **ceilings ใหม่ที่บันทึกไว้ (ตาม §16 ไม่ตัดเงียบ):** (1) **TOCTOU** — existence ถูกตรวจที่ propose time (Ring 1) แต่การเขียนเกิดที่ executor (Ring 0) หลังจากนั้น: action อื่นในรอบเดียวกัน (`RUN_COMMAND`, `APPLY_PATCH`, `WRITE_FILE` ตัวก่อนหน้า) สร้างไฟล์ขึ้นในหน้าต่างนั้นได้ **ยอมรับ** เพราะเนื้อที่ถูกทับมาจาก action ของโมเดลเองในรอบเดียวกัน ไม่ใช่ของที่ operator วางไว้แล้วโมเดลไม่เคยเห็น ซึ่งเป็นสิ่งที่ gate นี้ปกป้อง (process ภายนอกอยู่นอก threat model ตาม INV-15; ไฟล์ที่ gate command T0 สร้าง **ระหว่างรอบ** ไม่อยู่ในหน้าต่างนี้ — รอบถัดไป stat ใหม่แล้วเข้าเคส B ตามที่ควร) — ปิดสนิทต้องส่ง `allowed` ข้ามไปให้ executor ตรวจ ณ จังหวะเขียน = ขยาย type ของ core เพื่อกลไกที่ Ring 1 เป็นเจ้าของ **ไม่คุ้ม** (2) **feedback ยังไม่พกเนื้อ content ที่ถูก reject กลับ** — `ActionRejection` ให้แค่ `{actionId, reason, detail}` โมเดลจึงต้องเขียนไฟล์ใหม่ทั้งไฟล์เมื่อถูกปฏิเสธ (เนื้ออยู่ใน evidence store แล้วผ่าน `adapters/src/wire.ts` ที่แปลง `content` เป็น `contentRef` ตั้งแต่ normalize — ทำได้โดยไม่ต้องเก็บอะไรเพิ่ม) **เลื่อนเป็น backlog โดยมติเจ้าของระบบ**: v1.9 ทำให้ batch ที่ถูกต้องผ่านตั้งแต่รอบแรก อาการ "รอบถัดไปเดาโครงคนละแบบ ไม่ลู่เข้า" จึงควรรอหลักฐานจาก live run ถัดไปว่ายังจำเป็นอยู่จริง (3) **normalization mismatch ของ `readRequested` ยังอยู่** — set เก็บ path ดิบตามที่โมเดลส่งมา แต่ `bundle.pieces[].path` เป็นรูป normalized: `READ_FILE ./src/a.ts` แล้ว `WRITE_FILE src/a.ts` ตรงกันได้เพราะไฟล์เข้า bundle เท่านั้น ไม่ใช่เพราะ set match — v1.9 ทำให้เคสไฟล์ใหม่ไม่แสดงอาการนี้ (ผ่านทางเคส A) แต่ไม่ได้แก้ตัว mismatch (4) **ข้อความ `detail` แบบ `existing` ครอบเหตุอื่นนอกจาก "มีไฟล์อยู่จริง"** — `kindOf` เรียก path ทุกตัวที่ normalize ผ่านแล้ว helper ตอบ `true` ว่า `existing` แล้วแนะนำให้ `READ_FILE` ก่อน ทั้งที่ `true` มาได้จากอีกสามเหตุ (หลุดออกนอก worktree ผ่าน directory symlink, `EACCES`, stat error อื่น) ซึ่ง `READ_FILE` จะถูก containment ของ `readWithinWorktree` ปฏิเสธเช่นกัน ผลคือ **โมเดลอาจเสียรอบเปล่าหนึ่งรอบ ไม่ใช่ประเด็นความปลอดภัย** (การตัดสินยัง fail-closed ทุกทาง) และเป็นเคสที่ต้องมี symlink หลุดออกนอก worktree อยู่ใน repo ก่อน — แยกได้ด้วยการ `lstat` ซ้ำหนึ่งครั้งในเส้นทาง error ของ `kindOf` ถ้าอาการนี้โผล่จริงใน live run
- **v1.8** — **context bundle สะสมข้ามรอบ** (spec: `.ai/specs/context-accumulation/`) — ไม่ใช่ roadmap stage ใหม่ แต่เป็นการแก้ให้ implementation ตรงกับสัญญาที่ §6.1 ให้ไว้ตั้งแต่ต้น (`READ_FILE` → `core เติมผลรอบถัดไป`) · **อาการที่พิสูจน์แล้ว 3 live run ติดกัน:** autonomous loop ไม่เคยไปถึง REVIEWING, `WRITE_FILE` = 0 ทุก run ทั้งที่ implementer อ่าน `run-tests.sh` สำเร็จตั้งแต่รอบ 2 และไฟล์นั้นบอกเงื่อนไขผ่าน gate ครบ (`grep -q correct src/impl.txt`) — `CONTEXT_BUILT` ทั้ง 5 รอบของ `RUN-1785819815065` (seq 8, 29, 57, 76, 107) มี manifest เหมือนกันเป๊ะที่ `stats: {bytes: 6, pieceCount: 1}` และ recall ตันที่ 0.333 · **สาเหตุสองชั้น:** ผล `READ_FILE` ถูกเก็บเข้า evidence แล้วถูกทิ้ง (`executor.ts` คืน `outputRef` แต่ loop อ่านเฉพาะ `status === 'rejected'`) และ `buildContext` ถูกเรียกใหม่ทุกรอบด้วย `seedPaths` ชุดเดิมที่ผูกตอน construct · **รูปที่ส่งมอบ:** SEED ของแต่ละรอบ = `seedPaths` ∪ path ที่เคยขอผ่าน `READ_FILE` (normalize ให้อยู่ในขอบ worktree ก่อนเข้า SEED — จุดนี้บังคับเพราะ builder ใช้ `join()` ซึ่งไม่กัน `..` และ path ที่โมเดลกำหนดถูกเก็บก่อน executor จะได้ตรวจ · cap 20 path ล่าสุด ตัดเก่าสุด `seedPaths` ไม่ถูกไล่ออก) แล้วส่งทั้งชุดผ่าน `buildContext` **ทางเดียว** ไม่มี post-build append (precedent Phase-4 REQ-12.2) จึงได้ GOVERN + MARK ตามเส้นเดิมโดยไม่ต้องเขียนกลไกใหม่ · **สะสมเป็น path ไม่ใช่เนื้อ** — อ่านใหม่จากดิสก์ทุกรอบ ความสดของข้อมูลจึงรับประกันโดยโครงสร้าง ไม่ใช่โดยนโยบาย invalidate · การเปลี่ยนอยู่ใน Ring 1 (`aal/`) + prompt vocabulary (`adapters/`) เท่านั้น **ไม่แตะ `core/`** · **supersede 1 รายการ + บันทึกอีก 2:** **Phase-1 REQ-7.3** (`fail the bundle build` แบบไม่มีเงื่อนไข) — superseded **บางส่วน เฉพาะ piece ที่มาจาก accumulated path**: secret ในไฟล์จาก `seedPaths` คงพฤติกรรมเดิมทุกประการ (ล้มทั้ง bundle + escalate `secret_in_context`) ส่วน secret ในไฟล์ที่เข้ามาเพราะโมเดลเคย `READ_FILE` ให้ block รายชิ้นพร้อมบันทึก `ERROR {reason: 'accumulated_secret_evicted', file, kind}` แล้ว **build ใหม่วนต่อจนสำเร็จหรือชนเพดาน** (bounded drain — เพดาน = หน้าต่าง cap ของรอบนั้น `min(ชุดสะสม, 20)`; retry ครั้งเดียวไม่พอ ดู §9.4) และ secret ในไฟล์ที่เข้ามาเพราะ **EXPAND ล้วน** (ไม่อยู่ใน `seedPaths` ที่ส่งเข้า build รอบนั้น) ให้ **ข้าม piece นั้นรายชิ้นใน GOVERN ไม่ throw เลย** โดย **ตัวตัดสินต้องเป็น membership ใน `seedPaths` ห้ามใช้ inclusion reason ของ piece** (`visit()` กันเดินซ้ำด้วย `collected.has()` ทำให้ literal seed ที่ถูก import จาก seed ตัวก่อนหน้าค้าง `reason='expand:depth-1'` ถาวร — ตัดสินด้วย reason จะ skip secret ใน seed จริงแบบเงียบ ซึ่งกลับด้าน REQ-7.3 โดยไม่ตั้งใจ พบตอน implement มี regression test ปิดไว้แล้ว) — **เหตุผล:** path ที่ไม่ได้มาจาก composition ถูกเลือกโดย **โมเดล** ไม่ใช่ operator ถ้าคง abort ทั้งก้อน การอ่านไฟล์ที่ scan ติดครั้งเดียวจะฆ่างานทิ้ง (ทาง accumulated = path ค้างตลอดอายุ task ทำให้ทุกรอบถัดไปล้มซ้ำ · ทาง EXPAND ร้ายกว่าเพราะ valve eviction ไม่ครอบ — ไฟล์นั้นโมเดลไม่เคยขอ จึงไม่มีอะไรให้ evict ปลายทางคือ `move('block')` = **จบทั้ง run ไม่ใช่แค่รอบนั้น**) และ **trigger ไม่จำเป็นต้องเป็น secret จริงด้วยซ้ำ**: heuristic `high-entropy` ติด identifier ธรรมดาอย่าง `publicKeyFingerprintSha256` (H=4.210 > 3.5) — วัดบน production source จริงของรีโปนี้ได้ **3/120 ไฟล์ (~2.5%) โดยไม่มี secret จริงสักตัว** และประเด็นที่สำคัญกว่าอัตราคือ hit **เกาะกลุ่มตามหัวข้อ ไม่กระจายอิสระ**: `core/src/evidence/auth.ts` กับ `core/src/gates/report-integrity.ts` ติดด้วย identifier ตัวเดียวกันและทำงานเรื่องเดียวกัน โมเดลที่กำลังแก้เรื่องนั้นจึงมีเหตุผลจะอ่านทั้งคู่ในรอบเดียว — โมเดล binomial ใช้ไม่ได้ และนี่คือเหตุผลที่ valve ต้องเป็น drain ไม่ใช่ retry ครั้งเดียว (การปรับ heuristic ให้แม่นขึ้น = backlog แยก ไม่ตัดเงียบ); ส่วนที่ไม่เปลี่ยน = **block ไม่ใช่ redact** ตาม INV-14 เนื้อไม่ปรากฏใน prompt ทั้งสามทาง; **precedent ที่ carve-out แบบเดียวกันไปแล้วคือ Phase-4 REQ-12.3** (block lesson ที่มี secret รายชิ้นแทน abort ทั้ง build) · ประโยค `context builder is a pure function of (contract, worktree)` ที่ `.ai/specs/archive/platform-phase1/design.md:414` และ doc comment `core/src/context/builder.ts:4-6` ต้องขยับพร้อมกันในคอมมิตเดียวกับโค้ด — `buildContext` **ยังเป็น pure function ทุกประการ** สิ่งที่เปลี่ยนคือ caller ส่ง seed set ที่โตขึ้นตามรอบ · **Phase-1 REQ-7.6 ไม่ถูก supersede** เกณฑ์ยังใช้ได้ทุกตัวอักษร แต่บันทึกไว้ว่า `contextWaste` สูงขึ้นโดยกลไก (path ที่สะสมแต่รอบนั้นไม่ได้แตะนับเป็น unused) — **ไม่ใช่ regression** · **ceilings ที่บันทึกไว้ (ตาม §16 ไม่ตัดเงียบ):** (1) **byte cap ของ bundle ยังไม่ทำ** — พึ่งเพดานต่อไฟล์ 8,000 bytes + COMPRESS ที่มีอยู่ เพดานรวมที่รู้ตัว = 20 × 8,000 bytes; จุดตัดที่ต้องกลับมาเพิ่ม = เห็น `CONTEXT_BUILT.stats.bytes` เกิน 32 KB จริง (fixture ปัจจุบันสะสมเต็มที่ 2,541 bytes) (2) **EXPAND ขยายจากไฟล์ที่อ่านด้วย** — แยกสองผลที่ต่างกัน: **การหลุดออกนอก worktree ปิดแล้วในรอบนี้** (audit พิสูจน์ด้วยการรัน `buildContext` ตัวจริงว่าไฟล์ที่โมเดลตั้งชื่อซึ่งมี `import ... from '../../outside/x.ts'` ทำให้ได้ piece `reason=expand:depth-1` พร้อมเนื้อไฟล์เต็มไหลเข้า prompt เพราะ EXPAND ไม่เคยผ่านด่าน normalize ของ caller และบรรทัดแปลง import ตัด `../` แค่ชั้นเดียว — ช่องนี้มีมาก่อนบน develop แต่การสะสม path ขยาย trigger จาก "seed ที่ composition กำหนด" เป็น "path ใดก็ได้ที่โมเดลตั้งชื่อ" จึงถือเป็น trust boundary ที่ไม่เลื่อน) ส่วน **การที่ path จาก EXPAND ได้สิทธิ์เขียนตามไปด้วย** (อยู่ใน bundle = เขียนได้ ตาม Phase-1 REQ-5.4) **ยังยอมรับรอบนี้** เพราะ `checkWrite` ยังจำกัด implementer ที่ `src/` + `test/ai-generated/` และปฏิเสธ `test/golden/` + frozen RED เสมอ; แยก accumulated path ออกจาก EXPAND = backlog (3) **conformance ไม่ได้รับผลกระทบและไม่ต้อง re-record** — harness สร้าง bundle เป็น literal เอง ไม่มีเส้นทางไปถึง `buildContext` และ baseline record ไม่มี field ผูกกับ context (4) **defect ที่พบระหว่างออกแบบแต่ไม่ได้แก้ในรอบนี้ 4 ตัว เปิดเป็น task แยก:** idempotency key ชนข้ามรอบ (executor เทียบเฉพาะ `actionId` ขณะที่ wire แจก `a-${i}` ตามตำแหน่ง ทำให้ READ_FILE คนละไฟล์ถูกตัดว่าซ้ำ 13 จาก 22 ครั้ง) · `costUnits` ไม่รวม cache token จึงนับต่ำกว่าจริงมาก (กระทบ budget backstop) · `outputTail` ว่างเปล่าใน `GATE_RESULT` ทำให้ diagnostician สรุปสาเหตุผิดซ้ำ ๆ · `ESCALATED` ไม่ส่งต่อ hypothesis ที่ confirmed ไปให้มนุษย์
- **v1.7** — Phase 5 Stage 4 ส่งมอบ (spec: `.ai/specs/platform-phase5-stage4/`): **canonical ต่อ feature + promotion โดยมนุษย์** — generator เขียน `.ai/specs/<feature>/task-graph.draft.json`, promotion = rename เป็น `task-graph.json`, composition อ่านเฉพาะไฟล์ที่ promote แล้ว (draft ที่ค้างอยู่ถูกมองข้ามทั้งใบ — precedent goal.yaml เป๊ะ, INV-3/INV-16) · **opt-in ต่อ feature: ไม่มีไฟล์ที่ promote แล้ว = single-task path เดิมทุก byte** (result shape เดิม ไม่มี field `tasks`, ไม่ claim lease, ไม่มี event ใหม่) — บังคับด้วยกติกาตลอด stage ว่า **ห้ามแก้ไฟล์ test เดิมแม้บรรทัดเดียว** จึงเป็นหลักฐาน regression ในตัว · **driver เป็น sequential**: poll kill switch → select (pure deterministic: dep ทุกตัวอยู่ในเซต satisfied {PASSED, REVIEWING, APPROVED, MERGE_QUEUED, AUDITED, COMPLETED}, tie-break ด้วยลำดับในไฟล์กราฟ, projection scope ที่ seq ของ `TASK_GRAPH_FROZEN` ของรันนี้) → claim lease (owner ไม่ซ้ำต่อ invocation — คงที่ภายในรันนั้น, run id ยังเป็น identity ของ event log; CAS ของ lease ยอมให้ owner เดิม reclaim lease ตัวเอง สอง run ที่แชร์ state dir ภายใต้ owner เดียวกันจึงขโมย task กันได้ — Codex P1 review PR #124, TTL default = `max_wallclock_per_task_min` + 5 นาที slack) → branch hygiene 4 ขั้น → execute ผ่าน per-task machinery เดิมโดย **สร้าง budget tracker ใหม่ทุก task** (spend ของ task ก่อนไม่กิน task ถัดไป) → release · **planning gate** (`freezeTaskGraph` ใน `core/src/graph/`, ปลอด dep ตาม INV-7) ตรวจครบใน pass เดียวแล้วรวบ reason: `uncovered_acs` · `orphan_tasks` (ยกเว้น task ที่ tag `enabling`) · `max_diff_budget_per_task` ต่อ task · `goal_id` ต้องตรง `goal.id` ของ contract (AC id อย่าง `AC-1.1` ซ้ำข้าม feature ได้ การผูกจึงต้องชัด) · cycle/self-dependency/duplicate id/dangling edge (Kahn) · **`max_total_tasks` ได้ consumer จริงตัวแรก** · contract ที่มี `deploy` block + graph = reject · **ทั้งสองผลของ gate อยู่บนเส้น production**: `TASK_GRAPH_FROZEN {graphHash, taskIds}` เมื่อผ่าน / `TASK_GRAPH_REJECTED` พร้อม reason แบบ structured แล้วจบรัน BLOCKED **ก่อนสร้าง adapter หรือ agent ใด ๆ** — freeze เกิดครั้งเดียวในรัน หลังเปิด event log (CLI ทำแค่ ajv shape validation ไม่ freeze, INV-10) · **generator ขยาย**: emit task entry ต่อ block ของ tasks.md — `id` = `T-<n>` จาก ordinal ที่หัวบล็อก, `title` ตัด 120 ตัวอักษร, `satisfies` จาก `Satisfies:`, `depends_on` จาก `Depends on:` ด้วย grammar แคบ (อ่านเฉพาะ `\d+(\s*,\s*\d+)*` ที่ตามหลัง marker ทันที หยุดที่อักขระแรกที่ไม่เข้ารูป จึงข้าม prose/วงเล็บที่ตามมา) และ **union ทุก occurrence ในบล็อก** เหมือนที่ `Satisfies:` สะสมอยู่แล้ว — บล็อกที่ quote ชื่อ marker ใน prose ก่อน marker จริงเคยทำ dependency หายเงียบ; dangling ref / ordinal ซ้ำ / ordinal หาย = exit 1 โดยไม่เขียนไฟล์ใดเลย · **planner fusion** ได้ context piece ชิ้นเดียวคือกราฟที่ freeze แล้ว (MARK เป็น data ใต้ canary ของ request นั้น, `stats` จริง) และ event ของ planning ใน multi-task ติด `taskId: null` — block นี้เป็น per-run ที่รันก่อนเลือก task ใด ๆ ส่วน `T-1` เป็น id ของ task จริงในกราฟ การคงไว้จะ file event ใต้ task ที่ยังไม่เริ่ม · **supersede 6 รายการ:** **Stage-2 REQ-4.3/4.4** (`max_total_tasks` stored-only + deferral comment — consumer จริง land แล้ว, comment ถูกแทนด้วย pointer ไปกลไก) · **Phase-2 REQ-7.2** (วลี "the Phase-2 single-task loop maps ALL of them") เฉพาะ multi-task mode — mapped ACs ของ task = `task.satisfies` เท่านั้น ทั้ง excerpt ที่ agent เห็น, การตัดสิน auto-merge และ approval package มิฉะนั้น auto-merge ของ task หนึ่งจะผ่านด้วย golden ของ AC ที่ task นั้นไม่เคยแตะ (single-task คง "maps ALL" เดิมทุกประการ) · **Phase-4 REQ-16.2** บางส่วน (panel input pinned to goal+ACs, empty `contextBundle`) — multi-task เพิ่ม graph piece, composition ที่ไม่มีกราฟคงพฤติกรรมเดิมเป๊ะ · **Phase-4 REQ-16.5** เฉพาะประโยคเพดาน "no full planning gate exists in this composition" — gate มีจริงแล้ว (บน graph) แต่การ validate ผล plan ยัง structural-only และ plan ยัง advisory; ข้อความเพดานเดียวกันใน `plan.schema.json` `$comment` และ doc comment ของ `fusion.ts` อัปเดตพร้อมกัน · **Stage-1 REQ-4.2** (output gate เอกพจน์ "the output file") — gate กันเขียนทับแยกต่อไฟล์ output, draft กราฟที่ค้างไม่บล็อกการ regenerate goal draft และกลับกัน, `--force` เขียนทับทั้งคู่ · **Stage-1 REQ-4.1/4.6** (assert ว่า generation ที่สำเร็จเขียนไฟล์ใหม่ไฟล์เดียว) — ตอนนี้เขียนสอง draft; ส่วนที่ไม่เปลี่ยนของเกณฑ์เดิม (ไม่มี temp file ค้าง, input ไม่ถูกแตะ, ไม่ promote เอง) ยัง assert ตามเดิม · **ceilings ที่บันทึกไว้ (ตาม §16 วินัยการ claim — ไม่ตัดเงียบ):** (1) **task-level parallelism ไม่ได้สร้าง** — execution เป็น sequential โดยเจตนาตาม controller เดิมที่ single-threaded; clause "Stage 4: task workers" ของ Stage-2 REQ-4.2 จึงยังไม่ถูก exercise (`max_parallel_agents` ยังคุม agent fan-out ภายใน task ตามความหมายเดิม) (2) **drift check ระหว่าง `tasks.md` ↔ task-graph เลื่อนเป็น backlog** — drift anchor ของ Stage 3 ครอบ `requirements.md` ↔ `goal.yaml` เท่านั้น (3) **`deploy` + multi-task ถูก reject ที่ planning gate** — `deploy:` มี semantics per-goal และรันทุกครั้งที่ task ถึง COMPLETED กราฟหลาย task จึงจะ canary/expand ซ้ำ; ประกาศไม่รองรับตั้งแต่ gate ดีกว่า deploy ซ้ำเงียบ ๆ (4) **graph piece ของ planner fusion ยังไม่มีเส้น production** — CLI ไม่เคยประกอบ path `planning` (`bin/platform.ts` ไม่ส่ง option นี้) ตัว `runPlannerFusion` จึงเรียกได้จาก test เท่านั้น — ตัว graph piece เองมี test เจาะจงแล้ว (`console/backend/src/loop-graph-wiring.test.ts`, REQ-5.1/5.2) แต่เพดาน "ไม่มี composition บนเส้น production" ยังอยู่ตามเดิม · **บันทึกความซื่อสัตย์เพิ่มอีกสองข้อ:** guard `{ok: false, detail: 'unknown_task'}` ของ approval targeting เป็น defensive depth ของ port ไม่ใช่เส้นที่มีอาการ — เอื้อมไม่ถึงจาก HTTP surface ที่ประกอบอยู่วันนี้ เพราะ `core/src/human/api.ts` หา approval package ก่อนแล้วจึงเรียก `onDecision` ด้วย `taskId` ของ package นั้น (ไม่มี package = ตอบ 404 ตั้งแต่ก่อนถึง guard) ส่วนคุณสมบัติที่ REQ ต้องการจริงและเอื้อมถึงได้ถูก test แทน · เกณฑ์ที่ assembly trace พบว่ามีโค้ดครบแต่ไม่มี test สามในสี่ข้อถูกปิดด้วย follow-up commit หลังประกอบ (ทุกตัวผ่าน mutation check — พัง wiring ฝั่ง production แล้ว test แดงจริง): **REQ-4.5** effective `diff_budget` ต่อ task — graph fixture ประกาศ `diff_budget: 1` ใต้ ceiling ที่ไม่ใช่ default (200) ให้ budget แสดงตัวตรงจุดที่มันกัด คือ escalate `split_required` ที่ระบุตัวเลขที่ใช้จริง (approval package ไม่ได้เก็บ `maxDiffBudget` ไว้ในตัวมันเอง) จึงแยกออกจาก fallback `?? 400` ได้ · **REQ-4.7** unit test ของ `loadTaskGraphOption`: มีแต่ draft บนดิสก์ → `undefined`, promote แล้วจึงคืน `{rawBytes, parsed}` · **REQ-5.1/5.2** เรียก `runPlannerFusion` ตรง ๆ แล้ว assert `contextBundle` ที่ panel ได้รับจริง (มีกราฟ = piece เดียว `{id:'task-graph', kind:'contract', reason:'task_graph'}` + `stats` จริง + canary / ไม่มีกราฟ = empty bundle รูปเดิม) — **เหลือข้อเดียวที่ยังไม่มี test คือ REQ-4.10 CLI wiring + per-task summary ใน `bin/platform.ts`** เพราะไฟล์นั้นไม่มี test harness ใน repo นี้
- **v1.6** — Phase 5 Stage 3 ส่งมอบ (spec: `.ai/specs/platform-phase5-stage3/`): provenance schema เพิ่ม optional `requirements_sha256` (4 field, `minLength:1` ทุก field parity กับ `deploy` fields) — governance copy + embedded copy ขยับพร้อมกัน, parity test คงเขียว · generator (`spec_to_goal.py`) เปลี่ยน provenance จาก comment header 4 บรรทัดเป็น top-level `provenance:` flow-mapping บรรทัดเดียว JSON-quoted (`json.loads` parse ได้ตรง, `spec_path` repo-root-relative) — **supersede Stage-1 REQ-3.5** (comment form) · `freezeContract` เพิ่ม typed `provenance?` (pattern เดียวกับ `deploy`, helper เดิม, absent = พฤติกรรมเดิม 100%, unknown key ไม่ reject ที่ freeze — ajv edge จัดการแทน) · drift checker ใหม่ `scripts/spec_goal_drift.py` + wrapper stdlib-only: **sha256 ของเนื้อไฟล์ `requirements.md` = anchor เดียวที่ตัดสิน drift** ไม่ใช่ git commit (squash merge ทำ commit unreachable ถาวรใน CI) — **supersede Stage-2 REQ-1.6** (provenance เดิมระบุ 3 field เป๊ะ "ไม่ต้อง bump") · advisory default (exit 0 เสมอ, warning บน stdout) + `--strict` escalation path (exit 1) เป็น flag เดียว · CI verify job เพิ่ม step รันทุก `goal.yaml` ที่ promote แล้วใต้ `.ai/specs/*/` (ศูนย์ไฟล์ตอนนี้ = ผ่านเงียบ, `goal.draft.yaml`/`archive/` ไม่เข้า loop โดย construction) · Console approval package แสดง provenance read-only ทั้งสอง approval site (task + deploy) — spec_path/commit/generated_at เท่านั้น ไม่แสดง sha เต็มบนจอ, ไม่มี write path
- **v1.5** — Phase 5 Stage 2 ส่งมอบ (spec: `.ai/specs/platform-phase5-stage2/`): `goal.schema.json` governance copy + embedded copy + ajv edge validation ใน `loadGoalContract` (ทุก failing path, console เท่านั้น — core/aal ไม่มี dep ใหม่) · typed contract เต็ม: budget ครบ 6 field (integer >= 1, `ContractBudget`) + `risk` typed (absent → L2, invalid → reject) · consumer wiring: `max_hypotheses_per_failure` → `RepairPolicy`, `max_parallel_agents` → dispatch ceiling + fail-closed planning guard; `max_total_tasks` stored-only รอ Stage 4 · **retire root `.ai/goal.yaml`**: canonical = `.ai/specs/<feature>/goal.yaml`, promotion = human rename จาก draft, `loopManaged` banner อ่าน per-feature path (draft ไม่นับ) · **supersede Phase-1 REQ-8.4** (preserve-and-ignore unknown keys → schema reject ที่ edge; forward-compat ผ่าน schema amendment; raw passthrough ใน freeze คงเดิม) · **supersede Stage-1 REQ-4.5** (resolved draft freeze ได้ทันที → ต้องตั้ง risk จริงก่อน เพราะ generator emit `risk: "TODO"` เป็น human gate) · risk semantics เข้มขึ้น: phase-4 "unrecognized → L2 เงียบ" ถูกแทนด้วย reject ตั้งแต่ edge/freeze
- **v1.4** — sync สถานะส่งมอบ Phase 4 (merged เข้า develop, PR #50) + เพิ่ม **Phase 5 — SDD Integration**: เชื่อม SDD spec artifacts ↔ Goal Contract เป็น 5 stage ตาม dependency (spec-to-goal generator → goal.schema.json/typed contract → provenance/drift detection → Task Graph §11.2 → Evidence backflow) · ปิด gap ที่พบจากการ audit โค้ด: budget field ที่ `freezeContract` ทิ้งเงียบ 3 ตัว, `risk` untyped, ไม่มี goal.schema.json, convention `.ai/goal.yaml` กำพร้า · ยก single-task ceiling ใน stage 4 (implement §11.2 ที่ specced ไว้แต่ไม่มีโค้ด) · ขอบเขต INV คงเดิมทุกตัว: draft human-gated ห้าม auto-start (INV-3/16), Evidence backflow เขียนโดย core เท่านั้น (INV-1/2)
- **v1.3** — sync สถานะส่งมอบ + rescope Phase 4: Phase 3 ส่งมอบแล้ว (merged เข้า develop, PR #47 + follow-up #48/#49) · ดูด backlog ค้าง 3 รายการจาก Phase 3 เข้า scope Phase 4 (approval pipeline production wiring · planner-role fusion auto-routing · fusion uplift number จริง) · เพิ่ม **DoD ของ Phase 4** ที่เดิมไม่มี · GLM-5.2 **ยังไม่มี access → deferred ต่อแบบมีเงื่อนไข ไม่อยู่ใน scope Phase 4** (ไม่ตัดเงียบ — แก้ cell ล้าสมัยใน §7.4 ที่เขียนว่า "กลับมา Phase 4" ให้ตรงจริง) · กำหนดขอบ Phase 4: issue intake เป็น local-only (ไม่มี GitHub webhook — ขัด §13.3), canary deploy เป็น command-level บน target repo ติดป้ายตาม §16, outcome-routing activation เป็นการตัดสินของมนุษย์ผ่าน governance (INV-16), F-Chat เข้าแบบเต็ม + i18n TH/EN
- **v1.2** — sync สถานะส่งมอบ + rescope Phase 3: Phase 0–2 ส่งมอบแล้ว (Phase 2 merged เข้า develop, PR #45) · แก้ Phase column §8 ให้ตรงจริง (F-MCP/F-Hook/F-Sub/F-Skill/F-Sys = Phase 2, F-Sched = Phase 3 — §14 เป็น authoritative ตาม §0.3, column เดิมล้าสมัยก่อน re-plan) · Phase 3 = §14 เต็ม (multi-model + fusion + merge queue/T2 + auditor + outcome routing shadow + F-Loop + F-Sched + remote auth §13) โดย second lineage = **Codex เท่านั้น**; GLM-5.2 เลื่อนไป Phase 4 แบบมีเงื่อนไข access (บันทึกไว้ ไม่ตัดเงียบ) · ปรับ default §7.4/§7.6 ให้สอดคล้อง · ย้ำ gate §5.3 (ทบทวนนโยบาย non-interactive usage) ก่อนเปิด fusion ใน §14 Phase 3
- **v1.1** — interactive surface เปลี่ยนเป็น **binary `claude` ตัวจริงผ่าน PTY = 100% CLI parity** (เพิ่ม INV-17 + §4.1; F-Term เป็น P0/Phase 1 = interactive หลัก; F-Chat/SDK ลดเป็น optional non-parity Phase 4; เพิ่ม PTY parity spike §15.2; interactive approval เป็น CLI-native ไม่ใช่ web dialog)
- **v1.0** — หลอมรวมเป็นแพลตฟอร์มเดียว สองโหมด (Interactive + Autonomous) บน substrate Claude Max 20x
