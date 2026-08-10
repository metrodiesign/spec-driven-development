# Tasks: System stats degradation

> Status: approved 2026-08-09

ทำหนึ่ง vertical slice ตั้งแต่ host metric capture ถึง API response และ System surface
พร้อม regression tests ที่พิสูจน์ degraded path และพฤติกรรมเดิม.

- [x] 1. ทำ per-metric degradation และแสดง unavailable metric
  - Satisfies: F1, F2, F3, F4, F5, F6, B1, B2, B3, B4, B5, B6, B7, B8
  - Files: `console/backend/src/app.ts`, `console/backend/src/app-surfaces.test.ts`,
    `console/web/src/logic/surfaces.ts`, `console/web/src/logic/surfaces.test.ts`
  - Verify: focused backend + web tests ต้อง RED ก่อนแก้และ GREEN หลังแก้ จากนั้น
    typecheck, lint และ full project test ต้องผ่าน.
  Evidence:
  - RED backend: `pnpm --filter console-backend exec node --test --test-reporter spec --test-name-pattern='stats preserve healthy metrics' src/app-surfaces.test.ts` -> `500 !== 200`.
  - RED web: `pnpm --filter console-web exec node --test --test-reporter spec --test-name-pattern='unavailable uptime' src/logic/surfaces.test.ts` -> ได้ `uptime: 0h` แทน `uptime: unavailable`.
  - GREEN backend: `pnpm --filter console-backend exec node --test --test-reporter spec --test-name-pattern='F-Sys: (doctor|stats preserve|retention prune)' src/app-surfaces.test.ts` -> 3 pass, 0 fail, 0 skipped.
  - GREEN web: `pnpm --filter console-web exec node --test --test-reporter spec --test-name-pattern='statsRows' src/logic/surfaces.test.ts` -> 2 pass, 0 fail, 0 skipped.
  - Typecheck: `pnpm --filter console-backend typecheck`, `pnpm --filter console-web typecheck`, `pnpm typecheck` -> ผ่านทั้งหมด.
  - Lint: `pnpm lint` -> `ESLint: No issues found`.
  - Full test: `pnpm --filter console-backend test` -> 399 pass, 0 fail, 0 skipped; `pnpm test` -> exit 0.
  - Trace: `scripts/spec-trace.sh bugfix-system-stats-degradation` -> exit 0; bugfix spec ถูกข้ามตาม contract.
  - Viewports: n/a — เปลี่ยน Fastify API และ pure formatter ไม่มี browser-only behavior.
  - Deviations: none.
