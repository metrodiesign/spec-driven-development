# Implementation Tasks: Universal PR Quality Gate

> Status: completed 2026-08-10 (approved 2026-08-10)

แต่ละ task เป็น vertical slice ที่ตรวจได้เอง งานนี้ coupled สูง จึงรันทั้งหมดใน session เดียวตาม dependency order

- [x] 1. Ring 0 PR gate kernel — เพิ่ม contracts, policy/profile merge, deterministic classification, finding validation, coverage decision, state allowlist, budget/idempotency projection และ table-driven tests
     Satisfies: REQ-2, REQ-3, REQ-6, REQ-7, REQ-8, REQ-11. Verify: `pnpm --filter core typecheck && pnpm --filter core test`.
     Evidence:
       - test: `pnpm --filter core typecheck` -> passed
       - test: `pnpm --filter core test` -> passed, 0 failed; 10 existing runtime-guarded tests skipped
       - focused test: `(cd core && node --test --test-reporter=dot src/pr-gate/kernel.test.ts src/pr-gate/checks.test.ts)` -> 18 passed, 0 failed
       - viewports: n/a — logic-only
       - deviations: none
- [x] 2. Immutable snapshot and deterministic evidence — ต่อ pinned Git reads, detached snapshot manifest, stale-head handling และ planned checks เข้ากับ sandbox/evidence/report-integrity primitives เดิม
     Satisfies: REQ-1, REQ-4, REQ-11. Depends on: 1. Verify: `pnpm --filter core test && pnpm --filter console-backend test`.
     Evidence:
       - test: `(cd core && node --test --test-reporter=dot src/pr-gate/kernel.test.ts src/pr-gate/checks.test.ts)` -> 18 passed, 0 failed
       - focused test: `(cd console/backend && node --test --test-reporter=dot src/pr-gate/*.test.ts src/app-pr-gate.test.ts src/pr-gate-cli.test.ts)` -> 39 passed, 0 failed; covers exact-head pinning, stale replacement enqueue, manifests, deterministic checks and acceptance corpus
       - security: privileged finalize path verifies workflow-run provenance, current PR head and fetched PR object before pinning; unprivileged analysis uses trusted base code, copies only trusted base `node_modules`, then freezes those bytes into each command input
       - viewports: n/a — Git/evidence boundary only
       - deviations: none; full backend suite passed on final unrestricted host run
- [x] 3. Blind reviewer panel and Evidence Judge — เพิ่ม identical-context fan-out, anonymous Judge, structured validation, cancellation/cost controls และ reasoning-only Gemini/OpenCode transports
     Satisfies: REQ-5, REQ-6, REQ-8, REQ-11. Depends on: 1. Verify: `pnpm --filter aal test && pnpm --filter adapters test`.
     Evidence:
       - test: `pnpm --filter aal typecheck && pnpm --filter aal test` -> 192 passed, 0 failed
       - test: `pnpm --filter adapters typecheck && pnpm --filter adapters test` -> 50 passed, 0 failed
       - security: explicit provider env allowlist excludes GitHub reporter credentials; Gemini/OpenCode deny-all configs tested
       - viewports: n/a — transport/orchestration only
       - deviations: live provider calls not exercised in CI; injected transports and argv/config boundaries are hermetic
- [x] 4. Run manager and trusted GitHub boundary — orchestrate Stage 0–5, persist/recover append-only events, verify workflow artifacts, publish exact-head Check Runs และ fail closed ที่ credential boundary
     Satisfies: REQ-1, REQ-3, REQ-4, REQ-8, REQ-9, REQ-11. Depends on: 1, 2, 3. Verify: `pnpm --filter console-backend typecheck && pnpm --filter console-backend test`.
     Evidence:
       - typecheck: `pnpm --filter console-backend typecheck` -> passed
       - focused test: `(cd console/backend && node --test --test-reporter=dot src/pr-gate/*.test.ts src/app-pr-gate.test.ts src/pr-gate-cli.test.ts)` -> 39 passed, 0 failed
       - workflow syntax: `ruby -e "require 'yaml'; ARGV.each { |path| YAML.load_file(path, aliases: true) }" .github/workflows/pr-quality-analysis.yml .github/workflows/pr-quality-finalize.yml` -> passed
       - governance: timeout-aligned policy snapshot `8390f44d0c38e6d314674a03c2acc8ca06f3499b0bbd4fc63b0ba2c2e0c00a5e` approved by human event `gov-e5b83542c43caf5f`; runtime approval check passed
       - viewports: n/a — manager and GitHub trust boundary
       - deviations: none; full backend suite passed on final unrestricted host run
- [x] 5. Operator API, CLI, and Console — expose guarded run/list/detail/cancel/override entrypoints จาก manager เดียว พร้อม server-derived audit identity, idempotency และ accessible status UI
     Satisfies: REQ-8, REQ-10, REQ-11. Depends on: 4. Verify: `pnpm --filter console-backend test && pnpm --filter console-web typecheck && pnpm --filter console-web test && pnpm --filter console-web build`.
     Evidence:
       - backend focused test: `(cd console/backend && node --test --test-reporter=dot src/pr-gate/*.test.ts src/app-pr-gate.test.ts src/pr-gate-cli.test.ts)` -> 39 passed, 0 failed
       - web: `pnpm --filter console-web typecheck && pnpm --filter console-web test && pnpm --filter console-web build` -> typecheck passed, 77 tests passed, production build passed
       - accessibility: status semantics and control-state logic covered by headless tests; controls use native buttons and labels
       - viewports: local browser smoke passed at default desktop and `390x844`; PR Quality controls render, mobile has no horizontal overflow, console has no errors
       - deviations: none
- [x] 6. Phase 1 assembly and acceptance corpus — เพิ่ม durable schemas/policy governance, workflow definitions, end-to-end fixtures และ fault cases สำหรับ backend, docs-only, OpenAPI, stale SHA, provider failure, prompt injection, fork trust split และ override
     Satisfies: REQ-1, REQ-2, REQ-3, REQ-4, REQ-5, REQ-6, REQ-7, REQ-8, REQ-9, REQ-10, REQ-11. Depends on: 1, 2, 3, 4, 5. Verify: `scripts/spec-trace.sh universal-pr-quality-gate && pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
     Evidence:
       - trace: `scripts/spec-trace.sh universal-pr-quality-gate` -> 132/132 requirements covered; EARS lint passed
       - static gates: `pnpm typecheck && pnpm lint && pnpm build && pnpm vendor-check` -> passed; build reports only existing Vite chunk-size warning
       - security: `.ai/bin/check-secrets.sh --all` -> passed; `git diff --check` -> passed; no `.only` or `.skip` in feature tests
       - package tests: Web 77, Core 612, AAL 192, Adapters 50 และ Backend 436 passed; Core มี 10 capability-gated skips
       - CI guards: guard regression tests 14/14, lessons coverage และ spec-trace ของ active/archive specs 20/20 passed
       - full test: `pnpm test` -> exit `0`; 1,367 tests passed, 0 failed, 10 capability-gated skips
       - audit: `pnpm audit --prod --audit-level high` -> exit `0`; 1 low and 4 moderate findings remain below the configured blocking threshold
       - viewports: local browser desktop/mobile smoke passed; no horizontal overflow or console errors
       - deviations: live four-provider conformance calls require operator credentials and were not run; injected transports and conformance boundaries remain hermetic

## Suggested execution batches

รัน tasks 1–6 แบบ all-in-one เพราะแชร์ contracts, event state และ integration fixtures การแยก session เพิ่ม context reload และเสี่ยง wiring gap
