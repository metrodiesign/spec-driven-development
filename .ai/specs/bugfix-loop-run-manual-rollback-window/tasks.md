# Tasks: Loop Run Manual Rollback Window

> Status: approved 2026-08-10

ทำ vertical slice เดียวให้ accepted manual rollback ปิด remaining window แบบ event-driven
โดยคง HTTP, terminal-state, kill, retry และ production-default contracts เดิม.

- [x] 1. ปิด expanded window เมื่อรับ manual rollback และพิสูจน์ behavior ครบ
  - Satisfies: F-1, F-2, F-3, F-4, B-1, B-2, B-3, B-4, B-5, B-6
  - Files: `console/backend/src/loop-run.ts`, `console/backend/src/loop-run.test.ts`
  - Verify: เพิ่ม observable timing regression ที่ RED ก่อนแก้และ GREEN หลังแก้ จากนั้นรัน
    focused rollback/kill/helper tests, backend typecheck, lint, full backend test และ spec trace.
  Evidence:
    - RED: focused `manual rollback whose rollback_cmd FAILS` บน source เดิมและ
      `expandedWindowMs: 60_000` -> `pass 0, fail 1` ใน 71.8 วินาทีด้วย assertion
      `accepted manual rollback did not end the remaining expanded window`; cleanup `/kill`
      สำเร็จและไม่มี `ECONNREFUSED`.
    - GREEN: focused manual rollback success/failure -> `pass 2, fail 0` ใน 108.7 วินาที;
      success path เห็น `ROLLING_BACK` ผ่าน Human Plane ขณะ `sleep 1` ยังทำงาน แล้วบันทึก
      `ROLLED_BACK` และ `DEPLOY_WINDOW_CLOSED` อย่างละหนึ่ง; failure path จบก่อน window
      60 วินาทีด้วย task `COMPLETED` และ deploy `ESCALATED(rollback_failed)`.
    - Unchanged contracts: rollback นอก `EXPANDED` -> HTTP 409 และ callback ไม่ถูกเรียก
      (`pass 1, fail 0`); `fetchRetry`/pending kill/no-rollback window -> `pass 6, fail 0`;
      long-window kill ระหว่าง `EXPANDED` -> `pass 1, fail 0` ใน 46.0 วินาที; production
      fallback ยังเป็น `10 * 60_000` และ diff ไม่แตะค่า default.
    - Gates: `pnpm --filter console-backend test` -> `pass 436, fail 0` ใน 727.4 วินาที;
      `pnpm test` -> exit 0 ทุก workspace package; `pnpm typecheck` -> exit 0 ทั้ง 6 packages;
      `pnpm lint` -> `ESLint: No issues found`; `pnpm vendor-check` -> exit 0;
      `scripts/spec-trace.sh bugfix-loop-run-manual-rollback-window` -> exit 0 ตาม bugfix-skip contract.
    - Review: current diff เทียบ root-cause contract แล้วไม่มี actionable finding; ไม่มี API,
      retry, sandbox, provider, PR-gate หรือ production-default change.
    - Deviations: none.
