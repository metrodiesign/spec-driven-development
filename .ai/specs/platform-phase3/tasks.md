# Implementation Tasks: platform-phase3 — Multi-model + Fusion + Merge Queue/T2 + Auditor + F-Loop/F-Sched + Remote Auth

> Status: approved 2026-07-08 (13 tasks — spec-trace 142/142 green)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.
> All CI tasks prove with fakes only (FakeAdapter + fake ExecFn) — zero quota.
> Task 13 is the only live/manual task and never runs in CI.

- [x] 1. Multi-lineage AAL substrate — lineage on CapabilityManifest/RegisteredAdapter (+ FakeAdapter option), `reviewer` Role + roleRequires case, `Registry.all()`, RouteHints (maxSusceptibility + excludeLineages, hard rule wired from composition), source routeHints, `.ai/policies/routing.json` (+ sched.scriptAllowlist shape) + POLICY_FILES append with governance-refusal test, token bucket + bounded dispatcher. Done = Phase-2 router behavior byte-identical without hints; all new filters/buckets unit-proven.
     Satisfies: REQ-4, REQ-5, REQ-6, REQ-8.2, REQ-8.3. Verify: `pnpm -C aal test && pnpm -C core test && pnpm -r typecheck`.
     Evidence:
       - test: `pnpm -C aal test` -> 63 passed / 0 failed · `pnpm -C core test` -> 145 passed / 0 failed · `pnpm -C adapters test` -> 16 passed / 0 failed
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues · `pnpm vendor-check` -> OK (core+aal vendor-name-free, INV-7)
       - viewports: n/a — logic-only
       - deviations: lineage vendor VALUES ('openai' etc.) originate in Ring 2 (task 2 codex.ts); aal source/tests use neutral tags ('familyA/B') to keep INV-7 vendor-check green. REQ-5.5 hard-rule + REQ-5.6 file-piece gate proven at the source seam via a fake routeHints (loop-run wiring of test_designer is a later task — workstream B modifies source.ts, not loop-run.ts).
- [x] 2. Codex adapter lane — extract `adapters/src/wire.ts` (anthropic tests stay green untouched), `codex.ts` with ExecFn seam + replay + usage(+reasoning tokens) + events-as-transcript + killTimeoutMs(600000) + no healthProbe, `codex-live.ts` argv builder (SPIKE-6 flags, stdin ignored — argv snapshot test, no real spawn), `_template.ts` skeleton, conformance P1-P8 green on compliant fake ExecFn + prose-only sabotage fails exactly P2.
     Satisfies: REQ-1, REQ-2, REQ-3. Depends on: 1. Verify: `pnpm -C adapters test && pnpm -C aal test`.
     Evidence:
       - test: `pnpm -C adapters test` -> 37 passed / 0 failed (was 16; +21: wire REQ-1, codex REQ-2, conformance+template REQ-3) · `pnpm -C aal test` -> 63 passed / 0 failed
       - wire extraction behavior-preserving: pre-existing anthropic.test.ts (16 tests) stayed green UNMODIFIED (REQ-1.2); codex conformance P1-P8 green on compliant fake ExecFn, prose-only fails EXACTLY P2 (REQ-3.1/3.2)
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 clean · `pnpm lint` -> 0 issues · `pnpm vendor-check` -> OK (codex 'openai' lineage is Ring 2 adapters/, not scanned)
       - viewports: n/a — logic-only
       - deviations: live `codex exec` spawn in codex-live.ts is not CI-tested (mirrors anthropic live.ts; verified in the LIVE task 13) — the pure argv builder + parseCodexEvents/sumCodexUsage ARE unit-tested. killTimeoutMs lives in CodexAdapterOptions but is consumed by codex-live.ts (the Omit<...,'exec'> variant), not createCodexAdapter.
- [x] 3. Fusion plane — `fusion-profiles.json` (+ estimateCostUnitsPerCandidate required) + load validation, `deliberation-analysis.schema.json`, panel fan-out via dispatcher (seed/lineage diversity, distinct requestIds), CandidateEvidenceRunner port + composition impl in loop-run, blind judge as reviewer + bounded repair + fallback partitions (incl. hypotheses mechanical branch), resolve rules (gate-first tournament, no synthesis, unions, equal-weight reviews + dissent), panel_degraded + budget pre-checks + per-task depth counter at the REQUEST_TOOL handler, FUSION_* events.
     Satisfies: REQ-8.1, REQ-8.4, REQ-8.5, REQ-9, REQ-10. Depends on: 1, 2. Verify: `pnpm -C aal test && pnpm -C core test && pnpm -C console/backend test`.
     Evidence:
       - test: `pnpm -C aal test` -> 89 passed / 0 failed (was 63; +26 fusion: profiles 9 REQ-8.1/8.4/8.5, resolve 8 REQ-10.1..10.6, run 9 REQ-9.1/9.6/9.7/9.8/10.7/10.8) · `pnpm -C core test` -> 151 passed / 0 failed (FUSION_* EventTypes + toolHandlers seam, no regression) · `pnpm -C console/backend test` -> 109 passed / 0 failed (+4: gate-in-isolated-worktree REQ-9.2, depth_exceeded REQ-10.9 via executor seam, CI-off gate REQ-10.10)
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 clean · `pnpm lint` -> 0 issues · `pnpm vendor-check` -> OK (core+aal vendor-name-free; fusion module + tests use neutral 'familyA/familyB' lineage tags, INV-7)
       - viewports: n/a — logic-only
       - deviations: (1) fusion module lives at `aal/src/fusion/` not `aal/fusion/` — inside the aal package tsconfig include + `node --test` glob, matching the existing `aal/src/` layout. (2) The `REQUEST_TOOL fusion.deliberate` handler is an ADDITIVE `toolHandlers` seam on the core executor (INV-8 forbids Ring 0 importing aal/runFusion); the depth<=1 counter + the CandidateEvidenceRunner impl (real T1 gate in a per-candidate detached git worktree) live in `console/backend/src/fusion.ts` (the composition layer), and loop-run forwards the seam. Auto-routing of LIVE planner proposals through runFusion is the live-only trigger exercised in task 13 (`fusionActive` requires a confirmed live run, so CI structurally never fuses, REQ-10.10) — CI proves the port, all resolve rules, the pipeline, the real evidence runner, the depth counter, and the CI-off gate with fakes only. (3) anthropic adapter gained `lineage:'anthropic'` (Ring 2, vendor name legal) so the shipped cross_lineage profiles anchor two real lineages live (task 2 added only codex 'openai'). (4) plan `deliberate_synthesis` = deterministic first-candidate pick (no REQ-10 criterion pins plan resolve; chimera ban generalized, no silent merge) — true cross-candidate plan synthesis deferred to Phase-4 calibration.
- [x] 4. Fusion calibration + corpus scaffolding — `computeFusionCalibration` (uplift + interval, decorrelation, zero-n guard) in core/calibration, calibration corpus structure under `.ai/calibration/` for 10-task minimum (answer-key + hidden-golden layout, harness runnable with FakeAdapter, numbers labeled fixture until task 13).
     Satisfies: REQ-11. Depends on: 3. Verify: `pnpm -C core test`.
     Evidence:
       - test: `pnpm -C core test` -> 151 passed / 0 failed (+6: computeFusionCalibration REQ-11.1 uplift+interval, REQ-11.2 decorrelation-as-measurement, REQ-11.3 zero-n guard; corpus loader loads the shipped >=10-task fixture with intact golden hashes + composes loader+MATH into a runnable harness)
       - typecheck: `pnpm -C core typecheck` -> clean (part of the 6/6 above)
       - viewports: n/a — logic-only
       - deviations: corpus lives under `.ai/calibration/corpus/` (a NEW subdir — `.ai/calibration/` already holds live conformance records + evidence/replay from task 11). Layout physically separates MODEL-VISIBLE task specs (`corpus/tasks/<id>.json`: objective + budget) from HELD-OUT answer-key + hidden golden (`corpus/answers/<id>.json`), so a candidate is scored against evidence it never saw; the loader verifies golden sha256 integrity. `numbersAreFixture:true` until task 13. The full FakeAdapter pipeline run of the corpus is a live/composition path (cross-package); the core harness proves loader + golden integrity + calibration MATH with scripted fixture numbers.
- [x] 5. T2 tier + merge queue — gate-ladder t2 real-config parsing ({status} stays not_enabled; governance-coupled hash change test), `core/src/merge/queue.ts` (lease serialization, worktree hard-reset+clean per candidate, merge --no-ff + T2 on merged tree, t1_only labeling when T2 not_enabled, conflict/rejected_t2 paths + events), auto-merge queue path with in-band audit/revert unchanged, export `reproduces()`.
     Satisfies: REQ-12, REQ-13. Verify: `pnpm -C core test`.
     Evidence:
       - test: `pnpm -C core test` -> 164 passed / 0 failed (was 151; +13: 5 T2-tier in runner.test.ts REQ-12.1/12.2/12.3/12.4, 6 queue.test.ts REQ-13.1/13.2/13.3/13.5/13.7/13.9/13.10, 2 auto-merge.test.ts queue-integration REQ-13.4/13.6)
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues · `pnpm vendor-check` -> OK (core+aal vendor-name-free, INV-7)
       - viewports: n/a — logic-only
       - deviations: (1) `MergeQueueOptions` adds `runId`/`worktreeDir` (the design sketch omits both, but `EventLog.append` always needs a runId and the queue's own git ops need an explicit integration-worktree path — every sibling core module follows the same explicit-runId convention) and drops `evidence`/`clock` (unused — the queue's own MERGE_ENQUEUED/MERGE_RESULT events need no blob storage, and EventLog already owns its clock; T2 evidence stays inside GateReport via the pre-bound GateRunner). (2) The integration worktree's initial `git worktree add` is a one-time setup precondition (asserted, not auto-created by the queue) — `process()` only hard-resets+cleans an existing one (REQ-13.10); who creates it once is a composition concern for a later task, same posture as task 3 deferring loop-run wiring. (3) Lease contention (REQ-13.1) is proven as an immediate throw on a failed claim, not a wait/retry loop — the existing `LeaseManager.claim` is a synchronous CAS with no backoff primitive, and this repo's orchestration processes one task through REVIEWING at a time, so the lease is a defensive single-writer invariant (fail-fast, caller may retry later) rather than a real contention point today. (4) REQ-13.8 (tier label on approval-package evidence) needs no new code — `GateReport.tier` already carries this; approval-package composition is outside core's scope for this task.
- [x] 6. Out-of-band auditor — `core/src/audit/oob.ts` (salted independent sampling, alreadyAudited covers in-band + prior OOB, per-target clone in temp dir, retry-then-skip on lock, flaky_suspect vs non_repro verdicts, detection-only) + `platform auditor run` bin subcommand (own EventLog handle) + fault-injection proof: planted non-repro COMPLETED gets caught.
     Satisfies: REQ-14. Depends on: 5. Verify: `pnpm -C core test && pnpm -C console/backend test`.
     Evidence:
       - test: `pnpm -C core test` -> 171 passed / 0 failed (was 164; +7 oob.test.ts: 4 pure selectAuditTargets REQ-14.1/14.2, +3 orchestration — honest reproduced (+idempotent 2nd cycle REQ-14.2), fault-injection non_repro+ESCALATED REQ-14.9/14.6, one-time-flake flaky_suspect REQ-14.4/14.5) · `pnpm -C console/backend test` -> 116 passed / 0 failed (was 109; +7 auditor-cli.test.ts: usage error, no-targets exit 0, finds+reproduced, --rate override, --db/--repo override, invalid --rate, non_repro exit 2)
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues · `pnpm vendor-check` -> OK (core+aal vendor-name-free, INV-7)
       - spec-trace: `bash scripts/spec-trace.sh platform-phase3` -> OK, 142/142 EARS criteria covered in design.md + tasks.md
       - viewports: n/a — logic-only
       - deviations: (1) `selectAuditTargets` derives each target's `mergeCommit`/`runId` from that task's `AUDIT_RESULT` event (the one reliable taskId->mergeCommit source today, populated by every runAutoMerge path whether queue-routed or not) rather than a dedicated field the design sketch doesn't name — `alreadyAudited` is computed by an internal (unexported) helper from the same events, matching the design's exact `selectAuditTargets(events, sampleRate, alreadyAudited)` signature. (2) Re-run scope is T1 only (not "T1(+T2)" from the sequence diagram) — `reproduces()` semantics are proven exactly at the T1 level already; T2 is still `not_enabled` in the committed ladder today, so a T2 re-run would be a trivial no-op, and adding a second, currently-untested combined-verdict axis isn't needed for REQ-14's ACs. (3) The bin surface makes `--db`/`--repo` REQUIRED (clear usage error if omitted) rather than inventing a default — each loop run currently gets its own throwaway `events.db`/repo (no central multi-run store exists yet in this phase), so a silently-wrong default would be worse than an explicit prompt; `--rate` defaults to the governed `automation.json` `auditSampleRate` (25) unless overridden. (4) `platform auditor run`'s evidence dir defaults to `~/.platform/oob-evidence/`, matching the existing `~/.platform/` convention for out-of-repo runtime state (audit.jsonl, console-auth.json).
- [x] 7. Shadow routing — `aal/src/shadow.ts` (shadowWouldChoose, shadowFrozen over registry.all(), compareShadow), SHADOW_ROUTE recording from loop composition, freeze-on-stale, never-blocks/never-influences properties (route identical with and without recorder).
     Satisfies: REQ-7. Depends on: 1. Verify: `pnpm -C aal test && pnpm -C console/backend test`.
     Evidence:
       - test: `pnpm -C aal test` -> 99 passed / 0 failed (was 89; +10 shadow.test.ts: 5 shadowWouldChoose REQ-7.2 determinism/tie-break/insufficient_data, 2 shadowFrozen REQ-7.3, 3 compareShadow REQ-7.6) · `pnpm -C core test` -> 171 passed / 0 failed (additive SHADOW_ROUTE EventType, no regression) · `pnpm -C console/backend test` -> 122 passed / 0 failed (was 116; +6 loop-run.test.ts: never-influences REQ-7.4, recorded-choice shape REQ-7.1/7.2, freeze-on-stale REQ-7.3, append-failure-continues REQ-7.5, empty-eligible no-op, cross-task divergence REQ-7.2) · `pnpm -C adapters test` -> 37 passed / 0 failed (unaffected)
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues · `pnpm vendor-check` -> OK (core+aal vendor-name-free, INV-7)
       - spec-trace: `bash scripts/spec-trace.sh platform-phase3` -> OK, 142/142 EARS criteria covered
       - viewports: n/a — logic-only
       - deviations: (1) Outcome-stats computation (`computeShadowOutcomeStats`) lives in the composition root (`loop-run.ts`), not in `aal/` — `shadow.ts` stays pure and log-agnostic (matches breaker.ts's documented convention: "aal stays log-agnostic like the rest of Ring 1"); it replays each prior `SHADOW_ROUTE` + `TASK_STATE` from the SAME shared log, so stats sharpen as a log accumulates across many tasks (e.g. the calibration corpus) and a task still in flight simply contributes 0 to its own round (its outcome isn't known yet — proven by the dedicated cross-task divergence test, not the single-adapter E2E fixture). (2) The recorder wraps only `Router.eligibleAdapters` — the one method the main proposal flow (`source.ts`) actually calls each round to pick its live choice (`eligible[0]`); fusion's separate `router.route('reviewer')` call for the blind judge (REQ-9/10) is outside REQ-7's "a supervised loop" scope and stays unwrapped. (3) When frozen (any adapter stale), the recorder skips the `SHADOW_ROUTE` append entirely rather than appending `frozen:true` — matches the design's literal `{..., frozen:false}` example (an event is only ever appended when NOT frozen) and reads "freeze shadow recording" as pausing the recording itself. (4) `wrapRouterForShadow` is exported from `loop-run.ts` (no new console/backend file) since the design's file-mapping table names only `aal/src/shadow.ts` for REQ-7; keeping the wrapper co-located with the composition root it modifies made it directly unit-testable via fakes (Router/Registry/EventLog stubs) for freeze/append-failure/never-influences scenarios the single-adapter loop-run fixture cannot reach on its own.
- [x] 8. F-Loop + inject-without-pause — `loop-proxy.ts` (discoverRuns + loopFetch, token never leaves backend), loop routes (runs/approvals/events/steering/kill proxy, 502/409 paths, ended = absent-or-tombstoned + loop-run tombstone on exit), audit entries incl. local-operator principal, `core/human/api.ts` atNextBoundary queueing + loop boundary drain, web `Loop.tsx` + `logic/loop.ts` (package render + attestations + controls).
     Satisfies: REQ-15, REQ-17. Verify: `pnpm -C core test && pnpm -C console/backend test && pnpm -C console/web test`.
     Evidence:
       - test: `pnpm -r test` -> 479 passed / 0 failed (core 174 [+3 REQ-17 atNextBoundary], aal 99, adapters 37,
         console/backend 142 [+20: 9 loop-proxy.test.ts REQ-15.1/15.2/15.3/15.5/15.6/15.9, 11 app-loop.test.ts
         REQ-15.1/15.2/15.3/15.4/15.5/15.6/15.8/15.10 + loop-run.test.ts AZ-4 tombstone assertion updated],
         console/web 27 [+12 logic/loop.test.ts REQ-15.7])
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues · `pnpm vendor-check` -> OK (core+aal vendor-name-free, INV-7)
       - spec-trace: `bash scripts/spec-trace.sh platform-phase3` -> OK, 142/142 EARS criteria covered
       - viewports: 375 OK (clientWidth 375, mobile-emulate) | 768 OK (clientWidth 768) | 1440 OK (clientWidth 1440) —
         all three `scrollWidth === clientWidth` (no h-overflow); served the vite prod build via `buildApp` on
         127.0.0.1:9191 with a seeded live run (real `createHumanPlaneServer`) + an ended run; chrome-devtools MCP.
         Interactive proof at 1440: selected RUN-VERIFY -> state badge "IMPLEMENTING" -> ticked both attestation
         checkboxes (Approve stayed disabled at 1/2, enabled at 2/2, mirrors `canApprove`) -> clicked Approve ->
         proxied through to the real Human Plane server (`[decision] T-1 approve` in the server log) -> console
         audit fired `{event:'loop_approval',run:'RUN-VERIFY',approvalId:'A-1',principal:'local-operator',
         method:'none'}` (REQ-15.4/15.10) -> next poll (since=) showed the package gone ("none pending").
       - deviations: (1) console-side F-Loop audit entries use field name `event` (not the literal word "kind"
         from REQ-15.4's prose) — matches the pre-existing convention already used by this same file's F-Hook/
         F-Sys audit calls and by loop-run.ts's own audit mirror, so the shared `~/.platform/audit.jsonl` stream
         stays one shape; values are prefixed `loop_*` (`loop_approval`, `loop_steer_pause/inject/resume`,
         `loop_kill`) to stay distinguishable from an upstream run's OWN audit entries when both land in the same
         file. (2) `LoopRunRef` carries `token` internally (the design sketch's interface omits it) — `loopFetch`
         needs it to inject the Bearer header; `GET /api/loop/runs` only ever returns `{runId,ended}`, proven by
         an explicit "token never appears in the response body" test. (3) REQ-15.8 since-pagination is proxy-side:
         core's `/events` route is unchanged (design lists ONLY the inject change for `core/human/api.ts`) — the
         proxy fetches the full redacted log and slices by `PlatformEvent.seq > since`. (4) Ended-run 409 applies
         to every `:run`-scoped route, GET included, not only mutations — REQ-15.6 names mutations explicitly but
         a GET has equally nothing to proxy to (no url/token); the list route is the only one that lists ended
         runs instead of erroring. (5) REQ-17.4 (AC/scope-touching guidance needs a governance contract amendment)
         needed no new code — design.md marks it "(unchanged rule)"; same posture as task 5/6's no-new-code
         deviations for a procedural, non-mechanical AC. (6) `runSupervisedLoop`'s `onInject` mode propagation
         (`opts.atNextBoundary ? 'next_boundary' : 'immediate'`) has no dedicated E2E test — the loop's Human
         Plane server has no external seam to reach mid-run without refactoring a working composition root for a
         one-line, obviously-correct pass-through; the GATING contract it depends on is fully proven in core's
         `api.test.ts` (3 new tests), and the full `loop-run.test.ts` suite (11 tests) stays green with the wider
         signature wired through. (7) Kill has no state gate server-side (unlike pause/resume/inject) — `Loop.tsx`
         disables it on `ended` alone, not `steeringControls()`, matching the Human Plane API's actual `/kill`
         contract (no `STEERABLE` check there). (8) F-Loop routes register only when `AppDeps.loopRunsRoot` is
         set (mirrors `termManager`'s optional-registration pattern) — every other test file's `AppDeps` helper
         is unaffected; `platform console` now always passes `~/.ai/runs` for it. (9) `platform console` also
         wires `deps.audit: auditAppend` for the first time (design.md: "today the console path leaves it
         unwired") — this retroactively activates the pre-existing F-Hook/F-Sys audit call sites in `app.ts`,
         in scope per workstream E's own description, not overreach.
- [x] 9. F-Sched + F-MCP Authenticate — `sched.ts` (decideSchedStart, exact-match allowlist from governed routing.json, no modify route), sched routes (start two-step confirm + per-source rate limit, stop SIGTERM, status exit codes, audit entries), web `Sched.tsx` + `logic/sched.ts`; F-MCP Authenticate deep link to claude-only F-Term `claude mcp` (no token endpoints; disabled+hint when request is remote).
     Satisfies: REQ-16, REQ-18. Depends on: 8. Verify: `pnpm -C console/backend test && pnpm -C console/web test`.
     Evidence:
       - test: `pnpm -r test` -> 509 passed / 0 failed (core 174, aal 99, adapters 37, console/backend 167
         [+25: 11 sched.test.ts — decideSchedStart running/quota_threshold/estimate_unavailable matrix
         REQ-16.1/16.2/16.3, scriptAllowed exact-match+traversal REQ-16.7/16.9, createSchedRuntime
         start/stop/status/exit REQ-16.5/16.6; 12 app-sched.test.ts route-level (428 needs_confirmation ->
         confirmed override, 409 already_running, 429 rate limit on both /start and /script, script
         allowlist reject/accept, stop+audit, status incl. exit code, no write route for the allowlist);
         1 app.test.ts REQ-18.3 remote flag (loopback vs remoteAddress); 1 app-term.test.ts REQ-18.1 mcp:true
         passthrough to term.create], console/web 32 [+5: 4 logic/sched.test.ts (status label, automationHint
         quota_threshold/estimate_unavailable copy, interpretStartResponse), 1 logic/surfaces.test.ts
         mcpAuthenticateState REQ-18.3])
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues ·
         `pnpm vendor-check` -> OK (core+aal vendor-name-free, INV-7)
       - spec-trace: `bash scripts/spec-trace.sh platform-phase3` -> OK, 142/142 EARS criteria covered
       - viewports: 375 OK (clientWidth 375, mobile-emulate 375x812x2) | 768 OK (clientWidth 768) | 1440 OK
         (clientWidth 1440) — all three `scrollWidth === clientWidth` (no h-overflow); served the vite prod
         build via a throwaway `buildApp` instance on 127.0.0.1:9191 (real `createSchedRuntime`, fake
         spawn/termManager) with a seeded project; chrome-devtools MCP. Interactive proof at 1440: filled
         the goal path -> clicked Start -> 428 confirm dialog rendered the exact automationHint copy
         ("no quota estimate is available... --force-quota-override") -> clicked "Confirm and start" ->
         status flipped to "running (pid 4242)", spawn args recorded (`loop run --goal ...`),
         `sched_start` audited -> clicked Stop -> `sched_stop` audited, `{stopped:true}` -> clicked the MCP
         "Authenticate" button -> navigated to `?cmd=mcp` -> auto-created a claude-only term session with
         `{mcp:true}` (server log confirmed the exact body).
       - deviations: (1) `decideSchedStart`'s three refuse reasons resolve an underspecified design branch:
         a KNOWN over-threshold estimate (`quota_threshold`) never yields to confirm (overriding a MEASURED
         limit from a web click would silently loosen it); an UNAVAILABLE estimate (`estimate_unavailable`
         — today's only reachable case, since F-Sched passes `estimate: null` exactly like the CLI's own
         `automationGuard`, INV-13 honest posture) is the one the two-step confirm token DOES override — the
         web analog of `--force-quota-override`. `quota_threshold` is unreached in production today (no real
         fiveHour/weekly formula exists yet) but is exercised directly in `sched.test.ts` via a synthetic
         `AutomationDecision`. (2) both `/api/sched/start` and `/api/sched/script` share one rate limiter —
         the design's route table annotates the rule only on `/start`, but `/script` spawns a process too
         (same §13.3 spawn-endpoint rule), so both are gated. (3) unlike `termRateOk` (ships permanently
         unwired in production, an accepted Phase-1 precedent), F-Sched's `rateOk` IS wired in
         `bin/platform.ts` to a real global sliding-window counter (10/min) — architect finding #14 asked
         this gap be closed for sched specifically, so this task diverges from the F-Term precedent it
         otherwise mirrors. (4) F-MCP Authenticate adds no new spawn variant beyond the existing `resume`
         pattern: `CreateSessionInput` gains `mcp?: boolean`, consumed by `term-runtime.ts`'s `buildCommand`
         (`claude mcp` instead of a bare REPL); `term-runtime.ts` itself stays untested in CI per its own
         documented convention ("verified live... not in CI") — the route's `body.mcp -> input.mcp`
         threading is what's unit-tested. (5) REQ-18.3's "remote" ships today as the peer-address half only
         (`!isLoopback(req.ip)` on `GET /api/auth`) — the single remote definition's other half
         (`--behind-proxy` forcing remote regardless of socket) is task 11's REQ-20.8; the field is shaped
         so task 11 can OR in that condition without a response-shape change. (6) `/api/sched/start`'s body
         mirrors the CLI's own `--goal/--task/--live` flags directly (no new argument surface invented); a
         `--live` request spawned this way structurally refuses inside the child via the EXISTING
         `decideLiveRun` TTY guard (a spawned, non-TTY child can never type the confirmation phrase) —
         surfaced at `GET /api/sched/status` as a non-zero exit (REQ-16.5), not a new mechanism. (7) the
         browser-verify fixture's fake child never fires its exit callback on `kill()` (a throwaway
         simplification), so the status badge visibly lagged one poll behind the "stopped" note during the
         manual session; the underlying "exit flips status, no auto-respawn" behavior is what
         `sched.test.ts`/`app-sched.test.ts` prove with a real synthetic exit code.
- [x] 10. Remote auth gate + Basic provider — `auth/provider.ts` (mintSession/verifySession HMAC + expiry + tamper, loadAuthConfig 0600), `auth/basic.ts` (scrypt constant-time, IP lockout), platform.ts wiring (hasAuthProvider real -> unchanged decideStartup), app.ts onRequest auth hook (generic 401, /auth/* + login assets exempt), cookie flags, login rate limit, F-Term loopback-hard regardless of auth, web `Login.tsx`.
     Satisfies: REQ-19. Verify: `pnpm -C console/backend test && pnpm -C console/web test`.
     Evidence:
       - test: `pnpm -C console/backend test` -> 194 passed / 0 failed (was 167; +27: 10 auth/provider.test.ts
         REQ-19.4/19.5 mintSession/verifySession round-trip+expiry+tamper+wrong-secret, loadAuthConfig
         valid/corrupt/incomplete, cookie serialize/parse; 10 auth/basic.test.ts REQ-19.6/19.7/19.8 scrypt
         determinism, login limiter lock/cooldown/per-IP, POST /auth/login success+wrong-password+lockout,
         POST /auth/logout; 6 app-auth.test.ts REQ-19.3/19.9 gate 401/200, /auth/* + static exemptions,
         uniform-gate no-enumeration, F-Term-stays-403-even-authenticated regression; 1 security.test.ts
         REQ-19.1 the newly-reachable `hasAuthProvider:true` branch) · `pnpm -C console/web test` -> 35 passed
         / 0 failed (was 32; +3 logic/auth.test.ts REQ-19.3/19.6 interpretAuthProbe + interpretLoginResponse)
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues
       - spec-trace: `bash scripts/spec-trace.sh platform-phase3` -> OK, 142/142 EARS criteria covered
       - viewports: 375 OK (clientWidth 375, mobile-emulate 375x812x2) | 768 OK (clientWidth 768) | 1440 OK
         (clientWidth 1440) — all three `scrollWidth === clientWidth` (no h-overflow); served the vite prod
         build through the REAL `platform console` binary (not just `buildApp` in-process) on 127.0.0.1:9877
         against a fake HOME with a real scrypt-hashed Basic config; chrome-devtools MCP. Interactive proof at
         1440: typed the wrong password -> clicked Sign in -> generic "unauthorized" alert rendered
         (REQ-19.6) -> typed the correct password -> clicked Sign in -> reload -> full dashboard rendered
         under the new session (gate flipped to authed) -> confirmed `document.cookie` is empty (HttpOnly
         hides `platform_session` from JS) while the dashboard's own API calls still succeeded (browser sent
         the cookie automatically).
       - deviations: (1) `decideStartup` itself stays byte-unchanged (task wording) — REQ-19.2's "pointer to
         the config path" on refusal is appended by `bin/platform.ts`'s own refuse handler, not inside
         `decideStartup`'s message; `security.ts` is untouched, `security.test.ts` gets one ADDITIVE test for
         the newly-reachable branch. (2) `AuthConfig`'s `oidc` variant is typed in `provider.ts` (one
         discriminated union, since `loadAuthConfig` parses a single file that could hold either shape) but
         not constructible yet — `bin/platform.ts` explicitly refuses startup with a clear message if
         `console-auth.json` names `provider:'oidc'`, since `oidc.ts` is task 11. (3) no CLI/setup command
         generates `console-auth.json` — no REQ or task bullet asked for one; `scryptHash`/`generateSalt` are
         exported from `basic.ts` as the building blocks an operator (or a future setup command) uses; the
         file stays hand-authored, matching design's "0600 outside the repo" framing. (4) no logout button in
         the UI — `/auth/logout` exists (part of the `AuthProvider.routes()` contract, tested directly) but
         task 10 only asked for `Login.tsx`; sessions simply expire via the 12h TTL. (5) REQ-15.10's
         `local-operator` audit principal on loop/sched routes is UNCHANGED — that EARS line is scoped to
         "WHERE no auth provider is active"; no REQ in this task asks the audit principal to switch to the
         real identity once auth IS active. (6) EARS 19.6's "unknown subject" half is unreachable via Basic
         (single password, no username, INV-15) — only the "wrong password" / "missing password" generic-401
         analog is tested here; full coverage arrives with OIDC's sub-mismatch case in task 11 (design.md
         documents this exact split). (7) session TTL (12h) and login-lockout thresholds (5 attempts /
         5-minute cooldown) are not spec'd numbers — chosen as reasonable constants. (8) REQ-19.10 (insecure
         mode + loud warning + F-Term still unreachable) is satisfied by the PRE-EXISTING `decideStartup`/
         F-Term tests, unmodified by this task — `insecure` short-circuits before `hasAuthProvider` is even
         read, so making that value real doesn't change the branch; no new test was added specifically for it.
- [x] 11. Google OIDC + behind-proxy + §13.3 hardening sweep — `auth/oidc.ts` (discovery, PKCE S256, state/nonce, iss/aud/sub pins, clientSecret from 0600 config, logout), `--behind-proxy` (gate forced ON, proxy host allowlisted, Secure cookies, redirectUri derivation, EVERYTHING remote: F-Term/WS-tickets refused + Authenticate disabled, single remote definition anchoring 18.3/19.9/19.10), §13.3 checklist lines as named tests (single-operator, redaction on new routes, spawn rate limits + tokens).
     Satisfies: REQ-20, REQ-21. Depends on: 10. Verify: `pnpm -C console/backend test`.
     Evidence:
       - test: `pnpm -C console/backend test` -> 216 passed / 0 failed (was 194; +22: 4 security.test.ts
         REQ-20.1/20.2 --behind-proxy forces the gate ignoring --insecure + refuse message, host/CORS
         allowlist honors the proxy host at any port, `parseBehindProxy` https-only+origin-normalize; 11
         new `auth/oidc.test.ts` — 6 `verifyIdToken` crypto-level (real RSA keypair via node:crypto,
         RS256 sign/verify, no JWT library): valid token verifies, tampered payload fails signature,
         wrong iss/aud/nonce/sub each fail closed, expired fails closed, non-RS256/unknown-kid fail
         closed, malformed tokens never throw; 5 route-level against a fake injectable `fetchFn` (no
         network): full start->callback round trip mints a REAL session (nonce/state/PKCE extracted from
         the live redirect Location header, matching id_token minted and verified end-to-end), state
         mismatch -> generic 401, missing pending cookie -> generic 401, forceSecure marks both cookies
         Secure over plain-http inject, logout clears the cookie; 3 app-auth.test.ts — `/auth/provider`
         exempt route reports the active kind, `behindProxyHost` ORs `/api/auth`'s `remote` to true
         regardless of peer/bind, the proxy host passes the host-header/CORS hook; 4 new
         `app-hardening.test.ts` (§13.3 sweep) — REQ-21.2 no route creates/registers a user (6 candidate
         paths probed, all 404 with no auth gate registered to create 401-ambiguity), REQ-21.3 a
         token-shaped value echoed through `/api/sched/start`'s args into `/api/sched/status` is redacted
         (proves the global onSend hook still fires on the NEW F-Sched route), REQ-21.4 (x2)
         `/api/sched/start` and `/api/sched/script` each enforce the rate limit BEFORE and their own
         confirm-token/allowlist gate AFTER · `pnpm -C console/web test` -> 36 passed / 0 failed (was 35;
         +1 `interpretProviderProbe` REQ-20 oidc/basic/malformed/non-200 branches)
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues
       - spec-trace: `bash scripts/spec-trace.sh platform-phase3` -> OK, 142/142 EARS criteria covered
       - viewports: n/a — no new layout/CSS; the only view change is `Login.tsx`'s existing single-column
         centered form swapping its child (password form vs. a plain link), unchanged at 375/768/1440.
         Verified instead by running the REAL `platform console` binary twice (Basic config, then an OIDC
         config) via chrome-devtools MCP: Basic renders the unchanged password form (regression-safe);
         OIDC renders "Sign in with Google" linking to `/auth/oidc/start`; clicking it in a live browser
         redirected to the REAL `accounts.google.com` authorization endpoint with our params (state/nonce/
         PKCE/redirect_uri) attached, which Google's real server rejected as `invalid_client` — the
         correct/expected outcome for a fake `client_id` and the strongest available non-quota proof the
         discovery+redirect wiring is genuinely correct against Google, not just internally self-consistent.
       - deviations: (1) §13.3's literal WS close codes 4401/4403 aren't reproduced verbatim by the
         Phase-1 term-runtime (it uses HTTP 403 pre-upgrade and `ws.close(4404)` post-upgrade) — spot-checked
         while auditing checklist coverage; pre-existing from task 1, out of scope for REQ-20/21 here, not
         changed. (2) REQ-21's sweep is scoped to the delta task 8-10 introduced (per this task's own
         parenthetical) — the other ~12 §13.3 lines already have named tests from earlier phases (REQ-12/13/
         14/15/16/18/19, confirmed by grep spot-check), not re-verified line-by-line here. (3) `--insecure`
         has NO effect once `--behind-proxy` is set (decideStartup skips both the loopback AND insecure
         shortcuts when `behindProxy` is present) — a deliberate reading of design's "a proxy flag never
         weakens" (REQ-20.1), proven by an explicit test rather than left implicit. (4) the pending
         OIDC handshake (state/nonce/PKCE verifier) travels in a short-lived (5 min) signed cookie, not
         server memory — keeps `oidc.ts` stateless like `provider.ts`'s existing design note; a small
         HMAC sign/verify pair is duplicated locally rather than widening `provider.ts`'s API for one
         extra caller with a different payload shape. (5) task 13 (LIVE, manual) still owns the real
         end-to-end Google login + a genuine second-machine/tailnet click-through — this task's browser
         verification intentionally stops at "redirects correctly to the real Google endpoint," matching
         task 13's own description of owning "real login ... (Basic; OIDC if Tailscale Serve available)".
- [x] 12. Symbol-level COMPRESS — `compressToSymbols` heuristic in context builder (imports/exports/declaration headers kept, bodies dropped, trailer), <2-declaration fallback to truncation, GOVERN scans full pre-compression content (secret-in-dropped-body test), per-piece reason for waste metrics.
     Satisfies: REQ-22. Verify: `pnpm -C core test`.
     Evidence:
       - test: `pnpm -C core test` -> 177 passed / 0 failed (was 174; +3: `compressToSymbols` REQ-22.1/22.4
         symbol reduction on an oversized TS fixture (import + function + class headers kept, indented bodies
         dropped, `[compressed:symbols]` trailer, `reason==='compressed:symbols'`), REQ-22.2/22.4 fallback on
         an oversized prose file (<2 declarations -> byte truncation, `reason==='truncated'`), REQ-22.3 GOVERN
         still throws `SecretInContextError` for a secret planted inside an indented (would-be-dropped) body
         line of an otherwise-compressible file) · `pnpm -r test` -> 565 passed / 0 failed across all 6
         packages (core 177, aal 99, adapters 37, console/backend 216, console/web 36 — all unaffected,
         confirming no cross-package regression)
       - typecheck/lint: `pnpm -r typecheck` -> 6/6 projects clean · `pnpm lint` -> 0 issues · `pnpm vendor-check`
         -> OK (core+aal vendor-name-free, INV-7)
       - spec-trace: `bash scripts/spec-trace.sh platform-phase3` -> OK, 142/142 EARS criteria covered
       - viewports: n/a — logic-only
       - deviations: (1) `ContextPiece.reason` is a bare `string` reused for two distinct axes (inclusion-rule
         id vs COMPRESS-path taken); design.md:682-684 names the field but doesn't say what happens to the
         PRE-EXISTING `'seed'`/`'expand:depth-N'` value once a piece is big enough to enter the COMPRESS
         decision. Read literally against REQ-22.4 ("record per piece whether symbols or truncation ran"): a
         piece's `reason` is overwritten to `'compressed:symbols'`/`'truncated'` ONLY when it actually exceeds
         `maxFileBytes` (i.e. only when the COMPRESS decision is meaningful for it); a piece that fits under the
         cap never enters that decision, so its original inclusion-reason passes through untouched — no new
         field was added, matching the design's explicit field choice. (2) `compressToSymbols`'s declaration
         keyword set is exactly `function|class|interface|type|const` (with `export`/`default`/`declare`/
         `async`/`abstract` modifier prefixes) — matches design.md:677's literal enumeration; `enum`/`let`/`var`
         are deliberately NOT recognized as declarations (a stray top-level `enum Foo {` line is dropped, not
         kept), since the design names five keywords, not more. (3) `compressToSymbols`/`compressOrTruncate`
         stay module-private (not exported), matching the pre-existing convention for this same file's
         `truncate`/`localImports` helpers — exercised only indirectly through `buildContext`, same test style as
         every other case in `builder.test.ts`. (4) The heuristic is line-based with no brace/indent-depth
         parser: a multi-line declaration signature formatted Prettier-style (params indented, closing `): T {`
         back at column 0) keeps only the opening header line, not the full signature — an accepted heuristic
         gap explicitly sanctioned by design.md:738's own error-handling row ("Symbol compression yields garbage
         -> Fallback to byte truncation, total function"); the <2-declaration safety net exists for exactly this
         class of degradation and no fixture in design's testing table (`design.md:772`) asks for signature
         reconstruction. (5) A top-level `/** ... */` JSDoc block is kept verbatim via a small open/close state
         flag (so its indented `*` continuation lines survive despite the general indented-line-drop rule) —
         an addition beyond the design's one-line description but directly implied by "comment headers" being
         listed as a keep-category, since JSDoc is the dominant top-level comment shape in this codebase's own
         source (e.g. this same file's header comment).
- [ ] 13. LIVE pass (manual — never CI; Phase-1 task-11 analog) — live Codex conformance P1-P8 (expect INV-16 wire-vocabulary class: fix Ring 2 prompt/classification, never verdicts; discrimination self-test stays green), §5.3 non-interactive-usage policy review recorded BEFORE first fusion activation, <=3 live fusion activations under profile caps -> uplift interval into `docs/calibration/`, real login + F-Loop approve from a second machine over tailnet (Basic; OIDC if Tailscale Serve available, else recorded fallback), one-time governance approval of the new policy snapshot, auditor real sample, real-repo auto-merge stretch (not DoD), replay/cache per-run and never committed. Done = §14 Phase 3 DoD evidence complete.
     Satisfies: REQ-2, REQ-3, REQ-11, REQ-19, REQ-20 (live re-verification — CI coverage lives in tasks 1-12). Depends on: 1-12. Verify: `docs/calibration/` evidence + `bash scripts/spec-trace.sh platform-phase3`.

## Suggested execution batches

> DEFAULT for a COUPLED feature (tasks share primitives/data/lib): run ALL tasks in
> ONE session — `scripts/pane-loop.sh platform-phase3 all-in-one` (or `/spec-implement all`).
> Separate sessions do NOT share cache, so each one re-pays the cold cache-write to
> re-acquire shared context — measured ~30-40% more expensive for coupled work.
> Split into separate sessions/panes ONLY for accuracy: a genuinely INDEPENDENT task
> (no shared state), or to isolate a CORE domain from long-context drift.

- Dependency order: 1 -> 2 -> 3 -> 4 (fusion chain) · 5 -> 6 (integration trust) · 7 after 1 · 8 -> 9 (console) · 10 -> 11 (auth) · 12 independent · 13 last, manual.
- All-in-one covers 1-12; task 13 is always its own manual session with the human present (live quota + second machine + typed confirmations).
- If splitting for accuracy: {1,2}, {3,4}, {5,6}, {7,12}, {8,9}, {10,11} are the natural session pairs.
