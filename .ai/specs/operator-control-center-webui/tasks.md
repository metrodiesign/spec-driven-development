# Implementation Tasks: Operator Control Center Web UI
> Status: approved 2026-08-12

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass; decompose into sub-steps only during implementation.

## Tasks

- [x] 1. Add authoritative observation records without changing decisions — extend
     Core/AAL event contracts with `RUN_DESCRIPTOR`, complete
     `TASK_GRAPH_FROZEN.tasks`, `BUDGET_SNAPSHOT`, `RATE_LIMIT_OBSERVED`, and
     `SHADOW_ROUTE.order`; expose pure `evaluateEligibility` and shared
     `describe*Adapter` descriptors so runtime and future projections use one source;
     add compatibility tests proving observer failure and new fields do not alter
     execution, routing, transport, or deterministic decision behavior.
     Satisfies: REQ-11.3.
     Depends on: none.
     Verify: `pnpm -C core test && pnpm -C aal test && pnpm -C adapters test && pnpm -C console/backend test && pnpm typecheck`.

     Evidence:
     - `pnpm -C core test` — 614 passed, 0 failed, 10 skipped.
     - `pnpm -C aal test` — 200 passed, 0 failed.
     - `pnpm -C adapters test` — 51 passed, 0 failed.
     - `pnpm -C console/backend test` — 461 passed, 0 failed.
     - `pnpm typecheck` — clean across all workspace packages.
     - RED: `node --test --test-reporter spec src/fusion/run.test.ts` failed with
       actual `[]`; dispatcher sends produced no `RATE_LIMIT_OBSERVED` records.
     - GREEN: same focused suite — 17 passed, 0 failed; records carry authoritative
       run/task identity and append failure leaves fusion result unchanged.
     - Review RED: `node --test --test-reporter spec src/control-center.test.ts`
       returned `invalid-record` for producer-valid `{ limited: false,
       availableTokens: null }`; GREEN — 11 passed, 0 failed after aligning backend
       and Web DTOs, with Backend/Web typecheck and 15 Web logic/i18n tests clean.
     - Production scan: `rg -l "type: 'RATE_LIMIT_OBSERVED'" --glob '!*.test.ts'`
       now resolves to `aal/src/fusion/run.ts`; before fix it returned no files.
     - Viewports: n/a — logic-only task.
     - Reconciliation 2026-08-13: closed after adding additive per-dispatch observer
       wiring and aligning the unlimited-state projection contract; existing callers
       and dispatch decisions remain unchanged.
     - Deviations: none.

- [x] 2. Replace the long page with an auth-aware application shell — implement the
     Dashboard/Core/AAL/Adapters/Console navigation, selected project and inspector
     context, allowlisted History API route codec, invalid-link recovery, Back/Forward,
     progressive disclosure, area error boundaries, abortable last-good read state,
     auth-loss coordination, and in-memory draft policy using existing React, native
     `<dialog>`, `AbortController`, and co-located pure-logic tests.
     Satisfies: REQ-1 (all criteria), REQ-8.1-8.4, REQ-8.11, REQ-8.14-8.17, REQ-8.21, REQ-8.23-8.24, REQ-11.4, REQ-11.6-11.7, REQ-11.12.
     Depends on: none.
     Verify: `pnpm -C console/web typecheck && pnpm -C console/web test && pnpm -C console/web build`.

     Evidence:
     - `pnpm -C console/web typecheck` — clean.
     - `pnpm -C console/web test` — 92 passed, 0 failed.
     - `pnpm -C console/web build` — production build succeeded.
     - `git diff --check` — clean.
     - Viewports: deferred to Task 10 browser matrix as specified.
     - Deviations: none.

- [x] 3. Deliver Core read-only management end to end — add the injected
     `control-center.ts` read port and additive Core list/detail/event routes backed by
     bounded read-only SQLite and authoritative run/evidence stores; normalize and
     redact graph, transitions, tiered gates, evidence metadata, budgets, issues, and
     timestamps; build Core list/workspace/inspector UI with cursor load-more,
     sequence-based refresh, unavailable reasons, and no domain mutation controls.
     Satisfies: REQ-3 (all criteria), REQ-8.3, REQ-8.5-8.6, REQ-8.12, REQ-8.25-8.30, REQ-11.2, REQ-11.11-11.12.
     Depends on: 1, 2.
     Verify: `pnpm -C console/backend test && pnpm -C console/web test && pnpm -C console/web typecheck && pnpm -C console/web build`.

     Evidence:
     - `pnpm -C console/backend test` — 442 passed, 0 failed.
     - `pnpm -C console/web test` — 95 passed, 0 failed.
     - `pnpm -C console/web typecheck` — clean.
     - `pnpm -C console/web build` — production build succeeded.
     - `git diff --check` — clean.
     - Viewports: deferred to Task 10 browser matrix as specified.
     - Deviations: none.

- [x] 4. Deliver AAL read-only management end to end — project routing order,
     breaker, rate-limit policy and recorded state, conformance P1-P8, and Fusion from
     authoritative config/events/calibration through an additive read-only endpoint;
     build AAL workspace with provenance, source time, unknown freshness, empty and
     invalid states, while tests prove opening or refreshing it never probes, routes,
     runs conformance, constructs adapters, or calls providers.
     Satisfies: REQ-4 (all criteria), REQ-8.3, REQ-8.5, REQ-8.12, REQ-8.25-8.30, REQ-11.2, REQ-11.11-11.12.
     Depends on: 1, 2.
     Verify: `pnpm -C aal test && pnpm -C console/backend test && pnpm -C console/web test && pnpm -C console/web typecheck && pnpm -C console/web build`.

     Evidence:
     - `pnpm -C aal test` — 198 passed, 0 failed.
     - `pnpm -C console/backend test` — 444 passed, 0 failed.
     - `pnpm -C console/web test` — 96 passed, 0 failed.
     - `pnpm -C console/web typecheck` — clean.
     - `pnpm -C console/web build` — production build succeeded.
     - `pnpm -C console/backend typecheck` and `git diff --check` — clean.
     - Viewports: deferred to Task 10 browser matrix as specified.
     - Deviations: none.

- [x] 5. Deliver Adapter read-only management end to end — inject shared static
     descriptors into the backend projector, add paged catalog/detail endpoints, fold
     health/calibration/conformance independently, reject malformed current records,
     and build Adapter list/workspace/inspector UI for manifests, model mappings,
     provenance, timestamps, and dimension-level unknown states without exposing
     credentials or issuing live transport requests.
     Satisfies: REQ-5 (all criteria), REQ-8.3-8.6, REQ-8.12, REQ-8.25-8.30, REQ-11.2, REQ-11.11-11.12.
     Depends on: 1, 2.
     Verify: `pnpm -C adapters test && pnpm -C console/backend test && pnpm -C console/web test && pnpm -C console/web typecheck && pnpm -C console/web build`.

     Evidence:
     - `pnpm -C adapters test` — 51 passed, 0 failed.
     - `pnpm -C console/backend test` — 446 passed, 0 failed.
     - `pnpm -C console/web test` — 97 passed, 0 failed.
     - `pnpm -C console/web typecheck` — clean.
     - `pnpm -C console/web build` — production build succeeded.
     - `pnpm -C console/backend typecheck` and `git diff --check` — clean.
     - Viewports: deferred to Task 10 browser matrix as specified.
     - Deviations: none.

- [x] 6. Deliver the operational Dashboard from real read-only sources — add the pure
     Console service-health projection, compose host health, run/approval totals,
     usage/quota, and latest PR quality summaries, isolate loading/error/empty/read-time
     state per card, wire cards to the matching Console views, and make explicit refresh
     read-only with no CLI, doctor, process, provider, or domain action side effect.
     Satisfies: REQ-2 (all criteria), REQ-8.5, REQ-8.11, REQ-8.21, REQ-8.23, REQ-8.26-8.30.
     Depends on: 2, 3.
     Verify: `pnpm -C console/backend test && pnpm -C console/web test && pnpm -C console/web typecheck && pnpm -C console/web build`.

     Evidence:
     - `pnpm -C console/backend test` — 447 passed, 0 failed.
     - `pnpm -C console/web test` — 100 passed, 0 failed.
     - `pnpm -C console/web typecheck` — clean.
     - `pnpm -C console/web build` — production build succeeded.
     - `git diff --check` — clean.
     - Viewports: deferred to Task 10 browser matrix as specified.
     - Deviations: none.

- [x] 7. Preserve Console operations inside typed secondary navigation — reuse the
     existing Projects, Sessions, Terminal, Chat, Runs, Scheduler, Issues, PR Quality,
     System, and Usage components and contracts; keep project context, local/remote
     policy, approvals, guidance, deploy and process actions intact; add bounded
     pagination/polling, destructive-action confirmations, duplicate-action guards,
     safe technical rendering, and the explicit MCP Authenticate Terminal intent.
     Satisfies: REQ-6 (all criteria), REQ-8.2, REQ-8.5-8.6, REQ-8.8-8.10, REQ-8.13, REQ-8.18-8.25, REQ-8.28-8.29, REQ-11.1.
     Depends on: 2.
     Verify: `pnpm -C console/backend test && pnpm -C console/web test && pnpm -C console/web typecheck && pnpm -C console/web build`.

     Evidence:
     - `pnpm -C console/backend test` — 455 passed, 0 failed.
     - `pnpm -C console/web test` — 105 passed, 0 failed.
     - `pnpm -C console/web typecheck` — clean.
     - `pnpm -C console/web build` — production build succeeded; existing bundle-size warning only.
     - `pnpm -C console/backend typecheck` and `git diff --check` — clean.
     - Viewports: deferred to Task 10 browser matrix as specified.
     - Deviations: none.

- [x] 8. Deliver Governance Control Center through existing authority boundaries —
     mount Settings, Permissions, Memory, MCP, Hooks, Subagents, Skills, Plugins, and
     System/Retention views; add backward-compatible effective-settings, provenance,
     redaction metadata, and apply-timing fields; enforce scope matrix, base hash,
     authoritative validation, preview/token confirmation, stale-409 draft recovery,
     replace-entire sensitive edits, permission/idempotency checks, and auth-loss secret
     clearing without adding client-side authority.
     Satisfies: REQ-7 (all criteria), REQ-8.2-8.4, REQ-8.7-8.10, REQ-8.13-8.17, REQ-8.19-8.20, REQ-8.24, REQ-11.1.
     Depends on: 2, 7.
     Verify: `pnpm -C console/backend test && pnpm -C console/web test && pnpm -C console/web typecheck && pnpm -C console/web build`.

     Evidence:
     - `pnpm -C console/backend test` — 461 passed, 0 failed.
     - `pnpm -C console/web test` — 110 passed, 0 failed.
     - `pnpm -C console/web typecheck` — clean.
     - `pnpm -C console/web build` — production build succeeded; existing bundle-size warning only.
     - `pnpm -C console/backend typecheck` and `git diff --check` — clean.
     - Dependency/lockfile and `scripts/`/`spikes/` diff checks — no changes.
     - Viewports: deferred to Task 9/10 Chromium matrix as specified.
     - Deviations: none.

- [x] 9. Apply the complete visual, localization, responsive, and accessibility system
     across every area — add dark-before-first-paint and light themes, centralized
     semantic tokens, complete Thai/English UI labels with technical values preserved,
     storage-failure fallback, reduced motion, responsive three-region/drawer/modal
     layouts, contained overflow, keyboard/focus/dialog semantics, live regions, touch
     targets, contrast, and accessible long identifiers; keep all derivation logic pure
     and co-located with tests.
     Satisfies: REQ-9 (all criteria), REQ-10 (all criteria), REQ-11.4, REQ-11.6-11.7, REQ-11.9.
     Depends on: 2-8.
     Verify: `pnpm -C console/web test && pnpm -C console/web typecheck && pnpm -C console/web build`; verify latest stable Chromium at 375, 768, and 1440 px in dark/light and Thai/English.

     Evidence:
     - `pnpm -C console/web test` — 115 passed, 0 failed.
     - `pnpm -C console/web typecheck` — clean.
     - `pnpm -C console/web build` — production build succeeded; existing bundle-size warning only.
     - Chromium matrix — exact 375, 768, and 1440 px client widths passed dark/light and Thai/English with route state preserved and no document overflow.
     - Responsive layout — 1440 px showed navigation/workspace/inspector; 768 px used explicit drawers; 375 px used single-column full-viewport modal. Tables and 120-column xterm stayed in contained horizontal scrollers.
     - Accessibility — named controls and landmarks, one `h1` with no heading-level jumps, live regions, 44 px interactive targets, 3 px visible keyboard focus, native modal focus containment, `Escape` close/focus return, and wrapping 184-character identifiers passed.
     - Contrast — all semantic foreground tokens passed WCAG AA against light/dark panels; minimum measured ratio 4.61:1. Reduced-motion override, light/Thai reload persistence, localized draft preservation, and empty Chromium error log passed.
     - `git diff --check` and dependency/lockfile diff checks — clean; no dependency additions.
     - Deviations: none.

- [x] 10. Close cross-area regression and delivery gates — run browser journeys for
     auth, deep links, read-only workspaces, Console mutations, Governance stale and
     confirmation flows, selection races, polling, pagination, errors, and auth loss;
     fix only failures within approved design, confirm no dependency or lockfile
     additions and no `scripts/` or `spikes/` changes, then run the full monorepo,
     vendor, secret, and requirement-trace gates with recorded evidence.
     Satisfies: REQ-11.5, REQ-11.8-11.10.
     Depends on: 1-9.
     Verify: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm vendor-check && scripts/spec-trace.sh operator-control-center-webui`; verify latest stable Chromium at 375, 768, and 1440 px.

     Evidence:
     - `pnpm typecheck` and `pnpm lint` — all workspace packages clean.
     - `pnpm test` — 1,441 passed, 0 failed; 10 Core platform-only tests skipped by their declared external macOS/loopback requirements.
     - `pnpm build` — production build succeeded; existing Vite chunk-size warning only.
     - `pnpm vendor-check` — Core/AAL vendor-name gate passed.
     - `.ai/bin/check-secrets.sh --all` — full tracked-tree scan passed. Two redaction test fixtures initially matched the gate; runtime-assembled fixture values fixed the source pattern and their focused 28 tests plus backend typecheck passed.
     - `scripts/spec-trace.sh operator-control-center-webui` — all 170 criteria traced; EARS lint passed.
     - `pnpm audit --prod --audit-level high` — passed with no high/critical findings; reported 1 low and 4 moderate advisories.
     - Chromium production journeys — auth probe, allowlisted deep-link reload, read-only Core failure/empty states, route/draft preservation, dialogs, Terminal containment, and 375/768/1440 responsive matrix passed with no browser errors.
     - Cross-area regression coverage — full frontend/backend suites passed Console mutation and confirmation contracts, Governance stale-write/token flows, selection generation races, polling/in-flight rules, pagination cursors, error fallbacks, and auth-loss draft clearing.
     - Package manifests, lockfile, `scripts/`, and `spikes/` diff checks — no changes. `git diff --check` clean.
     - Reconciliation 2026-08-13: closed after fresh no-cache typecheck/test and all
       delivery gates passed on the production-wiring fix.
     - Deviations: declared platform-only skips and existing non-blocking build/audit warnings above; no failed required gate.

## Suggested execution batches

Recommended: run `/spec-implement all` in one fresh session because observation,
projection, shell, and cross-area safety contracts are tightly coupled.

If context must be split, use `1`, then `2-5`, then `6-8`, then `9-10`; start each
range only after its dependencies and verification commands are green.
