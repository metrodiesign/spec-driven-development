# Requirements: Autonomous Engineering Platform — Phase 0 + §15 Spikes

> Status: approved 2026-07-06 (goal-mode; /spec-analyze audit 1 applied — 9 findings, all resolved in-file)
> Derived from design.md (approved 2026-07-06) — each REQ cites its design section.
> Upstream: unified-platform-spec.md §14 Phase 0 DoD, §15, invariants §2.

## Overview

Phase 0 delivers the deterministic core (Ring 0) proven safe against a lying, over-reaching,
flaky, or crashing agent BEFORE any real model is connected, plus the Console foundation the
single operator uses to see projects, sessions, auth shadowing, and estimated quota. Success is
the 9-item fault-injection DoD passing as tests, the console foundation running fail-closed, and
§15 spikes recorded with honest evidence.

## REQ-1: Action validation & policy enforcement (design: "Ring 0 components — actions/executor")

**User Story:** As the platform operator, I want every proposed action validated and policy-checked
by the core, so that an agent can never act outside its granted rights.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL accept only actions conforming to the Action DSL union
      (WRITE_FILE, APPLY_PATCH, RUN_COMMAND, READ_FILE, REQUEST_TOOL), each carrying an `actionId`.
- 1.2 WHEN an action's path falls outside the proposing role's path allowlist THE SYSTEM SHALL
      reject it with a structured ActionRejection recorded as an `ACTION_REJECTED` event.
- 1.3 WHEN an action targets `test/golden/**` with a write THE SYSTEM SHALL reject it
      (golden is read-only for every role).
- 1.4 IF an action is malformed (schema violation) THEN THE SYSTEM SHALL reject it as structured
      feedback without crashing the loop.
- 1.5 THE SYSTEM SHALL return rejections to the agent as next-round structured feedback,
      never free text.
- 1.6 THE SYSTEM SHALL define the Phase 0 role set and allowlists in policy config, defaulting to
      spec §6.1: planner = read-only; test_designer = write `test/ai-generated/**`; implementer =
      write `src/**` + `test/ai-generated/**` within its own worktree; `test/golden/**` read-only
      for all.

## REQ-2: Egress default-deny (design: "security", Technology Decisions "Egress enforcement")

**User Story:** As the operator, I want every RUN_COMMAND network-isolated by default, so that a
compromised or lying agent cannot exfiltrate data.

**Acceptance Criteria (EARS):**
- 2.1 WHEN executing RUN_COMMAND with `network: "none"` (the default) THE SYSTEM SHALL run the
      command inside a deny-network sandbox in which child processes inherit the denial (darwin:
      `sandbox-exec`).
- 2.2 WHEN a sandboxed command attempts a network connection THE SYSTEM SHALL cause the connection
      to fail, capture the failure output as core-produced evidence, and log an `egress_blocked`
      marker.
- 2.3 IF no enforcing sandbox implementation exists on the host platform THEN THE SYSTEM SHALL
      refuse to execute RUN_COMMAND with `sandbox_unavailable` (fail-closed) rather than run
      unsandboxed.

## REQ-3: Append-only event log & projection (design: "state", Data Models "Events")

**User Story:** As the operator, I want all state derived from an append-only event log, so that
every run is auditable and reconstructable.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL persist all state changes as INSERT-only events in SQLite (WAL); the storage
      layer SHALL expose no update or delete operation for events.
- 3.2 THE SYSTEM SHALL rebuild the `state.json` projection purely from the event log, and the
      rebuilt projection SHALL equal the incrementally-maintained one.
- 3.3 THE SYSTEM SHALL export the event log as `events.jsonl` for audit.

## REQ-4: Immutable evidence store (design: "evidence")

**User Story:** As the operator, I want every gate result backed by immutable core-produced
evidence, so that "passed" claims are verifiable later.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL store evidence blobs content-addressed by sha256, written only by core.
- 4.2 THE SYSTEM SHALL bind every GateReport to `{commitHash, envHash, gateConfigHash}`.
- 4.3 IF an evidence blob's content hash does not match its address THEN THE SYSTEM SHALL treat the
      evidence as invalid and fail the consuming check.

## REQ-5: Lease — single writer per task (design: "state", Data Models "Events" lease rules)

**User Story:** As the operator, I want at most one worker owning a task at a time, so that
concurrent runs cannot corrupt a worktree.

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL grant a task lease via an atomic compare-and-set inside a single SQLite
      transaction that also inserts the `LEASE_CLAIMED` event (both or neither).
- 5.2 WHEN a second claimant attempts a claim on a held, unexpired lease THE SYSTEM SHALL deny the
      claim (CAS affects 0 rows) and that claimant SHALL execute nothing.
- 5.3 WHILE a lease is held THE SYSTEM SHALL renew it via heartbeat; WHEN the TTL expires without
      renewal THE SYSTEM SHALL allow a new claimant.

## REQ-6: Exactly-once action application (design: "Crash recovery", executor idempotency)

**User Story:** As the operator, I want actions applied exactly once across crashes and retries,
so that recovery never corrupts work.

**Acceptance Criteria (EARS):**
- 6.1 WHEN executing a mutating action (WRITE_FILE, APPLY_PATCH, RUN_COMMAND) THE SYSTEM SHALL take
      a worktree snapshot (git recovery ref), record `ACTION_INTENT{snapshotRef}` BEFORE applying,
      and `ACTION_APPLIED{resultHash}` after; non-mutating actions (READ_FILE, REQUEST_TOOL) need
      no snapshot.
- 6.2 WHEN recovery finds an `ACTION_INTENT` without matching `ACTION_APPLIED` THE SYSTEM SHALL
      reset the worktree to the recorded snapshot and re-run that single action (rollback-then-
      rerun), including for non-idempotent RUN_COMMAND actions, such that effects appear exactly once.
- 6.3 WHEN an action arrives whose `actionId` already has an `ACTION_APPLIED` event THE SYSTEM
      SHALL skip execution and record the duplicate (idempotent skip).
- 6.4 IF the worktree content hash disagrees with the last `ACTION_APPLIED.resultHash` at recovery
      THEN THE SYSTEM SHALL roll back to the last snapshot rather than continue on tampered state.

## REQ-7: Orchestrator authority & state machine (design: "orchestrator", Data Models "State machine")

**User Story:** As the operator, I want only the core to decide task progress, so that an agent's
self-reported success can never mark work complete.

**Acceptance Criteria (EARS):**
- 7.1 THE SYSTEM SHALL implement the §6.3 state machine as a pure transition table; every
      transition SHALL be recorded as an event.
- 7.2 WHEN a ProposalSource claims READY_FOR_VERIFICATION THE SYSTEM SHALL record the claim as data
      and run the gates itself; only core-run gate results SHALL cause PASSED/FAILED transitions.
- 7.3 THE SYSTEM SHALL provide no code path by which a ProposalSource output sets a task to
      COMPLETED (INV-2).
- 7.4 IF an illegal transition is attempted THEN THE SYSTEM SHALL record a structured error event
      and refuse the transition without crashing.
- 7.5 WHERE a transition belongs to a later phase (post-REVIEWING) THE SYSTEM SHALL guard it as
      `not_enabled_phase0` explicitly.
- 7.6 WHEN a task reaches REVIEWING in Phase 0 THE SYSTEM SHALL stop the loop cleanly with an
      `awaiting_human_phase0` marker — REVIEWING is the Phase 0 happy-path terminal state.

## REQ-8: Gate ladder T0/T1 with explicit stubs (design: "gates", Data Models "Gate config + report")

**User Story:** As the operator, I want green defined by core-run gates with a recorded config, so
that "passed" always names what was checked.

**Acceptance Criteria (EARS):**
- 8.1 WHEN running T0 THE SYSTEM SHALL execute lint, typecheck, and targeted tests (fallback: full
      unit) from `gate-ladder.json`.
- 8.2 WHEN an agent claims READY_FOR_VERIFICATION THE SYSTEM SHALL run T0 first (fast fail), then
      T1 (full tests, convention gate, golden check) — regardless of the claim.
- 8.3 THE SYSTEM SHALL include the gate-config file's byte hash in every GateReport.
- 8.4 WHEN T2 or T3 is requested THE SYSTEM SHALL return `not_enabled` explicitly, never a silent
      pass.
- 8.5 IF a test fails then passes on one retry THEN THE SYSTEM SHALL mark it `flaky_suspect` and
      flag for human review, never auto-quarantine (INV-16).

## REQ-9: Golden harness (design: "Golden harness")

**User Story:** As the operator, I want an independent truth base the loop cannot rewrite, so that
COMPLETED means passing tests the system did not author.

**Acceptance Criteria (EARS):**
- 9.1 THE SYSTEM SHALL deny write actions to `test/golden/**` for every role (also REQ-1.3).
- 9.2 WHEN T1 runs THE SYSTEM SHALL recompute golden file hashes and compare against
      `_MANIFEST.sha256`; a mismatch SHALL fail the gate with `golden_manifest_mismatch`.
- 9.3 THE SYSTEM SHALL document (in gate output) that Phase 0 fake-green detection covers golden
      tampering only; vacuous ai-generated tests are addressed by the Phase 1 RED-check.

## REQ-10: Budget backstop (design: "budget")

**User Story:** As the operator, I want hard budget limits, so that a failing loop halts instead of
burning quota forever.

**Acceptance Criteria (EARS):**
- 10.1 THE SYSTEM SHALL track per-task iterations, costUnits, and wallclock against configured
       budgets.
- 10.2 WHEN any budget is exceeded THE SYSTEM SHALL record `BUDGET_EXCEEDED`, transition the task
       to ESCALATED, and stop proposing — provably halting the loop.

## REQ-11: Vendor-neutral core boundary (design: "Dependency rule", INV-7)

**User Story:** As the operator, I want Ring 0 free of vendor coupling, so that core stays testable
with stubs and quota-survivability remains possible.

**Acceptance Criteria (EARS):**
- 11.1 THE SYSTEM SHALL provide a CI check that fails when `core/` (including tests and comments)
       contains any of: claude, anthropic, codex, glm, openai (case-insensitive).
- 11.2 THE SYSTEM SHALL keep `core/` free of imports from `console/`, `spikes/`, or any vendor SDK.
- 11.3 THE SYSTEM SHALL expose agent input to core only through the vendor-neutral ProposalSource
       port.

## REQ-12: Console launcher & fail-closed security baseline (design: "Console startup gate", "§13.3 subset")

**User Story:** As the operator, I want the console to start safe-by-default, so that exposure
requires an explicit, informed act.

**Acceptance Criteria (EARS):**
- 12.1 THE SYSTEM SHALL provide `platform console` with flags `--port` (default 9119), `--host`
       (default 127.0.0.1), `--no-open`, `--insecure`.
- 12.2 IF the bind host is non-loopback and no auth provider exists THEN THE SYSTEM SHALL refuse to
       start, exit non-zero, and print an actionable message (fail-closed).
- 12.3 WHERE `--insecure` is given THE SYSTEM SHALL start on a non-loopback bind and print a loud
       warning; `--insecure` SHALL never be a default.
- 12.4 THE SYSTEM SHALL reject requests whose Host header is not in the allowlist (localhost forms
       plus the actual configured bind host when non-loopback) and restrict CORS to the console's
       own origins on the same basis.
- 12.5 THE SYSTEM SHALL redact credential-file paths and any token-like values in every API
       response and log, and SHALL render paths under the home directory in `~`-prefixed display
       form (project paths remain usable — blanket home-path redaction would break F-Proj/F-Sess).
- 12.6 THE SYSTEM SHALL expose no endpoint that returns/exports credentials and no endpoint that
       creates users (verified by negative tests).
- 12.7 THE SYSTEM SHALL display a disclaimer that the console is a third-party tool, not an
       Anthropic product.

## REQ-13: Console read surfaces — F-Status, F-Proj, F-Sess (design: "Console REST API")

**User Story:** As the operator, I want to see CLI status, projects, and sessions in one place,
read live from Claude Code's own files.

**Acceptance Criteria (EARS):**
- 13.1 WHEN `GET /api/status` is called THE SYSTEM SHALL return the CLI version (from
       `claude --version`) and active runs from the event log.
- 13.2 IF the `claude` binary is not found THEN THE SYSTEM SHALL return a degraded status card with
       an install hint, not a 500.
- 13.3 WHEN `GET /api/projects` is called THE SYSTEM SHALL list projects from `~/.claude/projects/`
       plus registered cwds, flagging `loopManaged` where `.ai/goal.yaml` exists.
- 13.4 WHEN `GET /api/sessions?project=` is called THE SYSTEM SHALL parse session metadata live
       from Claude Code JSONL without persisting any copy (INV-11).
- 13.5 IF `~/.claude` is absent THEN THE SYSTEM SHALL return an empty state with guidance, not a 500.
- 13.6 IF a session JSONL file is malformed THEN THE SYSTEM SHALL skip that file, include a parse
       warning in the response, and never crash or 500.

## REQ-14: F-Auth — env shadowing detection (design: "Console REST API", spec §5.1)

**User Story:** As the operator, I want a red warning when an env var silently overrides my Max
subscription, so that I never pay API rates unknowingly.

**Acceptance Criteria (EARS):**
- 14.1 WHEN `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is present in the platform's environment
       THE SYSTEM SHALL report `shadowing: true` naming the variable(s) to unset.
- 14.2 THE SYSTEM SHALL never unset or modify the operator's environment variables itself.
- 14.3 THE SYSTEM SHALL report the active auth method heuristically without reading, storing, or
       displaying any token value.

## REQ-15: F-Usage — quota estimate mini-card (design: "Console REST API", spec §5.3)

**User Story:** As the operator, I want an estimated quota picture, so that I can plan work against
the 5-hour window and weekly caps.

**Acceptance Criteria (EARS):**
- 15.1 WHEN `GET /api/usage/estimate` is called THE SYSTEM SHALL group local transcript timestamps
       into rolling 5-hour windows and return an estimate labeled "estimate", with every monetary
       figure labeled "API-equivalent value — not an actual bill" (English rendering of the INV-13
       label; meaning is normative, language follows the UI).
- 15.2 WHERE the operator has stored a weekly reset anchor THE SYSTEM SHALL also return a weekly
       estimate; IF no anchor exists THEN THE SYSTEM SHALL state that a reset time is needed
       instead of guessing.
- 15.3 THE SYSTEM SHALL hardcode no quota caps; calibration input (`calibratedPercent`) SHALL be
       operator-entered via `PUT /api/usage/config`.

## REQ-16: §15 spikes with honest evidence (design: "Spikes")

**User Story:** As the operator, I want the five §15 spikes executed and recorded, so that Phase 1
gates rest on observed behavior, not assumption.

**Acceptance Criteria (EARS):**
- 16.1 THE SYSTEM SHALL provide runnable spike scripts for §15 items 1–5 in `spikes/`, isolated
      from core/console packages.
- 16.2 WHEN a spike runs THE SYSTEM SHALL record exact commands and observed output in
      `docs/spikes/SPIKE-<n>.md` with verdict PASS, FAIL, or PARTIAL(reason).
- 16.3 IF a spike step requires unautomatable observation (TUI `/usage`, node-pty build failure)
      THEN the record SHALL state PARTIAL with the exact manual step remaining — never PASS.
- 16.4 WHERE spike 5 verifies context isolation THE SYSTEM SHALL use the documented indirect
      marker-probe method and state its indirect nature in SPIKE-5.md.

## Fault-injection DoD mapping (spec §14 Phase 0)

| DoD# | Scenario | Proven by |
|---|---|---|
| 1 | agent lies about success | REQ-7.2/7.3 |
| 2 | out-of-allowlist / golden write | REQ-1.2/1.3 |
| 3 | sneaky egress | REQ-2.1/2.2 |
| 4 | fake-green / hash mismatch | REQ-9.2 (scope: REQ-9.3) |
| 5 | flaky test | REQ-8.5 |
| 6 | crash between INTENT/APPLIED | REQ-6.1/6.2 |
| 7 | duplicate actionId | REQ-6.3 |
| 8 | lease contention | REQ-5.1/5.2 |
| 9 | budget exceeded | REQ-10.2 |

## Edge Cases & Open Questions

- Windows is out of scope for Phase 0 (dev + CI are darwin; ConPTY concerns are Phase 1 F-Term).
- `envHash` composition (which env vars characterize a run) is decided at implementation and
  documented in code — must be deterministic and secret-free.
- Phase 0 costUnits are stub-declared (no real model); real usage normalization arrives with the
  Phase 1 adapter. Budget mechanics (REQ-10) are proven with stub-declared numbers.

### /spec-analyze findings log (audit 1, goal-mode decisions; anchor: initial commit of this file)

| # | Finding | Decision |
|---|---|---|
| A1 | REQ-6.1 "any action" covered non-mutating READ_FILE/REQUEST_TOOL | Fixed: scoped to mutating actions |
| A2 | REQ-12.3 vs 12.4 conflict: --insecure non-loopback blocked by localhost-only Host allowlist | Fixed: allowlist includes configured bind host |
| A3 | REQ-12.5 blanket home-path redaction breaks F-Proj/F-Sess (paths live under home) | Fixed: redact credential paths + token values; home shown as `~` display form |
| A4 | Role set referenced but undefined | Fixed: REQ-1.6 defines §6.1 default roles in policy config |
| A5 | Gate order on claim ambiguous (T0 vs T1) | Fixed: REQ-8.2 T0-then-T1 |
| A6 | Post-PASSED behavior in Phase 0 undefined | Fixed: REQ-7.6 REVIEWING = terminal, awaiting_human_phase0 |
| A7 | Thai disclaimer string inside English UI | Fixed: REQ-15.1 meaning normative, English rendering |
| A8 | Malformed JSONL behavior implied only | Fixed: REQ-13.6 skip + warn, never 500 |
| A9 | costUnits source in Phase 0 (no model) undefined | Logged above: stub-declared, per-REQ-10 note |
