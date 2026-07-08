# Implementation Tasks: platform-phase4 — Continuous + Polish (Approval E2E + Deploy + Intake + Learning + Fusion gaps + F-Chat + Console polish)

> Status: approved 2026-07-08 (12 tasks — spec-trace 126/126 green)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.
> All CI tasks prove with fakes only (FakeAdapter + scripted queryFn + fixture
> repos with forced exit codes) — zero quota.
> Task 12 is the only live/manual task and never runs in CI.

- [ ] 1. Approval pipeline E2E — extract `runApprovedMerge` from `runAutoMerge` (shared merge/audit engine, AUTO_APPROVED event stays auto-only), wire `buildApprovalPackage` into `runSupervisedLoop` on an approval_package decision (core-computed diff/evidence inputs, shared `approvals` Map, APPROVAL_PACKAGE_CREATED), add deferred-promise `awaitDecision` (timeout default 30 min → escalate `approval_timeout` before log.close; kill ends wait), approve → APPROVED → `runApprovedMerge` → COMPLETED, reject → CHANGES_REQUESTED terminal. Done = the Phase-3 carried gap #1 is closed: a real run's decline produces a decidable package and both decision paths + timeout are event-proven with fakes.
     Satisfies: REQ-1, REQ-2, REQ-3. Verify: `pnpm -C core test && pnpm -C console/backend test && pnpm -r typecheck`.

- [ ] 2. Deploy contract + Loop 5 engine — optional `deploy:` section in `freezeContract` (commands + observe bounds `probes >= 1`, `failure_threshold < probes`; no network knob; hash-covered), new `core/src/deploy/stage.ts` with DEPLOY_STATE machine (CANARY → OBSERVING → EXPANDED | ROLLING_BACK → ROLLED_BACK | ESCALATED), every command through the executor at `network:'none'` with evidence, canary/expand non-zero → rollback path (root cause `canary_failed`/`expand_failed`), rollback non-zero → ESCALATED `rollback_failed`, root-cause payload with probe refs, simulation labeling. Done = fault-injection fixtures force every path (observe-fail → rollback; rollback-fail → escalate; expand-fail → rollback) and the task state machine table is untouched.
     Satisfies: REQ-4, REQ-5. Verify: `pnpm -C core test && pnpm -r typecheck`.

- [ ] 3. Deploy approval + Human Plane surface + F-Loop card — deploy approval package built ALWAYS when `deploy:` present (L4 attestations, id `deploy-<taskId>`, never the task Map / never `onDecision` — regression test), Human Plane routes GET /deploy (501 | null-fields | {state, approval}), POST /deploy/decision (attestation-complete, 400/404 guards), POST /deploy/rollback (EXPANDED-only, 409 otherwise), decision timeout → recorded skip, server stays open through stage + `expandedWindowMs` (default 10 min) → DEPLOY_WINDOW_CLOSED, all audited; F-Loop deploy card (state + probe summary + pending approval + manual rollback at EXPANDED + simulation label, hidden when unconfigured).
     Satisfies: REQ-6, REQ-7. Depends on: 1, 2. Verify: `pnpm -C core test && pnpm -C console/backend test && pnpm -C console/web test && pnpm -r typecheck`.

- [ ] 4. Issue intake — `.ai/issues/` store (deterministic ids, status open|converted|rejected), POST/GET /api/issues (size caps → 413), POST /api/issues/{id}/convert (human-only path → draft goal.yaml with empty-AC scaffold + HUMAN header + §11.1 budget defaults, 409 non-open), POST /api/issues/{id}/reject (409 non-open), never starts a run, behind existing auth/rate-limit/audit; web Issues section rendering body as plain text + untrusted-data banner; test proving an unedited draft is refused by `freezeContract`.
     Satisfies: REQ-8, REQ-9. Depends on: 2. Verify: `pnpm -C console/backend test && pnpm -C console/web test && pnpm -r typecheck`.

- [ ] 5. Lessons pipeline — `core/src/lessons/` (LessonRecord, idempotent ids, post-run fold over confirmed hypothesis verdicts → pending/ + LESSON_PROPOSED + `lesson_promote` governance proposal carrying lessonId), GovernanceKind + records extension, `promoteLesson` callback moving pending/ → approved/ + LESSON_APPROVED, offline-approval reconciler in `loadApprovedLessons` (deferred-quarantine pattern), injection through `buildContext` (SEED→GOVERN→MARK: secret-bearing lesson BLOCKED, injected lessons MARKed + canaried, caps 5/8192 defaults, LESSON_INJECTED events), pending/rejected structurally unloadable, corrupt file skipped + ERROR.
     Satisfies: REQ-10, REQ-11, REQ-12. Depends on: 1. Verify: `pnpm -C core test && pnpm -C aal test && pnpm -r typecheck`.

- [ ] 6. Outcome routing ACTIVE — relocate `computeShadowOutcomeStats` into `aal/src/shadow.ts` (exported; composition imports), `shadowProven` built on `compareShadow` + relocated stats (criteria from routing.json), `outcomeRouting {mode, epsilon, minSamples, minDivergences}` block parsing + governance re-approval test, `wrapRouterForOutcome` (reorder by reviewing-reached rate, zero-attempt adapters keep position, deterministic hash epsilon with precedence frozen > insufficient_data > reorder > epsilon, eligible ≥ 2, OUTCOME_ROUTE + ROUTING_FROZEN events, hint filters still only remove), composition mode wiring (off | shadow | active with recorder outermost).
     Satisfies: REQ-13, REQ-14, REQ-15. Verify: `pnpm -C aal test && pnpm -C console/backend test && pnpm -r typecheck`.

- [ ] 7. Planner fusion auto-routing — `triggers.plannerRole` in fusion-profiles.json, `runPlannerFusion` composition step before the task loop (same router instance as the task loop, panel input pinned to frozen goal + ACs, `plan` profile), new `.ai/schemas/plan.schema.json` + structural validation of the resolved plan, evidence + `PLAN_RESOLVED` event, plan into task context as MARKed data; CI proves the trigger contract with fakes (dispatch iff flag+option; never when `fusionActive` false; both offs proven).
     Satisfies: REQ-16. Depends on: 6. Verify: `pnpm -C console/backend test && pnpm -C aal test && pnpm -r typecheck`.

- [ ] 8. F-Chat E2E — `console/backend/src/chat.ts` (POST /api/chat/sessions {projectDir, resume?, fork?} → single-use TTL ticket, WS stream, injected `queryFn` — CI uses a scripted fake, SDK dep pinned to adapters' version), canUseTool bridge (approval_request cards, timeout/WS-drop → deny fail-closed, every decision audited), stream error → error card + close + audit (no retry), bad ticket → 4403, behind auth/rate-limit/audit; `console/web/src/Chat.tsx` (stream + tool cards + approve/deny + permanent NON-PARITY banner + quota estimate line).
     Satisfies: REQ-17, REQ-18, REQ-19. Verify: `pnpm -C console/backend test && pnpm -C console/web test && pnpm -r typecheck`.

- [ ] 9. Themes + responsive — `styles.css` CSS custom properties (`:root` light + `[data-theme="dark"]`), prefers-color-scheme default + persisted toggle stamping `data-theme` (wins both directions), migrate hardcoded colors to `var()` (layout untouched), AA contrast both themes; `@media (max-width: 768px)` nav collapse + single-column cards + `overflow-x:auto` table wrappers + tappable controls.
     Satisfies: REQ-20, REQ-21. Depends on: 8. Batch: 10. Verify: `pnpm -C console/web test && pnpm -r typecheck && pnpm -r build`.

- [ ] 10. i18n TH/EN — dependency-free `logic/i18n.ts` (typed dict, TH completeness enforced at typecheck, React context + hook, persisted toggle), sweep ALL page chrome through `t()` (Phase-4 pages included), backend-authored strings verbatim (events, CLI output, quota label).
     Satisfies: REQ-22. Depends on: 8, 9. Batch: 9. Verify: `pnpm -C console/web test && pnpm -r typecheck && pnpm -r build`.

- [ ] 11. §13.3 sweep + calibration wiring — hardening tests over every new endpoint (issues/chat/deploy: auth, rate-limit, audit, redaction, fail-closed non-loopback, no token exposure, WS single-use 4403 semantics), calibration output gains lesson injection count + hit-rate PROXY (injected tasks reaching REVIEWING ÷ injected tasks, labeled), `shadowProven` snapshot, fusion-uplift interval slot (empty-but-labeled until the live pass); run `scripts/spec-trace.sh platform-phase4` and reconcile any uncovered criteria.
     Satisfies: REQ-23, REQ-24. Depends on: 1, 2, 3, 4, 5, 6, 7, 8. Verify: `pnpm -r test && pnpm -r typecheck && pnpm lint && pnpm vendor-check`.

- [ ] 12. LIVE pass (manual — never CI; Phase-3 task-13 analog) — through a real iTerm TTY pane: fusion uplift interval from ≥1 `code_diff`/`tests` activation + single-model baseline on the same corpus task (~2x task-13 fusion spend, hard-capped) recorded in `docs/calibration/`; F-Loop approve of a real package from a second physical device over tailnet → pipeline continues to COMPLETED (+ a reject → CHANGES_REQUESTED pass); live canary deploy on a fixture target incl. one forced observe-failure → real rollback + root cause; live lesson propose → approve → inject (marked in built context); `shadowProven` evaluated on the accumulated real log with the activation decision recorded honestly (insufficient n = recorded gap); F-Chat live smoke (stream + one canUseTool approval); run-by-run RUNBOOK-phase4.md.
     Satisfies: REQ-25. Depends on: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11. Verify: `docs/calibration/RUNBOOK-phase4.md` evidence (not a pnpm command).

## Suggested execution batches

Dependency order: 1 → 2 → 3; 4 after 2; 5 after 1; 6 → 7; 8 standalone; 9+10
after 8 (batchable — same area, same type); 11 after all CI tasks; 12 last,
live, manual-only.

- Batch A (platform spine, one session): 1, 2, 3 — the approval + deploy chain
  shares loop-run composition state; splitting risks merge friction in one file.
- Batch B (independent CI slices, parallel-safe across sessions): 4, 5, 6+7, 8.
- Batch C (web polish, one session): 9, 10.
- Batch D (closure): 11 (sweep + trace), then 12 (LIVE, separate sitting, real
  TTY + second device + quota budget).
