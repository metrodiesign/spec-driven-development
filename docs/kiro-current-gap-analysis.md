# Kiro current gap analysis

เอกสารนี้เทียบ capability ที่ Kiro ประกาศไว้กับ framework ใน repo ณ วันที่ 2026-08-09 เพื่อเลือกการปรับปรุงที่เพิ่มประสิทธิภาพสูงสุดโดยไม่สร้างระบบซ้ำ. ข้อสรุปหลักคือควรปิด contract gap ของ context routing ที่มีอยู่แล้ว ก่อนเพิ่ม workflow หรือ hook surface ใหม่.

> Update 2026-08-09: recommendation อันดับ 1 ถูก implement ใต้
> `.ai/specs/bugfix-spec-slice-contract/`; ส่วน baseline และข้อเสนอด้านล่างคงไว้เป็น
> decision record ก่อนแก้. ผลหลังแก้คือ `context-accumulation` task 1–4 มี `MISSING:` 0/4
> และแต่ละ task คืน DESIGN section จริง 2 section.

## วิธีอ่านและวิธีตรวจ

- `[DOCUMENTED]` คือข้อเท็จจริงจาก official Kiro documentation หรือ contract ที่เขียนไว้ใน repo.
- `[INFERRED]` คือข้อสรุปจากการเทียบเอกสารกับไฟล์จริงหรือผลรันคำสั่งแบบ read-only.
- `[PROPOSED]` คือข้อเสนอที่ยังไม่ได้ implement.
- ตรวจ URL ทั้ง 16 รายการจาก master prompt โดยเปิด URL ตรงและติดตาม final URL; title และวันที่ใช้ข้อความที่หน้าเว็บแสดง ไม่ใช่ HTTP `Last-Modified`.
- ตรวจ repo จาก `.ai/`, `.agents/`, `.claude/`, `.codex/`, Git/CI guards, scripts, tests และ active specs. หลักฐาน `path:line` อ้าง state ที่ตรวจ ณ วันที่ข้างต้น.
- ทุกหน้าเข้าถึงได้. ข้อจำกัดคือเอกสารสาธารณะยืนยัน documented behavior ไม่ได้พิสูจน์ runtime behavior ภายใน Kiro; การประเมิน effort/risk จึงเป็น comparative judgment ไม่ใช่ benchmark ของ vendor.

## Official source inventory

| # | Requested URL | Final/canonical URL, current title | วันที่หน้าแสดง / การเปลี่ยนชื่อ |
|---:|---|---|---|
| 1 | [Feature Specs](https://kiro.dev/docs/specs/feature-specs/) | URL เดิม — `Feature Specs` | Aug 4, 2026 |
| 2 | [Requirements-first](https://kiro.dev/docs/specs/feature-specs/requirements-first/) | URL เดิม — `Requirements-First Workflow` | Jun 25, 2026 |
| 3 | [tech-design-first](https://kiro.dev/docs/specs/feature-specs/tech-design-first/) | URL เดิม — `Design-First Workflow` | Feb 18, 2026; slug เก่า แต่ชื่อปัจจุบันตัดคำว่า `Tech` |
| 4 | [Bugfix Specs](https://kiro.dev/docs/specs/bugfix-specs/) | URL เดิม — `Bugfix Specs` | Aug 4, 2026 |
| 5 | [quick-plan](https://kiro.dev/docs/specs/quick-plan/) | [quick-spec](https://kiro.dev/docs/specs/quick-spec/) — `Quick Spec` | Aug 4, 2026; redirect และ rename จาก `Quick Plan` |
| 6 | [Analyze Requirements](https://kiro.dev/docs/specs/analyze-requirements/) | URL เดิม — `Analyze Requirements` | Aug 4, 2026 |
| 7 | [Correctness](https://kiro.dev/docs/specs/correctness/) | URL เดิม — `Correctness with Property-based tests` | Aug 4, 2026 |
| 8 | [Specs best practices](https://kiro.dev/docs/specs/best-practices/) | URL เดิม — `Best practices` | Aug 4, 2026 |
| 9 | [Hook types](https://kiro.dev/docs/hooks/types/) | URL เดิม — `Hook types` | Aug 4, 2026 |
| 10 | [Hook actions](https://kiro.dev/docs/hooks/actions/) | URL เดิม — `Hook actions` | Aug 4, 2026 |
| 11 | [Hook examples](https://kiro.dev/docs/hooks/examples/) | URL เดิม — `Hook examples` | Aug 4, 2026 |
| 12 | [Hook management](https://kiro.dev/docs/hooks/management/) | URL เดิม — `Hook management` | Aug 4, 2026 |
| 13 | [Hooks best practices](https://kiro.dev/docs/hooks/best-practices/) | URL เดิม — `Best practices` | Aug 4, 2026 |
| 14 | [Hooks troubleshooting](https://kiro.dev/docs/hooks/troubleshooting/) | URL เดิม — `Troubleshooting hooks` | Aug 4, 2026 |
| 15 | [Steering](https://kiro.dev/docs/steering/) | URL เดิม — `Steering` | Aug 4, 2026 |
| 16 | [Agent Skills](https://kiro.dev/docs/skills/) | URL เดิม — `Agent Skills` | Aug 4, 2026 |

หมายเหตุ: ในเอกสารหรือ automation ใหม่ควรใช้ `Quick Spec` และ `/quick-spec/`; เก็บ `/quick-plan/` ไว้ได้เฉพาะเป็น compatibility reference.

## Capability baseline ของ Kiro

- [DOCUMENTED] Feature Specs มีสองลำดับที่ชัด: Requirements-First คือ Requirements → Design → Tasks และ Design-First คือ Design → Requirements → Tasks; Requirements ใช้ EARS และสามารถ Analyze Requirements ก่อน design ได้. แหล่งอ้างอิง: [Feature Specs](https://kiro.dev/docs/specs/feature-specs/), [Requirements-First Workflow](https://kiro.dev/docs/specs/feature-specs/requirements-first/), [Design-First Workflow](https://kiro.dev/docs/specs/feature-specs/tech-design-first/), [Analyze Requirements](https://kiro.dev/docs/specs/analyze-requirements/).
- [DOCUMENTED] Bugfix Specs แยก current/expected/unchanged behavior, root cause, fix และ regression properties; Quick Spec สร้าง requirements/design/tasks ในรอบเดียวหลังถาม clarification ล่วงหน้า. แหล่งอ้างอิง: [Bugfix Specs](https://kiro.dev/docs/specs/bugfix-specs/), [Quick Spec](https://kiro.dev/docs/specs/quick-spec/).
- [DOCUMENTED] Kiro เชื่อม EARS → correctness properties → optional property-based tests และ shrinking แต่ระบุว่า PBT flow นี้รองรับใน IDE เท่านั้นและไม่ใช่ formal proof. แหล่งอ้างอิง: [Correctness with Property-based tests](https://kiro.dev/docs/specs/correctness/).
- [DOCUMENTED] `Run All Tasks` สร้าง dependency graph และรัน independent tasks เป็น parallel waves; incomplete required tasks คือ scope เริ่มต้น. แหล่งอ้างอิง: [Specs best practices](https://kiro.dev/docs/specs/best-practices/).
- [DOCUMENTED] Hooks ครอบคลุม Prompt Submit, Agent Stop/Spawn, Pre/Post Tool, file events, Pre/Post Task และ Manual โดยรองรับ Agent Prompt หรือ Shell Command; shell action มี timeout และ exit semantics. แหล่งอ้างอิง: [Hook types](https://kiro.dev/docs/hooks/types/), [Hook actions](https://kiro.dev/docs/hooks/actions/), [Hook examples](https://kiro.dev/docs/hooks/examples/), [Hook management](https://kiro.dev/docs/hooks/management/), [Hook best practices](https://kiro.dev/docs/hooks/best-practices/), [Hook troubleshooting](https://kiro.dev/docs/hooks/troubleshooting/).
- [DOCUMENTED] Steering รองรับ workspace/global precedence และ inclusion แบบ `always`, `fileMatch`, `manual`, `auto`; Agent Skills ใช้ progressive disclosure โดยโหลด metadata ก่อน แล้วค่อยโหลด `SKILL.md` และ resources เมื่อ activate. แหล่งอ้างอิง: [Steering](https://kiro.dev/docs/steering/), [Agent Skills](https://kiro.dev/docs/skills/).

## สิ่งที่ repo มีแล้ว

| Capability | สถานะและหลักฐาน |
|---|---|
| Requirements-first, Design-first, EARS และ approval gates | [DOCUMENTED] มีครบและเป็น canonical workflow (`.ai/shared/TASK_PROTOCOL.md:4`, `.claude/skills/spec-design/SKILL.md:12`, `.claude/skills/spec-design/SKILL.md:18`, `.ai/shared/EARS.md:16`). |
| Analyze, Bugfix, Quick Spec และ PBT | [DOCUMENTED] มี skill เฉพาะ และ `.agents/skills/spec-*` route ไป canonical `.claude/skills/*` แทนการ duplicate (`.ai/README.md:11-17`, `.agents/skills/spec-analyze/SKILL.md:8`, `.agents/skills/spec-bugfix/SKILL.md:10`, `.agents/skills/spec-pbt/SKILL.md:10`). |
| Cross-harness Agent Skills | [DOCUMENTED] Codex/OpenCode/Pi ใช้ `.agents/skills/` ชุดเดียว; Claude ใช้ canonical body เดียวกัน (`.ai/README.md:42-49`, `.ai/agents/codex/AGENT.md:52-60`). |
| Deterministic enforcement | [DOCUMENTED] Git hooks บังคับ secret/Evidence/protected-branch และ CI รัน typecheck, lint, tests, guard tests, secret scan และ spec trace (`AGENTS.md:44-49`, `.github/workflows/ci.yml:34-72`, `.github/workflows/ci.yml:85-94`). นี่แข็งแรงกว่าการพึ่ง agent prompt อย่างเดียว. |
| Harness hooks | [DOCUMENTED] Claude และ Codex มี Pre/Post Tool, task gate และ persistence hooks แต่ Codex interactive hooks ต้อง trust และ headless automation พึ่ง Git/CI floor (`.claude/settings.json:2-54`, `.codex/config.toml:15-24`, `.codex/config.toml:26-49`). |
| Context slicing | [DOCUMENTED] `/spec-implement` เรียก `scripts/spec-slice.sh` ก่อน และ fallback ไปอ่าน requirements/design เต็มเมื่อพบ `MISSING:` (`.claude/skills/spec-implement/SKILL.md:33-43`). `spec-design` กำหนด `Section` ให้ตรงกับ `##` heading จริง (`.claude/skills/spec-design/SKILL.md:29-43`). |

[INFERRED] ดังนั้น repo ไม่ได้ขาด “Kiro-style SDD” ในภาพรวม: workflow หลัก, durable artifacts, analysis, bugfix, PBT, skills และ enforcement มีอยู่แล้ว. การสร้าง package ใหม่เลียนแบบ Kiro จะเพิ่ม duplication มากกว่าประสิทธิภาพ.

## Gap ที่จัดอันดับแล้ว

เกณฑ์: Impact วัดผลต่อเวลา/ความถูกต้องในงานประจำ, Effort คือขนาดงานโดยประมาณ, Risk คือโอกาสทำให้ workflow เดิมถอย.

| อันดับ | Gap | Impact | Effort | Risk | เหตุผลตัดสิน |
|---:|---|---|---|---|---|
| 1 | Context-routing contract ไม่ถูก enforce | สูง | ต่ำ | ต่ำ | [INFERRED] `spec-design` กำหนด `Section` ชัด แต่ `spec-quick` ยังบอกเพียง REQ → file/function (`.claude/skills/spec-quick/SKILL.md:35-37`) และ `spec-trace` ตรวจ coverage ของ REQ โดยไม่รับรองว่า slicer resolve section ได้ (`scripts/spec_trace.py:112-113`, `scripts/spec_trace.py:231-237`). Active spec จึงผ่าน trace แต่ fallback ทุก task. |
| 2 | ไม่มี dependency-DAG parallel waves ใน execution path มาตรฐาน | สูงต่อ wall-clock | สูง | กลาง-สูง | [INFERRED] repo บันทึก `Depends on`/`Batch` แต่ `/spec-implement all` ทำหลาย task ตาม dependency order ใน session เดียว (`.claude/skills/spec-implement/SKILL.md:9-10`, `.claude/skills/spec-implement/SKILL.md:72`; `.claude/skills/spec-tasks/SKILL.md:65-71`). ต่างจาก [Kiro Run All Tasks](https://kiro.dev/docs/specs/best-practices/) แต่เป็น trade-off เรื่อง accuracy/cost ที่ตั้งใจไว้ จึงไม่ใช่ quick win. |
| 3 | ไม่มี vendor-neutral conditional steering schema | กลาง | กลาง | กลาง | [INFERRED] repo ใช้ read order แบบ always-on และ optional stack profile (`AGENTS.md:13-26`, `.ai/shared/stack/README.md:13-18`) แต่ไม่มี equivalent กลางของ Kiro `fileMatch`/`manual`/`auto`. มีโอกาสลด context แต่ต้องออกแบบ semantics ข้าม harness จึงเสี่ยงกว่า gap อันดับ 1. |
| 4 | PBT integration ยังเป็น opt-in manual branch | กลาง | กลาง | กลาง | [INFERRED] `/spec-pbt` ให้ผู้ใช้เลือก properties และ fallback เป็น randomized loops เมื่อไม่มี framework (`.claude/skills/spec-pbt/SKILL.md:14-31`) ขณะที่ [Kiro correctness flow](https://kiro.dev/docs/specs/correctness/) เชื่อม property เข้ากับ design/tasks โดยตรง. ประโยชน์สูงเฉพาะ logic-heavy specs ไม่ใช่ทุก task. |
| 5 | Hook event/action surface แคบกว่า Kiro | กลาง | สูง | สูง | [INFERRED] repo มี guard สำคัญและ CI floor แล้ว แต่ไม่ได้ทำ parity ทุก event หรือ Agent Prompt action. การเพิ่มตาม [Hook types](https://kiro.dev/docs/hooks/types/) และ [Hook actions](https://kiro.dev/docs/hooks/actions/) แบบ wholesale จะผูก vendor behavior และเพิ่ม failure surface; ทำเฉพาะเมื่อมี use case วัดได้. |

## ขอบเขตการตัดสินใจ

[PROPOSED] รอบปรับปรุงถัดไปควรถือว่าเป็นงานซ่อม context-routing contract ไม่ใช่งานเพิ่ม platform capability.

### อยู่ในขอบเขต

- ทำให้ producer ทุก path ใช้ traceability schema เดียวกัน.
- ทำให้ validator ปฏิเสธ `Section` ที่หายหรือชี้ heading ไม่ได้.
- เพิ่ม regression fixture ที่พิสูจน์ทั้ง fail และ pass path.
- ซ่อม active artifact ที่ validator ใหม่ตรวจพบเท่านั้น.

### เลื่อนไปก่อน

- Dependency-DAG executor จนกว่าจะมี wall-clock benchmark และ isolation contract.
- Conditional steering schema จนกว่าจะนิยาม semantics ข้าม harness ได้.
- PBT auto-generation จนกว่าจะเลือก provenance และ framework policy.
- Hook parity จนกว่าจะมี event-specific use case ที่ Git/CI floor แก้ไม่ได้.

### ไม่แนะนำ

[PROPOSED] ไม่สร้าง Kiro-compatible 27-file package, slicer ตัวที่สอง หรือ metadata format ใหม่ เพราะ capability หลักมีอยู่แล้วและ root cause คือ contract drift ระหว่าง producer, validator และ consumer.

## หลักฐานของ gap อันดับ 1

- [DOCUMENTED] `scripts/spec-slice.sh` ต้องใช้ `Section` column และส่ง `MISSING:` เมื่อ resolve ไม่ได้ เพื่อให้ caller fallback อย่างปลอดภัย (`scripts/spec-slice.sh:4-11`, `scripts/spec-slice.sh:173-184`).
- [INFERRED] Active spec `context-accumulation` ใช้ตาราง `| เกณฑ์ | ลงที่ไหนในดีไซน์ |` ไม่มี `Section` (`.ai/specs/context-accumulation/design.md:190-213`).
- [INFERRED] ผลรัน `scripts/spec-trace.sh context-accumulation` ณ 2026-08-09 คือ `OK` ครบ 21 criteria แต่ `scripts/spec-slice.sh context-accumulation 1`, `2`, `3`, `4` มี `MISSING: design section ...` ทุก task: baseline failure 4/4 หรือ 100%.
- [INFERRED] `requirements.md` + `design.md` มีขนาด raw 60,591 bytes. เพราะ `/spec-implement` กำหนด full fallback เมื่อมี `MISSING:`, แต่ละ task จึงต้องรับ full-artifact input เพิ่มจาก slice; ตัวเลขนี้เป็น byte baseline ไม่ใช่ billed-token measurement.
- [INFERRED] ปัญหานี้เคยถูกแก้ด้วยการ retrofit active specs 11 ชุดและตรวจทุก task ว่าไม่มี `MISSING:` (`.ai/specs/archive/sdd-spec-context-loading/tasks.md:201-235`) แต่ contract ยังปล่อย artifact ใหม่ถอยกลับได้. Lesson เดิมที่ยังบอกว่า “Not fixed” จึงล้าสมัยเมื่อเทียบกับ evidence ดังกล่าว (`.ai/shared/LESSONS.md:54`).

## Recommendation เดียว

[PROPOSED] เพิ่ม **structural context-routing gate** ลงในกลไก `spec-trace` เดิม: สำหรับ non-bugfix `design.md`, บังคับให้ `Requirement Traceability` มี column ชื่อ `Section` และทุกค่าตรงกับ real `##` heading; align ข้อความของ Quick Spec ให้ใช้ schema เดียวกับ `spec-design`; แล้ว retrofit เฉพาะ active spec ที่ fail. ไม่สร้าง slicer, metadata format, workflow หรือ package ใหม่.

เหตุผลที่เลือก: เป็น defect บน critical path ที่เกิดจริง, fallback ซ่อนต้นทุนไว้หลังผล `spec-trace` สีเขียว, และมี authoring convention + slicer + tests อยู่แล้ว. การ enforce contract ที่ producer/CI boundary จึงเล็กกว่าและเสี่ยงน้อยกว่าการเพิ่ม task scheduler, steering engine หรือ hook parity.

### Baseline และ target ที่วัดได้

| Metric | Baseline 2026-08-09 | Target หลังปรับ |
|---|---:|---:|
| Incomplete tasks ของ `context-accumulation` ที่ slice มี `MISSING:` | 4/4 (100%) | 0/4 (0%) |
| Task slices ที่คืนอย่างน้อยหนึ่ง real DESIGN section | 0/4 | 4/4 |
| Active spec ที่ traceability schema ใช้กับ slicer ไม่ได้แต่ `spec-trace` ปล่อยผ่าน | 1 | 0; command ต้อง fail พร้อม actionable message |
| Full requirements+design fallback จาก gap นี้ | 60,591 raw bytes ต่อ task | 0 bytes ต่อ task |

Definition of done ของข้อเสนอคือ guard regression test เขียว, sweep ทุก incomplete task ใน active non-bugfix specs ได้ `MISSING:` เท่ากับศูนย์, และ `spec-trace` เดิมยังตรวจ bidirectional REQ coverage ได้ครบ. ไม่ควรอ้าง token/cost saving จนกว่าจะวัดจาก session ledger จริงหลังใช้งาน.

## ข้อสรุปสำหรับการตัดสินใจ

[INFERRED] ให้ลงทุนที่ context-routing gate ก่อน. Repo มี capability parity หลักกับ Kiro อยู่มากแล้ว แต่ contract ที่ไม่ถูก enforce ทำให้ optimization ที่ implement แล้วไม่ทำงานกับ active spec หนึ่งชุดโดยที่ gate ยังรายงานเขียว; การปิดรูนี้ให้ผลทันที วัดได้ และไม่เพิ่ม conceptual surface ใหม่.
