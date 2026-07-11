# Requirements — platform-phase4

> Status: approved 2026-07-08, amended 2026-07-08 (EARS lint rewording of 25.2-25.8 for spec-trace — no semantic change)
> Derived from design.md (design-first mode — the design is upstream; REQ IDs below are backfilled into its traceability table).
> Upstream spec: `unified-platform-spec.md` v1.3 §14 Phase 4 (scope + DoD) + `clarifications.md` (binding decisions 2026-07-08).

## Overview

Phase 4 — Continuous + Polish. Wires the human-approval pipeline end-to-end
(carried Phase-3 gap #1), adds goal-level continuous stages (issue intake,
canary deploy + automated rollback as command-level simulation), activates the
Learning Plane (lessons + outcome routing) behind human governance (INV-16),
closes the fusion gaps (planner trigger — carried #2; uplift interval — carried
#3), and finishes the Console (F-Chat full, themes, responsive, i18n TH/EN).
All CI evidence uses fakes (zero quota); REQ-25 is the single LIVE/manual task.

---

## REQ-1: Shared approved-merge engine (design: "A. Approval pipeline production wiring")

**User Story:** As the platform core, I want one merge/audit engine serving both
approval bases, so that a human approval continues through the exact same
merge-queue/audit path an auto-approval does.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL expose `runApprovedMerge` executing the merge
  continuation (merge_queued → merge or T2 queue → sampled audit → audited →
  completed) from state APPROVED, extracted from the existing
  post-`auto_approved` body of `runAutoMerge`.
- 1.2 WHEN `runAutoMerge` decides `auto_approve`, THE SYSTEM SHALL fire
  `auto_approved` + append `AUTO_APPROVED`, then delegate to `runApprovedMerge`,
  producing the same events and outcomes as before the extraction.
- 1.3 WHEN `runApprovedMerge` runs after a HUMAN approval, THE SYSTEM SHALL NOT
  append any `AUTO_APPROVED` event.
- 1.4 THE SYSTEM SHALL preserve the existing merge-conflict, rejected_t2, and
  audit_mismatch escalation paths unchanged in behavior through the extraction.

## REQ-2: Approval package production wiring (design: "A. Approval pipeline production wiring")

**User Story:** As an operator, I want a real approval package to appear when
auto-merge declines, so that F-Loop shows something a human can actually decide.

**Acceptance Criteria (EARS):**
- 2.1 WHEN `runAutoMerge` returns `decision === 'approval_package'` in
  `runSupervisedLoop`, THE SYSTEM SHALL build an approval package via
  `buildApprovalPackage` with core-computed inputs: diffRef =
  evidence-stored `git diff main...task`, diffLineCount from that diff,
  worktreeHash, goal excerpt, AC ids, and riskClass = the decision's
  `effectiveRisk`.
- 2.2 WHEN the package is built, THE SYSTEM SHALL insert it into the SAME
  `approvals` Map instance served by the Human Plane server and append
  `APPROVAL_PACKAGE_CREATED`.
- 2.3 IF `buildApprovalPackage` returns `kind: 'escalate'` (diff over budget),
  THEN THE SYSTEM SHALL escalate `split_required` and create no package.
- 2.4 THE SYSTEM SHALL take maxDiffBudget from composition options with default
  400 (§11.2).
- 2.5 WHILE a package is pending, GET /approvals on the Human Plane SHALL list
  it (existing route, now non-empty in production).

## REQ-3: Decision wait + post-decision continuation (design: "A. Approval pipeline production wiring")

**User Story:** As an operator, I want my approve/reject to actually move the
task, so that approving from F-Loop completes the pipeline without a restart.

**Acceptance Criteria (EARS):**
- 3.1 WHILE a package is pending, THE SYSTEM SHALL keep the Human Plane server
  open and await the decision via a deferred resolved by the wrapped
  `onDecision` (or kill).
- 3.2 WHEN the decision is `approve` (attestations complete), THE SYSTEM SHALL
  transition REVIEWING → APPROVED (`human_approved`) and run `runApprovedMerge`,
  ending COMPLETED when merge + audit succeed.
- 3.3 WHEN the decision is `reject`, THE SYSTEM SHALL transition to
  CHANGES_REQUESTED and end the run in that state (terminal for this run —
  recorded limitation, no silent retry).
- 3.4 IF no decision arrives within `approval.timeoutMs` (default 30 minutes,
  overridable in composition options), THEN THE SYSTEM SHALL escalate
  `approval_timeout`, remove the package from the Map, and end ESCALATED.
- 3.5 THE SYSTEM SHALL append the timeout escalation to the event log BEFORE
  `log.close()` and await the decision only within the scope where the server
  is open; WHEN a deploy stage is configured, that scope SHALL extend through
  the deploy stage and its post-EXPANDED window (REQ-6.11/6.12).
- 3.6 WHEN kill is requested while a package is pending, THE SYSTEM SHALL end
  the wait and terminate via the existing kill path.

## REQ-4: Deploy contract section (design: "B. Deploy plane — contract + Loop 5 engine")

**User Story:** As a goal author, I want to declare deploy commands in
goal.yaml, so that the platform can run a canary stage against my target repo.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL parse an optional `deploy:` section in `freezeContract`
  with fields canary_cmd, observe_cmd, expand_cmd, rollback_cmd, and
  observe {probes, failure_threshold, interval_ms}.
- 4.2 IF `deploy:` is present with any missing/empty command, a non-numeric
  observe field, `probes < 1`, or `failure_threshold >= probes` (a threshold
  rollback could never exceed), THEN THE SYSTEM SHALL throw
  `ContractInvalidError` at freeze time (never mid-stage).
- 4.3 WHEN `deploy:` is absent, THE SYSTEM SHALL freeze the contract exactly as
  today (backward compatible).
- 4.4 THE SYSTEM SHALL include the deploy section bytes in the frozen contract
  hash (mid-run edits detectable as `contract_changed`).
- 4.5 THE SYSTEM SHALL NOT accept any network-enabling knob in the deploy
  section.

## REQ-5: Deploy stage engine (design: "B. Deploy plane — contract + Loop 5 engine")

**User Story:** As the platform, I want a deterministic canary→observe→
expand|rollback engine, so that a bad deploy rolls itself back with evidence.

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL implement `runDeployStage` in `core/src/deploy/stage.ts`
  as a goal-level stage with states PENDING_APPROVAL, CANARY, OBSERVING,
  EXPANDED, ROLLING_BACK, ROLLED_BACK, ESCALATED, recorded as `DEPLOY_STATE`
  events; the task state machine table SHALL remain untouched.
- 5.2 THE SYSTEM SHALL run every deploy command through the core executor as
  `RUN_COMMAND` with `network: 'none'` and evidence-captured output (INV-1/
  INV-14).
- 5.3 WHEN the canary command exits 0, THE SYSTEM SHALL run `observe_cmd`
  `probes` times spaced `interval_ms` apart using the injected clock, counting
  exit 0 as a healthy probe.
- 5.4 IF observed failures exceed `failure_threshold`, THEN THE SYSTEM SHALL
  run `rollback_cmd`; exit 0 SHALL yield DEPLOY_STATE ROLLED_BACK with a
  root-cause payload containing failed-probe count and evidence refs.
- 5.5 IF `rollback_cmd` exits non-zero, THEN THE SYSTEM SHALL end DEPLOY_STATE
  ESCALATED with reason `rollback_failed` and SHALL NOT retry.
- 5.6 IF failures are within threshold, THEN THE SYSTEM SHALL run `expand_cmd`;
  exit 0 SHALL end DEPLOY_STATE EXPANDED; IF `expand_cmd` exits non-zero, THEN
  THE SYSTEM SHALL take the rollback path per 5.4/5.5 with root cause
  `expand_failed` (Loop 5 "Expand|Rollback").
- 5.7 IF the canary command exits non-zero, THEN THE SYSTEM SHALL proceed to
  rollback per 5.4/5.5 without running observe probes.
- 5.8 THE SYSTEM SHALL label deploy output and events as command-level
  simulation on the target repo, never a production rollout (§16).

## REQ-6: Deploy approval + Human Plane deploy surface (design: "B. Deploy plane", "Human Plane extension")

**User Story:** As an operator, I want production deploys gated on my explicit
approval with rollback attestations, so that no deploy starts unattended.

**Acceptance Criteria (EARS):**
- 6.1 WHEN a task ends COMPLETED and the frozen contract has `deploy:`, THE
  SYSTEM SHALL build a deploy approval package (id `deploy-<taskId>`,
  riskClass L4 attestations, diffRef = merge commit, assumptions noting
  `network: none (simulation)`) — ALWAYS, regardless of the contract's
  `approvalPolicy` content (hard human floor; `production_deployment` in
  §11.1 makes it explicit, its absence never disables the gate).
- 6.2 THE SYSTEM SHALL NEVER insert the deploy package into the task
  `approvals` Map and SHALL NEVER route its decision through `onDecision`.
- 6.3 THE SYSTEM SHALL serve GET /deploy: 501 when deploy callbacks are not
  composed (Phase-1 pattern); `{state: null, approval: null}` when composed
  but no deploy is configured/pending; `{state, approval}` otherwise.
- 6.4 WHEN POST /deploy/decision receives `approve` with ALL attestations
  present, THE SYSTEM SHALL invoke `onDeployDecision('approve')` and start
  `runDeployStage`.
- 6.5 IF POST /deploy/decision arrives with incomplete attestations, THEN THE
  SYSTEM SHALL return 400 without starting the stage.
- 6.6 IF POST /deploy/decision arrives with no pending deploy package, THEN THE
  SYSTEM SHALL return 404.
- 6.7 WHEN the decision is `reject`, THE SYSTEM SHALL record
  `DEPLOY_DECISION {decision:'reject'}`, skip the stage, and leave the task
  COMPLETED.
- 6.8 WHEN POST /deploy/rollback arrives WHILE DEPLOY_STATE is EXPANDED, THE
  SYSTEM SHALL run `rollback_cmd` via the executor with the same evidence and
  state semantics as automated rollback.
- 6.9 IF POST /deploy/rollback arrives in any state other than EXPANDED, THEN
  THE SYSTEM SHALL return 409.
- 6.10 THE SYSTEM SHALL audit every deploy decision and manual rollback via the
  existing audit sink.
- 6.11 IF no deploy decision arrives within `approval.timeoutMs` (same knob as
  REQ-3.4), THEN THE SYSTEM SHALL record `DEPLOY_DECISION
  {decision:'timeout'}`, skip the stage, and leave the task COMPLETED.
- 6.12 WHEN DEPLOY_STATE reaches EXPANDED, THE SYSTEM SHALL keep the Human
  Plane server open for a manual-rollback window of `deploy.expandedWindowMs`
  (composition option, default 10 minutes), then append `DEPLOY_WINDOW_CLOSED`
  and close; WHILE any deploy stage is running, the server SHALL remain open.

## REQ-7: F-Loop deploy card (design: "B. Deploy plane", "Console")

**User Story:** As an operator, I want deploy status and a rollback control in
F-Loop, so that I can watch and reverse a deploy from the Console.

**Acceptance Criteria (EARS):**
- 7.1 THE SYSTEM SHALL show a deploy card in F-Loop rendering the latest
  DEPLOY_STATE, probe results summary, and the pending deploy approval (with
  attestation checklist) when present.
- 7.2 WHEN DEPLOY_STATE is EXPANDED, THE SYSTEM SHALL show a manual-rollback
  control calling POST /deploy/rollback.
- 7.3 THE SYSTEM SHALL label the card as command-level simulation (§16 claim
  discipline).
- 7.4 WHILE no deploy is configured or composed, THE SYSTEM SHALL hide the card
  without errors.

## REQ-8: Issue store + API (design: "C. Issue intake")

**User Story:** As an operator, I want to file issues locally through the
Console, so that incoming work is captured without exposing a remote ingress.

**Acceptance Criteria (EARS):**
- 8.1 THE SYSTEM SHALL persist issues as `.ai/issues/<id>.json` with fields
  {id, title, body, createdAt, status ∈ open|converted|rejected,
  goalDraftPath?} and deterministic id `iss-<sha256 slice>`.
- 8.2 WHEN POST /api/issues receives {title ≤ 200 chars, body ≤ 20000 chars},
  THE SYSTEM SHALL create the issue with status `open`.
- 8.3 IF title or body exceeds its cap, THEN THE SYSTEM SHALL return 413 and
  write nothing.
- 8.4 THE SYSTEM SHALL serve GET /api/issues listing issues; the web UI SHALL
  render issue body strictly as plain text (no HTML/markdown interpretation)
  with an "issue text is untrusted data" banner (INV-3).
- 8.5 THE SYSTEM SHALL expose the issues endpoints only behind the existing
  console auth, rate-limit, and audit middleware.
- 8.6 WHEN POST /api/issues/{id}/reject is called on an `open` issue, THE
  SYSTEM SHALL set status `rejected` and audit the action; IF the issue is not
  `open`, THEN THE SYSTEM SHALL return 409.

## REQ-9: Issue → draft goal conversion (design: "C. Issue intake")

**User Story:** As an operator, I want to convert an issue into a draft goal
contract, so that intake feeds the loop only through my explicit actions.

**Acceptance Criteria (EARS):**
- 9.1 WHEN POST /api/issues/{id}/convert is called on an `open` issue, THE
  SYSTEM SHALL write `.ai/issues/<id>.goal.yaml` containing goal id/title from
  the issue, objective from the body excerpt, `acceptance_criteria: []`, a
  `# HUMAN: fill ACs, risk, budget before running` header, and §11.1 budget
  defaults, then set status `converted` and audit the action.
- 9.2 IF convert is called on a non-open issue, THEN THE SYSTEM SHALL return
  409 and change nothing.
- 9.3 THE SYSTEM SHALL NOT start, schedule, or enqueue any run as part of
  intake or conversion.
- 9.4 THE SYSTEM SHALL rely on `freezeContract` refusing empty
  `acceptance_criteria` so an unedited draft is structurally unrunnable; a
  test SHALL prove the unedited draft is refused.

## REQ-10: Lesson proposal from confirmed hypotheses (design: "D. Lessons pipeline")

**User Story:** As the platform, I want confirmed repair hypotheses to become
pending lessons, so that hard-won diagnostic knowledge is captured with
evidence.

**Acceptance Criteria (EARS):**
- 10.1 WHEN a run ends, THE SYSTEM SHALL fold the event log for confirmed
  hypothesis verdicts (post-run, in the composition — the core engine is
  untouched) and, per confirmed hypothesis, write
  `.ai/lessons/pending/<id>.json` with {id, statement, sourceRunId,
  sourceTaskId, evidenceRefs, proposedAt} and append `LESSON_PROPOSED`.
- 10.2 THE SYSTEM SHALL derive the lesson id as `lsn-<sha256 slice>` of
  statement + evidence refs; re-proposing the same lesson SHALL be idempotent
  (no duplicate files or proposals).
- 10.3 WHEN a lesson is proposed, THE SYSTEM SHALL append a governance proposal
  of kind `lesson_promote` carrying `lessonId`.
- 10.4 THE SYSTEM SHALL leave `.ai/shared/LESSONS.md` (human-curated process
  lessons) untouched by this pipeline — separate artifacts.

## REQ-11: Lesson promotion governance (design: "D. Lessons pipeline")

**User Story:** As an operator, I want lessons to require my approval before
they can ever be injected, so that the system cannot teach itself (INV-16).

**Acceptance Criteria (EARS):**
- 11.1 THE SYSTEM SHALL extend `GovernanceKind` with `lesson_promote` and the
  proposal/change records with `lessonId?`.
- 11.2 WHEN a `lesson_promote` proposal is approved via the existing Human
  Plane approval route, THE SYSTEM SHALL move the file pending/ → approved/
  and append `LESSON_APPROVED`.
- 11.3 WHEN a lesson is approved offline (CLI, no live run), THE SYSTEM SHALL
  reconcile at `loadApprovedLessons` time against the governance log
  (promoted-but-unmoved → move then load) — deferred-quarantine pattern.
- 11.4 THE SYSTEM SHALL list pending `lesson_promote` proposals on GET
  /approvals alongside existing governance proposals.

## REQ-12: Lesson injection through the context pipeline (design: "D. Lessons pipeline")

**User Story:** As the platform, I want approved lessons injected only through
the governed context pipeline, so that lessons stay marked, scanned, canaried
untrusted data (INV-3).

**Acceptance Criteria (EARS):**
- 12.1 THE SYSTEM SHALL load lessons exclusively from `.ai/lessons/approved/`;
  a pending or rejected lesson SHALL be structurally unloadable.
- 12.2 THE SYSTEM SHALL pass loaded lessons into `buildContext` so they flow
  SEED → GOVERN → MARK; THE SYSTEM SHALL NOT append lessons to a built context
  (the feedback-style post-build path).
- 12.3 IF a loaded lesson contains a secret per the GOVERN scan, THEN THE
  SYSTEM SHALL block it from the context and record the block — it SHALL never
  reach a prompt.
- 12.4 THE SYSTEM SHALL mark injected lessons as data with an injection canary
  (existing MARK mechanism).
- 12.5 THE SYSTEM SHALL cap injected lessons by count and bytes from
  composition options (defaults: maxLessons 5, maxBytes 8192) and record
  `LESSON_INJECTED {ids, refs}` per injection.
- 12.6 IF a lesson file is corrupt JSON, THEN THE SYSTEM SHALL skip it, append
  an ERROR event, and continue the run.

## REQ-13: shadowProven evaluator (design: "E. Outcome routing ACTIVE")

**User Story:** As an operator, I want a deterministic report of what shadow
routing has learned, so that my activation decision rests on evidence.

**Acceptance Criteria (EARS):**
- 13.1 THE SYSTEM SHALL provide pure `shadowProven(events, criteria)` in aal
  returning {proven, n, agreementRate, divergences, perAdapter}.
- 13.2 THE SYSTEM SHALL compute n/agreementRate/divergences via the existing
  `compareShadow` and perAdapter via `computeShadowOutcomeStats` relocated
  into `aal/src/shadow.ts` (exported; composition imports it — no duplicate
  fold).
- 13.3 THE SYSTEM SHALL evaluate `proven` as n ≥ minSamples AND divergences ≥
  minDivergences; both thresholds SHALL come from the `outcomeRouting` block
  in routing.json (REQ-14.1; minDivergences default 1).
- 13.4 THE SYSTEM SHALL NOT consult `shadowProven` anywhere in routing code —
  it is evidence for the human governance decision only (INV-16).

## REQ-14: Outcome-routing config governance (design: "E. Outcome routing ACTIVE")

**User Story:** As an operator, I want routing activation to be a governed
policy change, so that no code path can flip it silently.

**Acceptance Criteria (EARS):**
- 14.1 THE SYSTEM SHALL read `outcomeRouting {mode ∈ off|shadow|active,
  epsilon (integer percent), minSamples, minDivergences}` from
  `.ai/policies/routing.json`.
- 14.2 WHEN routing.json changes (including adding the block), THE SYSTEM SHALL
  require governance re-approval before the next run starts (existing
  POLICY_FILES snapshot mechanism — verified by test).
- 14.3 WHEN mode is `off`, THE SYSTEM SHALL use the plain router; `shadow` →
  the existing recorder only; `active` → recorder wrapped OUTSIDE the outcome
  wrapper so shadow observes the reordered live choice.

## REQ-15: Active reorder + epsilon + freeze (design: "E. Outcome routing ACTIVE")

**User Story:** As the platform, I want outcome-based routing that is
replayable and freezes on drift, so that routing never becomes untraceable.

**Acceptance Criteria (EARS):**
- 15.1 WHEN mode is `active`, THE SYSTEM SHALL reorder `eligibleAdapters()`
  output by reviewing-reached rate descending, keeping router order for ties
  and for adapters with zero attempts (never inventing preference).
- 15.2 THE SYSTEM SHALL apply epsilon exploration by deterministic hash percent
  of runId+taskId+round (auditSampleValue pattern); WHEN the hash percent is
  below epsilon AND an outcome-based reorder actually occurred this round
  (≥1 rated adapter) AND the eligible set has ≥2 entries, THE SYSTEM SHALL
  swap positions 0 and 1; precedence: frozen (15.5) > insufficient data (15.7)
  > reorder > epsilon — a frozen or insufficient-data round SHALL never swap.
- 15.3 THE SYSTEM SHALL use no RNG anywhere in the routing path; identical
  inputs SHALL yield identical order.
- 15.4 THE SYSTEM SHALL append `OUTCOME_ROUTE {order, explored, basis}` when
  the wrapper is active.
- 15.5 IF any registered adapter is stale (drift canary), THEN THE SYSTEM SHALL
  return the unwrapped router order and append `ROUTING_FROZEN` once per
  round.
- 15.6 THE SYSTEM SHALL apply reordering only within the already-filtered
  eligible set (hint/breaker/health filters still only remove — REQ-5
  semantics of Phase 3 preserved).
- 15.7 IF outcome stats are empty or all-zero, THEN active mode SHALL keep the
  router order with basis `insufficient_data`.

## REQ-16: Planner-role fusion auto-routing (design: "F. Planner-role fusion auto-routing")

**User Story:** As the platform, I want the planner role to dispatch through
fusion when policy says so, so that §7.5's "planning เสมอ" trigger finally has
implementing code.

**Acceptance Criteria (EARS):**
- 16.1 THE SYSTEM SHALL read `triggers.plannerRole` from
  `.ai/policies/fusion-profiles.json` (governance-hashed file).
- 16.2 WHEN `triggers.plannerRole` is true AND the composition enables
  planning, THE SYSTEM SHALL dispatch role `planner` through the SAME router
  instance the task loop uses (whatever mode governance pinned — off/shadow/
  active; empty stats behave per 15.7, no special case) into `runFusion` with
  the `plan` artifact profile BEFORE the task loop, with panel input pinned to
  the frozen goal {id, title, objective} + acceptance criteria.
- 16.3 WHEN either the policy flag or the composition option is off, THE
  SYSTEM SHALL NOT dispatch the planner (and a test SHALL prove both offs).
- 16.4 WHILE `fusionActive` is false (CI), THE SYSTEM SHALL never activate real
  fusion — the trigger contract is proven with fakes only.
- 16.5 THE SYSTEM SHALL add `plan.schema.json` to `.ai/schemas/` (per §11.3 —
  the file does not exist yet) and validate the resolved plan against it
  (structural validation only — no full planning gate exists in this
  composition), store it as evidence, append
  `PLAN_RESOLVED {winner, panelSize, costUnits}`, and pass the plan into task
  context as MARKed data.

## REQ-17: F-Chat sessions + transport (design: "G. F-Chat")

**User Story:** As an operator, I want a card-style chat surface on the
Console, so that I can use the SDK view when I prefer it over the raw TUI.

**Acceptance Criteria (EARS):**
- 17.1 THE SYSTEM SHALL create chat sessions via POST /api/chat/sessions
  {projectDir, resume?, fork?} returning {sessionId, wsTicket} with a
  single-use, TTL-bound WS ticket (same pattern as F-Term).
- 17.2 IF a WS connection presents a used, expired, or missing ticket, THEN THE
  SYSTEM SHALL close with 4403 (F-Term precedent, `term-runtime.ts:75`).
- 17.3 THE SYSTEM SHALL put all chat endpoints behind the existing console
  auth + rate limit and audit every session spawn (§13.3).
- 17.4 THE SYSTEM SHALL inject the SDK entry as `queryFn`; CI tests SHALL use a
  scripted fake with no SDK import and no network.
- 17.5 THE SYSTEM SHALL pin the `@anthropic-ai/claude-agent-sdk` dependency in
  console/backend to the same version adapters/ uses.

## REQ-18: F-Chat streaming + canUseTool bridge (design: "G. F-Chat", diagram 5)

**User Story:** As an operator, I want streamed replies with tool cards and
web approvals, so that I can supervise tool use per call.

**Acceptance Criteria (EARS):**
- 18.1 WHEN a user message arrives over the session WS, THE SYSTEM SHALL run
  `queryFn` and stream deltas and tool cards to the client as they arrive.
- 18.2 WHEN the SDK invokes `canUseTool`, THE SYSTEM SHALL emit an
  `approval_request` card and resolve allow/deny from the operator's response.
- 18.3 IF the operator does not respond within `approvalTimeoutMs` OR the WS
  drops, THEN THE SYSTEM SHALL resolve `deny` (fail-closed) and audit it.
- 18.4 IF the SDK stream errors, THEN THE SYSTEM SHALL send an error card,
  close the session, audit, and SHALL NOT auto-retry.
- 18.5 THE SYSTEM SHALL audit every canUseTool decision (allow/deny/timeout).

## REQ-19: F-Chat fork/resume + non-parity label + quota (design: "G. F-Chat")

**User Story:** As an operator, I want fork/resume plus an honest banner, so
that I never mistake the enhanced view for CLI parity.

**Acceptance Criteria (EARS):**
- 19.1 WHEN `resume` (and optionally `fork`) is passed at session create, THE
  SYSTEM SHALL continue (or fork) the SDK session; transcripts SHALL remain
  SDK-owned under `~/.claude` with no platform copy (INV-11).
- 19.2 THE SYSTEM SHALL render a permanent non-parity banner on the Chat page
  stating slash commands/plan mode are unavailable and pointing to Terminal
  for 100% parity (§8 F-Chat row).
- 19.3 THE SYSTEM SHALL show a quota estimate line on the Chat page labeled as
  an estimate (INV-13).

## REQ-20: Console themes (design: "H. Console themes + responsive + i18n")

**User Story:** As an operator, I want dark/light themes, so that the Console
is comfortable in both environments.

**Acceptance Criteria (EARS):**
- 20.1 THE SYSTEM SHALL define theme palettes as CSS custom properties on
  `:root` (light) and `[data-theme="dark"]`.
- 20.2 WHEN no preference is stored, THE SYSTEM SHALL follow
  `prefers-color-scheme`; WHEN the operator toggles, THE SYSTEM SHALL persist
  to localStorage and stamp `data-theme` on the document element, winning over
  the media default in both directions.
- 20.3 THE SYSTEM SHALL keep text/background contrast at WCAG AA in both
  themes.
- 20.4 THE SYSTEM SHALL migrate existing hardcoded color values to `var()`
  references (layout styles untouched).

## REQ-21: Console responsive/mobile (design: "H. Console themes + responsive + i18n")

**User Story:** As an operator, I want the Console usable on a phone, so that
remote approvals do not require a desktop.

**Acceptance Criteria (EARS):**
- 21.1 WHEN viewport width ≤ 768px, THE SYSTEM SHALL collapse navigation and
  stack cards single-column.
- 21.2 THE SYSTEM SHALL wrap wide tables in `overflow-x: auto` containers so
  the page body never scrolls horizontally.
- 21.3 THE SYSTEM SHALL keep interactive controls (approve/reject/rollback,
  theme + locale toggles) reachable and tappable at mobile sizes.

## REQ-22: Console i18n TH/EN (design: "H. Console themes + responsive + i18n")

**User Story:** As a Thai-speaking operator, I want the Console chrome in Thai,
so that daily operation reads naturally — without falsifying evidence strings.

**Acceptance Criteria (EARS):**
- 22.1 THE SYSTEM SHALL implement a dependency-free typed dictionary
  (`logic/i18n.ts`) with locales `en` and `th` where TH keys are checked
  complete against EN at typecheck time.
- 22.2 WHEN the operator toggles locale, THE SYSTEM SHALL persist the choice
  and re-render UI chrome in the selected locale.
- 22.3 THE SYSTEM SHALL render backend-authored strings (event payloads, CLI
  output, error details, the INV-13 quota label) verbatim, untranslated.
- 22.4 THE SYSTEM SHALL cover all Phase-4 and existing page chrome strings
  through `t()` (no hardcoded chrome strings left in components).

## REQ-23: §13.3 hardening sweep over new endpoints (design: "I. Security sweep + calibration wiring")

**User Story:** As the platform owner, I want the release checklist executable
over the new surface, so that Phase 4 ships behind the same floor as Phase 3.

**Acceptance Criteria (EARS):**
- 23.1 THE SYSTEM SHALL extend hardening tests so every new endpoint (issues,
  chat, deploy) requires auth, is rate-limited, and produces audit entries.
- 23.2 THE SYSTEM SHALL verify redaction applies to all new responses/logs and
  no endpoint exposes tokens or credential paths (INV-12/14).
- 23.3 THE SYSTEM SHALL keep fail-closed behavior on non-loopback binds for the
  whole new surface (INV-15).
- 23.4 THE SYSTEM SHALL verify WS tickets for chat are single-use with the
  close-code semantics F-Term actually implements (bad/expired/reused ticket →
  4403; §13.3's 4401/4403 read per those semantics).

## REQ-24: Calibration wiring (design: "I. Security sweep + calibration wiring")

**User Story:** As an operator, I want Phase-4 signals in the calibration
report, so that phase gates cite numbers, not feelings (INV-6, §12).

**Acceptance Criteria (EARS):**
- 24.1 THE SYSTEM SHALL fold LESSON_INJECTED events into the calibration
  output as (a) injection count and (b) a lesson hit-rate PROXY defined as:
  tasks that were injected with ≥1 lesson and reached REVIEWING ÷ all
  injected tasks — labeled as a proxy (same convention as the shadow
  reviewing-reached stat).
- 24.2 THE SYSTEM SHALL include a `shadowProven` report snapshot in the
  calibration output.
- 24.3 THE SYSTEM SHALL provide a fusion-uplift interval slot in the
  calibration output, filled by the live task and empty-but-labeled until then
  (never a fabricated number).

## REQ-25: LIVE pass (manual — never CI; Phase-3 task-13 analog) (design: "Testing Strategy — LIVE pass")

**User Story:** As the platform owner, I want one honest live pass over the
Phase-4 surface, so that the DoD's live items carry real evidence.

**Acceptance Criteria (EARS):**
- 25.1 THE SYSTEM SHALL be exercised live ONLY via manual trigger through a
  real TTY (iTerm pane technique); no CI job SHALL invoke any live path.
- 25.2 WHEN the live pass runs, THE SYSTEM SHALL produce a fusion uplift
  interval from ≥1 `code_diff`/`tests` activation plus a single-model baseline
  on the same calibration corpus task, recorded as an interval (small n, §12)
  in `docs/calibration/`.
- 25.3 WHEN the live pass runs, THE SYSTEM SHALL accept approval of a real
  approval package from a second physical device over the tailnet and continue
  the pipeline to COMPLETED (and demonstrate a reject path to
  CHANGES_REQUESTED).
- 25.4 WHEN the live pass runs, THE SYSTEM SHALL execute a live canary deploy
  on a fixture target including one forced observe-failure producing a real
  rollback with root-cause evidence.
- 25.5 WHEN the live pass runs, THE SYSTEM SHALL propose, approve, and inject
  a real lesson and show the injected lesson marked in the built context.
- 25.6 WHEN the live pass runs, THE SYSTEM SHALL evaluate `shadowProven` on the
  accumulated real log and record the activation decision honestly —
  insufficient n SHALL be recorded as a gap, never a fabricated activation.
- 25.7 WHEN the live pass runs, THE SYSTEM SHALL demonstrate F-Chat streaming
  plus one canUseTool approval live.
- 25.8 WHEN the live pass runs, THE SYSTEM SHALL record it run-by-run in
  `docs/calibration/RUNBOOK-phase4.md` (every attempt, every root cause —
  Phase-3 style).

---

## Edge Cases & Open Questions

- **Reject-then-what:** CHANGES_REQUESTED ends the run (3.3). Post-reject
  automated repair continuation is a recorded limitation — a future phase
  could feed reviewer feedback into a repair round; nothing here precludes it.
- **Cross-restart approval resume:** the package dies with the process; the
  timeout escalation (3.4) is the honest terminal. Recorded limitation
  (design Non-Functional).
- **Deploy egress:** deploy commands run `network: 'none'` (4.5, 5.2). A real
  deploy target needing network requires a new governed executor grant —
  Ring-0 work, explicitly out of Phase 4.
- **Sparse divergence data:** with 2 lineages, shadow divergences may stay
  below `minDivergences` for a long time; 25.6 records that outcome honestly.
  The DoD claims activation MECHANICS + criteria evaluation, not proven
  outcome improvement (§16).
- **Fusion uplift n:** ~2× task-13 spend yields n≈1-2 → interval only (25.2);
  "uplift proven" is deliberately not claimed anywhere.
- **GLM-5.2:** out of scope (still no access, v1.3) — Test Designer/Reviewer
  ensembles remain Claude+Codex.
- **F-Sched interplay:** deploy stages run inside the loop process; F-Sched
  start/stop semantics unchanged (no task scheduling — §8 F-Sched row).
- **Issue body size cap (8.3):** 20000 chars chosen to keep drafts reviewable;
  oversized intake belongs in a repo file a human curates, not the intake
  form.

### /spec-analyze findings log (anchor: pre-commit draft on `feat/platform-phase4` @ bbcbf06, audited 2026-07-08)

User decision: "ตามแนะนำทั้งหมด" — all 14 findings applied per recommendation.

**Applied (AZ-1..AZ-14):**
- AZ-1 `approval.timeoutMs` default → 30 min, overridable (3.4)
- AZ-2 server lifetime × deploy: scope extends through deploy stage; deploy
  decision shares the AZ-1 timeout (timeout → recorded skip, task stays
  COMPLETED); EXPANDED manual-rollback window `expandedWindowMs` default 10 min
  → `DEPLOY_WINDOW_CLOSED` (3.5, 6.11, 6.12) [auditor R2]
- AZ-3 `expand_cmd` non-zero → rollback path with root cause `expand_failed`;
  freeze-time bounds `probes >= 1`, `failure_threshold < probes` (4.2, 5.6)
  [auditor R3]
- AZ-4 deploy approval = hard human floor regardless of approvalPolicy (6.1)
- AZ-5 GET /deploy wording: 501 not-composed vs null-fields composed (6.3)
- AZ-6 added POST /api/issues/{id}/reject, 409 on non-open (8.6)
- AZ-7 lesson proposal = post-run fold in composition, core engine untouched
  (10.1)
- AZ-8 lesson caps defaults maxLessons 5 / maxBytes 8192 (12.5)
- AZ-9 lesson hit-rate defined as labeled PROXY (injected tasks reaching
  REVIEWING ÷ injected tasks) (24.1) [auditor R6]
- AZ-10 `minDivergences` lives in routing.json `outcomeRouting` (default 1)
  (13.3, 14.1)
- AZ-11 epsilon precedence: frozen > insufficient_data > reorder > epsilon;
  swap only when reorder occurred and eligible ≥ 2 (15.2) [auditor R5]
- AZ-12 `plan.schema.json` does not exist — creating it is part of REQ-16
  (16.5) [auditor R1]
- AZ-13 planner uses the SAME router instance as the task loop, mode per
  governance, empty stats per 15.7 (16.2) [auditor R7]
- AZ-14 chat WS bad-ticket close code 4401 → 4403 matching F-Term
  (`term-runtime.ts:75`); 23.4 verifies actual semantics (17.2, 23.4)
  [auditor R4]

**Dismissed:** none — all findings accepted.
