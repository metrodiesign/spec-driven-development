# Autonomous Engineering Platform on Claude

แพลตฟอร์ม self-hosted ตัวเดียวสำหรับรัน Claude Code เป็นเครื่องมือวิศวกรรมซอฟต์แวร์
ทั้งแบบมีคนนำและแบบรันเอง บนเครื่องของเจ้าของบัญชีเอง พัฒนาแบบ spec-driven อย่างเคร่งครัด
(spec มาก่อน code เสมอ)

> คู่มือนี้เป็นจุดเริ่มระดับ repo — รายละเอียดสถาปัตยกรรมและ roadmap เต็มอยู่ใน
> `unified-platform-spec.md` (source of truth หลักสำหรับ implement)

**Disclaimer:** นี่เป็นเครื่องมือ third-party ไม่ใช่ผลิตภัณฑ์ของ Anthropic ออกแบบเป็น
**single-operator** — ไม่มีระบบ multi-user หรือ roles สำหรับผู้ใช้หลายคน และไม่ bridge auth
ไปเครื่องมืออื่น

## 1. โปรเจกต์นี้คืออะไร

แพลตฟอร์ม self-hosted หนึ่งตัว รันบนเครื่องผู้ใช้ ทำสองอย่างบน substrate เดียว
(Claude Code + credentials + โควตา Claude Max 20x subscription; auth ผ่าน `claude login`
ไม่ใช่ API plan):

- **Interactive mode** — binary `claude` ตัวจริงรันผ่าน PTY แล้วสตรีมขึ้น terminal บนเว็บ
  ได้ 100% CLI parity (INV-17): ทุก slash command, keybinding, plan/vim mode และฟีเจอร์ใหม่
  ที่ CLI จะออกในอนาคต สำหรับงานที่มนุษย์นำ
- **Autonomous mode** — โมเดลแบบ propose/dispose: โมเดลเสนอ structured action ส่วน
  deterministic core เป็นคนลงมือและตรวจเองใน sandbox ด้วย golden tests โดยมนุษย์อนุมัติที่
  ระดับ task/risk สำหรับงานที่รันเองไม่มีคนเฝ้า

ทั้งสองโหมดใช้ substrate ร่วมกัน แต่แยก approval ตามโหมด (interactive อนุมัติแบบ CLI-native
ใน terminal, autonomous อนุมัติผ่าน approval package บน Console)

## 2. โครง monorepo

pnpm workspace ที่ประกอบด้วย package ต่อไปนี้ (`pnpm-workspace.yaml`):

| path | package | บทบาท |
|---|---|---|
| `core/` | `core` | Ring 0 deterministic core ปลอด vendor name (INV-7) |
| `aal/` | `aal` | Ring 1 Agent Abstraction Layer (depend `core`) |
| `adapters/` | `adapters` | Ring 2 ตัวแปล wire format (depend `@anthropic-ai/claude-agent-sdk` + `aal` + `core`) |
| `console/backend` | `console-backend` | Fastify server + PTY (`node-pty`) + WebSocket, bin ชื่อ `platform` |
| `console/web` | `console-web` | React 19 SPA (Vite, `@xterm/xterm`) |
| `spikes/` | `spikes` | สคริปต์ verification/spike (§15) ไม่ใช่ production code |

ไดเรกทอรีระดับ repo ที่ไม่ใช่ package:

- `.ai/` — vendor-neutral operating layer ที่ทุก harness (Claude Code / Codex / OpenCode / Pi)
  ใช้ร่วมกัน (knowledge, protocols, roles, check engine)
- `.claude/` — Claude-specific adapter (hooks / agents / skills / commands)
- `scripts/` — shell/python utility ระดับ repo
- `docs/` — เอกสารระดับ repo

## 3. สิ่งที่ต้องมีก่อน

- **Node** `>=26` (ระบุใน `.nvmrc` = `26` และ `engines` ของ root `package.json`)
- **pnpm** `11.9.0` (ระบุใน `packageManager` ของ root `package.json`)

## 4. เริ่มต้นใช้งาน

รันจาก root ของ repo:

```bash
pnpm install        # ติดตั้ง dependency (CI ใช้ --frozen-lockfile)
pnpm build          # pnpm -r build; ปัจจุบันมีแค่ console/web ที่มี script build (vite build)
pnpm typecheck      # tsc ทุก package (pnpm -r typecheck)
pnpm lint           # eslint ทั้ง repo
pnpm test           # test ทุก package (pnpm -r test)
pnpm vendor-check   # ตรวจว่า core/ และ aal/ ปลอด vendor name (INV-7)
```

หมายเหตุ: ทุก workspace มี script `typecheck` และ `test` ยกเว้น `spikes/` ที่ไม่มี `test`
(มีแค่ `typecheck` และ `spike:1`–`spike:5`) ส่วน `console/web` วาง test scope ไว้ที่
`src/logic/**/*.test.ts`

## 5. CI ตรวจอะไรบ้าง

CI (`.github/workflows/ci.yml`) ยิงเมื่อ `pull_request` และ `push` บน `main`/`develop`
มีสอง job:

- **job `platform`** (`macos-latest`) — vendor-name check, golden manifest verifier,
  ติดตั้งด้วย `pnpm install --frozen-lockfile`, `pnpm audit --prod --audit-level high`,
  typecheck, lint และ test (ผ่าน `scripts/ci-test-scope.sh`)
- **job `verify`** (`ubuntu-latest`) — guard regression tests
  (`.claude/hooks/tests/*.test.sh`), lessons coverage check
  (`scripts/lessons-coverage-check.sh`), secret scan (ผ่าน `scripts/ci-secret-scope.sh`),
  spec trace (`scripts/spec-trace.sh`) และ spec-goal drift (advisory)

job `platform` ถูก pin ไว้ที่ `macos-latest` โดยเจตนา (`docs/DEVIATIONS.md` D-003) เพราะ
fault-injection ของ egress default-deny ต้องใช้ `sandbox-exec` ของ darwin จริง — ไม่ได้
ออกแบบให้รันข้าม platform

## 6. git hooks และ guard

Tier 1 enforcement floor เป็น git hooks ที่ครอบทั้ง agent และมนุษย์ เปิดใช้ต่อ clone ด้วย:

```bash
git config core.hooksPath .githooks
```

- **`pre-commit`** — secret scan ของ staged diff และเมื่อ `tasks.md` ถูก stage ก็บังคับ
  ให้มี `Evidence:` block ในเนื้อที่ stage
- **`pre-push`** — block push ตรงเข้า `main`/`develop`, block force push (non-fast-forward)
  และ block การลบ remote ref

logic ตัวจริงของ guard ทั้งหมดอยู่ใน `.ai/bin/` (single source: `check-secrets.sh`,
`check-destructive.sh`, `check-bypass.sh`, `check-evidence.sh`, `gate-task.sh`,
`check-spec-edit.sh`) ที่ทุก harness เรียกผ่าน thin adapter

## 7. แผนที่เอกสาร

- `unified-platform-spec.md` — source of truth หลักสำหรับ implement (สถาปัตยกรรม + roadmap)
- `docs/01-spec-driven-flow.md` — 3 artifact + approval gate ของ spec workflow
- `docs/02-automation.md` — pane-loop automation
- `docs/03-cost-and-retro.md` — cost ledger + retrospective
- `docs/04-git-pr-and-rules.md` — convention ของ branch/PR
- `docs/05-hooks.md` — hook แต่ละตัวยิงเมื่อไร
- `docs/06-github-issues.md` — sync spec tasks ไป GitHub Issues
- `docs/README.md` — index/สารบัญ ของโฟลเดอร์ `docs/` เอง (คู่มือปฏิบัติ 6 หัวข้อ + ตารางแหล่งความจริง)
- `docs/DEVIATIONS.md` — บันทึกจุดที่ implement เบี่ยงจาก `unified-platform-spec.md` (ตาม §0.2/§0.6: อะไร/ทำไม/ขอบเขต/วิธีย้อน)
- `docs/sdd-optimization-plan.md` — แผน optimize spec workflow (อ้าง Kiro docs) พร้อมสถานะราย item Tier 1–5 (APPLIED/OPEN/SUPERSEDED)
- `.ai/shared/` — knowledge/protocol ที่ทุก agent อ่านร่วม (`PROJECT_CONTEXT`,
  `CODING_STANDARDS`, `ARCHITECTURE`, `LESSONS`, `TASK_PROTOCOL` และอื่น ๆ)
- `.ai/README.md` — ภาพรวมของ vendor-neutral operating layer

## 8. สถานะโปรเจกต์

**นี่คือแพลตฟอร์มที่ยัง build อยู่ ไม่ใช่ production-ready** — อย่าถือว่าทุก spec เสร็จแล้ว

- Phase 0 ถึง 4 ส่งมอบแล้ว (PR #41, #42/#43, #45, #47, #50)
- Phase 5 (SDD Integration): ส่งมอบ Stage 1 ถึง 4 แล้ว เหลือ **Stage 5 (Evidence backflow)**
  ที่ยังไม่ทำ
- patch นอก roadmap stage หลัง Stage 4: v1.8 (context-accumulation),
  v1.9 (write-provenance), v1.10 (run-command-prompt-contract)
- `.ai/specs/context-accumulation/tasks.md` ยังปิดไม่ครบ (1 จาก 4 task)
