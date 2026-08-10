> Canonical source for ALL agents (Claude loads via .claude/rules stub; Codex/OpenCode/Pi read directly).
> แก้ที่นี่ที่เดียว — single source of truth.

# Project Structure

## Folder Layout

โครงสร้างจริงของ repo นี้ (ตัว framework เอง) เป็นตัวอย่าง concrete ของการแยก
operating layer ที่ vendor-neutral ออกจาก per-agent adapter:

```
.ai/                  # operating layer ที่ใช้ร่วมทุก agent (durable source of truth)
  shared/             # มาตรฐาน + protocol ที่อ่านได้ทุก agent (PROJECT_CONTEXT, CODING_STANDARDS,
                      #   ARCHITECTURE, LESSONS, TASK_PROTOCOL, EARS, REVIEW/TESTING/SECURITY/...)
  bin/                # check engine จริง (gate-task.sh, check-secrets.sh, check-destructive.sh, ...)
  roles/              # นิยาม role กลาง (spec-architect, bug-investigator, pbt-runner)
  workflows/          # คู่มือ flow ต่อชนิดงาน (feature, bug-fix, code-review, ...)
  templates/          # template ของ artifact (handoff note, review report, task brief, ...)
  agents/             # per-agent adapter map (claude/, codex/, opencode/, pi/)
  policies/           # governed runtime policies รวม pr-quality-gate.json
  schemas/            # durable JSON schemas รวม PR reviewer/Judge/result
  governance/         # append-only policy proposals/approvals
  calibration/        # per-lineage conformance records/evidence
  specs/              # approved feature artifacts + handoff
.claude/              # Claude Code adapter — agents/, commands/, hooks/, rules/ (stub), skills/,
                      #   specs/, settings.json
.codex/               # Codex adapter — agents/, hooks/, config.toml
.opencode/            # OpenCode adapter — agents/, commands/, plugins/
.agents/              # adapter ร่วม (skills/)
.githooks/            # enforcement floor (Tier 1): pre-commit, pre-push
.github/              # CI + PR quality analysis/finalize workflows + PR template
scripts/              # automation (pane-loop, cost/trace tooling, spec-state, ...)
docs/                 # คู่มือผู้ใช้ของ framework
retrospectives/       # บันทึก retro รายเดือน
```

`specs/<feature-name>/` ภายใต้ `.ai/` เก็บ `requirements.md`, `design.md`, `tasks.md`,
`handoff.md` และ optional `.github-sync.json` sidecar.

> layout นี้เป็นตัวแทนหลัก ไม่ exhaustive — ground truth คือ `ls` จริง;
> /spec-retro มีขั้น steering sync คอยเทียบให้ตรง

## Application structure (per project)

`.ai/` คือ operating layer ของ framework ไม่ใช่ของแอป — แต่ละ project ที่ใช้ framework นี้
จัดวาง source ของตัวเองอย่างไรก็ได้ตาม stack ที่เลือก โดยยึด PRINCIPLE ต่อไปนี้
(ไม่ผูกกับ framework/ภาษาใดภาษาหนึ่ง):

- แยก pure logic ออกจาก presentation — logic คำนวณ/validate/transform อยู่คนละชั้นกับ
  ส่วน UI; ส่วน UI เรียกใช้ ไม่ฝังสูตรไว้ในตัว view
- co-locate unit test ไว้ข้าง logic ที่มันทดสอบ (test อยู่ติดกับโค้ดที่รับผิดชอบ)
- config/design token มี single source ที่เดียว — เรียกผ่าน semantic reference ไม่ทำซ้ำค่าดิบ
- จัด import เป็นชั้น: external ก่อน → internal absolute → relative
- naming convention ชัดและคงเส้นคงวาทั้ง project (ดู Naming Conventions ด้านล่าง)

`.github-sync.json` ใน `.ai/specs/<feature>/` = sidecar manifest ของ `/spec-sync-github`
(link map issue<->task) — commit เข้า repo, เฉพาะคำสั่ง sync เขียน; ห้ามแก้มือ,
ห้ามใส่ link ลง tasks.md

## Naming Conventions

- type/interface: PascalCase
- ไฟล์ logic/data: ตาม convention ของภาษา/stack ที่ project เลือก แต่คงเส้นคงวาทั้ง repo
- ค่าคงที่ที่ export: ตั้งชื่อสื่อความหมาย + มี type ชัด

## Import Ordering

1. external (dependency ของภายนอก)
2. internal absolute (โมดูลภายใน project)
3. relative (`./...`)

## Architectural Patterns

- logic คำนวณ/validate แยกเป็นชั้นของตัวเอง — ส่วน UI เรียกใช้ ไม่ฝังสูตรไว้ในตัว view
- data แยกจากตัว presentation — ส่งผ่าน props หรือ import โดยตรง ไม่ inline ก้อนใหญ่ในไฟล์ view
- design token อยู่ที่เดียว — เรียกผ่าน semantic reference
- ถ้า project มี UI: องค์ประกอบ interactive มี state ครบ (default/hover/focus/active/disabled)
  และ accessible เป็น principle (keyboard reachable, focus มองเห็น, contrast พอ)
- โค้ดพิสูจน์ว่าเขียวด้วย `.ai/bin/gate-task.sh` ตอน flip task เป็น `[x]`: gate อ่าน
  `SDD_TYPECHECK_CMD` / `SDD_TEST_CMD` (auto-detect script ใน package.json ให้ project แบบ Node)
  เพื่อรัน typecheck/test; เมื่อไม่มีทั้งคู่จะข้าม code-green แล้วเหลือเพียง Evidence gate

## Universal PR Quality Gate boundary

PR gate reuse สาม ring เดิม แต่แยก GitHub trust boundary ที่ composition root:

| Layer | Ownership |
|---|---|
| `core/src/pr-gate/` | vendor-neutral contracts, policy merge, state transitions, deterministic decision และ budget/idempotency |
| `aal/src/pr-review/` | identical-context blind panel, structured validation และ anonymized Judge orchestration |
| `adapters/src/` | provider wire/CLI/SDK, explicit env allowlist, timeout/cancellation; ไม่ execute PR action |
| `console/backend/src/pr-gate/` | Git pin/snapshot/classification/context, manager, artifacts, GitHub read/report และ workflow provenance |
| `console/web/src/PrQuality.tsx` | operator start/list/detail/cancel/override; pure state logic อยู่ `src/logic/pr-quality.ts` |
| `.github/workflows/pr-quality-*.yml` | unprivileged `pull_request` analysis + trusted `workflow_run` finalize |

Dependency direction ยังเป็น `core <- aal <- adapters <- composition`. GitHub/provider credential
อยู่ outer boundary เท่านั้น. Finalize checkout trusted default branch, verify artifact/source/policy
ใหม่ และห้าม checkout/execute PR head. Production operation อยู่ใน
`docs/08-pr-quality-gate-production.md`.

## Anti-Patterns

- ห้าม duplicate magic constant / ค่าดิบซ้ำหลายที่ (ใช้ single source แทน)
- ห้าม inline data ก้อนใหญ่ในไฟล์ presentation
- ห้ามฝังสูตรคำนวณ/business logic ตรงในตัว view
- ห้าม mark task `[x]` ทั้งที่ typecheck/test ยังไม่เขียว หรือไม่มี Evidence
- test ต้อง assert พฤติกรรมที่สังเกตได้ ไม่ใช่ snapshot รายละเอียดภายในที่เปราะ
- ห้ามให้ PR head policy/workflow/model output เปลี่ยน authority ของ run เดียวกัน
- ห้ามถือว่า workflow file เป็น enforcement จน repository ruleset require check จริง
