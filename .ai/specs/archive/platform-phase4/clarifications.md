# Clarifications — platform-phase4

> Mode: user-gated. Spec source of truth: `unified-platform-spec.md` v1.3 in-repo
> (§0.1) — the v1.3 amendment (this branch) rescopes Phase 4 before this spec was
> opened, same pattern as v1.2/Phase 3. The four numbered decisions below were
> answered by the USER directly (2026-07-08, plan-mode interview); the plan built
> on them was approved the same day (`feat/platform-phase4`).

## Workflow chosen

Design-First (Design -> Requirements -> Tasks), same as Phases 0–3. Architecture
is fixed by the spec (§9.1 Loop 5, §10.4 learning plane, §7.4 routing/§7.5 fusion
trigger, §10.3 Human Plane, §8 F-Chat row, §13.3 checklist, §14 Phase 4) plus a
VERIFIED carried backlog with known code anchors — the work is transcription onto
the Phase-3 codebase, not architecture discovery.

## Pre-spec state (verified on develop, 2026-07-08)

- Phase 0–3 delivered (Phase 3 = PR #47, follow-ups #48/#49; squash `bbcbf06`
  latest). All 565 tests green at Phase-3 close, 6/6 typecheck.
- Carried Phase-3 backlog recorded at `.ai/specs/platform-phase3/tasks.md:301,306`
  + `docs/calibration/RUNBOOK-phase3.md`:
  1. F-Loop approve has zero production wiring — `approvals` Map always
     `new Map()` (`console/backend/src/loop-run.ts:341`), `runAutoMerge` runs
     before any human step (`loop-run.ts:414`), `buildApprovalPackage`
     (`core/src/human/approval.ts:62`) called only from tests.
  2. Fusion planner-role auto-routing has zero implementing code —
     `loop-run.ts:366` hardcodes `role: 'implementer'`; only the agent-invoked
     `fusion.deliberate` seam is real.
  3. No genuine fusion uplift calibration number — the 3 live Phase-3 activations
     used `plan`/`hypotheses` artifacts (no GateReport to compare on).
- Outcome routing SHADOW exists and is wired (`aal/src/shadow.ts`,
  `wrapRouterForShadow` at `loop-run.ts:107`, `SHADOW_ROUTE` events). ACTIVE mode
  has zero code; router today only removes candidates (`aal/src/router.ts:25`).
- No `.ai/lessons/`, no deploy/rollback code (`core/src/security/canary.ts` is the
  injection tripwire — name collision only), no issue-intake code, Console has no
  router/theme/i18n/responsive/Chat (`console/web/src/App.tsx` renders sections).

## Scope of this spec (§14 Phase 4, v1.3)

- Approval pipeline production wiring (carried #1): populate approvals on
  auto-merge decline, wait for decision (timeout -> ESCALATED), continue
  post-approve to COMPLETED, reject -> CHANGES_REQUESTED
- Canary deploy + automated rollback (Loop 5 §9.1) as per-goal configurable
  commands run by the core executor with core-owned evidence; deploy stage sits
  behind a `production_deployment` approval package (§11.1)
- Issue intake -> Goal Contract (§11.1): local-only store + Console review UI;
  issue text = untrusted data (INV-3); human approve -> draft goal.yaml; never
  auto-starts a run
- Lessons active (§10.4): confirmed hypotheses + evidence -> pending lesson ->
  human approve via existing governance -> injectable, injected as MARKed data
  with canary; separate artifact from the repo's human-curated
  `.ai/shared/LESSONS.md`
- Outcome routing ACTIVE (§10.4): reorder-by-outcome-stats + deterministic
  epsilon-greedy + freeze on drift canary; activation itself is a human
  governance decision fed by a pure `shadowProven()` evaluator (INV-16)
- Planner-role fusion auto-routing (carried #2) per §7.5 policy trigger
  ("planning เสมอ"); CI proves the trigger with fakes, `fusionActive` gates live
- Genuine fusion uplift number (carried #3): live `code_diff`/`tests` activation
  + single-model baseline, reported as an interval (small n, §12)
- Console: F-Chat FULL (SDK `query()` streaming + tool cards + web `canUseTool`
  approvals + fork; mandatory non-parity label) + themes (dark/light) +
  responsive/mobile + i18n TH/EN
- NOT in scope: GLM-5.2 / `adapters/openai-compatible.ts` (still no access —
  deferred again, recorded in v1.3, not silently dropped); GitHub webhook
  intake; cross-restart approval resume (recorded limitation); multi-user
  anything (§1.3)

## User decisions (2026-07-08)

1. **GLM-5.2: still no access — CUT from Phase 4.** Deferral re-recorded in the
   v1.3 changelog (conditional-on-access, same wording discipline as v1.2);
   §7.4's stale "returns in Phase 4" cells corrected. Test Designer / Reviewer
   role defaults stay Claude + Codex.
2. **Carried backlog: ALL THREE folded into Phase 4** (recommended option) —
   one spec, one PR train; approval wiring is a hard prerequisite for the
   canary-deploy approval path (§11.1) and for the second-device DoD item
   Phase 3 could not test.
3. **F-Chat: IN, full scope** — streaming + tool cards + web `canUseTool`
   approvals + fork, with the mandatory non-parity banner.
4. **Console polish: FULL per spec** — themes + responsive/mobile + i18n TH/EN
   (complete translation, not scaffold-only).

## Defaults accepted without objection (recorded in the approved plan)

- **Issue intake is local-only this phase** (Console form + files under
  `.ai/issues/`); GitHub webhook = unauthenticated remote ingress, conflicts
  with §13.3 — future phase if ever.
- **Claim discipline wording (§16):** DoD says "uplift interval recorded" and
  "activation mechanics proven", never "uplift proven" — live budget (~2x
  task-13 fusion spend) yields n too small to prove uplift.
- **Cut line pre-declared** if squeezed: F-Chat fork -> i18n depth -> planner
  auto-routing (recorded descope, never silent slippage).
- **Spec-first PR** to `develop` (precedent PR #45); implementation PRs follow
  in later sessions.

## Assumptions (decided here, recorded — reversible)

- **B1 Branch/PR:** work lands on `feat/platform-phase4` off `develop` (branch
  carries the v1.3 amendment + this spec), PR back to `develop`.
- **B2 Live quota policy carried forward:** dev/test/CI run against fake
  adapters only; LIVE runs are manual-trigger with costUnits caps, never CI;
  live replay/cache is per-run and never committed (Phase-1 lesson).
- **B3 One live task per phase:** exactly one live/manual task, last, never CI
  (Phase-1 task-11 / Phase-3 task-13 precedent), driven through a real iTerm2
  TTY pane (Bash tool has no TTY — Phase-3 technique).
- **B4 Deploy is command-level simulation:** "canary deploy" operates on target
  repos via contract-declared commands; it is NOT a real production rollout and
  every surface labels it honestly (§16 claim discipline).
- **B5 Epsilon-greedy must be replayable:** deterministic hash-based exploration
  (the `auditSampleValue` pattern), epsilon pinned in governance-hashed
  `routing.json` — no `Math.random` in the routing path.
- **B6 F-Chat vs INV-17:** §15 item 3 sanctions `query()` + `canUseTool` for the
  SDK enhanced view explicitly ("ไม่ใช่ interactive parity path"); the
  "interactive approval = CLI-native" rule is scoped to F-Term. design.md quotes
  both lines to prevent drift.
- **B7 DoD (v1.3 §14):** see the new Phase-4 DoD line in the spec — approval
  package from a real run approved from a second device continues to COMPLETED;
  fault-injection covers canary-fail->rollback, rollback-fail->ESCALATED,
  unapproved-lesson-never-injected, drift-freeze, injected-issue-needs-human;
  uplift interval + shadow numbers into calibration; §13.3 sweep over new
  endpoints; F-Chat labeled; Console passes mobile viewports + TH/EN toggle.
