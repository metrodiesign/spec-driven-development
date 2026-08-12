# Handoff Note: Cross-Harness SDD Closure

## Task Summary

ทำ spec `cross-harness-sdd-closure` เพื่อให้ Claude Code, Codex, OpenCode และ Pi ใช้ shared SDD
contract เดียวกัน พร้อม Pi pre-execution extension, diff-aware Evidence CI, exact MCP pins,
cross-harness conformance และ server-side branch rules.

## Current Status

Local implementation เสร็จและผ่าน review/gates. Tasks 1-6 complete. Operator ยืนยัน exposed
Gemini key ถูกลบและสร้าง replacement key แล้ว. ค่า `HTTP 200` ที่ probe ภายหลังเป็น replacement
key จึงไม่ใช่ blocker.

## Files Changed

- `.ai/specs/cross-harness-sdd-closure/` — requirements, design, tasks และ handoff ใหม่
- `.pi/extensions/sdd-enforcement.ts` — Pi guard/task-gate extension ใหม่
- `.ai/bin/check-evidence.sh` — เพิ่ม `--lines-strict`
- `scripts/ci-evidence-scope.sh` — diff range และ physical-line Evidence scope ใหม่
- `.github/workflows/ci.yml` — เพิ่ม Node setup และ diff-aware Evidence step
- `.claude/hooks/tests/` — เพิ่ม conformance/CI Evidence fixtures และขยาย policy tests
- `.ai/README.md`, `AGENTS.md`, `.ai/agents/*/AGENT.md`, `.ai/shared/SECURITY_RULES.md` — capability/security contract
- `.codex/config.toml`, `opencode.json` — pin `chrome-devtools-mcp@1.7.0`

## Important Decisions

- Pi รองรับ guard/task gate ผ่าน project extension เมื่อ launch จาก repository root; fresh-context
  subagent และ MCP/browser ยัง unsupported และต้อง stop-and-route.
- Pi blocks literal Bash access to canonical `tasks.md`; dynamic/obfuscated paths ยังพึ่ง Tier 1.
- CI selects newly completed tasks ด้วย new-side physical line number ไม่ใช้ opening text.
- MCP version authority อยู่ใน executable configs เท่านั้น.
- Pi path resolution ใช้ `lstatSync` ก่อน `realpathSync` เพื่อ block dangling-symlink escape.

## Constraints

- ห้าม commit/push ตรงจาก `develop`; ต้อง review แล้วเปิด PR.
- ห้ามบันทึกหรือแสดง credential; provider probe พิมพ์เฉพาะ HTTP status.
- Task 6 ขึ้นกับ Task 1; operator-confirmed deletion ของ exposed key เป็น closure evidence เพราะ
  ระบบไม่เก็บ original key identity หลัง rotation.

## Tests Run

- `pnpm typecheck` -> pass ทุก workspace package
- `pnpm lint` -> pass
- `pnpm test` -> web 77, core 612, aal 192, adapters 50, backend 436 passed; core skipped 10
- ทุก `.claude/hooks/tests/*.test.sh` -> pass; conformance `11/11 + 24/24`
- `.claude/hooks/tests/cross-harness-conformance.test.sh --live` -> ทั้ง 4 harness และ Pi loader pass
- `scripts/spec-trace.sh cross-harness-sdd-closure` -> 37/37 criteria covered
- `.ai/bin/gate-task.sh` via Codex task hook on Tasks 1/6 completion -> pass
- vendor check, golden manifest, `pnpm audit --prod --audit-level high` -> pass; audit reports 1 low + 4 moderate
- bounded config scan, temporary-index working-tree secret scan, `check-secrets.sh --all` -> pass
- GitHub ruleset readback -> active ID 20737973 ตรง contract
- credential status probe -> GitHub 401/401; Gemini replacement/control 200/400 ตามคาด

## Known Issues

- Guard test cleanup traps บางไฟล์พิมพ์ pre-existing `unbound variable` warning หลังสรุป pass แต่ exit 0.

## Next Recommended Agent

Human review.

## Next Steps

1. Review completed Tasks 1 และ 6 พร้อม final gate evidence.
2. สร้าง feature branch และเปิด PR; ห้าม push ตรง `develop`.
