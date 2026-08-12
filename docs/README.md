# คู่มือการทำงาน (Operating Manual)

คู่มือปฏิบัติของโปรเจกต์นี้ — spec-driven development, automation, cost/retro และ
Universal PR Quality Gate. อ่านตามลำดับสำหรับคนใหม่ หรือกระโดดเข้าหัวข้อที่ต้องการ.

## สารบัญ

1. [Spec-driven flow + gates](01-spec-driven-flow.md) — วงจร requirements -> design -> tasks
   -> implement -> retro, approval gate, EARS, การ size task, slash command ทั้งหมด
2. [Automation (pane-loop)](02-automation.md) — รันหลาย task อัตโนมัติด้วย interactive pane
   (สรุป + ลิงก์คู่มือเต็ม `../scripts/pane-loop.md`)
3. [Cost ledger + retrospective](03-cost-and-retro.md) — cost จริงต่อ session/task, ledger,
   สคริปต์ cost, การทำ retro และ promote บทเรียน
4. [Git / PR + rules](04-git-pr-and-rules.md) — นโยบาย branch/PR, secrets/CI/destructive,
   conventions (structure/tech/product)
5. [Hooks / guardrails](05-hooks.md) — ชั้น deterministic hook (destructive/secret/spec-edit/
   task-gate/precompact) ที่ block/warn อัตโนมัติรอบ tool call
6. [GitHub Issues (teammate visibility)](06-github-issues.md) — เชื่อม spec -> GitHub Issues,
   epic + sub-issue, label, ผูก PR, CI gate
7. [Packages / workspace guide](07-packages.md) — แต่ละ workspace (core/aal/adapters/console/scripts)
   คืออะไร รับผิดชอบอะไร งานแบบไหนลงที่ไหน พร้อมตัวอย่างโค้ดจริง + ตาราง "งานแบบนี้ลงที่ไหน"
8. [Universal PR Quality Gate production](08-pr-quality-gate-production.md) — activation gate,
   GitHub Actions, CLI, Console, REST API, conformance, monitoring, troubleshooting และ rollback

## แหล่งความจริง (source of truth) — ห้ามขัดกับไฟล์เหล่านี้

| เรื่อง | ไฟล์ |
|---|---|
| Front door ทุก agent | `../AGENTS.md` |
| Product/architecture/standards/protocol | `../.ai/shared/` |
| บทเรียนสะสม | `../.ai/shared/LESSONS.md` |
| Spec ของแต่ละฟีเจอร์ | `../.ai/specs/<feature>/` |
| Spec skills ที่ทุก harness เรียกได้ | `../.agents/skills/spec-*/` |
| Check engine กลาง | `../.ai/bin/` |
| Git enforcement floor | `../.githooks/` + `../.github/workflows/` |
| Per-agent adapters | `../.ai/agents/` + `../.{claude,codex,opencode}/` |
| PR gate production contract | `08-pr-quality-gate-production.md` |
| อ้างอิง Kiro gap ล่าสุด | `kiro-current-gap-analysis.md` |

> เอกสารใน `docs/` เป็นคู่มือวิธีทำงาน. เมื่อขัดกับ approved feature spec, `.ai/shared/`,
> policy/workflow หรือ source runtime ให้ยึด contract เหล่านั้น แล้วอัปเดต docs ตาม.
