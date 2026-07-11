# Design: platform-phase5-stage1 — Spec-to-Goal Generator
> Status: approved 2026-07-11

## Architecture Overview

สอง component ใหม่ใต้ `scripts/` (tooling layer — ไม่แตะ core/aal/adapters/console
production code) + test หนึ่งไฟล์ใน `console/backend`:

| Component | Responsibility |
|---|---|
| `scripts/spec_to_goal.py` | ตัว generator ทั้งหมด: resolve + validate spec, map criteria → AC, emit `goal.draft.yaml` แบบ atomic |
| `scripts/spec-to-goal.sh` | wrapper บางๆ `exec python3 "$SCRIPT_DIR/spec_to_goal.py" "$@"` — clone `spec-trace.sh` |
| `console/backend/src/spec-to-goal.e2e.test.ts` | e2e test: exec generator แล้ว assert ผลด้วย `yaml` parser + `freezeContract` จริง |

หลักการ: **reuse `spec_trace.py` เป็น library** — `spec_to_goal.py` อยู่โฟลเดอร์เดียวกัน
`import spec_trace` แล้วใช้ `parse_requirements()` + `expand_refs()` ตรงๆ. ส่วนการเดิน
tasks.md: `satisfies_text()` เดิม **ใช้ตรงๆ ไม่ได้** — มัน flatten ทุก task เป็นสตริง
เดียว ไม่เหลือ task boundary ขณะที่ REQ-2.4/2.5 ต้องการ per-task association
(Satisfies ↔ Verify ใน task เดียวกัน). ทางแก้แบบ single-source: **เพิ่ม helper
`iter_task_blocks(tasks_text)` ใน `spec_trace.py`** (yield block ละ task: checkbox
line + continuation lines) แล้ว refactor `satisfies_text()` ให้ build บน helper นี้
โดย output เดิมต้อง byte-identical (มี regression test) — generator กับ spec-trace
เดินไฟล์ด้วยโค้ดตัวเดียวกัน semantics ไม่มีวัน drift (REQ-2.3).
Generator เพิ่มเฉพาะ logic ที่ spec_trace ไม่มี: duplicate/empty-REQ detection
(rescan `## REQ-N:` heading ด้วย `spec_trace.REQ_HEADING_RE` — `parse_requirements`
ไม่คืนรายการ heading, REQ ที่ว่างจะหายเงียบจาก criteria ถ้าไม่ rescan),
Verify-per-task extraction, YAML emission.

Test อยู่ที่ `console/backend` โดยเจตนา: สองสิ่งที่ e2e ต้องใช้ — `yaml` package
(REQ-3.7) และ `freezeContract` (REQ-4.4/4.5) — เป็นของ composition root อยู่แล้ว;
precedent เดียวกับ `fusion.test.ts` ที่อ่าน `.ai/schemas/` จาก disk. ไม่ต้องเพิ่ม
CI wiring — job `platform` รัน test ของ console/backend อยู่แล้ว.

## Sequence Diagrams

```mermaid
sequenceDiagram
    participant Op as Operator
    participant SH as spec-to-goal.sh
    participant PY as spec_to_goal.py
    participant ST as spec_trace (import)
    participant FS as .ai/specs/<feature>/

    Op->>SH: spec-to-goal.sh <feature> [--force] [--specs-dir <p>]
    SH->>PY: exec python3 spec_to_goal.py ...
    PY->>FS: read_bytes(requirements.md) — hash + decode จาก buffer เดียว
    PY->>PY: gate: บรรทัดแรกที่ขึ้นต้น "> Status:" ต้องเป็น "> Status: approved..." (REQ-1.4)
    PY->>ST: parse_requirements(text)
    PY->>PY: gate: REQ headings? dup IDs? empty REQ (rescan headings)? (REQ-1.5/1.7/1.8)
    PY->>FS: read tasks.md (absent -> warn, all unresolved; REQ-1.6)
    PY->>ST: iter_task_blocks + expand_refs ต่อ block (REQ-2.3)
    PY->>PY: map criterion -> verification (unique task + Verify:; REQ-2.4/2.5)
    PY->>PY: gate: output exists && !--force -> refuse (REQ-4.2)
    PY->>FS: atomic write goal.draft.yaml (temp + os.replace)
    PY-->>Op: exit 0 + summary (ACs, resolved/unresolved)
    Note over Op: human: review, fill TODO, activate ACs,<br/>set risk/golden/approval_policy
    Note over Op,FS: แล้วค่อย platform loop run --goal ... (นอก scope generator)
```

## Data Models & Interfaces

### CLI (REQ-5.1)

```
scripts/spec-to-goal.sh <feature> [--force] [--specs-dir <path>]
```
- `<feature>` — โฟลเดอร์ใต้ specs dir (default `.ai/specs/`)
- `--force` — อนุญาต overwrite output ที่มีอยู่ (REQ-4.3)
- `--specs-dir <path>` — override specs dir (REQ-1.2; ใช้ชี้ `.ai/specs/archive` ใน test)
- exit 0 = สำเร็จ + summary บน stdout; exit 1 = ทุก refusal, เหตุผลบรรทัดเดียวบน stderr (REQ-5.3)

parse ด้วย `argparse` (stdlib) — positional `feature`, flag `--force`, option `--specs-dir`.

### Internal model

```python
# หลัง parse + map
Criterion = tuple[int, int, str]          # (major, minor, joined_text) — จาก spec_trace
ACEntry   = { "id": "AC-N.M", "description": str, "verification": str | None }
#   verification=None = unresolved (REQ-2.5) -> render เป็น "TODO" ใน pending block
```

Verify-extraction — สร้างบน `iter_task_blocks()` (helper ใหม่ใน spec_trace, ดู
Architecture Overview):
- **Task block** = บรรทัด checkbox (`- [ ]` / `- [x]`, checkbox state ไม่มีผล —
  analyze log) + continuation lines ที่ตามมา (indent, ไม่ว่าง, ไม่ใช่ checkbox ใหม่)
  join เป็นข้อความเดียว — นิยามเดียวกับที่ `satisfies_text` ใช้อยู่ หลัง refactor
  ให้ทั้งคู่เรียก helper ตัวเดียวกัน
- ภายใน block (marker `Satisfies:` / `Verify:` / `Depends on:` / `Batch:` อยู่ลำดับ
  ใดก็ได้): แต่ละ segment = ข้อความหลัง marker ตัดท้ายที่ marker ตัวถัดไปตัวใดตัวหนึ่ง
  ใน 4 ตัวนี้
- `satisfies_refs = expand_refs(satisfies_segment, criteria_by_req)` (reuse)
- `verify_cmd = verify_segment.strip()` — copy verbatim (แม้ไม่ใช่ executable command
  — analyze log: human review จับ)
- criterion `(a,b)` resolved เมื่อ: จำนวน block ที่ cover == 1 AND block นั้นมี
  verify_cmd ไม่ว่าง (REQ-2.4/2.5)

### Output: `goal.draft.yaml`

String ทุกตัว emit ผ่าน `json.dumps()` — JSON string = valid YAML double-quoted flow
scalar (precedent: `goalDraftYaml` ใน `issues.ts` ใช้ `JSON.stringify` ด้วยเหตุผลเดียวกัน)
— text จาก spec (quotes, `:`, `#`, newline) break ออกจาก mapping ไม่ได้ (REQ-3.7).

กรณีมี unresolved อย่างน้อย 1 ตัว (REQ-4.4):

```yaml
# spec-to-goal draft — DO NOT run as-is
# source: .ai/specs/user-auth/requirements.md
# requirements_sha256: <64-hex ของ bytes ที่อ่านจริง>
# head_commit: <git rev-parse HEAD | "unknown">
# generated_at: <ISO-8601 UTC>
# HUMAN: (1) review pending_acceptance_criteria + fill every TODO verification
#        (2) rename pending_acceptance_criteria -> acceptance_criteria
#            and delete the empty acceptance_criteria line below
#            WARNING: freezeContract does NOT reject "TODO" strings — renaming
#            without doing step (1) produces a freezable contract with fake
#            verifications; steps are advisory ordering, the only structural
#            gate is the empty acceptance_criteria below
#        (3) set risk (L0-L4), decide golden flags, set approval_policy
#        (4) write goal.objective (one sentence) + fill scope/forbidden
goal: { id: "USER-AUTH-001", title: "<H1 feature name>", objective: "TODO" }
risk: "TODO"
scope:
  include: ["TODO"]
  exclude: ["TODO"]
constraints:
  forbidden: ["TODO"]
acceptance_criteria: []   # gate: freezeContract rejects empty — activate per HUMAN step (2)
pending_acceptance_criteria:
  - { id: "AC-1.1", description: "WHEN ... THE SYSTEM SHALL ...", verification: "pnpm test auth-login" }
  - { id: "AC-1.2", description: "IF ... THEN THE SYSTEM SHALL ...", verification: "TODO" }
budget: { max_iterations_per_task: 8, max_hypotheses_per_failure: 3, max_total_tasks: 30,
          max_parallel_agents: 3, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 }
approval_policy:
  require_human_approval: ["TODO"]
```

กรณี resolved ครบทุกตัว (REQ-4.5): ไม่มี `pending_acceptance_criteria`, criteria ทั้งหมด
อยู่ใน `acceptance_criteria:` จริง (banner ยังคงขั้น (3)/(4) — objective/scope/risk ยังเป็น
TODO ที่ freeze ไม่ตรวจ แต่ human ต้องตัดสิน) — ไฟล์ผ่าน `freezeContract` เชิงโครงสร้าง.

- `goal.id` = feature slug uppercase + `-001` (REQ-3.1); ตัวอักษรที่ไม่ใช่ `[A-Za-z0-9-]`
  แทนด้วย `-`
- `goal.title` = H1 (บรรทัดแรกที่ขึ้นต้น `# `) strip prefix `# Requirements` แล้วตัด
  separator นำหน้า (`:` หรือ `—` หรือ `-`) + whitespace — รองรับทั้ง
  `# Requirements: <name>` (spec ใหม่) และ `# Requirements — <name>` (convention
  ของ archive เช่น platform-phase4) (REQ-3.2)
- header gate (REQ-1.4) = **scan** หาบรรทัดแรกที่ขึ้นต้น `> Status:` แล้วเช็ค prefix
  `> Status: approved` — ไม่ fix ตำแหน่งบรรทัด (archive phase4 มี header ที่บรรทัด 3,
  spec ใหม่อยู่บรรทัด 2); ไม่เจอบรรทัด `> Status:` เลย = refuse ตาม 1.4
- sha256 provenance (REQ-3.5) = hash จาก `read_bytes()` ดิบ แล้ว `decode("utf-8")`
  จาก buffer เดียวกันไป parse — ห้าม hash `read_text().encode()` (newline translation
  ทำ anchor เพี้ยนบนไฟล์ CRLF/BOM)
- budget literal 6 ค่า pin ตาม `issues.ts` `goalDraftYaml` ณ วันนี้ (analyze log:
  ไม่ import ข้าม layer — ค่าซ้ำโดยเจตนา มี comment ชี้แหล่ง)
- `pending_acceptance_criteria` เป็น unknown key สำหรับ `freezeContract` → ตกไปอยู่ใน
  `contract.raw` เฉยๆ ไม่มีผลใดๆ แม้ human ลืมลบ

## Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| ภาษา generator | Python 3 stdlib เท่านั้น (`argparse`, `hashlib`, `json`, `subprocess` สำหรับ git, `tempfile`/`os.replace`) | convention เดียวกับ `spec_trace.py`; ไม่เพิ่ม dependency (Dependency rules) |
| Parsing | `import spec_trace` | single source ของ REQ/Satisfies semantics (REQ-2.3); แก้ที่เดียว |
| YAML emission | string template + `json.dumps` ต่อ scalar — ไม่ใช้ pyyaml | pyyaml ไม่มีใน repo; JSON-escape เป็น valid YAML และมี precedent ใน `issues.ts` |
| YAML validation ใน test | `yaml` package ของ console/backend | มีอยู่แล้ว (loop-cli ใช้) — parser เดียวกับที่ runtime ใช้จริง = fidelity สูงสุด |
| Freeze assertion ใน test | `freezeContract` ตัวจริงจาก `core` | REQ-4.4/4.5 นิยามเป็นพฤติกรรมของ freezeContract — ต้อง assert กับของจริง ไม่ mock |
| Atomic write | `tempfile.NamedTemporaryFile(dir=เดียวกับ output)` + `os.replace` | กัน partial file ค้างแล้วชน REQ-4.2 รอบถัดไป (analyze log) |
| git hash | `subprocess.run(["git", "rev-parse", "HEAD"])`, ล้มเหลว → `"unknown"` + warn | analyze log: นอก git repo ไม่ refuse เพราะ sha256 ยังครบ |

## Error Handling Strategy

ทุก refusal: ข้อความบรรทัดเดียวบน stderr + `exit 1` (REQ-5.3). ตาราง:

| Condition | REQ | Message (สาระ) |
|---|---|---|
| feature dir / requirements.md ไม่มี | 1.3 | ชื่อไฟล์ที่หาย + usage |
| header ไม่ขึ้นต้น `> Status: approved` | 1.4 | สถานะที่เจอ + บอกว่าต้อง approve ก่อน, ไม่มี bypass |
| ไม่มี `## REQ-` heading (รวม bugfix F-/B-) | 1.5 | "REQ-form feature specs only" |
| duplicate criterion ID | 1.7 | ID ที่ซ้ำ |
| REQ heading ไม่มี criteria | 1.8 | REQ ที่ว่าง |
| output มีอยู่ + ไม่มี `--force` | 4.2 | path + แนะ `--force`; ไฟล์เดิม byte-identical (ไม่แตะเลย — เช็คก่อนเขียน temp) |
| tasks.md ไม่มี | 1.6 | **warning** (stderr) — ไม่ refuse; ทุก AC unresolved |
| git ใช้ไม่ได้ | 3.5 | **warning** — `head_commit: "unknown"` |

ลำดับ gate: resolve paths → read+header check → parse → structural checks (1.5→1.7→1.8)
→ tasks read/map → output-exists check → write. Output-exists เช็คหลัง validation ทั้งหมด
โดยเจตนา: ผู้ใช้เห็น error ของ spec ก่อนเรื่อง `--force` (spec ผิดต้องรู้ไม่ว่า force ไหม).

stderr noise ที่ยอมรับ: `parse_requirements` มี side-effect print คำเตือน near-miss
(บรรทัด `- N.M.` ที่ไม่ตรง format — spec_trace.py:78) ลง stderr — คงไว้ (เป็นคำเตือน
ที่มีประโยชน์) และไม่กระทบ exit code; REQ-5.3 "single-line reason" ตีความเป็น "เหตุผล
ของ refusal เป็นบรรทัดเดียว" ไม่ใช่ "stderr ทั้งหมดมีบรรทัดเดียว".

## Residual Risk (ขีดจำกัดที่ยอมรับใน Stage 1 — ห้าม claim เกิน)

`freezeContract` ตรวจเชิงโครงสร้างเท่านั้น: `goal.id`, `acceptance_criteria` ไม่ว่าง,
budget 3 field. มัน**ไม่ตรวจ**: `objective`/`scope`/`constraints.forbidden`/`risk`/
เนื้อหา `verification`. ผลที่ต้องพูดตรงๆ:

1. **เส้น resolved ครบ (REQ-4.5):** draft freeze ผ่านทันทีทั้งที่ objective/scope/
   forbidden/risk/approval_policy ยังเป็น TODO — การป้องกันเส้นนี้มีแค่ HUMAN banner
   (advisory) + วินัย operator; ไม่มี structural gate. Stage 1 แตะ runtime ไม่ได้
   จึงปิดไม่ได้ที่นี่
2. **Rename โดยไม่ fill (เส้น unresolved):** human ที่ rename `pending_*` →
   `acceptance_criteria` โดยข้าม step (1) ได้ contract ที่ freeze ผ่านพร้อม
   `verification: "TODO"` ปลอม — banner เตือนชัดแล้ว (ดู template) แต่บังคับไม่ได้
3. **Fail-loud path เดียวที่ฟรี:** rename แล้วลืมลบ `acceptance_criteria: []` เดิม →
   duplicate key → `yaml` parser ของ loop-cli throw ตอน parse (uniqueKeys default)
   ก่อนถึง freeze — พังดังไม่พังเงียบ

**Handoff → Stage 2 (goal.schema.json):** ปิด 1+2 ที่ schema layer — reject
`verification: "TODO"` / `objective: "TODO"`, ประกาศ `pending_acceptance_criteria`
เป็น draft-only key (ห้ามมีตอน freeze), `risk` เป็น typed enum. บันทึกใน spec ของ
Stage 2 — ไม่ใช่ scope ที่นี่.

## Testing Strategy

ไฟล์เดียว: `console/backend/src/spec-to-goal.e2e.test.ts` — ทุก case `execFile` generator
จริง (ผ่าน `python3 <abs-path>/scripts/spec_to_goal.py` — resolve path แบบ absolute
จาก repo root ใน test เพราะ cwd ของ test runner คือ `console/backend`; ไม่ผ่าน .sh
เพื่อตัด PATH variance; มี 1 case เรียกผ่าน `.sh` เพื่อพิสูจน์ wrapper) กับ fixture spec
ที่ test เขียนลง temp dir (`--specs-dir` ชี้ temp) — ไม่ commit fixture เพิ่ม ยกเว้น
reuse archive จริง. Precondition ของ CI: job `platform` ต้องมี `python3` บน PATH —
ubuntu runner มีอยู่แล้ว แต่ task implementation ต้อง verify และ skip test พร้อม
ข้อความชัดถ้าไม่มี (local dev บางเครื่อง):

| Test case | REQs |
|---|---|
| spec สมบูรณ์ (ทุก criterion → 1 task + Verify) → exit 0, YAML parse ผ่าน, `freezeContract` **ผ่าน**, ไม่มี `pending_*`, ไม่มี `golden` key | 2.1, 2.2, 2.4, 2.6, 3.7, 4.5, 5.2 |
| spec มี criterion ที่ 2 tasks cover + criterion ที่ task ไม่มี Verify → `acceptance_criteria: []`, `pending_*` ครบทุก criterion, `freezeContract` **throw** | 2.5, 4.4 |
| ไม่มี tasks.md → warn บน stderr, ทุกตัว unresolved, freeze throw | 1.6, 4.4 |
| header `Status: draft` → exit 1 / header `approved ..., amended ...` → ผ่าน gate | 1.4 |
| requirements.md หาย / ไม่มี REQ heading / dup ID / REQ ว่าง → exit 1 + message ตรงตาราง | 1.3, 1.5, 1.7, 1.8 |
| output มีอยู่: ไม่มี --force → exit 1 + ไฟล์ byte-identical; มี --force → overwritten | 4.2, 4.3 |
| draft shape: goal.id/title, scope/forbidden TODO, budget 6 key ตรง literal, provenance header (sha256 ตรงกับ bytes จริง), HUMAN banner ครบ 4 ข้อ | 3.1-3.6 |
| Satisfies รูป `REQ-N (all criteria)` + dash range → mapping ตาม spec_trace semantics | 2.3 |
| spec_trace refactor regression: `spec-trace.sh platform-phase4 .ai/specs/archive` ยัง exit 0 (พิสูจน์ `iter_task_blocks` refactor ไม่เปลี่ยนผล satisfies_text) | 2.3 |
| e2e กับ archive จริง: `--specs-dir .ai/specs/archive platform-phase4` → exit 0, YAML parse ผ่าน, header บรรทัด 3 + amended form ผ่าน gate, title = "platform-phase4" (H1 em-dash form) | 1.2, 1.1, 1.4, 3.2 |
| generator ไม่แตะไฟล์อื่น: หลังรัน สแกน temp dir — มีแค่ goal.draft.yaml ใหม่ไฟล์เดียว | 4.1, 4.6 |
| wrapper: `spec-to-goal.sh` case เดียว (happy path) | 5.1 |

Property-style เสริมใน case แรก: ทุก criterion จาก `parse_requirements` ต้องมี AC id
ตรงกัน 1:1 (นับ + set เท่ากัน) — จับ off-by-one ของ mapping.

## Requirement Traceability

| Design element | Satisfies |
|---|---|
| CLI (`argparse`: positional feature, `--force`, `--specs-dir`) + wrapper `spec-to-goal.sh` | REQ-1.1, REQ-1.2, REQ-5.1 |
| Gate chain ใน `main()`: missing-file, header-prefix check, no-REQ-heading, dup-ID, empty-REQ | REQ-1.3, REQ-1.4, REQ-1.5, REQ-1.7, REQ-1.8 |
| tasks.md-absent path (warn + all-unresolved) | REQ-1.6 |
| Mapper: `import spec_trace` (`parse_requirements`/`expand_refs`/`iter_task_blocks` helper ใหม่ที่ `satisfies_text` refactor ไปใช้ร่วม) + Verify-extraction + unique-cover rule | REQ-2.1, REQ-2.2, REQ-2.3, REQ-2.4, REQ-2.5 |
| Emitter: AC dict ไม่มี `golden` key | REQ-2.6 |
| Emitter: goal block (`id` slug-upper-001, `title` จาก H1), scope/forbidden TODO, budget literal, provenance header (path+HEAD+sha256+timestamp), HUMAN banner, `json.dumps` ทุก scalar | REQ-3.1, REQ-3.2, REQ-3.3, REQ-3.4, REQ-3.5, REQ-3.6, REQ-3.7 |
| Output path คงที่ `<feature>/goal.draft.yaml` ใต้ specs dir | REQ-4.1 |
| Exists-check ก่อนเขียน + `--force` branch + atomic temp/replace | REQ-4.2, REQ-4.3 |
| Empty-active + `pending_acceptance_criteria` shape / all-resolved active shape | REQ-4.4, REQ-4.5 |
| `main()` เขียนไฟล์เดียว + stdout/stderr เท่านั้น — ไม่ import/เรียก runtime ใด; ข้อยกเว้นเดียว: `git rev-parse HEAD` (read-only subprocess เพื่อ provenance ตาม REQ-3.5, analyze log) | REQ-4.6 |
| Summary line + exit-code discipline | REQ-5.2, REQ-5.3 |

## Deviations / Notes

- Test อยู่ console/backend (ไม่ใช่ scripts/) — เหตุผลใน Architecture Overview;
  เป็น test-only coupling, production code ไม่ข้าม layer
- `pending_acceptance_criteria` เป็น key ใหม่นอก §11.1 — อยู่เฉพาะใน draft, ตกใน
  `contract.raw` ถ้าหลุดไปถึง freeze; Stage 2 schema จะประกาศ key นี้อย่างเป็นทางการ
  (draft-only, ห้ามมีตอน freeze) — บันทึกไว้กัน schema strict แล้ว reject draft เก่า
- **แตะ `scripts/spec_trace.py`** (เพิ่ม `iter_task_blocks` + refactor `satisfies_text`
  ให้ใช้ helper) — ไฟล์นี้เป็น CI-critical (spec trace ทุก spec + archive); guard สองชั้น:
  (1) regression case ใน e2e test (spec-trace บน archive ต้องยัง OK), (2) CI verify job
  รัน spec-trace ทุก feature อยู่แล้ว — refactor ที่เปลี่ยนผลจะแดงทันที
- `risk: "TODO"` placeholder ใน template ไม่อยู่ใน REQ-3.3 (ซึ่งระบุแค่ scope/forbidden)
  — เพิ่มเพื่อรองรับ banner step "set risk" (REQ-3.6): key ที่มองเห็นดีกว่าให้ human
  จำเองว่าต้องเพิ่ม; string "TODO" ที่ `parseRisk` ไม่รู้จัก → default L2 เหมือน absent
  (ไม่เปลี่ยนพฤติกรรม runtime)
