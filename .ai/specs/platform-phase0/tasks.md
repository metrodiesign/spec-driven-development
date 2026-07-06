# Implementation Tasks: Autonomous Engineering Platform — Phase 0 + §15 Spikes

> Status: approved 2026-07-06 (goal-mode; spec-trace OK — 64 criteria covered, EARS lint pass)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.
> RED-first is normative (spec §0.4): task 2 lands the fault-injection suite as
> FAILING tests; tasks 3–6 turn it green module by module. Never weaken a scenario
> to pass it (INV-16).

- [x] 1. Monorepo scaffold + enforcement guards — pnpm workspaces (core/, console/backend,
     console/web, spikes/), strict tsconfig, eslint minimal, `.ai/policies/gate-ladder.json`,
     `scripts/check-core-vendor-free.sh`, CI: vendor check on every job + fault-injection job
     pinned to macOS (D-003). Done = install/typecheck/lint green; vendor check passes and a
     planted vendor word demonstrably fails it.
     Satisfies: REQ-11.1, REQ-11.2. Verify: `pnpm install && pnpm -r typecheck && pnpm -r lint`;
     `scripts/check-core-vendor-free.sh` exit 0, planted-word run exit 1.
     Evidence:
       - test: `pnpm install && pnpm typecheck && pnpm lint && pnpm test` -> all 4 packages
         typecheck Done, ESLint no issues, 3 smoke tests pass (core, console-backend, console-web)
       - test: `scripts/check-core-vendor-free.sh` -> exit 0; planted vendor word in
         core/src/*.tmp.ts -> exit 1 with file:line; removed -> exit 0 again
       - test: `pnpm --filter console-web build` -> vite build OK (28 modules)
       - viewports: n/a — scaffold/logic-only
       - deviations: lint is a single root `eslint .` (flat config) instead of per-package
         `pnpm -r lint`; `pnpm test` glob requires >=1 test file per package so each package
         ships a smoke test from the scaffold commit; pnpm-workspace.yaml gained allowBuilds
         esbuild:true (pnpm 11 build-script approval, needed by vite)

- [x] 2. Core public interfaces + fault-injection suite in RED — `core/src/ports.ts`
     (ProposalSource), Action DSL types, event/report types; synthetic target-repo fixture
     helper (temp git repo + golden dir + `_MANIFEST.sha256`); all 9 DoD scenarios written as
     tests against the interfaces, observed FAILING (modules throw NotImplemented). Done = suite
     runs, every scenario RED for the expected reason, RED output recorded in Evidence.
     Satisfies: REQ-11.3 (+DoD 1–9 authored). Verify: `pnpm --filter core test` shows 9 failing
     scenarios with expected messages.
     RED milestone note (2026-07-06): reached and observed — `pnpm --filter core test` ->
     tests 11, pass 1 (smoke), fail 10; all 9 DoD scenarios (DoD#6 split 6/6b) RED with
     `Error: NotImplemented: openEventLog` (expected reason). typecheck/lint/vendor-check green.
     (Checkbox stayed [ ] until the suite turned green — task-gate enforces green-on-[x];
     flipped together with task 6 per RED-first §0.4.)
     Evidence:
       - test: RED state recorded above (commit 3241b54); suite now GREEN — see task 6 Evidence
       - test: adversarial review of the suite itself (61-agent workflow, 2-refuter verify,
         verifierFailures 0): 11 confirmed + 7 split findings ALL applied — honest-path control
         (DoD#1b), positive-allowlist + traversal cases (DoD#2), loop-feedback (DoD#2b), raw-IP
         no-proxy egress probe + evidence content assert (DoD#3), delete/add golden routes
         (DoD#4b), real-retry count + deterministic-failure control (DoD#5/5b), pre-crash
         effect + snapshotRef + partial-apply garbage + recovery idempotence (DoD#6/6b),
         restart-surviving dedupe + non-idempotent duplicate (DoD#7/7b), TTL boundary pinning +
         cross-process race (DoD#8/8b)
       - viewports: n/a — logic-only
       - deviations: event types extended with CLAIM_RECORDED + ERROR; eslint gains
         argsIgnorePattern '^_'; APPLY_PATCH + REQUEST_TOOL + network allowlists rejected as
         unsupported_action_phase0 (structured, honest — land in later phases)

- [x] 3. Core state layer — SQLite (WAL) append-only event log (INSERT-only API), `state.json`
     projection + rebuild-equality, `events.jsonl` export, content-addressed evidence store,
     lease claim as single-transaction CAS + heartbeat/TTL. Done = co-located unit tests green +
     DoD#8 (lease contention) green.
     Satisfies: REQ-3, REQ-4, REQ-5. Depends on: 2. Verify: `pnpm --filter core test` — state
     unit tests + fault-injection scenario 8 pass.
     Evidence:
       - test: `pnpm --filter core test` -> 43/43 pass incl. DoD#8 (sequential CAS + TTL
         boundary at 59999/60000/60001ms) and DoD#8b (5 rounds of two REAL processes racing
         one SQLite file — exactly one WON + one LEASE_CLAIMED per round), event-log unit
         tests (INSERT-only surface, projection fold-equality, jsonl export), evidence store
         (roundtrip, tamper -> hash mismatch throw, invalid refs), lease unit (renew/release/
         self-reclaim)
       - viewports: n/a — logic-only
       - deviations: node:sqlite RC risk recorded as D-001 (docs/DEVIATIONS.md)

- [x] 4. Core executor — action schema validation, role path-policy (REQ-1.6 defaults), golden
     write-deny, structured ActionRejection→feedback, egress deny-network sandbox (darwin
     sandbox-exec; fail-closed elsewhere), snapshot-before-intent + INTENT/APPLIED events,
     duplicate-actionId skip, rollback-then-rerun recovery incl. non-idempotent RUN_COMMAND.
     Done = DoD#2,3,6,7 green.
     Satisfies: REQ-1, REQ-2, REQ-6. Depends on: 3. Verify: `pnpm --filter core test` —
     scenarios 2,3,6,7 pass.
     Evidence:
       - test: `pnpm --filter core test` -> DoD#2 (7 rejection cases: traversal, prefix-escape,
         absolute, golden direct + via src/../, gate-script rewrite, planner write — files
         proven untouched), DoD#2b (rejection feedback reaches round-2 propose), DoD#3
         (`nc -z 1.1.1.1 443` under sandbox-exec deny-network -> exit != 0, evidence blob
         non-empty), DoD#6/6b (crash after apply AND after intent + partial-apply garbage ->
         exactly-once, recovery idempotent), DoD#7/7b (dedupe across restart + non-idempotent
         duplicate not re-run) — all pass on darwin; path-policy unit tests green
       - viewports: n/a — logic-only
       - deviations: realpath containment added at apply time (symlink escapes) beyond the
         lexical policy; RUN_COMMAND env is minimal deterministic PATH (no secret leakage)
       - post-review (Codex, PR #41): sandbox now denies file-write outside the worktree +
         onto test/golden even via shell (D-005); new DoD#2c proves escape/golden writes fail
         and in-worktree writes still work; DoD#4 tamper moved out-of-band (prevention proven
         separately, detection still fully exercised)

- [x] 5. Core gates + golden harness + budget — T0/T1 runners from `gate-ladder.json` (byte hash
     into every GateReport), T2/T3 explicit `not_enabled`, flaky retry-once-and-flag, golden
     manifest verify (`golden_manifest_mismatch`), DoD#4 scope note in gate output, budget
     counters → BUDGET_EXCEEDED + ESCALATED. Done = DoD#4,5,9 green.
     Satisfies: REQ-8, REQ-9, REQ-10. Depends on: 3. Verify: `pnpm --filter core test` —
     scenarios 4,5,9 pass.
     Evidence:
       - test: `pnpm --filter core test` -> DoD#4 (edit route; gateConfigHash asserted equal to
         sha256 of actual config bytes; scopeNote matches /tamper/i), DoD#4b (delete + add
         routes), DoD#5 (.runs proves the suite ran exactly twice; flaky_suspect flagged; not
         passed; zero GOVERNANCE_CHANGE), DoD#5b control (stable failure NOT labeled flaky),
         DoD#9 (3 proposals max, BUDGET_EXCEEDED + ESCALATED) — plus golden unit tests (all
         tamper routes + fail-closed missing manifest) and budget boundary unit tests
       - viewports: n/a — logic-only
       - deviations: convention gate builtin = .only/.skip scan of test files (INV-16 list);
         flaky fail-then-pass = pass:false (conservative, human decides)
       - post-review (Codex, PR #41): GateReport gains worktreeHash (git tree hash of the exact
         dirty tree the gate ran on) beside commitHash — REQ-4.2 binding honest for mid-loop
         gates; unit test runner.test.ts + fault-injection helper now assert it on every
         GATE_RESULT

- [x] 6. Orchestrator + state machine — pure transition table (§6.3), claims-as-data, no
     COMPLETED path for agents, illegal-transition structured error, `not_enabled_phase0`
     guards, REVIEWING terminal (`awaiting_human_phase0`), loop wiring ProposalSource→executor→
     gates. Done = DoD#1 green and the WHOLE fault-injection suite green (Phase 0 core DoD).
     Satisfies: REQ-7. Depends on: 4, 5. Verify: `pnpm --filter core test` — all 9 scenarios +
     unit tests pass.
     Evidence:
       - test: `pnpm --filter core test` -> tests 43, pass 43, fail 0, skipped 0 (darwin) —
         ALL 9 DoD scenarios + hardened variants green; DoD#1 (liar never PASSED, every
         GATE_RESULT bound to resolvable evidence + real config hash), DoD#1b honest control
         (real fix reaches REVIEWING + awaiting_human_phase0 with genuinely green T1)
       - test: machine unit — exhaustive state x trigger sweep proves NO trigger reaches
         COMPLETED in Phase 0 (INV-2 structural), post-REVIEWING = not_enabled_phase0,
         illegal transitions structured (REQ-7.4)
       - test: `pnpm typecheck && pnpm lint && scripts/check-core-vendor-free.sh` -> all green
       - viewports: n/a — logic-only
       - deviations: none

- [x] 7. Console backend + launcher — Fastify app: `/api/status`, `/api/projects`,
     `/api/sessions`, `/api/auth`, `/api/usage/estimate`, `PUT /api/usage/config`; `platform
     console` bin with flags; fail-closed non-loopback gate; host-header/CORS allowlist;
     redaction (`~` display form, credential paths/tokens); negative guarantees (no credential
     route, no user-creation route); degraded/empty states (no binary, no ~/.claude, malformed
     JSONL). Done = endpoint + gate + negative tests green.
     Satisfies: REQ-12.1–12.6, REQ-13, REQ-14, REQ-15. Depends on: 1. Verify:
     `pnpm --filter console-backend test`.
     Evidence:
       - test: `pnpm --filter console-backend test` -> tests 21, pass 21, fail 0 — startup
         gate (refuse/warn/start), host-header + CORS rejects, redaction (tokens, credential
         paths, home->~), auth shadowing red warning with names-never-values (fake key value
         asserted absent from response), projects/sessions live-read fixtures incl. malformed
         JSONL skip+warn, usage estimate + anchor-required weekly + config PUT roundtrip,
         negative route guarantees (no credential/user routes; probes 404)
       - live smoke: `node console/backend/bin/platform.ts console --host 0.0.0.0` ->
         refused, exit 1 with fail-closed message; `--port 9123 --no-open` -> listening,
         GET /api/status returned real CLI version `2.1.201 (Claude Code)` + disclaimer;
         Host: evil.example.com -> 403
       - viewports: n/a — API/CLI
       - deviations: static SPA serving added to the backend (path-contained, no dep) so the
         launcher serves the UI at /
       - post-review (Codex, PR #41): CORS/host allowlist now pins the EFFECTIVE port — a
         portless origin/Host resolves to its default port (80/443) and must equal the console
         port, closing the `http://localhost` (:80) cross-origin read; tests added

- [x] 8. Console web SPA — React+Vite: Status/Projects/Sessions/Auth/Usage views wired to the
     API, third-party disclaimer, usage 5h-window grouping + shadowing display as pure tested
     functions, accessibility basics (labels, keyboard, contrast). Done = build green + logic
     unit tests green + served by backend.
     Satisfies: REQ-12.7 (+UI for REQ-13/14/15). Depends on: 7. Verify:
     `pnpm --filter console-web test && pnpm --filter console-web build`.
     Evidence:
       - test: `pnpm --filter console-web test` -> 4/4 pass (authBanner red/ok, windowSummary,
         projectLabel loop-managed); `pnpm --filter console-web build` -> vite OK
       - browser (real `platform console` on 127.0.0.1:9123, live ~/.claude data): disclaimer
         note rendered; auth status region (role=status/alert); real CLI version card; usage
         card showed live open 5h window + "weekly needs reset time"; projects list with ~
         display paths; deep-link ?project= rendered 23 live session rows in a captioned table
       - viewports: 375 clientWidth 360 hScroll false | 768 clientWidth 753 hScroll false |
         1440 clientWidth 1425 hScroll false (after overflow-wrap + table overflow-x fix)
       - deviations: found+fixed during browser verify: sessions fetch fired with empty
         project param when none selected (400 in console) -> useFetch now accepts null;
         favicon 404 left as-is (cosmetic)

- [x] 9. §15 spikes 1–5 + evidence — runnable scripts in `spikes/` (SDK sessions, PTY parity
     with node-pty preflight, query streaming + canUseTool, subscription billing proof, adapter
     isolation via indirect marker-probe); record each in `docs/spikes/SPIKE-<n>.md` with exact
     commands, observed output, verdict PASS/FAIL/PARTIAL(reason) — PARTIAL for any
     unautomatable step, never a hollow PASS.
     Satisfies: REQ-16. Depends on: 1. Verify: 5 SPIKE files exist, each with commands + output +
     verdict; scripts re-runnable.
     Evidence:
       - test: all 5 spikes run green on 2026-07-06 (sdk 0.3.200, node-pty 1.1.0, Node 26):
         SPIKE1 PASS (25 sessions read), SPIKE2 PASS automated subset (TUI render, /status,
         backend-owned PTY detach, --resume) + PARTIAL manual (permission-prompt keystroke,
         /usage visual), SPIKE3 PASS (stream + canUseTool gates Write-deny), SPIKE4 PASS
         automated (query succeeds with all auth env stripped; keychain credential present)
         + PARTIAL manual (/usage before/after), SPIKE5 PASS (tools:[]+settingSources:[] ->
         zero tools, no tool_use, no file, no canary leak, NO_CONFIG_VISIBLE)
       - test: `pnpm --filter spikes typecheck && pnpm lint` -> green; node-pty preflight
         (typeof pty.spawn === 'function') passed on Node 26
       - docs: docs/spikes/SPIKE-1..5.md record exact output + honest PARTIAL remainders (A4)
       - viewports: n/a — CLI/SDK
       - deviations: D-004 recorded (tools:[] is the real isolation mechanism, not
         allowedTools:[]; machine settings allow-rules shadow canUseTool -> settingSources:[]
         required). Spikes 2/4 carry documented manual remainders — never claimed auto-passed.

## Suggested execution batches

Coupled feature — DEFAULT: run ALL tasks in ONE session (`/spec-implement all`), dependency
order 1→2→3→4→5→6→7→8→9 (7/8 can interleave after 1; 9 after 1, needs live login for 2–5).
No Batch tags: every task is big/foundational — each wants focused context; all-in-one session
covers the shared-cache benefit already.
