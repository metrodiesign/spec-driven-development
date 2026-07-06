# Implementation Tasks: Autonomous Engineering Platform — Phase 0 + §15 Spikes

> Status: approved 2026-07-06 (goal-mode; spec-trace OK — 64 criteria covered, EARS lint pass)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.
> RED-first is normative (spec §0.4): task 2 lands the fault-injection suite as
> FAILING tests; tasks 3–6 turn it green module by module. Never weaken a scenario
> to pass it (INV-16).

- [ ] 1. Monorepo scaffold + enforcement guards — pnpm workspaces (core/, console/backend,
     console/web, spikes/), strict tsconfig, eslint minimal, `.ai/policies/gate-ladder.json`,
     `scripts/check-core-vendor-free.sh`, CI: vendor check on every job + fault-injection job
     pinned to macOS (D-003). Done = install/typecheck/lint green; vendor check passes and a
     planted vendor word demonstrably fails it.
     Satisfies: REQ-11.1, REQ-11.2. Verify: `pnpm install && pnpm -r typecheck && pnpm -r lint`;
     `scripts/check-core-vendor-free.sh` exit 0, planted-word run exit 1.

- [ ] 2. Core public interfaces + fault-injection suite in RED — `core/src/ports.ts`
     (ProposalSource), Action DSL types, event/report types; synthetic target-repo fixture
     helper (temp git repo + golden dir + `_MANIFEST.sha256`); all 9 DoD scenarios written as
     tests against the interfaces, observed FAILING (modules throw NotImplemented). Done = suite
     runs, every scenario RED for the expected reason, RED output recorded in Evidence.
     Satisfies: REQ-11.3 (+DoD 1–9 authored). Verify: `pnpm --filter core test` shows 9 failing
     scenarios with expected messages.

- [ ] 3. Core state layer — SQLite (WAL) append-only event log (INSERT-only API), `state.json`
     projection + rebuild-equality, `events.jsonl` export, content-addressed evidence store,
     lease claim as single-transaction CAS + heartbeat/TTL. Done = co-located unit tests green +
     DoD#8 (lease contention) green.
     Satisfies: REQ-3, REQ-4, REQ-5. Depends on: 2. Verify: `pnpm --filter core test` — state
     unit tests + fault-injection scenario 8 pass.

- [ ] 4. Core executor — action schema validation, role path-policy (REQ-1.6 defaults), golden
     write-deny, structured ActionRejection→feedback, egress deny-network sandbox (darwin
     sandbox-exec; fail-closed elsewhere), snapshot-before-intent + INTENT/APPLIED events,
     duplicate-actionId skip, rollback-then-rerun recovery incl. non-idempotent RUN_COMMAND.
     Done = DoD#2,3,6,7 green.
     Satisfies: REQ-1, REQ-2, REQ-6. Depends on: 3. Verify: `pnpm --filter core test` —
     scenarios 2,3,6,7 pass.

- [ ] 5. Core gates + golden harness + budget — T0/T1 runners from `gate-ladder.json` (byte hash
     into every GateReport), T2/T3 explicit `not_enabled`, flaky retry-once-and-flag, golden
     manifest verify (`golden_manifest_mismatch`), DoD#4 scope note in gate output, budget
     counters → BUDGET_EXCEEDED + ESCALATED. Done = DoD#4,5,9 green.
     Satisfies: REQ-8, REQ-9, REQ-10. Depends on: 3. Verify: `pnpm --filter core test` —
     scenarios 4,5,9 pass.

- [ ] 6. Orchestrator + state machine — pure transition table (§6.3), claims-as-data, no
     COMPLETED path for agents, illegal-transition structured error, `not_enabled_phase0`
     guards, REVIEWING terminal (`awaiting_human_phase0`), loop wiring ProposalSource→executor→
     gates. Done = DoD#1 green and the WHOLE fault-injection suite green (Phase 0 core DoD).
     Satisfies: REQ-7. Depends on: 4, 5. Verify: `pnpm --filter core test` — all 9 scenarios +
     unit tests pass.

- [ ] 7. Console backend + launcher — Fastify app: `/api/status`, `/api/projects`,
     `/api/sessions`, `/api/auth`, `/api/usage/estimate`, `PUT /api/usage/config`; `platform
     console` bin with flags; fail-closed non-loopback gate; host-header/CORS allowlist;
     redaction (`~` display form, credential paths/tokens); negative guarantees (no credential
     route, no user-creation route); degraded/empty states (no binary, no ~/.claude, malformed
     JSONL). Done = endpoint + gate + negative tests green.
     Satisfies: REQ-12.1–12.6, REQ-13, REQ-14, REQ-15. Depends on: 1. Verify:
     `pnpm --filter console-backend test`.

- [ ] 8. Console web SPA — React+Vite: Status/Projects/Sessions/Auth/Usage views wired to the
     API, third-party disclaimer, usage 5h-window grouping + shadowing display as pure tested
     functions, accessibility basics (labels, keyboard, contrast). Done = build green + logic
     unit tests green + served by backend.
     Satisfies: REQ-12.7 (+UI for REQ-13/14/15). Depends on: 7. Verify:
     `pnpm --filter console-web test && pnpm --filter console-web build`.

- [ ] 9. §15 spikes 1–5 + evidence — runnable scripts in `spikes/` (SDK sessions, PTY parity
     with node-pty preflight, query streaming + canUseTool, subscription billing proof, adapter
     isolation via indirect marker-probe); record each in `docs/spikes/SPIKE-<n>.md` with exact
     commands, observed output, verdict PASS/FAIL/PARTIAL(reason) — PARTIAL for any
     unautomatable step, never a hollow PASS.
     Satisfies: REQ-16. Depends on: 1. Verify: 5 SPIKE files exist, each with commands + output +
     verdict; scripts re-runnable.

## Suggested execution batches

Coupled feature — DEFAULT: run ALL tasks in ONE session (`/spec-implement all`), dependency
order 1→2→3→4→5→6→7→8→9 (7/8 can interleave after 1; 9 after 1, needs live login for 2–5).
No Batch tags: every task is big/foundational — each wants focused context; all-in-one session
covers the shared-cache benefit already.
