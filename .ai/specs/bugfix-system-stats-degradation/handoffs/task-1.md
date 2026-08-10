# Handoff Note: System stats degradation

> From: Codex `/root`   To: any reviewer   Date: 2026-08-09

## Task Summary

แก้ task 1 ของ `bugfix-system-stats-degradation` ครบ F1-F6 และ B1-B8 ให้ metric
แต่ละตัว degrade แยกกัน โดย response ปกติคง shape เดิมและ UI แสดง `unavailable` เฉพาะค่าที่อ่านไม่ได้.

## Current Status

Implementation, regression tests, typecheck, lint, full workspace tests และ review ผ่านแล้ว.
Task 1 mark complete พร้อม Evidence ใน `tasks.md`.

## Files Changed

- `console/backend/src/app.ts` — เพิ่ม per-metric capture และ test dependency seam (edited)
- `console/backend/src/app-surfaces.test.ts` — เพิ่ม healthy/degraded API regression tests (edited)
- `console/web/src/logic/surfaces.ts` — รองรับ nullable metrics (edited)
- `console/web/src/logic/surfaces.test.ts` — เพิ่ม unavailable rendering regression test (edited)
- `.ai/specs/bugfix-system-stats-degradation/bugfix.md` — approved root-cause spec (new, untracked)
- `.ai/specs/bugfix-system-stats-degradation/tasks.md` — task state และ Evidence (new, untracked)
- `.ai/specs/bugfix-system-stats-degradation/handoffs/task-1.md` — handoff นี้ (new, untracked)

## Important Decisions

- จับ exception แยก metric เพื่อไม่ให้ `os.uptime()` failure ทำ response ทั้ง route เป็น 500.
- response ปกติไม่เพิ่ม metadata; degraded response เพิ่ม `degraded` และ `unavailableMetrics` เท่านั้น.
- inject host metric source สำหรับ deterministic tests ไม่ mock global `node:os`.

## Constraints

- รักษา host-header/auth guards และ retention behavior เดิม.
- ห้าม commit/push ตรง `main` หรือ `develop`; ต้อง review และ PR.
- Preserve unrelated dirty-worktree changes.

## Tests Run

- Focused backend stats -> 3 pass, 0 fail, 0 skipped.
- Focused web formatter -> 2 pass, 0 fail, 0 skipped.
- `pnpm --filter console-backend typecheck` -> pass.
- `pnpm --filter console-web typecheck` -> pass.
- `pnpm typecheck` -> pass.
- `pnpm lint` -> `ESLint: No issues found`.
- `pnpm --filter console-backend test` -> 399 pass, 0 fail, 0 skipped.
- `pnpm test` -> exit 0.
- Viewports: n/a — API และ pure formatter.

## Known Issues

- none.

## Next Recommended Agent

Human reviewer หรือ `cavecrew-reviewer` สำหรับ final diff review ก่อน commit.

## Next Steps

1. อ่าน `bugfix.md`, `tasks.md` และรัน `scripts/spec-state.sh bugfix-system-stats-degradation`.
2. ตรวจ diff แล้ว ship ผ่าน feature branch และ PR เมื่ออนุมัติ.
