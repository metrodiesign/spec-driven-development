# Implementation Tasks: Autonomous Engineering Platform — Phase 2 (Semi-autonomous + Survivability + Console Extensions)

> Status: approved 2026-07-07 (human gate)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.
> Upstream: design.md + requirements.md both approved 2026-07-07 (AZ-1..AZ-20 applied).
> RED-first per area (§0.4); all CI on FakeAdapter; live runs manual only.

- [x] 1. AAL survivability: breaker + quota-aware routing + degraded source — `aal/src/breaker.ts`
     (closed/open/half-open per adapterId@modelVersion, injected clock, sink events), registry
     `healthProbe`/`refreshHealth` cached snapshot + probe timeout, eligible/route filter order,
     source per-call role from `ProposalInput.role` + catches `AdapterError` (breaker record →
     re-route once excluding failed keys → `BLOCKED(no_capacity)`), `diagnostician` Role +
     `roleRequires` case + empty write-prefixes, repair `totalUsage` accumulation + real
     remaining budget in `AgentRequest.budget`, anthropic `quotaProbe` injection point +
     `{fiveHourPct, weeklyPct}` struct, FakeAdapter fault knobs (`throw_quota_limited` /
     `throw_transport` / `health_unhealthy`). Done = breaker/routing/repair unit tests green
     incl. benign baseline (compliant adapter never trips), P3/P4 conformance verdicts unchanged.
     Satisfies: REQ-1 (all), REQ-2 (all), REQ-3 (all), REQ-4 (all), REQ-6.1-6.3.
     Verify: pnpm -r test (aal + adapters); conformance suite on FakeAdapter all-pass.
     Evidence:
       - test: `pnpm -r test` -> 199 passed / 0 failed (core 71, aal 38 [+15], adapters 13 [+2],
         console/backend 65, console/web 12); P1–P8 conformance harness green (P3/P4 unchanged).
       - typecheck: `pnpm -r typecheck` -> all 6 projects Done. lint: `pnpm lint` clean;
         `pnpm vendor-check` -> core/ + aal/ vendor-name-free (INV-7).
       - new tests: `aal/src/breaker.test.ts` (window/half-open single-flight/per-key/sink-only),
         registry (open-breaker excluded, refreshHealth not-ok + hung-probe timeout=probe_failed,
         diagnostician eligible), source (adapter_failure→BLOCKED, switch_to_next_eligible,
         benign baseline no-trip, quota-unhealthy excluded+QUOTA_PROBE estimate-labeled),
         repair totalUsage=4, anthropic quotaProbe→healthProbe (under/over/null).
       - viewports: n/a — logic-only.
       - deviations: (1) breaker trips only on a FULL window (windowSize samples) per "failure
         rate over the sliding window" — a lone failure is recorded but does not open; the
         re-route test asserts via claim + no-escalation, not breaker state. (2) REQ-6.3 wired
         through an optional `budgetRemaining()` closure in `AALSourceDeps` (composition passes
         `budget.remaining()`); core's `ProposalInput` port is unchanged (INV-8). (3) anthropic
         returns `AnthropicAdapter = AdapterInterface & { healthProbe? }`; `AdapterInterface`
         (send/manifest) unchanged, composition hands `adapter.healthProbe` to `register`.
         (4) all Phase-2 `EventType`s added at once (single append-only declaration point,
         INV-10); producers land per task. Full loop composition (real clock, Human Plane,
         auto-merge) stays Task 5/9 per plan.

- [x] 2. Hypothesis-driven repair — `.ai/schemas/hypothesis` + `core/src/repair/hypothesis.ts`
     (validate proposal, probes cheapest-first short-circuit via core executor `network:'none'`,
     policy-capped probes default 5, per-probe timeout, errored probe = `undecided` never
     refuted, budget/wallclock checks between probes), loop wiring FAILED → DIAGNOSING
     (diagnostician round) → CONFIRMED → REPAIRING with patchPlan folded as marked data /
     exhausted → `ESCALATED hypotheses_exhausted` with ordered hypothesis log, events
     HYPOTHESIS_PROPOSED/PROBE_RUN/HYPOTHESIS_CONFIRMED/HYPOTHESIS_REFUTED, budget-exhausted
     check between charge and propose (never send ≤0). Done = engine + loop-path unit tests
     green, refuted hypotheses persisted, fault-injection suite unchanged green.
     Satisfies: REQ-5 (all), REQ-6.7. Depends on: 1.
     Verify: pnpm -r test (core); core/test/fault-injection.test.ts unchanged green.
     Evidence:
       - test: `pnpm -r test` -> 209 passed / 0 failed (core 81 [+10], aal 38, adapters 13,
         console/backend 65, console/web 12); fault-injection suite (9 DoD scenarios) unchanged green.
       - typecheck: `pnpm -r typecheck` -> all 6 projects Done. lint: `pnpm lint` clean;
         `scripts/check-core-vendor-free.sh` -> core/ + aal/ vendor-name-free (INV-7).
       - new tests: `core/src/repair/hypothesis.test.ts` (confirm+short-circuit, cheapest-first,
         refute+persist, undecided-on-error/timeout, probe-cap reject, max_hypotheses, between-probe
         wallclock stop), `core/test/repair-loop.test.ts` (confirmed→REPAIRING+patchPlan-folded→REVIEWING,
         all-refuted→ESCALATED hypotheses_exhausted with dump-free ref log, REQ-6.7 exact-zero budget).
       - viewports: n/a — logic-only.
       - deviations: (1) AAL hypothesis PRODUCTION (diagnostician adapter response → `Proposal.hypotheses`)
         + FakeAdapter diagnostician behavior deferred to composition (Task 5/9), per plan's "full loop
         composition stays Task 5/9"; Task 2 delivers the core engine + loop wiring + schema, loop-path
         test uses a stub source returning the exact `Proposal.hypotheses` contract the AAL will fill.
         All existing composition/integration tests stay green (honest adapters never fail gates → never
         diagnose; lying adapters escalate either way — via hypotheses_exhausted now vs budget before).
         (2) per-probe timeout wired via a new optional `RUN_COMMAND.timeoutMs` threaded to `spawnSync`
         (REQ-5.8); default 120s preserved when unset. (3) `undecided` = executor rejected OR no clean
         exit status (exitCode < 0 = spawn-fail/timeout-kill); a clean run whose output lacks `expected`
         feeds refutation. (4) `expected` matched as a substring only (design "substring|regex" — regex
         not implemented, YAGNI). (5) repair policy (maxHypotheses 3 / maxProbes 5 / probeTimeout 30s)
         is a `LoopOptions.repairPolicy` with defaults; sourcing max_hypotheses_per_failure from the
         frozen contract deferred to composition (no contract field added here). (6) `LoopOptions.evidence`
         /`ids` optional (append-only, INV-8): a harness without them treats a diagnostician round as
         vacuously exhausted; loop-run.ts wires them. (7) core port extended append-only —
         `Proposal.hypotheses?` + `RepairGuidance` in the `ProposalInput.feedback` union.

- [x] 3. State machine + auto-merge L0–L1 + sampling audit — `machine.ts` (`auto_approved:
     REVIEWING→APPROVED` core-only, `merge_queued`/`audited`/`completed` out of PHASE_GATED,
     MERGE_QUEUED+AUDITED into ACTIVE_STATES), `core/src/merge/auto-merge.ts` (auto-approve
     gate: risk∈{L0,L1} + gates green + all contract ACs `golden:true` + no dep-touching diff
     per security-plane pattern list + zero-AC → approval package; `task/<taskId>` branch from
     fixture main, `--no-ff` merge, conflict → ESCALATED; deterministic sampling
     `sha256(runId+taskId) mod 100`; audit re-runs T1 from clean checkout, reproduce = ordered
     verdicts + evidence hashes excluding timing/host metadata; mismatch → single
     `escalate(audit_mismatch)` with git revert side effect), events AUTO_APPROVED/
     AUDIT_SAMPLED/AUDIT_RESULT. Done = L1 fixture task auto-merges + sampled audit reproduces;
     `auto_approved` unreachable via ports (fault-injection scenario).
     Satisfies: REQ-7 (all), REQ-8 (all). Depends on: 1.
     Verify: pnpm -r test (core + console/backend); new fault-injection scenarios green.
     Evidence:
       - test: `pnpm -r test` -> 221 passed / 0 failed (core 93 [+12], aal 38, adapters 13,
         console/backend 65, console/web 12); `pnpm -r typecheck` all 6 Done; `pnpm lint` clean;
         `scripts/check-core-vendor-free.sh` -> core/ + aal/ vendor-name-free (INV-7).
       - new tests: `core/src/merge/auto-merge.test.ts` (decideAutoApprove table: L0/L1 approve,
         gates_not_green / risk_above_l1 / null-risk→L2 / zero_acceptance_criteria / non_golden_ac /
         dep_touching_diff-floor; matchesDepManifest basename+suffix; real security-plane.json floors
         a lockfile diff; auditSampleValue deterministic ∈[0,100); L1 auto-merge + sampled audit
         reproduces→COMPLETED with a real --no-ff merge commit; unsampled rate=0→COMPLETED, no re-run;
         mismatch→single escalate(audit_mismatch)+merge reverted; conflict→escalate(merge_conflict),
         main untouched, tree clean; L2→approval_package, no merge, state unchanged). `machine.test.ts`
         (auto_approved/merge_queued/audited/completed enabled; MERGE_QUEUED+AUDITED escalate legal;
         COMPLETED reachable ONLY via core-internal `completed` from AUDITED). `fault-injection.test.ts`
         DoD#10 (no ProposalClaim across honest/liar/blocker reaches APPROVED/MERGE_QUEUED/AUDITED/
         COMPLETED or fires AUTO_APPROVED — REQ-7.3/INV-2).
       - viewports: n/a — logic-only.
       - deviations: (1) full loop composition (runSupervisedLoop creating the real `task/<taskId>`
         branch + calling runAutoMerge after REVIEWING) stays Task 5/9 per plan; Task 3 delivers the
         machine changes + the standalone core engine (`decideAutoApprove` pure gate + `runAutoMerge`
         orchestration) + the security-plane pattern list + the INV-2 fault-injection scenario.
         `runAutoMerge` takes riskClass/acceptanceCriteria/gatesGreen/originalReport as DATA (composition
         sources them from the frozen contract + core-run T1); the pure gate ignores the agent claim by
         construction, so the "auto_approved unreachable via ports" DoD is proven structurally + via the
         loop scenario, not by wiring the loop. (2) `.ai/policies/security-plane.json` seeds
         `depManifestPatterns` now (basename match; slash-pattern = path suffix) — the single list REQ-7.6
         and REQ-11.2 share (AZ-17); Task 6 extends it with install patterns + provider-data policy.
         (3) "reproduce" (REQ-8.6/AZ-9) = ordered (name,pass) verdicts equal AND evidenceRef equal —
         evidenceRef is `blob://sha256(content)`, so ref-equality IS content-hash equality; commit/
         worktree/env hashes + ts are excluded. (4) clean-checkout audit via `git worktree add --detach
         <mergeCommit>`; revert-on-mismatch via `git revert -m 1 --no-edit` (single merge-commit target).
         (5) the now-unproduced `not_enabled_phase0`/`not_enabled_phase1` reasons stay in the
         TransitionResult union (append-only, avoids churning consumers); human/api.ts steering 501 uses
         its own string literal, unrelated to the machine.

- [x] 4. Meta-governance — `core/src/governance/policy.ts` (policy snapshot hash vs last
     GOVERNANCE_CHANGE in durable `.ai/governance/events.jsonl`; empty log = `beforeHash:null`
     mismatch → `GOVERNANCE_PROPOSED` + refuse `policy_unapproved` printing
     `platform governance approve <id>`), `platform governance list|approve <id>` CLI (works
     with no server), Human Plane approval by kind (`policy_change` append-only /
     `flaky_quarantine` fires quarantine for its taskId, CLI-approved with no live run =
     deferred to next load), flakySuspect → `flaky_quarantine` proposal (never auto), CI-fixture
     seeding labeled `decidedBy:'ci-fixture'`. Done = tamper-with-policy-file test refuses
     start; approve unblocks; quarantine only via approval.
     Satisfies: REQ-9 (all). Depends on: 3.
     Verify: pnpm -r test (core + console/backend) incl. no-server CLI approve test.
     Evidence:
       - test: `pnpm -r test` -> 241 passed / 0 failed (core 108 [+15], aal 38, adapters 13,
         console/backend 70 [+5], console/web 12); `pnpm -r typecheck` all 6 Done; `pnpm lint`
         clean; `scripts/check-core-vendor-free.sh` -> core/ + aal/ vendor-name-free (INV-7).
       - new tests: `core/src/governance/policy.test.ts` (empty-log→policy_unapproved+beforeHash:null
         +GOVERNANCE_PROPOSED+approve-cmd; idempotent proposal; approve→unblock; tamper-file→refuse;
         absent-file-created is itself gated; flaky proposal never-auto + approval-required + deferred
         taskId; flaky change kept out of lastApprovedHash; applyGovernanceApproval fires quarantine
         for flaky only; unknown id; ci-fixture seed decidedBy:'ci-fixture'; deterministic snapshot),
         `core/src/human/api.test.ts` (+4: GET lists governance proposals; POST routes to
         onGovernanceApprove NOT onDecision + no APPROVAL_RECORDED; unknown gov id→404; no-plane→404),
         `console/backend/src/governance-cli.test.ts` (5: list-empty; no-server refuse→list→approve→
         next preflight ok; approve unknown→nonzero+stderr; missing id/unknown sub→usage).
       - viewports: n/a — logic-only.
       - deviations: (1) governance preflight WIRING into run startup (bin ordering
         governance→automation→adapter) stays Task 9 per tasks.md; Task 4 delivers the engine
         (`ensureGovernanceApproved`) + CLI + Human Plane by-kind + flaky proposal + ci-fixture seed.
         "refuses start" is proven at the engine level (→`policy_unapproved`), not via full-run wiring.
         (2) Human Plane by-kind (REQ-9.4): `HandlerDeps` gains append-only optional
         `governanceProposals?()` + `onGovernanceApprove?(id)` (INV-8; Phase-1 servers behave
         identically). Routing + `applyGovernanceApproval` (fires quarantine for `flaky_quarantine`
         ONLY, `policy_change` append-only) unit-tested with fakes; server COMPOSED into
         runSupervisedLoop with a real `fireQuarantine` stays Task 5. (3) snapshot inputs = the 4
         files REQ-9.1 names (`gate-ladder`/`security-plane`/`automation`/`provider-data-policy`);
         a missing file hashes as an `absent` sentinel so creating one later (Task 6/9) is itself a
         gated change (REQ-9.6 conservative superset). Design prose said "path policy version" — the
         AC's file list is authoritative, followed it. (4) `flaky_quarantine.afterHash` = `flaky:<taskId>`
         marker (not a policy hash), excluded from `lastApprovedHash` so a flaky approval never moves
         the policy gate; `pendingQuarantines` returns approved taskIds for composition to quarantine
         on next load (deferred, REQ-9.5). (5) `decidedBy ∈ {'human','ci-fixture'}` — CLI + Human Plane
         both record `'human'` (both are the single operator, INV-15); only seeded fixtures use
         `'ci-fixture'` (REQ-9.7). (6) `.ai/governance/events.jsonl` is created lazily on first
         proposal/seed (mkdir -p in appendRecord) — no empty durable log committed yet; it begins when
         the first governance event is recorded (Task 9 fixture seeds it).

- [x] 5. Steering + loop operability — `LoopControl` port polled at iteration boundaries,
     `pause` → PAUSED + `PAUSE_REQUESTED {prePauseState}`, `resumeTransition(prePauseState)`
     (PAUSED-only, ACTIVE_STATES targets) + `RESUMED {resumedTo}`, `/steering/pause|inject|
     resume` replace Phase-1 501s (inject PAUSED-only 409; steering from MERGE_QUEUED onward
     409 structured; approval wait = boundary racing control port; task approval while PAUSED
     409; kill during PAUSED clean), guidance → evidence + `GUIDANCE_INJECTED` + folded as
     marked data, Human Plane server COMPOSED into `runSupervisedLoop` (human-plane.json 0600,
     onDecision task-only), injected `Clock` replacing frozen `nowMs` (production `Date.now()`,
     tickable in tests), ACTIVE-time wallclock (exclude pause + approval-wait intervals from
     event timestamps) that now really trips. Done = pause/resume round-trips from every
     ACTIVE_STATE (property test), wallclock trip test green under tickable clock.
     Satisfies: REQ-10 (all), REQ-6.4-6.6, REQ-18.1. Depends on: 3.
     Verify: pnpm -r test (core + console/backend); loop-run wallclock-trip + steering tests.
     Evidence:
       - test: `pnpm -r test` -> 260 passed / 0 failed (core 126 [+18], aal 38, adapters 13,
         console/backend 71 [+1], console/web 12); `pnpm -r typecheck` all 6 Done; `pnpm lint`
         clean; `scripts/check-core-vendor-free.sh` -> core/ + aal/ vendor-name-free (INV-7).
       - new tests: `core/src/orchestrator/machine.test.ts` (+2: pause/resume round-trips from
         EVERY ACTIVE_STATE property; resumeTransition legal PAUSED-only + active-target-only),
         `core/src/orchestrator/control.test.ts` (4: idle/pause+resume/kill-wins/kill-before-wait),
         `core/src/budget/budget.test.ts` (+1: ACTIVE wallclock excludes noted intervals — REQ-6.5),
         `core/test/steering-loop.test.ts` (5: pause@boundary→PAUSED{prePauseState}+guidance-folds+
         RESUMED{resumedTo}→REVIEWING; kill@boundary→CANCELLED; kill-while-paused→CANCELLED;
         wallclock trip under tickable clock; idle control inert), `core/src/human/api.test.ts`
         (+6: pause 202; inject PAUSED-only 409/202; resume 202; MERGE_QUEUED+ 409 structured;
         no-guidance 400; task-approval-while-PAUSED 409 — REQ-10.9), `console/backend/src/
         loop-run.test.ts` (+1: run reaches REVIEWING + human-plane.json 0600 [REQ-18.1];
         governance-approved deferred flaky_quarantine → QUARANTINED on load [REQ-9.5]).
       - viewports: n/a — logic-only.
       - deviations: (1) SCOPE (human decision, this session): implemented the REQ-faithful lean
         Task 5 — steering(REQ-10) + injected Clock/active-wallclock(REQ-6.4-6.6) + Human Plane
         server + governance compose + steering/kill→control port(REQ-18.1). The two composition-
         backlog items that are NOT Task-5 REQs — AAL hypothesis PRODUCTION (REQ-5, Task 2's
         deferral) and task-branch + `runAutoMerge` WIRING (REQ-7/8, Task 3's deferral) — move to
         Task 9, where the E2E DoD (REQ-18.4: one L1 task → COMPLETED) forces AND tests them; this
         avoids ad-hoc integration tests here that Task 9 would redo. (2) REQ-18.1 `onDecision`
         (task approval → `human_approved`/`changes_requested` transition over the log's last
         TASK_STATE) is WIRED into the live server but not exercised end-to-end here: no approval
         package is produced without the auto-merge routing (Task 9), so the reachable-via-HTTP
         path is the handler unit test. (3) machine: universal escapes (cancel/escalate/…) are now
         legal from PAUSED too (append to the guard) — needed so kill-while-PAUSED terminates via
         `cancel` (REQ-10.7); pause-from-every-ACTIVE_STATE property + terminal-refusal tests
         unchanged. (4) guidance folds into the next round via a new append-only
         `GuidanceFeedback {kind:'guidance'}` in the `ProposalInput.feedback` union (INV-8); the
         AAL source already stringifies+marks any feedback value, so no AAL change was needed. The
         loop drains a guidance queue at the boundary and lets guidance take precedence for that
         round (ponytail: the pause boundary sits between clean rounds, pending feedback normally
         null). (5) `steeringState()` reads the event log's last TASK_STATE — the single state
         source the loop and the Human Plane share — so no new loop→server state callback was
         added. (6) REQ-6.6 (verdicts/hashes independent of timestamps) satisfied by construction:
         the Clock change touches only the wallclock budget + event metadata; no gate verdict or
         evidenceRef reads the clock (auto-merge `reproduces()` already excludes ts, Task 3).
         (7) `governanceLogPath` is an optional runSupervisedLoop param (governance plane +
         deferred quarantine on load); the governance PREFLIGHT ordering at startup stays Task 9.

- [x] 6. Security plane completions — canary tripwire helper + source check post-repair
     (`CANARY_TRIPPED` + structured reject, round consumed), dep-policy in executor
     (`network:'allowlist:package_install'` gated by `.ai/policies/security-plane.json`:
     frozen-lockfile + `--ignore-scripts` pattern + lockfile present per shared pattern list;
     all else `network:'none'` hard-deny; non-darwin fail-closed `sandbox_unavailable`;
     mitigated-not-solved wording in code), provider data policy (`.ai/policies/
     provider-data-policy.json`; per-path check before send; pathless pieces only enumerated
     platform kinds else `data_policy_violation`). Done = trip/deny/allow tests green with
     benign baselines (normal RUN_COMMAND untouched; compliant response never trips).
     Satisfies: REQ-11 (all). Depends on: 1.
     Verify: pnpm -r test (core + aal); fault-injection suite unchanged green.
     Evidence:
       - test: `pnpm -r test` -> 281 passed / 0 failed (core 144 [+18], aal 41 [+3], adapters 13,
         console/backend 71, console/web 12); fault-injection suite unchanged green; skipped 0
         (darwin execution tests ran locally).
       - typecheck: `pnpm -r typecheck` -> all 6 projects Done. lint: `pnpm lint` clean;
         `scripts/check-core-vendor-free.sh` -> core/ + aal/ vendor-name-free (INV-7).
       - new tests: `core/src/security/canary.test.ts` (trip in structuredResult / inline action
         field; benign no-trip; body-is-ref invisible; empty-token no-trip), `core/src/security/
         data-policy.test.ts` (in-policy pass; out-of-policy blocks; `*` within-segment glob;
         pathless enumerated-kind pass; pathless other-kind escalate), `core/src/executor/
         executor.test.ts` (shipped security-plane pattern accept+near-miss; requireLockfile
         gate; package_install on linux sandbox -> sandbox_unavailable; no-policy/near-miss ->
         network_policy_denied; unknown grant -> unsupported_action_phase0; benign none unaffected;
         allowed install runs egressBlocked:false — last two darwin-gated), `aal/src/source.test.ts`
         (+3: canary trip -> CANARY_TRIPPED+WORKING+no-actions; out-of-policy path -> BLOCKED +
         DATA_POLICY_VIOLATION + ESCALATED data_policy_violation + no CONTEXT_BUILT + costUnits 0;
         in-policy benign baseline unaffected).
       - viewports: n/a — logic-only.
       - deviations: (1) COMPOSITION WIRING stays Task 9 per plan (bin parses the two policy JSONs
         and passes `depPolicy` to the executor + `dataPolicyFor` to the AAL source; the L1->COMPLETED
         E2E exercises them). Task 6 delivers the mechanism (canary helper, dep-policy gate +
         network-permitting sandbox, provider-data-policy checker), the security-plane packageInstall
         block + new provider-data-policy.json, and the executor/source wiring points + tests — the
         same deferral shape as Tasks 2/3/5. (2) `network_policy_denied` added to `ActionRejection.reason`
         (append-only, INV-8/10) for a governed-grant policy near-miss / missing lockfile; other
         allowlist names keep `unsupported_action_phase0` (REQ-11.3). (3) canary checks structuredResult
         + inline action fields only — written file bodies travel as evidence refs, never inline, so a
         token there is not in the response (documented in the helper + a test asserts it). (4)
         `security-plane.json` commandPattern pins the CANONICAL flag order for pnpm/npm/yarn frozen
         installs (`--frozen-lockfile --ignore-scripts`; npm ci implies frozen); flag-order permutations
         are YAGNI — the platform emits canonical commands, widen the pattern if that changes. (5)
         data-policy check runs per-CHOSEN-adapter at the top of the send loop (a re-route re-checks the
         new adapter's policy); a violation is a hard escalate + send-nothing, never a re-route (REQ-11.5).
         (6) `egressBlocked` in `ExecuteOutcome` now reflects the grant — `false` for a package_install
         that ran with network permitted, `true` otherwise. (7) provider-data-policy.json is created now
         (was the governance `absent` sentinel from Task 4); this is itself a gated governance change —
         the Task 9 CI fixture seeds the approving `decidedBy:'ci-fixture'` snapshot.

- [x] 7. Console governance surfaces (F-MCP, F-Hook, F-Sub, F-Skill, F-Sys) + audit extension —
     backend route groups copying the F-Mem writeSafe pattern (GET {content,hash} / PUT 409/422),
     F-MCP project `.mcp.json` writes + user scope read-only + `POST /api/mcp/test` advisory,
     F-Hook validate → {verdict, JSON-diff preview, confirmToken=sha256(baseHash+content)} +
     install/uninstall requiring token AND baseHash (428/409) + audit, F-Sub CRUD
     `.claude/agents/*.md` frontmatter-validated, F-Skill SKILL.md + enabledPlugins, F-Sys
     doctor capture (degraded card) + node:os stats + retention editor with two-step prune
     (409 when PTY live), managed scope no-PUT route-table test, audit JSONL extended to hook
     install/uninstall + retention prune + governance decisions + approvals + steer + kill,
     minimal web pages per surface. Done = all routes tested; pages render in prod build.
     Satisfies: REQ-12 (all), REQ-13 (all), REQ-14 (all), REQ-15 (all), REQ-18.3.
     Verify: pnpm -r test (console/backend + web); prod build (`next`-equivalent: vite build +
     serve) browser check per browser-verify lesson.
     Evidence:
       - test: `pnpm -r test` -> 302 passed / 0 failed (core 144, aal 41, adapters 13,
         console/backend 89 [+18], console/web 15 [+3]); `pnpm -r typecheck` all 6 Done;
         `pnpm lint` clean; `scripts/check-core-vendor-free.sh` -> core/ + aal/ vendor-free.
       - new tests: `console/backend/src/surfaces.test.ts` (confirmToken bind/invalidate;
         jsonDiffPreview exact; validateHookConfig valid/unknown-event/bad-shape/non-command;
         validateMcpConfig stdio/http/reject; validateSubagentFrontmatter req-fields+body-verbatim;
         retentionPreview cutoff), `console/backend/src/app-surfaces.test.ts` (F-MCP GET/PUT/422/409
         + user read-only no-PUT route-table + advisory test; F-Hook validate diff+token, install
         needs BOTH token+baseHash [428], stale base [409], invalid [422], audit; F-Sub CRUD +
         frontmatter 422; F-Skill SKILL.md + enabledPlugins toggle; F-Sys doctor degraded-never-500
         + node:os stats + retention prune two-step [428] + live-PTY [409] + audit + cleanupPeriodDays),
         `console/web/src/logic/surfaces.test.ts` (statsRows/diffLines/listOrEmpty).
       - viewports: 375 OK | 768 OK | 1440 OK — served the vite prod build via buildApp (real /api,
         temp home) on 127.0.0.1:9191; chrome-devtools emulate, verified
         `document.documentElement.clientWidth === target` exactly (375 mobile-emulate; 768 via 783
         and 1440 via 1455 to offset the 15px real-window scrollbar per browser-verify.md) with
         `scrollWidth === clientWidth` (no horizontal overflow) and all five surface panels +
         Governance heading rendered at each.
       - deviations: (1) AUDIT scope: the console audit sink (REQ-18.3) is wired to the
         console-originated writes — hook install/uninstall + retention prune — and route-tested.
         The loop-side items REQ-18.3 also names (governance decisions, approvals, steering, kill)
         are already recorded in the durable core event log by Tasks 3/4/5 (GOVERNANCE_*/
         APPROVAL_RECORDED/PAUSE_REQUESTED/RESUMED/GUIDANCE_INJECTED/KILL_REQUESTED — the
         authoritative audit trail); mirroring them into the console JSONL is loop-run composition
         and rides Task 9. (2) `AppDeps.audit` is an injected optional sink (tests capture; the live
         server appends to the shared audit JSONL) — no server bin composes buildApp yet (index.ts is
         still the Phase-1 placeholder), so the JSONL file path is wired when the server is composed,
         not here. (3) `AppDeps.doctorCapture` added (injected, mirrors `cliVersion`) so the doctor
         test never spawns the real CLI; production falls back to `claude doctor` capture. (4)
         MANAGED/user-readonly enforced BY CONSTRUCTION (REQ-13.4): PUT registered only at literal
         writable paths (`/api/mcp/project`, `/api/subagents/:name`, …); a PUT to a read-only scope
         has no route (404) — asserted via `app.hasRoute`. (5) WEB is minimal READ/list views per
         surface (System stats+doctor, MCP/Hooks content, Subagent/Skill lists) + the two-step-consent
         entry-point note; the write flows (consent gate, writeSafe, toggles) live in the backend and
         are exercised by the API tests, not re-implemented as web forms (ponytail — DoD is
         routes-tested + pages-render). (6) `network_policy_denied`-style new reasons: none here.
         (7) F-Mem-pattern helpers (`contentHash`/`putThrough`/`settingsScopePath`) are local to
         buildApp to avoid churning govern.ts; writeSafe/sha256 are reused from govern.ts.

- [x] 8. F-Term repaint nudge + transcript glob fallback (carried backlog #3 #4) — `PtyLike.resize`
     + `TermManager.resize(ptyId,cols,rows)` with per-session dims, WS attach double-resize
     nudge (rows−1→rows) after ring replay (signal-only, byte-prefix invariant), anthropic
     transcript capture glob `~/.claude/projects/*/<sessionId>.jsonl` on predicted-path miss →
     structured null when both miss. Done = nudge + fallback unit tests green; manual re-attach
     check recorded.
     Satisfies: REQ-17 (all).
     Verify: pnpm -r test (console/backend + adapters).
     Evidence:
       - test: `pnpm -r test` -> 308 passed / 0 failed (core 144, aal 41, adapters 16 [+3],
         console/backend 92 [+3], console/web 15); `pnpm -r typecheck` all 6 Done; `pnpm lint`
         clean; `scripts/check-core-vendor-free.sh` -> core/ + aal/ vendor-free.
       - new tests: `console/backend/src/term.test.ts` (+3: resize tracks per-session dims +
         forwards to PTY + rejects unknown/non-positive [REQ-17.1]; nudgeRepaint double-resizes
         rows-1→rows around the tracked geometry [REQ-17.2]; nudge is signal-only — 0 bytes written,
         ring buffer unchanged [REQ-17.3]), `adapters/src/anthropic.test.ts` (+3: transcript at the
         PREDICTED path → source `predicted`; predicted miss + sibling project dir has it → glob
         fallback hit [REQ-17.4]; both miss → null + `not_found_after_poll_and_glob`, no crash
         [REQ-17.5]).
       - viewports: n/a — logic-only. (The nudge is verified structurally on a fake PtyLike; the
         actual full-screen-TUI repaint on browser re-attach is a live check that needs a real
         `claude` PTY — recorded as deferred to the task-11-style live pass, per term-runtime's
         existing "verified live" contract. Not runnable headless.)
       - deviations: (1) `manager.nudgeRepaint(ptyId)` is wired into the WS bridge after
         `ws.send(re.buffer)` in term-runtime.ts (runtime glue; node-pty+ws, live-verified) — the
         double-resize logic itself is unit-tested. The DoD "manual re-attach check recorded" is a
         live browser + real-`claude` check → deferred to the live pass (can't drive a real TUI
         headless); noted here rather than asserted. (2) `DEFAULT_PTY_DIMS` (120x32) hoisted into
         term.ts as the SINGLE source both `nodePtySpawn` and the session default use, so the nudge
         toggles around the ACTUAL geometry and never resizes the terminal. (3) the REQ-17.5
         "structured reason" is surfaced as `usage.raw.transcriptSource`
         (predicted|glob_fallback|not_found_after_poll_and_glob|no_session_id|no_transcript_dir) —
         `usage.raw` is a free-form `Record`, so no protocol/response-shape change; `rawTranscriptRef`
         stays `string|null`. (4) glob root = `dirname(transcriptDir)` (the projects root) — no new
         adapter option; `globTranscript` scans sibling project dirs with `readdirSync` wrapped so an
         unreadable root returns null (never throws, REQ-17.5). (5) `TermManager` gained `resize` +
         `nudgeRepaint` (append-only, INV-8); the WS bridge holds only a `ptyId` and calls the manager
         (REQ-17.1) — parsing client-resize control messages over the WS is out of REQ-17 scope
         (needs a control/data byte protocol) and is not added.

- [x] 9. Automation guards + composition preflight + CI E2E DoD proof — `console/backend/src/
     guards.ts` pure `decideAutomationStart` ({fiveHourPct,weeklyPct}|null; max ≥ threshold
     default 85% → defer with tripping-window reset as `until`; null → fail-closed
     `estimate_unavailable`; `--force-quota-override` bypasses refusal only + `AUTOMATION_
     OVERRIDE`; Sonnet default from `.ai/policies/automation.json`), bin/platform wiring order
     governance preflight → automation guard → adapter construction, fixture ships
     `auditSampleRate:100` + seeded `decidedBy:'ci-fixture'` snapshot, CI E2E: one L1 task to
     COMPLETED (auto-merge + sampled audit) with FakeAdapter on macOS runner, live guards
     unchanged (CI/non-TTY refuse; manual + budget cap). Done = E2E green in CI; guard unit
     tests incl. null-estimate and override paths.
     CARRIED from Task 5 (lean-scope decision 2026-07-07): this task ALSO owns the two
     composition-backlog items Task 5 did not absorb, because the L1→COMPLETED E2E forces + tests
     them — (a) AAL hypothesis PRODUCTION: `aal/source.ts` turning a diagnostician adapter
     response into `Proposal.hypotheses` (per-role hypothesis schema, NOT task-result) +
     FakeAdapter emitting hypotheses when `agentRole==='diagnostician'` (core consume-side already
     proven, Task 2); (b) real branch topology in `runSupervisedLoop`: create `task/<taskId>` from
     fixture main BEFORE the loop, executor worktree tracks it, commit the work, call `runAutoMerge`
     after REVIEWING (risk from the frozen contract — add a parsed `risk?` to `freezeContract` or
     read `raw['risk']`; gatesGreen from the core-run T0+T1; ACs/originalReport from the contract).
     Satisfies: REQ-16 (all), REQ-18.2, REQ-18.4-18.5 (+ carried REQ-5 production, REQ-7.1/7.4
     wiring). Depends on: 1-8.
     Verify: pnpm -r test; scripts/spec-trace.sh platform-phase2; CI workflow green on both jobs.
     Evidence:
       - test: `pnpm -r test` -> 322 passed / 0 failed / 0 skipped (core 144, aal 42 [+1],
         adapters 16, console/backend 105 [+13: guards 10 + loop-run E2E 3]); `scripts/spec-trace.sh
         platform-phase2` -> 108 REQs covered, EARS lint pass. E2E `an L1 task auto-merges + the
         sampled audit reproduces -> COMPLETED` green (REQ-18.4); E2E `FAILS, self-repairs via a
         confirmed hypothesis, then auto-merges -> COMPLETED` green (REQ-5 production; darwin-gated).
       - typecheck: `pnpm -r typecheck` -> all 6 Done; lint: `pnpm lint` clean;
         `scripts/check-core-vendor-free.sh` -> core/ + aal/ vendor-name-free (INV-7).
       - new: `.ai/policies/automation.json` (production auditSampleRate 25, Sonnet, threshold 85);
         `console/backend/src/guards.ts` (pure `decideAutomationStart` + `loadAutomationConfig`) +
         `guards.test.ts` (10). New tests: `aal/src/source.test.ts` (+1: diagnostician round ->
         Proposal.hypotheses), `console/backend/src/loop-run.test.ts` (+3: L1->COMPLETED sampled-audit,
         repairable diagnosis->COMPLETED [darwin], L2 default -> approval package REVIEWING).
       - bin smoke (manual): `platform loop run --goal <L1>` -> governance preflight refuses
         (`policy_unapproved`, exit 5, prints `platform governance approve <id>`) -> approve -> re-run
         -> loop -> `COMPLETED` (auto-merge on the throwaway fixture). Runtime `.ai/governance/
         events.jsonl` removed after: the repo ships an EMPTY governance log — the first real run gates
         policy and the operator approves once (never a committed fake-human approval).
       - viewports: n/a — logic-only (composition/CLI; console web surfaces were Task 7).
       - deviations: (1) CI E2E runs inside `pnpm test` on the existing macos-latest `platform` job
         (no CI YAML change). The E2E passes `auditSampleRate:100` + `risk:'L1'` DIRECTLY to
         `runSupervisedLoop` (governance-preflight-free — preflight is bin-only per REQ-18.2), meeting
         the deterministic sampled-COMPLETED intent (AZ-15); governance seeding/preflight is covered by
         `core/governance/policy.test.ts` + the bin smoke, not re-seeded in the E2E. (2) "commit the
         work" (review #6): `runSupervisedLoop` commits the worktree onto `task/<taskId>` before
         `runAutoMerge` — the executor snapshots BEFORE each write (rollback), so the final write is
         uncommitted at REVIEWING. Auto-merge ALWAYS runs post-REVIEWING; a null/absent risk defaults to
         L2 -> approval package (finalState REVIEWING), so the two Phase-1 loop-run tests are unaffected.
         (3) FakeAdapter write actionId is now per-attempt unique (`fake-<path>-<attempt>`) — the
         executor dedups by actionId (crash replay), so a task writing the same path across rounds
         (repairable) needs distinct ids; P8 replay-by-requestId still dedups (cached response carries
         the same attempt). (4) Automation guard estimate is `null` in the bin (honest INV-13: no
         operator-calibrated cap -> no percentage), so a live run fail-closes and passes
         `--force-quota-override` after checking `/usage`; the pure `decideAutomationStart` is fully
         unit-tested over both estimate shapes. AUTOMATION_DEFERRED/OVERRIDE + MODEL_OVERRIDE recorded to
         `~/.platform/audit.jsonl` (the trail REQ-18.3 extends). (5) REQ-18.3 loop-side audit mirror
         (approvals/steering/kill/governance) is an injected `auditSink` echoing the authoritative core
         event log; the handlers are unit-tested in `core/human/api.test.ts` and the mirror is a thin
         echo — not driven via HTTP in loop-run.test (would race a fast loop). Console-originated writes
         (hook/retention) were audited in Task 7. (6) `.ai/policies/automation.json` created (was the
         Task-4 `absent` sentinel): changes the real policy snapshot, so the first real run refuses
         `policy_unapproved` until approved once. (7) REQ-16.3: default model = automation.json
         `autonomousModel` (Sonnet) + a logged `--model` per-run override; conformance --live also uses
         the policy default.

## Suggested execution batches

Coupled feature — DEFAULT: run ALL tasks in ONE session (`/spec-implement all` or
`scripts/pane-loop.sh platform-phase2 all-in-one`), dependency order 1→2→3→4→5→6→7→8→9
(6 can interleave after 1; 7-8 after their consoles; 9 last — composition + DoD proof).
No Batch tags: every task is big/foundational or its own domain — each wants focused
context; all-in-one session already captures the shared-cache benefit (multi-session
measured ~30-40% more expensive for coupled work).
