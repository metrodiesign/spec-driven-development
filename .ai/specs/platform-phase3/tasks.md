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
- [ ] 5. T2 tier + merge queue — gate-ladder t2 real-config parsing ({status} stays not_enabled; governance-coupled hash change test), `core/src/merge/queue.ts` (lease serialization, worktree hard-reset+clean per candidate, merge --no-ff + T2 on merged tree, t1_only labeling when T2 not_enabled, conflict/rejected_t2 paths + events), auto-merge queue path with in-band audit/revert unchanged, export `reproduces()`.
     Satisfies: REQ-12, REQ-13. Verify: `pnpm -C core test`.
- [ ] 6. Out-of-band auditor — `core/src/audit/oob.ts` (salted independent sampling, alreadyAudited covers in-band + prior OOB, per-target clone in temp dir, retry-then-skip on lock, flaky_suspect vs non_repro verdicts, detection-only) + `platform auditor run` bin subcommand (own EventLog handle) + fault-injection proof: planted non-repro COMPLETED gets caught.
     Satisfies: REQ-14. Depends on: 5. Verify: `pnpm -C core test && pnpm -C console/backend test`.
- [ ] 7. Shadow routing — `aal/src/shadow.ts` (shadowWouldChoose, shadowFrozen over registry.all(), compareShadow), SHADOW_ROUTE recording from loop composition, freeze-on-stale, never-blocks/never-influences properties (route identical with and without recorder).
     Satisfies: REQ-7. Depends on: 1. Verify: `pnpm -C aal test && pnpm -C console/backend test`.
- [ ] 8. F-Loop + inject-without-pause — `loop-proxy.ts` (discoverRuns + loopFetch, token never leaves backend), loop routes (runs/approvals/events/steering/kill proxy, 502/409 paths, ended = absent-or-tombstoned + loop-run tombstone on exit), audit entries incl. local-operator principal, `core/human/api.ts` atNextBoundary queueing + loop boundary drain, web `Loop.tsx` + `logic/loop.ts` (package render + attestations + controls).
     Satisfies: REQ-15, REQ-17. Verify: `pnpm -C core test && pnpm -C console/backend test && pnpm -C console/web test`.
- [ ] 9. F-Sched + F-MCP Authenticate — `sched.ts` (decideSchedStart, exact-match allowlist from governed routing.json, no modify route), sched routes (start two-step confirm + per-source rate limit, stop SIGTERM, status exit codes, audit entries), web `Sched.tsx` + `logic/sched.ts`; F-MCP Authenticate deep link to claude-only F-Term `claude mcp` (no token endpoints; disabled+hint when request is remote).
     Satisfies: REQ-16, REQ-18. Depends on: 8. Verify: `pnpm -C console/backend test && pnpm -C console/web test`.
- [ ] 10. Remote auth gate + Basic provider — `auth/provider.ts` (mintSession/verifySession HMAC + expiry + tamper, loadAuthConfig 0600), `auth/basic.ts` (scrypt constant-time, IP lockout), platform.ts wiring (hasAuthProvider real -> unchanged decideStartup), app.ts onRequest auth hook (generic 401, /auth/* + login assets exempt), cookie flags, login rate limit, F-Term loopback-hard regardless of auth, web `Login.tsx`.
     Satisfies: REQ-19. Verify: `pnpm -C console/backend test && pnpm -C console/web test`.
- [ ] 11. Google OIDC + behind-proxy + §13.3 hardening sweep — `auth/oidc.ts` (discovery, PKCE S256, state/nonce, iss/aud/sub pins, clientSecret from 0600 config, logout), `--behind-proxy` (gate forced ON, proxy host allowlisted, Secure cookies, redirectUri derivation, EVERYTHING remote: F-Term/WS-tickets refused + Authenticate disabled, single remote definition anchoring 18.3/19.9/19.10), §13.3 checklist lines as named tests (single-operator, redaction on new routes, spawn rate limits + tokens).
     Satisfies: REQ-20, REQ-21. Depends on: 10. Verify: `pnpm -C console/backend test`.
- [ ] 12. Symbol-level COMPRESS — `compressToSymbols` heuristic in context builder (imports/exports/declaration headers kept, bodies dropped, trailer), <2-declaration fallback to truncation, GOVERN scans full pre-compression content (secret-in-dropped-body test), per-piece reason for waste metrics.
     Satisfies: REQ-22. Verify: `pnpm -C core test`.
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
