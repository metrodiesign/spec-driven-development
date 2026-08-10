# Tasks: Synthetic loop sandbox isolation

> Status: approved 2026-08-09

ทำหนึ่ง vertical slice ให้ synthetic loop scenarios ใช้ explicit test sandbox
พร้อมคง production fail-closed และ real-SBPL capability tests.

- [x] 1. Inject test-only sandbox ให้ synthetic loop scenarios
  - Satisfies: F1, F2, F3, F4, F5, F6, B1, B2, B3, B4, B5, B6, B7, B8, B9, B10, B11, B12
  - Files: `console/backend/src/loop-run.ts`, loop test helpers และ
    `console/backend/src/loop-run*.test.ts`
  - Verify: focused direct/cascade tests ต้อง RED ก่อนแก้และ GREEN หลังแก้,
    real-SBPL tests ต้องคง explicit capability gate จากนั้น typecheck, lint และ full project test ต้องผ่าน.
  Evidence:
  - RED: `pnpm --filter console-backend exec node --test --test-reporter spec --test-name-pattern='REQ-4.3: without a task-graph option' src/loop-run-graph.test.ts` -> actual `ESCALATED`, expected `REVIEWING`; stderr มี `sandbox_apply: Operation not permitted`.
  - GREEN: command เดิม -> 1 pass, 0 fail, 0 skipped; public result กลับเป็น `REVIEWING`.
  - Focused cascade: `TG#3`, two-task graph, approval-package และ confirmed-hypothesis self-repair scenarios -> ผ่านทั้งหมด.
  - Isolation: `rg -n "darwinOnly|process\\.platform.*skip|skip:.*darwin" console/backend/src/loop-run*.test.ts` -> ไม่พบ ambient platform skip.
  - Typecheck: `pnpm --filter console-backend typecheck`, `pnpm typecheck` -> ผ่านทั้งหมด.
  - Lint: `pnpm lint` -> `ESLint: No issues found`.
  - Full test: `pnpm --filter console-backend test` -> 399 pass, 0 fail, 0 skipped; `pnpm test` -> exit 0.
  - Trace: `scripts/spec-trace.sh bugfix-loop-run-nested-sandbox` -> exit 0; bugfix spec ถูกข้ามตาม contract.
  - Security/review: ตรวจ current worktree diff, production callers และ sandbox defaults -> ไม่พบ actionable finding; production path ยังใช้ `denyNetworkSandbox(process.platform)` และ fail-closed.
  - Viewports: n/a — backend orchestration/security logic ไม่มี browser surface.
  - Deviations: none; real Seatbelt enforcement tests ยังคงอยู่ใน explicit capability suite.
