# Handoff Note: Synthetic loop sandbox isolation

> From: Codex `/root`   To: any reviewer   Date: 2026-08-09

## Task Summary

แก้ task 1 ของ `bugfix-loop-run-nested-sandbox` ครบ F1-F6 และ B1-B12 ให้ synthetic
loop scenarios ไม่พึ่ง ambient nested Seatbelt โดย production sandbox/fail-closed behavior คงเดิม.

## Current Status

Implementation, regression tests, typecheck, lint, full workspace tests และ security/code review
ผ่านแล้ว. Task 1 mark complete พร้อม Evidence ใน `tasks.md`.

## Files Changed

- `console/backend/src/loop-run.ts` — เพิ่ม guarded test-only sandbox injection seam (edited)
- `console/backend/test/helpers/synthetic-loop-sandbox.ts` — explicit synthetic command wrapper (new, untracked)
- `console/backend/src/loop-run-graph.test.ts` — ใช้ synthetic sandbox (edited)
- `console/backend/src/loop-run-graph.fault-injection.test.ts` — ใช้ synthetic sandbox (edited)
- `console/backend/src/loop-run-lease.test.ts` — ใช้ synthetic sandbox (edited)
- `console/backend/src/loop-run.test.ts` — ใช้ synthetic sandboxและลบ ambient Darwin skips (edited)
- `.ai/specs/bugfix-loop-run-nested-sandbox/bugfix.md` — approved root-cause spec (new, untracked)
- `.ai/specs/bugfix-loop-run-nested-sandbox/tasks.md` — task state และ Evidence (new, untracked)
- `.ai/specs/bugfix-loop-run-nested-sandbox/handoffs/task-1.md` — handoff นี้ (new, untracked)

## Important Decisions

- synthetic loop tests ยังวิ่งผ่าน executor, gates, repair, merge และ approval paths จริง แต่ใช้ explicit test sandbox.
- test sandbox รับได้เมื่อ `syntheticGoldenFixtureForTests === true` เท่านั้น.
- production CLI callers ไม่ส่ง test options; default ยังเป็น `denyNetworkSandbox(process.platform)`.
- real Seatbelt enforcement อยู่ใน core explicit capability suite ไม่ผูก orchestration tests กับ host capability.

## Constraints

- ห้าม fallback production command ไป unsandboxed execution.
- ห้ามเปลี่ยน expected state เป็น `ESCALATED` เพื่อทำ test เขียว.
- ห้ามปิด gate, approval, dependency หรือ Human Plane assertions.
- ห้าม commit/push ตรง `main` หรือ `develop`; preserve unrelated dirty-worktree changes.

## Tests Run

- Focused direct regression -> 1 pass, 0 fail, 0 skipped; ก่อนแก้ได้ `ESCALATED` แทน `REVIEWING`.
- Focused graph/approval/self-repair scenarios -> pass.
- `pnpm --filter console-backend typecheck` -> pass.
- `pnpm typecheck` -> pass.
- `pnpm lint` -> `ESLint: No issues found`.
- `pnpm --filter console-backend test` -> 399 pass, 0 fail, 0 skipped.
- `pnpm test` -> exit 0; existing explicit host-capability skip คงเดิม.
- Viewports: n/a — backend orchestration/security logic.

## Known Issues

- none.

## Next Recommended Agent

Human reviewer หรือ `security-reviewer` สำหรับ final diff review ก่อน commit.

## Next Steps

1. อ่าน `bugfix.md`, `tasks.md` และรัน `scripts/spec-state.sh bugfix-loop-run-nested-sandbox`.
2. ตรวจ production caller diff แล้ว ship ผ่าน feature branch และ PR เมื่ออนุมัติ.
