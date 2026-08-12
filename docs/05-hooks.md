# 5. Hooks / Guardrails

ระบบ guard ปัจจุบันมี check engine กลางชุดเดียวที่ `.ai/bin/`; Claude, Codex, OpenCode, git hooks และ CI เป็น thin adapters. Tier 1 (`.githooks` + CI) คือ durable floor: local hook ครอบ clone ที่ wire แล้ว, CI ครอบ event ที่ workflow match และ server จะ block merge เมื่อ ruleset require check. In-session hooks ให้ feedback เร็วเพิ่มเติม.

## 5.1 Enforcement model

| Tier | Caller | สิ่งที่ครอบ | Enforcement |
|---|---|---|---|
| 1 | `.githooks/pre-commit`, `.githooks/pre-push`, `.github/workflows/ci.yml` | ทุก agent + มนุษย์ | commit/push/CI floor |
| 2 | Claude hooks, Codex hooks, OpenCode plugin | harness ที่รองรับ pre/post-tool hook | block ก่อน command หรือหลัง task edit |
| 3 | `AGENTS.md`, `.ai/shared/SECURITY_RULES.md`, workflows/roles | ทุก harness | procedural; ใช้เมื่อ harness ไม่มี hook |

Logic/regex ต้องแก้ที่ `.ai/bin/` เท่านั้น. ห้าม fork policy ไปไว้ใน adapter; adapter มีหน้าที่ parse payload แล้วส่ง input เข้า engine.

## 5.2 Setup ต่อ clone

มนุษย์รันครั้งเดียว:

```bash
./.ai/bin/install.sh
```

Script ตั้ง `core.hooksPath=.githooks` และ mark committed hook/engine scripts executable แบบ idempotent. ตรวจผล:

```bash
git config --get core.hooksPath
ls -l .githooks .ai/bin
```

Expected `core.hooksPath` คือ `.githooks`. Agent ที่อยู่หลัง bypass guard อาจถูก block เมื่อพยายามเขียนค่า config นี้เอง; ให้มนุษย์รัน installer ที่ review แล้ว.

Codex interactive ต้องเปิด `/hooks` แล้ว review/trust project hooks ต่อเครื่อง. `codex exec` ไม่ควรถูกสมมติว่า fire in-session hooks; Tier 1 ยังเป็น backstop.

## 5.3 Check engine

| Script | Input | ผล |
|---|---|---|
| `.ai/bin/check-destructive.sh` | shell command ผ่าน argv/stdin | exit 2 เมื่อ destructive/branch/force-push pattern ถูก block |
| `.ai/bin/check-bypass.sh` | shell command ผ่าน argv/stdin | exit 2 เมื่อพยายามข้ามหรือแก้ enforcement floor |
| `.ai/bin/check-secrets.sh` | staged diff โดย default; `--all` สำหรับ tree | block secret/credential/forbidden file |
| `.ai/bin/check-spec-edit.sh` | requirements path | advisory เมื่อแก้ approved requirements ทั้งที่ task ค้าง |
| `.ai/bin/check-evidence.sh` | tasks content + mode | ตรวจ `Evidence:` ต่อ newly-completed task |
| `.ai/bin/gate-task.sh` | tasks path/content + env | รัน typecheck/test + strict Evidence gate ตอน flip `[x]` |
| `.ai/bin/install.sh` | current git clone | wire Tier 1 floor |

Convention ของ command guards: exit 0 = allow, exit 2 = block พร้อม stderr. `check-spec-edit.sh` เตือนแต่ไม่ block.

## 5.4 Harness wiring

| Harness | Wiring | ข้อจำกัด |
|---|---|---|
| Claude | `.claude/settings.json` -> `.claude/hooks/` -> `.ai/bin/` | fire ผ่าน `PreToolUse`, `PostToolUse`, `PreCompact`, `SessionStart` |
| Codex | `.codex/config.toml` -> `.codex/hooks/` -> `.ai/bin/` | interactive ต้อง trust hooks ผ่าน `/hooks` |
| OpenCode | `.opencode/plugins/ai-guard.js` และ spec/task adapters -> `.ai/bin/` | plugin แปลง exit 2 เป็น tool error |
| Pi | ไม่มี core pre-tool hook | ใช้ procedural check + Tier 1 |
| Git | `.githooks/` | ต้อง wire `core.hooksPath` ต่อ clone |
| CI | `.github/workflows/ci.yml` | server run ไม่พึ่ง local hook setup |

## 5.5 Guard behavior

### Destructive operations

Engine block อย่างน้อย:

- recursive+force `rm`, `git reset --hard`, `git clean -f`, `find -delete`
- `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `dropdb`, `DELETE FROM` ที่ไม่มี `WHERE`
- force/non-fast-forward push, direct commit/push ไป `main`/`develop`
- spelling/wrapper ที่ engine normalize เช่น quoted executable, backslash และ `sh -c`

Engine เป็น flat-string fail-safe จึงอาจ over-block destructive text ใน quote. อย่าแก้ด้วย bypass; แยก command หรือใช้ test fixture file แล้วรัน suite.

### Bypass/tamper

Engine block `--no-verify`, `git commit -n`, `SECRET_GUARD_SKIP=`, write/unset `core.hooksPath`, การ chmod/move/remove/overwrite guard files และ redirect เข้า `.git/config`. Read-only `git config --get core.hooksPath` ผ่าน.

### Secrets

`check-secrets.sh` ตรวจ staged diff ก่อน commit และ tree/diff-range ใน CI. ครอบ API keys/tokens/private keys, credentialed connection strings, generic secret assignment และ forbidden `.env`/key files. Placeholder value ผ่านได้; trailing comment ที่เขียนว่า placeholder ไม่ทำให้ค่าจริงผ่าน.

`SECRET_GUARD_SKIP=1` มีไว้เฉพาะ staged human escape hatch ตาม engine contract และถูก force-clear/ignore ใน CI full-tree mode. ใช้เมื่อมนุษย์ตรวจ false positive แล้วเท่านั้น; ห้าม agent ตั้งเอง.

### Spec edit

`check-spec-edit.sh` เตือนเมื่อแก้ `.ai/specs/<feature>/requirements.md` ที่ approved ขณะ sibling `tasks.md` ยังมี `[ ]`. ต้อง propagate ไป design/tasks, ตรวจ trace และขอ re-approval เมื่อ contract เปลี่ยน.

### Task completion

In-session `task-gate` ยิงเมื่อ edit ทำให้ task เป็น `[x]`:

1. รัน `SDD_TYPECHECK_CMD` หรือ auto-detect root `package.json` typecheck.
2. รัน `SDD_TEST_CMD` หรือ auto-detect root `package.json` test.
3. บังคับ `Evidence:` อยู่ใน task block เดียวกัน.

Git pre-commit ไม่ rerun full tests; มัน scan secrets และตรวจ Evidence presence ของ newly-added `[x]` จาก staged content. CI เป็น code-green backstop.

### Context hooks

`PreCompact` เตือน persist active spec/task, files, commands, decisions และ next step ลง durable artifact. `SessionStart` inject current branch + active spec summary. ทั้งคู่ช่วย context ไม่ใช่ correctness authority.

## 5.6 Git และ CI floor

`pre-commit` ทำสองงาน:

1. `.ai/bin/check-secrets.sh` บน staged diff.
2. `.ai/bin/check-evidence.sh --added-only` ต่อ staged `tasks.md` ที่เพิ่ม `[x]`.

`pre-push` อ่าน Git ref tuples แล้ว block push ไป `main`/`develop`, remote ref deletion และ non-fast-forward push.

CI มี exact check names:

```text
platform (vendor check + typecheck + lint + tests)
guards + spec-trace
```

Workflow file ไม่ทำให้ check required เอง. สถานะตรวจ 2026-08-10 ยังไม่มี branch protection/ruleset; production ต้องเปิด server-side enforcement หลัง canary ตาม [08-pr-quality-gate-production.md](08-pr-quality-gate-production.md).

## 5.7 Tests และ troubleshooting

Guard regression suite อยู่ `.claude/hooks/tests/*.test.sh`; CI รันทุกไฟล์. ก่อนแก้ security pattern:

1. เพิ่ม paired block/allow case ที่ reproduce ปัญหา.
2. แก้ single-source engine ใน `.ai/bin/`.
3. รัน guard regression suite และเทียบ adapter exit behavior.
4. รัน `.ai/bin/check-secrets.sh --all` และ core CI scope tests.

เมื่อ guard block command ที่ชอบธรรม ให้อ่าน stderr และลด command ให้เหลือ operation ชัดเจน. ห้ามปิด hook, เปลี่ยน hooksPath, ใช้ skip flag หรือแก้ regex เฉพาะ adapter.

Canonical rule details: `../.ai/shared/SECURITY_RULES.md`. Engine interface details: `../.ai/bin/README.md`.
