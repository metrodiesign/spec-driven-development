# Requirements: Autonomous Engineering Platform — Phase 2 (Semi-autonomous + Survivability + Console Extensions)

> Status: approved 2026-07-07 (human gate; /spec-analyze AZ-1..AZ-20 applied pre-approval)
> Derived from design.md (approved 2026-07-07, human gate) — each REQ cites its design section.
> Upstream: unified-platform-spec.md §14 Phase 2 DoD, §5.4, §6.6, §9.3, §10.1–10.3, §12, §13.3, §16, invariants §2.
> User decisions binding: clarifications.md (one spec; backlog 4 items in scope; fixture-repo auto-merge; human gates).

## Overview

Phase 2 makes the supervised loop semi-autonomous and survivable: hypothesis-driven repair
replaces blind re-proposing, a circuit breaker plus quota-aware health routing keeps the loop
from thrashing a failing or exhausted provider, L0–L1 tasks auto-merge onto the fixture repo
under a deterministic sampling audit, every policy change passes meta-governance, and a paused
loop accepts human guidance mid-flight (steering). The Console grows the remaining governance
surfaces (MCP, hooks with a consent gate, subagents, skills, system/retention) and every
autonomous entry point gains quota guards. The four issues carried from the Phase-1 live pass
(repair-round budget charging, frozen wallclock, first-attach blank render, missing nested
transcript) are closed at their root.

## REQ-1: Circuit breaker per adapter+model (design: "aal/src/breaker.ts", "Breaker" data model)

**User Story:** As the platform operator, I want a failing provider circuit-broken instead of
re-hit, so that the loop degrades in a controlled, observable way (INV-5).

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL keep one breaker state machine (closed / open / half_open) per key
      `adapterId@modelVersion`, isolated per key.
- 1.2 WHEN the failure rate over the sliding window of recent sends crosses the configured
      threshold THE SYSTEM SHALL transition that key closed → open.
- 1.3 WHILE a key is open THE SYSTEM SHALL exclude its adapter from `eligible()` results.
- 1.4 WHEN the configured open interval elapses THE SYSTEM SHALL admit exactly one probe
      request for that key (half-open, single-flight).
- 1.5 IF the half-open probe fails THEN THE SYSTEM SHALL re-open the breaker; a successful
      probe SHALL close it.
- 1.6 THE SYSTEM SHALL emit every breaker transition through an injected sink as a
      `BREAKER_STATE_CHANGED` event — transitions are never silent.
- 1.7 THE SYSTEM SHALL implement the breaker in `aal/` vendor-name-free with an injected
      clock (no wall-clock reads inside the module).

## REQ-2: Quota-aware health routing (design: "aal/src/source.ts (extended)" (c), "Breaker" data model, "adapters/src/anthropic.ts (extended)")

**User Story:** As the operator on a capped Max plan, I want routing to sidestep an adapter
whose quota is nearly exhausted, so that autonomous runs never burn the interactive window
(INV-13, §5.4).

**Acceptance Criteria (EARS):**
- 2.1 THE SYSTEM SHALL let a registered adapter supply an optional health probe returning
      `{ok, reason?, windows?: {fiveHourPct, weeklyPct}}` — per-window estimates, not one
      collapsed number; an absent probe means always-ok.
- 2.2 WHEN `propose()` starts a round THE SYSTEM SHALL await one `registry.refreshHealth()`
      that runs the probes and stores results in a cached snapshot; `eligible()` and
      `route()` SHALL stay synchronous over that snapshot.
- 2.3 WHEN the cached health result changes THE SYSTEM SHALL emit a `QUOTA_PROBE
      {fiveHourPct, weeklyPct}` event.
- 2.4 WHILE an adapter's health is not-ok (reason `quota_threshold` or `probe_failed`)
      THE SYSTEM SHALL exclude it from `eligible()`.
- 2.5 THE SYSTEM SHALL inject the Claude quota probe into `createAnthropicAdapter` as a
      closure built at the composition root from the console usage estimator — the adapter
      itself SHALL contain no quota-estimation logic.
- 2.6 THE SYSTEM SHALL label every quota number exposed by probes or events as an estimate
      (INV-13 claim discipline).
- 2.7 THE SYSTEM SHALL bound every health probe inside `refreshHealth` with a
      policy-pinned timeout; IF a probe does not resolve within it THEN THE SYSTEM SHALL
      treat that adapter as not-ok (reason `probe_failed`) and emit the health-change
      event — a hung probe never blocks the loop.

## REQ-3: Degraded routing on adapter failure (design: "aal/src/source.ts (extended)" (b), "Error Handling Strategy")

**User Story:** As the operator, I want a failing send to route around the failure once and
then stop cleanly, so that no retry loop and no loosened criteria ever hide capacity loss
(INV-5).

**Acceptance Criteria (EARS):**
- 3.1 WHEN `send()` throws `AdapterError` THE SYSTEM SHALL record the failure with the
      breaker for that adapter+model key.
- 3.2 WHEN a send has failed THE SYSTEM SHALL re-route once to the next eligible adapter
      (`switch_to_next_eligible`), excluding every adapter+model key that already failed
      in the current round regardless of breaker state.
- 3.3 IF no eligible adapter remains after that exclusion, or the single re-route has
      also failed, THEN THE SYSTEM SHALL return the structured `BLOCKED(no_capacity)`
      proposal — no retry loops, no role-requirement loosening.
- 3.4 WHEN a send succeeds THE SYSTEM SHALL record the success with the breaker (closing a
      half-open key).
- 3.5 THE SYSTEM SHALL leave a compliant adapter's breaker closed across an entire run
      (benign baseline — no false-positive trips).

## REQ-4: Per-call role routing + diagnostician role (design: "aal/src/source.ts (extended)" (a), "core/src/repair/hypothesis.ts" routing prerequisite)

**User Story:** As the loop, I want to request different agent roles per round through one
source, so that a DIAGNOSING round can actually reach a diagnostician.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL route and build each `AgentRequest` from `ProposalInput.role` at call
      time, not from a construction-time role.
- 4.2 THE SYSTEM SHALL add `diagnostician` to the `Role` union with a `roleRequires` case in
      the registry (schema conformance only, no extra capability bits).
- 4.3 THE SYSTEM SHALL give the diagnostician role an empty write-prefix list — read plus
      probe `RUN_COMMAND` only, `test/golden/**` read-only like every role.

## REQ-5: Hypothesis-driven repair (design: "core/src/repair/hypothesis.ts", "Hypothesis-driven repair" sequence, "Hypothesis schema")

**User Story:** As the operator, I want failures diagnosed with testable hypotheses whose
probes are cheaper than patch+verify, so that repair is targeted and escalation carries a
decidable question (§9.3, §10.3).

**Acceptance Criteria (EARS):**
- 5.1 WHEN a task enters FAILED THE SYSTEM SHALL transition to DIAGNOSING and request a
      diagnostician proposal conforming to the hypothesis schema
      `{statement, probes:[{cmd, expected}], ifConfirmed:{patchPlan, estimatedBlastRadius}}`.
- 5.2 THE SYSTEM SHALL run every probe itself through the core executor as `RUN_COMMAND`
      with `network: 'none'` — the agent never executes anything (INV-1).
- 5.3 THE SYSTEM SHALL run probes in array order (the agent's cheapest-first ordering) and
      stop at the first confirming probe.
- 5.4 WHEN a probe output matches its `expected` THE SYSTEM SHALL record
      `HYPOTHESIS_CONFIRMED`, transition to REPAIRING, and fold `patchPlan` into the next
      implementer round as marked untrusted data.
- 5.5 THE SYSTEM SHALL record every probe execution as a `PROBE_RUN` event with a
      content-addressed evidenceRef, and every refuted hypothesis as `HYPOTHESIS_REFUTED` —
      refuted hypotheses are always persisted.
- 5.6 IF every hypothesis is refuted or the count exceeds `max_hypotheses_per_failure` THEN
      THE SYSTEM SHALL escalate as `hypotheses_exhausted` carrying the ordered hypothesis
      log (statements, verdicts, probe evidence refs) — never a raw log dump.
- 5.7 IF a hypothesis carries more probes than the policy-pinned cap (default 5) THEN
      THE SYSTEM SHALL reject the proposal as structured feedback — the diagnostician
      output is untrusted input and cannot demand unbounded execution.
- 5.8 THE SYSTEM SHALL bound each probe with a policy-pinned timeout; IF a probe errors
      or times out (command missing, sandbox denial, nonzero unexpected exit) THEN
      THE SYSTEM SHALL record the error in `PROBE_RUN` and mark the hypothesis
      `undecided` — counting toward `max_hypotheses_per_failure` but never as a
      refutation, because an execution error is not evidence.
- 5.9 THE SYSTEM SHALL run the budget and wallclock checks between probes, not only
      between rounds.

## REQ-6: Budget honesty (design: "aal/src/repair.ts (backlog #1)", "aal/src/source.ts (extended)" (d), "Composition root" clock; carried backlog #1 #2)

**User Story:** As the operator, I want the budget backstop to count real spend and real
time, so that caps actually cap (§6.6 backstop, carried backlog).

**Acceptance Criteria (EARS):**
- 6.1 THE SYSTEM SHALL accumulate `usage.costUnits` across ALL repair rounds into a
      `totalUsage` on the repair outcome and charge the total against the task budget.
- 6.2 THE SYSTEM SHALL keep conformance P3/P4 verdicts unchanged by the accounting fix
      (they assert validity and round count, not usage).
- 6.3 THE SYSTEM SHALL send the task's actual remaining budget in
      `AgentRequest.budget.costUnits`, replacing the hardcoded value.
- 6.4 THE SYSTEM SHALL accept an injected `Clock` in `runSupervisedLoop` (production
      `Date.now()` per call, tickable clock in tests), replacing the frozen `nowMs`
      parameter.
- 6.5 WHILE a task's ACTIVE wallclock exceeds `max_wallclock_per_task_min` THE SYSTEM SHALL
      trip the wallclock budget and escalate — active time excludes
      `PAUSE_REQUESTED → RESUMED` intervals and approval-wait intervals (interval
      timestamps live in the event log, so the computation is replayable); a trip that
      was impossible under the frozen clock.
- 6.6 THE SYSTEM SHALL keep every gate verdict and evidence hash independent of timestamps
      (wall-clock timestamps affect only the wallclock budget and event metadata).
- 6.7 WHEN charging a round leaves the remaining budget at or below zero THE SYSTEM SHALL
      escalate `budget_exhausted` BEFORE building any further `AgentRequest` — a zero or
      negative budget value is never sent to an adapter.

## REQ-7: Auto-merge L0–L1 (design: "core/src/merge/auto-merge.ts", "State machine changes", "Auto-merge" sequence)

**User Story:** As the operator, I want low-risk green tasks merged without me, so that the
loop finishes routine work at machine pace while risk stays human-gated (§6.6).

**Acceptance Criteria (EARS):**
- 7.1 THE SYSTEM SHALL create a task branch `task/<taskId>` from the fixture repo's main
      branch before the loop starts, and the executor's worktree SHALL track that branch.
- 7.2 WHEN a task reaches REVIEWING with riskClass in {L0, L1}, all gates green, every
      mapped acceptance criterion golden-backed, and no dependency-touching diff THE SYSTEM
      SHALL fire `auto_approved` → APPROVED and record an `AUTO_APPROVED` event labeled as
      a policy decision, not a human approval — "mapped acceptance criteria" = the frozen
      contract's `acceptance_criteria` entries for the task (the Phase-2 single-task loop
      maps ALL of them); an AC is golden-backed iff it carries `golden: true`.
- 7.3 THE SYSTEM SHALL keep the `auto_approved` trigger unreachable through `ports.ts` — no
      agent claim can fire it (INV-2).
- 7.4 WHEN a task is APPROVED by auto-merge policy THE SYSTEM SHALL merge the task branch
      into main with `--no-ff` so the revert target is a single merge commit.
- 7.5 IF the merge conflicts THEN THE SYSTEM SHALL escalate as `merge_conflict` with no
      automatic resolution.
- 7.6 IF a task declares no risk class THEN THE SYSTEM SHALL treat it as L2
      (fail-toward-human); a diff touching a dependency manifest or lockfile — matched
      against the single governance-pinned pattern list in
      `.ai/policies/security-plane.json` — SHALL floor the effective risk to at least L2.
- 7.7 IF any mapped acceptance criterion is not golden-backed THEN THE SYSTEM SHALL route
      the task to the approval-package path regardless of declared risk.
- 7.8 THE SYSTEM SHALL enable the `merge_queued`/`audited`/`completed` transitions (removed
      from the phase gate) and add MERGE_QUEUED and AUDITED to the active states so
      `escalate`/`roll_back` are legal from both.
- 7.9 IF the frozen contract carries zero acceptance criteria THEN THE SYSTEM SHALL route
      the task to the approval-package path — auto-merge never rides a vacuous
      golden-backed check.

## REQ-8: Sampling audit (design: "core/src/merge/auto-merge.ts", "Auto-merge" sequence)

**User Story:** As the operator, I want a deterministic sample of auto-merged tasks
re-verified from a clean checkout, so that auto-merge honesty is measured, not assumed
(§6.5 residual).

**Acceptance Criteria (EARS):**
- 8.1 THE SYSTEM SHALL decide sampling deterministically as
      `sha256(runId + taskId) mod 100 < auditSampleRate` — no RNG, replayable from the
      event log.
- 8.2 WHEN a merged task is sampled THE SYSTEM SHALL record `AUDIT_SAMPLED`, re-run the T1
      ladder from a clean checkout of the merged tree, and record `AUDIT_RESULT` with a
      gate-report evidenceRef.
- 8.3 IF the audit result does not reproduce the recorded GateReport THEN THE SYSTEM SHALL
      fire a single `escalate(audit_mismatch)` from MERGE_QUEUED whose handling performs
      the git revert of the merge commit as a side effect — final task state ESCALATED;
      no separate roll_back transition on this path.
- 8.4 WHEN a merged task is not sampled THE SYSTEM SHALL record `sampled=false` and proceed
      audited → completed.
- 8.5 THE SYSTEM SHALL keep COMPLETED producible only from core-produced evidence — the
      audit path adds evidence, never substitutes an agent claim (INV-2).
- 8.6 THE SYSTEM SHALL define "reproduce" as: ordered gate verdicts equal AND evidence
      content hashes equal — explicitly excluding timing and host metadata (consistent
      with REQ-6.6), so run-varying fields never fail an audit.

## REQ-9: Meta-governance (design: "core/src/governance/policy.ts", "Technology Decisions" governance rows)

**User Story:** As the operator, I want every policy change to pass me before a run uses it,
so that gate loosening can never happen silently (INV-16).

**Acceptance Criteria (EARS):**
- 9.1 WHEN a run starts THE SYSTEM SHALL hash its policy inputs (gate ladder, security
      plane, automation, provider data policy) and compare them against the last
      `GOVERNANCE_CHANGE` in the DURABLE governance log — an append-only JSONL at
      `.ai/governance/events.jsonl`, committed to the repo (survives checkouts; git
      history doubles as the audit trail) — never a per-run event log.
- 9.2 IF the hashes mismatch, or the governance log is empty (first run: compared as
      `beforeHash: null`), THEN THE SYSTEM SHALL refuse to start (`policy_unapproved`),
      record `GOVERNANCE_PROPOSED` in the governance log, and print the pending proposal
      id plus the exact `platform governance approve <id>` command.
- 9.3 THE SYSTEM SHALL provide `platform governance list|approve <id>` CLI subcommands that
      read pending proposals from the governance log and append `GOVERNANCE_CHANGE
      {kind, beforeHash, afterHash, rationale}` directly — usable with no server running.
- 9.4 WHERE a Human Plane server is running THE SYSTEM SHALL list governance proposals at
      `GET /approvals` and handle their approval WITHOUT calling `onDecision` for kind
      `policy_change` (append-only); kind `flaky_quarantine` (carries a taskId) SHALL
      additionally fire the `quarantine` transition for that task upon approval — still
      human-approved, never policy-driven.
- 9.5 WHEN a gate reports `flakySuspect` THE SYSTEM SHALL create a governance proposal of
      kind `flaky_quarantine` whose approval fires the `quarantine` transition —
      quarantine never happens automatically; IF approved via the CLI while no run is
      live THEN the quarantine SHALL take effect when the next run loads that task
      (deferred, recorded).
- 9.6 THE SYSTEM SHALL gate ALL policy-file hash changes through governance (a conservative
      superset of loosening — tightening pays one extra approval).
- 9.7 WHERE a CI or test fixture needs an approved snapshot THE SYSTEM SHALL accept a
      seeded `GOVERNANCE_CHANGE` labeled `decidedBy: 'ci-fixture'` — explicit scaffolding,
      never claimed as a human decision.

## REQ-10: Steering (design: "core/src/orchestrator/loop.ts (extended)", "Steering" sequence, "Steering + control port" data model)

**User Story:** As the operator, I want to pause a running loop, inject guidance, and resume,
so that I can steer without killing work in flight (§10.3).

**Acceptance Criteria (EARS):**
- 10.1 WHEN `POST /steering/pause` is received THE SYSTEM SHALL signal the loop's control
       port and respond 202; the loop SHALL pause only at an iteration boundary, after the
       current atomic action completes.
- 10.2 WHEN the loop pauses THE SYSTEM SHALL transition the task to PAUSED and record
       `PAUSE_REQUESTED {prePauseState}` — the pre-pause state lives in the event so resume
       is replayable from the log.
- 10.3 WHEN `POST /steering/resume` is received THE SYSTEM SHALL restore the recorded
       pre-pause state via `resumeTransition(prePauseState)` — legal only from PAUSED and
       only to an active state — and record `RESUMED {resumedTo}`.
- 10.4 WHILE the task is not PAUSED THE SYSTEM SHALL reject `POST /steering/inject` with
       409 — guidance is atomic with the pause window.
- 10.5 WHEN guidance is injected THE SYSTEM SHALL store it in the evidence store, record
       `GUIDANCE_INJECTED {evidenceRef}`, and fold it into the next round as marked
       untrusted data.
- 10.6 IF injected guidance would change acceptance criteria or scope THEN THE SYSTEM SHALL
       require a goal.yaml amendment — the frozen-contract hash check escalates
       `contract_changed`; guidance alone never alters the contract.
- 10.7 IF kill is signaled while PAUSED THEN THE SYSTEM SHALL terminate cleanly (the
       resume wait resolves to kill).
- 10.8 IF a steering request (pause or inject) arrives while the task is in MERGE_QUEUED
       or any later state THEN THE SYSTEM SHALL reject it with 409 and a structured
       reason — the merge/audit path is short, deterministic, core-only work with no
       iteration boundary; a silently-unreachable pause is never accepted.
- 10.9 WHILE a task waits for a human approval decision THE SYSTEM SHALL treat the wait
       as an iteration boundary racing the control port — pause is honored during the
       wait; IF a task-approval decision arrives while the task is PAUSED THEN THE
       SYSTEM SHALL reject it with 409 (resume first, then decide).

## REQ-11: Security plane completions (design: "core/src/security/ completions", "aal/src/source.ts (extended)" canary + data-govern)

**User Story:** As the operator, I want the Phase-2 security mechanisms live — canary
tripwire, dependency policy, provider data policy — so that the §10.1 threat ladder holds at
its stated tiers.

**Acceptance Criteria (EARS):**
- 11.1 WHEN a response (structuredResult or any action content) contains the round's
       canaryToken THE SYSTEM SHALL record `CANARY_TRIPPED` and reject the proposal as
       structured feedback — the round is consumed, the loop continues, nothing crashes.
- 11.2 WHERE the security-plane policy authorizes package installation THE SYSTEM SHALL
       accept `RUN_COMMAND` with `network: 'allowlist:package_install'` only when the
       command matches the frozen-lockfile + `--ignore-scripts` pattern AND a lockfile —
       matched against the SAME governance-pinned pattern list in
       `.ai/policies/security-plane.json` that REQ-7.6 uses — exists in the worktree.
- 11.3 THE SYSTEM SHALL keep `network: 'none'` hard-deny for every other `RUN_COMMAND`
       (egress default-deny unchanged, INV-14).
- 11.4 THE SYSTEM SHALL document in code that the registry pin is enforced by lockfile
       resolution (the SBPL grant is transport only) and that the residual is a malicious
       committed lockfile — labeled mitigated, not solved (§16).
- 11.5 WHEN building a send THE SYSTEM SHALL check every `ContextPiece.path` against the
       provider data policy of the routed adapter BEFORE sending; IF any path violates it
       THEN THE SYSTEM SHALL escalate `data_policy_violation` and send nothing.
- 11.6 THE SYSTEM SHALL leave ordinary `RUN_COMMAND`s unaffected by the dependency policy
       (benign baseline — no false-positive blocks).
- 11.7 WHERE the platform is not darwin THE SYSTEM SHALL refuse `package_install` (and
       `RUN_COMMAND` generally, per the Phase-0 posture) fail-closed with a structured
       `sandbox_unavailable` reason — the network grant never executes unconfined.
- 11.8 THE SYSTEM SHALL permit pathless context pieces only for the platform-generated
       kinds enumerated in the provider data policy file (feedback, contract, guidance,
       patchPlan); IF any other pathless piece reaches the send check THEN THE SYSTEM
       SHALL escalate `data_policy_violation`.

## REQ-12: F-MCP (design: "Console additions" F-MCP)

**User Story:** As the operator, I want to manage MCP servers from the Console, so that I
can add/enable/disable servers without hand-editing JSON.

**Acceptance Criteria (EARS):**
- 12.1 THE SYSTEM SHALL serve `GET /api/mcp/{scope}` returning the current MCP config with
       its content hash, and `PUT /api/mcp/project` writing the project `.mcp.json`
       through `writeSafe` (validate → baseHash optimistic concurrency → atomic rename);
       the user scope is READ-ONLY in Phase 2 (its backing file `~/.claude.json` is
       multi-purpose state the CLI rewrites concurrently) — the UI points at
       `claude mcp` for user-scope edits.
- 12.2 THE SYSTEM SHALL support adding stdio and HTTP server entries and toggling
       enable/disable per entry, in the project scope.
- 12.3 WHEN `POST /api/mcp/test` is called THE SYSTEM SHALL attempt a timeout-bounded
       connection (stdio spawn or HTTP ping) and return an advisory result — never a
       verdict that blocks saving.
- 12.4 IF a PUT carries a stale baseHash THEN THE SYSTEM SHALL respond 409 with the current
       hash; IF the payload fails schema validation THEN 422.

## REQ-13: F-Hook with consent gate (design: "Console additions" F-Hook, "Consent-gated hook install" sequence)

**User Story:** As the operator, I want hook edits to require my explicit two-step consent,
so that nothing programmable installs a hook behind my back (INV-16, §13.3).

**Acceptance Criteria (EARS):**
- 13.1 THE SYSTEM SHALL validate hook entries (every hook event, all five handler types)
       via `POST /api/hooks/validate`, returning the validity verdict, an exact JSON diff
       preview, and a `confirmToken` = sha256 of the target file's baseHash concatenated
       with the proposed content — a moved base invalidates the token.
- 13.2 WHEN `POST /api/hooks/install` (or uninstall) carries BOTH a matching confirmToken
       AND the current baseHash THE SYSTEM SHALL write through `writeSafe` and append an
       audit entry; a stale baseHash SHALL yield 409 (the previewed diff must be the
       applied diff).
- 13.3 IF the confirmToken is missing or stale THEN THE SYSTEM SHALL respond 428 and write
       nothing.
- 13.4 THE SYSTEM SHALL never register a PUT route for the managed scope — managed stays
       read-only by construction (applies to every new F-* route group).

## REQ-14: F-Sub + F-Skill (design: "Console additions" F-Sub, F-Skill)

**User Story:** As the operator, I want subagents and skills manageable from the Console, so
that the full governance surface lives in one place.

**Acceptance Criteria (EARS):**
- 14.1 THE SYSTEM SHALL provide CRUD for `.claude/agents/*.md` with frontmatter validated
       (name, description, tools) and the markdown body preserved verbatim.
- 14.2 THE SYSTEM SHALL list and edit `.claude/skills/*/SKILL.md` and toggle
       `enabledPlugins` entries in settings scopes, all through `writeSafe`.
- 14.3 IF a subagent file's frontmatter fails validation THEN THE SYSTEM SHALL respond 422
       and write nothing.

## REQ-15: F-Sys (design: "Console additions" F-Sys)

**User Story:** As the operator, I want doctor/host/retention visibility with safe pruning,
so that system health and data retention are operable from the Console.

**Acceptance Criteria (EARS):**
- 15.1 WHEN `GET /api/system/doctor` is called THE SYSTEM SHALL return captured
       non-interactive `claude doctor` output; IF the binary is missing THEN THE SYSTEM
       SHALL return the degraded card (Phase-0 pattern), never a 500.
- 15.2 THE SYSTEM SHALL serve host stats from `node:os` at `GET /api/system/stats`.
- 15.3 THE SYSTEM SHALL edit `cleanupPeriodDays` through the retention endpoint and require
       the two-step confirm-token flow for transcript pruning, with a preview of what a
       prune would delete.
- 15.4 IF a prune is requested while a PTY session is live THEN THE SYSTEM SHALL respond
       409 — transcripts are never yanked under an attached session.

## REQ-16: Automation guards (design: "console/backend/src/guards.ts", "Composition root")

**User Story:** As the operator, I want every autonomous entry point to yield to my
interactive quota, so that automation never starves the window I work in (INV-13, §10.2).

**Acceptance Criteria (EARS):**
- 16.1 WHEN `platform loop run` or `platform conformance --live` starts a live run
       THE SYSTEM SHALL evaluate the usage estimate against the configured thresholds
       BEFORE constructing any adapter.
- 16.2 IF the estimate struct `{fiveHourPct, weeklyPct}`'s maximum meets or exceeds the
       threshold (default 85%) THEN, UNLESS `--force-quota-override` is passed, THE
       SYSTEM SHALL refuse to start, record `AUTOMATION_DEFERRED {until, window,
       percent}` where `until` is the reset time of the window that tripped, and print a
       defer-until-reset hint.
- 16.3 THE SYSTEM SHALL default autonomous runs to the model named in
       `.ai/policies/automation.json` (Sonnet), keeping Opus for interactive use; a
       per-run override flag SHALL exist and be logged.
- 16.4 WHERE `--force-quota-override` is passed THE SYSTEM SHALL record an
       `AUTOMATION_OVERRIDE` event and start the run, still enforcing the hard budget
       caps from the goal contract — the flag bypasses REQ-16.2's refusal and nothing
       else.
- 16.5 THE SYSTEM SHALL keep the guard module scheduler-agnostic (pure decision function)
       so F-Sched reuses it unchanged in Phase 3.
- 16.6 IF the usage estimate is unavailable (no transcripts, estimator failure — a null
       estimate) THEN THE SYSTEM SHALL defer fail-closed with reason
       `estimate_unavailable`, overridable only by `--force-quota-override`.

## REQ-17: F-Term repaint + transcript fallback (design: "F-Term repaint nudge", "adapters/src/anthropic.ts (extended)"; carried backlog #3 #4)

**User Story:** As the operator, I want a resumed terminal to paint on first attach and
adapter transcripts to survive nested-process path drift, so that the two remaining Phase-1
observability holes close at their root.

**Acceptance Criteria (EARS):**
- 17.1 THE SYSTEM SHALL add `resize(cols, rows)` to `PtyLike` and
       `resize(ptyId, cols, rows)` to `TermManager` (with current dims tracked per
       session) — the WS bridge holds only a ptyId and never touches `PtyLike` directly.
- 17.2 WHEN a WS attach completes its ring-buffer replay THE SYSTEM SHALL send a
       double-resize nudge (rows−1 → rows) forcing SIGWINCH so full-screen TUIs repaint.
- 17.3 THE SYSTEM SHALL keep the nudge signal-only (no injected bytes) — the ring buffer
       remains a byte-prefix of the PTY stream.
- 17.4 WHEN the predicted transcript path misses after polling THE SYSTEM SHALL glob
       `~/.claude/projects/*/<sessionId>.jsonl` once before giving up.
- 17.5 IF both the predicted path and the glob miss THEN THE SYSTEM SHALL return
       `rawTranscriptRef: null` with a structured reason — never a crash.

## REQ-18: Loop composition + observability (design: "Composition root", "Console additions" audit; DoD)

**User Story:** As the operator, I want the loop operable end-to-end — approvals, steering,
kill, audit — so that Phase 2's DoD (L0–L1 auto with sampling audit, breaker sidestepping,
valid Console-created files) is provable.

**Acceptance Criteria (EARS):**
- 18.1 WHEN a supervised loop run starts THE SYSTEM SHALL start the Human Plane server,
       write `human-plane.json` (0600), and wire task-approval decisions to machine
       transitions, governance approvals to event append only, and steering/kill to the
       loop control port.
- 18.2 THE SYSTEM SHALL run the governance preflight, then the automation guard, before
       any adapter is constructed.
- 18.3 THE SYSTEM SHALL extend the audit JSONL to cover hook install/uninstall, retention
       prune, governance decisions, and every approval, steering (pause/inject/resume),
       and kill call (§13.3).
- 18.4 THE SYSTEM SHALL prove one L1 task end-to-end to COMPLETED (auto-merge + sampled
       audit) on the fixture repo with FakeAdapter in CI, on a macOS runner (the
       RUN_COMMAND sandbox is darwin-only, D-003 posture) — the fixture ships
       `automation.json` with `auditSampleRate: 100` plus a seeded governance snapshot
       (REQ-9.7) so the sampled path runs deterministically; production keeps REQ-8.1's
       rate — CI-scripted numbers are never reported as §12 calibration metrics.
- 18.5 WHILE running in CI or without a TTY THE SYSTEM SHALL keep refusing live runs
       (Phase-1 structural guards unchanged); live runs stay manual with a budget cap and
       recorded evidence.

## Edge Cases & Open Questions

- **MCP OAuth flows** — deferred to Phase 3 (needs a browser round-trip design); F-MCP
  ships add/edit/enable/disable/test only. Recorded in design "Console additions".
- **F-Sys "update"** — §8 names an update action for F-Sys; Phase 2 ships doctor/stats/
  retention only. Triggering `claude update` from a web surface is a security decision —
  parked as an open question for the human at tasks review (default: out).
- **`switch_to_next_eligible` with one lineage** — Phase 2 registers one real adapter
  (B4); the switch path is proven with a second FakeAdapter in tests and ends at
  `no_capacity` in live single-lineage runs.
- **Breaker window/threshold defaults** — design fixes the mechanism, not the numbers;
  defaults land in `.ai/policies/automation.json` at implementation and are
  governance-pinned like every policy (REQ-9.6).
- **Steering inject is PAUSED-only** by design (409 otherwise) — an operator wanting
  "inject at next boundary without pausing" is out of scope for Phase 2.
- **Sampling audit scope** — audits re-run T1 only (T2/T3 stay stubbed per conflict
  resolution #4); a T1-invisible regression escaping audit is a known residual until the
  Phase-3 out-of-band auditor.

### /spec-analyze findings log — 2026-07-07, anchor `544d014` (HEAD; requirements.md was uncommitted/pre-first-commit at audit time)

Full audit (3 fresh-context lenses + main-thread pass), 20 findings, ALL decided by the
user 2026-07-07 as the recommended option and applied in-file:

- AZ-1 governance durable log + first-run undefined (REQ-9.1-9.3, 18.4) — APPLIED: durable
  `.ai/governance/events.jsonl` committed; empty log = `beforeHash: null` mismatch; CI seed
  `decidedBy: 'ci-fixture'` (9.1, 9.2, 9.7)
- AZ-2 wallclock counts PAUSED/approval-wait (REQ-6.5 vs 10, 18.1) — APPLIED: active-time
  only, intervals from event log (6.5)
- AZ-3 REQ-9.5 quarantine vs 9.4 no-transitions contradiction — APPLIED: kind split;
  `flaky_quarantine` fires quarantine, `policy_change` append-only; CLI approve with no
  live run = deferred to next run load (9.4, 9.5)
- AZ-4 re-route can re-select just-failed adapter (REQ-3.2-3.3) — APPLIED: exclude failed
  keys this round; BLOCKED also after failed re-route (3.2, 3.3)
- AZ-5 REQ-8.3 revert+escalate = two transitions from one state — APPLIED: single
  `escalate(audit_mismatch)` with git revert as side effect (8.3)
- AZ-6 REQ-16.2 refuse vs 16.4 override contradiction — APPLIED: UNLESS clause + explicit
  `AUTOMATION_OVERRIDE` event (16.2, 16.4)
- AZ-7 pause on merge/audit path = silent noop (REQ-10.1 vs 7.8) — APPLIED: 409 +
  structured reason from MERGE_QUEUED onward (10.8)
- AZ-8 approval wait vs pause race; decision while PAUSED (REQ-10, 18.1) — APPLIED: wait =
  boundary racing control port; decision while PAUSED = 409 (10.9)
- AZ-9 audit "reproduce" comparison basis undefined (REQ-8.3) — APPLIED: ordered verdicts +
  evidence hashes, excluding timing/host metadata (8.6)
- AZ-10 null usage estimate behavior undefined (REQ-16.2) — APPLIED: fail-closed
  `estimate_unavailable`, override-only (16.6)
- AZ-11 probes uncapped / no timeout / error semantics (REQ-5) — APPLIED: policy cap
  (default 5) + timeout + errored probe = `undecided`, never refuted + budget checks
  between probes (5.7-5.9)
- AZ-12 confirmToken unbound from base file state (REQ-13.2) — APPLIED: token =
  sha256(baseHash + content) AND baseHash required, 409 on stale (13.1, 13.2)
- AZ-13 dep-policy on non-darwin + CI platform unstated (REQ-11.2, 18.4) — APPLIED:
  fail-closed `sandbox_unavailable`; CI on macOS runner (11.7, 18.4)
- AZ-14 health probe unbounded await = silent hang (REQ-2.2) — APPLIED: policy-pinned
  timeout → `probe_failed` (2.7)
- AZ-15 sampled audit flaky-by-construction in CI (REQ-8.1 vs 18.4) — APPLIED: fixture
  `auditSampleRate: 100` + seeded snapshot; production keeps 8.1 (18.4)
- AZ-16 "mapped AC" undefined + vacuous auto-merge (REQ-7.2, 7.7) — APPLIED: mapping =
  contract ACs (single-task = all); zero ACs → approval package (7.2, 7.9)
- AZ-17 manifest/lockfile pattern set unnamed (REQ-7.6, 11.2) — APPLIED: one
  governance-pinned list in `.ai/policies/security-plane.json`, shared by both (7.6, 11.2)
- AZ-18 F-MCP user-scope file = `~/.claude.json` CLI-contended (REQ-12.1) — APPLIED:
  Phase 2 writes project `.mcp.json` only; user scope read-only view (12.1, 12.2)
- AZ-19 threshold vs multi-window quota semantics (REQ-16.2, 2.1) — APPLIED: estimate
  struct `{fiveHourPct, weeklyPct}`, trip on max, `until` = tripping window's reset;
  probe/event shapes widened (2.1, 2.3, 16.2)
- AZ-20 pathless ContextPiece bypasses data policy + remaining budget ≤ 0 (REQ-11.5, 6.3)
  — APPLIED: pathless allowed only for enumerated platform kinds (11.8); remaining ≤ 0 →
  `budget_exhausted` before any send (6.7)

No findings dismissed. Re-runs: focus on REQs changed after anchor `544d014`.
