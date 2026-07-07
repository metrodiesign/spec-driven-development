# Implementation Tasks: Autonomous Engineering Platform — Phase 2 (Semi-autonomous + Survivability + Console Extensions)

> Status: approved 2026-07-07 (human gate)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.
> Upstream: design.md + requirements.md both approved 2026-07-07 (AZ-1..AZ-20 applied).
> RED-first per area (§0.4); all CI on FakeAdapter; live runs manual only.

- [ ] 1. AAL survivability: breaker + quota-aware routing + degraded source — `aal/src/breaker.ts`
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

- [ ] 2. Hypothesis-driven repair — `.ai/schemas/hypothesis` + `core/src/repair/hypothesis.ts`
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

- [ ] 3. State machine + auto-merge L0–L1 + sampling audit — `machine.ts` (`auto_approved:
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

- [ ] 4. Meta-governance — `core/src/governance/policy.ts` (policy snapshot hash vs last
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

- [ ] 5. Steering + loop operability — `LoopControl` port polled at iteration boundaries,
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

- [ ] 6. Security plane completions — canary tripwire helper + source check post-repair
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

- [ ] 7. Console governance surfaces (F-MCP, F-Hook, F-Sub, F-Skill, F-Sys) + audit extension —
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

- [ ] 8. F-Term repaint nudge + transcript glob fallback (carried backlog #3 #4) — `PtyLike.resize`
     + `TermManager.resize(ptyId,cols,rows)` with per-session dims, WS attach double-resize
     nudge (rows−1→rows) after ring replay (signal-only, byte-prefix invariant), anthropic
     transcript capture glob `~/.claude/projects/*/<sessionId>.jsonl` on predicted-path miss →
     structured null when both miss. Done = nudge + fallback unit tests green; manual re-attach
     check recorded.
     Satisfies: REQ-17 (all).
     Verify: pnpm -r test (console/backend + adapters).

- [ ] 9. Automation guards + composition preflight + CI E2E DoD proof — `console/backend/src/
     guards.ts` pure `decideAutomationStart` ({fiveHourPct,weeklyPct}|null; max ≥ threshold
     default 85% → defer with tripping-window reset as `until`; null → fail-closed
     `estimate_unavailable`; `--force-quota-override` bypasses refusal only + `AUTOMATION_
     OVERRIDE`; Sonnet default from `.ai/policies/automation.json`), bin/platform wiring order
     governance preflight → automation guard → adapter construction, fixture ships
     `auditSampleRate:100` + seeded `decidedBy:'ci-fixture'` snapshot, CI E2E: one L1 task to
     COMPLETED (auto-merge + sampled audit) with FakeAdapter on macOS runner, live guards
     unchanged (CI/non-TTY refuse; manual + budget cap). Done = E2E green in CI; guard unit
     tests incl. null-estimate and override paths.
     Satisfies: REQ-16 (all), REQ-18.2, REQ-18.4-18.5. Depends on: 1-8.
     Verify: pnpm -r test; scripts/spec-trace.sh platform-phase2; CI workflow green on both jobs.

## Suggested execution batches

Coupled feature — DEFAULT: run ALL tasks in ONE session (`/spec-implement all` or
`scripts/pane-loop.sh platform-phase2 all-in-one`), dependency order 1→2→3→4→5→6→7→8→9
(6 can interleave after 1; 7-8 after their consoles; 9 last — composition + DoD proof).
No Batch tags: every task is big/foundational or its own domain — each wants focused
context; all-in-one session already captures the shared-cache benefit (multi-session
measured ~30-40% more expensive for coupled work).
