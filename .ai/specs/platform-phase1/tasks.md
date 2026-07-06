# Implementation Tasks: Autonomous Engineering Platform — Phase 1

> Status: approved 2026-07-06 (goal-mode AFK; spec-trace OK — 94 criteria covered, EARS lint
> pass; spec-architect review: REVISE 8 findings, all applied — live conformance gate added to
> task 11, split-claims reconciled, RED-first explicit for core tasks)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.
> RED-first is normative (spec §0.4): task 2 lands the conformance suite + AAL
> integration scenarios as FAILING tests; task 3 turns that suite green; tasks
> 4–6 add core modules RED→GREEN within each task (author failing tests first —
> the rule covers core itself). Never weaken a scenario to pass it (INV-16).
> CI must never spend quota: every CI path uses the FakeAdapter (REQ-11.2);
> live runs are task 11 only.

- [x] 1. Ring 1/2 scaffold + enforcement extension — new pnpm workspaces `aal/` and `adapters/`
     (strict tsconfig, smoke tests), extend `scripts/check-core-vendor-free.sh` to grep `aal/`
     (planted vendor word demonstrably fails), create `.ai/schemas/task-result.schema.json`,
     `.ai/policies/phase1.json` (named policy keys: transcript_poll_interval_ms,
     transcript_poll_attempts, term_ticket_ttl_s, activity_hook_timeout_ms,
     kill_adapter_wait_ms), `.ai/runs/agent-sessions/` + `.ai/calibration/` dirs. Done =
     install/typecheck/lint green across all workspaces; vendor check passes and planted words
     in core/ AND aal/ each fail it.
     Satisfies: REQ-12.1. Verify: `pnpm install && pnpm typecheck && pnpm lint && pnpm test`;
     planted-word runs exit 1 for both rings.
     Evidence:
       - test: `pnpm typecheck` -> all 6 workspaces Done (aal, adapters added); `pnpm test` ->
         73 pass / 0 fail (aal smoke 1 incl. `core/types` link resolves, adapters smoke 1,
         plus existing core 45 / backend 22 / web 4 unchanged); `pnpm lint` -> eslint no issues
       - test: `scripts/check-core-vendor-free.sh` -> exit 0 "core/ and aal/ vendor-name-free";
         planted "anthropic" in aal/src/*.tmp.ts -> exit 1 with file:line; planted "openai" in
         core/src/*.tmp.ts -> exit 1; both removed -> exit 0 again
       - viewports: n/a — scaffold/logic-only
       - deviations: added `exports` map to core/package.json (".", "./ports", "./types") so
         Ring 1 can import core types by package name; aal depends on `core` (workspace:*),
         adapters depends on `aal`+`core`; `_template.ts` deferred to Phase 3 (design amended);
         `.ai/policies/phase1.json` also carries repair_max_rounds + cost_units_per_1k_tokens
         (used by later tasks, colocated with the other bounds)

- [x] 2. AAL protocol + conformance suite in RED — `aal/src/protocol.ts` (AgentRequest/
     AgentResponse/CapabilityManifest/AdapterInterface/AdapterError types), FakeAdapter skeleton
     + sabotaged variants (prose-only, fabricated-execution, schema-ignoring, double-burning),
     conformance probes P1–P8 + registry-gating + repair-loop + router scenarios authored as
     FAILING tests (harness/registry/router throw NotImplemented), RED state observed and
     recorded in Evidence. Done = suite runs, every scenario RED for the expected reason.
     Satisfies: REQ-1.1, REQ-1.2 (+REQ-3 scenarios authored RED). Depends on: 1.
     Verify: `pnpm --filter aal test` shows the scenarios failing with expected messages.
     RED milestone (2026-07-06): reached and observed — `pnpm --filter aal test` -> tests 16,
     pass 1 (index smoke), fail 15; all conformance/registry/router/repair scenarios RED with
     `Error: NotImplemented: <fn>` (expected reason). protocol.ts + fake-adapter.ts (compliant +
     4 saboteurs + schema_fail_first) are real; harness/registry/router/repair are stubs.
     core typecheck/tests green (45), vendor check green (Ring 0+1). Checkbox stays [ ] until the
     suite turns green — task-gate enforces green-on-[x]; flips with task 3 (RED-first §0.4).
     Evidence:
       - test: RED observed at commit 46758e9 (`pnpm --filter aal test` -> 16 tests, 1 pass,
         15 fail, all `NotImplemented: <fn>`); suite now GREEN — see task 3 Evidence
       - viewports: n/a — logic-only
       - deviations: shared context DTOs (ContextBundle/ContextPiece/TaskContractExcerpt) +
         5 Phase-1 event types added to core/types.ts (Ring 0 owns them, Ring 1 imports upward
         per INV-8); AgentResponse.adapterMeta gains `toolUseCount` (deterministic P6 signal);
         probes drive the FakeAdapter via a `[probe:Pn ...]` directive embedded in the
         objective — doubles as a natural-language instruction so the same requests exercise a
         real model in task 11

- [x] 3. AAL core GREEN — implement `aal/repair.ts` (bounded 2-round schema repair),
     `aal/registry.ts` (refuse without P1–P6+P8 pass; P7 score stored; drift canary re-run →
     stale_conformance + refuse-live), `aal/router.ts` (capability match, no_capacity at
     selection AND on send-failure without alternatives), `aal/conformance/` harness with
     deterministic structural verdicts, first-class FakeAdapter (durable replay for P8). Done =
     entire task-2 suite green incl. sabotage discrimination self-test.
     Satisfies: REQ-1.3-1.5, REQ-2, REQ-3, REQ-6. Depends on: 2.
     Verify: `pnpm --filter aal test` all green; vendor check still green.
     Evidence:
       - test: `pnpm --filter aal test` -> 16 tests, 16 pass, 0 fail — compliant adapter passes
         P1–P8; sabotage self-test proves each saboteur (prose_only/fabricate_execution/
         ignore_schema/double_burn) fails EXACTLY its owned probe; conformance record carries a
         P7 score; repair loop 0-round (compliant) / 1-round (schema_fail_first recovers) /
         exhaust-2-then-fail (ignore_schema); registry refuses a failing record + drift canary
         marks stale + drops from eligible; router returns match / throws no_capacity
       - test: `pnpm typecheck && pnpm test && pnpm lint` -> all 6 packages green, 88 tests 0
         fail; `scripts/check-core-vendor-free.sh` -> Ring 0+1 vendor-name-free
       - viewports: n/a — logic-only
       - deviations: router no_capacity is a dedicated `NoCapacityError` (not an AdapterError —
         it is a routing outcome, not an adapter failure); repair re-asks use a `#r<n>`
         requestId suffix so the FakeAdapter's replay cache doesn't return the stale invalid
         response mid-repair

- [x] 4. Core context builder + goal contract — `core/src/context/` (SEED→EXPAND→COMPRESS(v1
     whole-file+truncate)→GOVERN(core-own generic secret patterns, block+ESCALATED
     secret_in_context)→MARK(data markers + canary)→MANIFEST(evidence blob); recall/waste
     counters; machine-config exclusion), `core/src/contract/` (validate pre-parsed object,
     freeze sha256 of raw bytes, mid-run mutation → ESCALATED contract_changed, budget flow),
     CONTEXT_BUILT/PROPOSAL_INTENT event types. Done = co-located unit tests authored RED FIRST
     (observe fail) then green (determinism, secret block, canary, counters, freeze), core stays
     zero-dep, fault-injection suite still green.
     Satisfies: REQ-7, REQ-8. Depends on: 1.
     Verify: `pnpm --filter core test`; `scripts/check-core-vendor-free.sh`.
     Evidence:
       - test: RED observed first (11 fail, all `NotImplemented: buildContext/scanForSecret/
         freezeContract`); then GREEN — `pnpm --filter core test` -> 56 tests, 56 pass, 0 fail
         (context builder: determinism/byte-identical manifest, GOVERN blocks + names the secret
         file, MARK canary in serialized wire, COMPRESS v1 truncation, machine-config exclusion
         via injected predicate, recall/waste 0.5/0.5; secret-scan: sk/ghp/AKIA/PEM/JWT shapes +
         high-entropy blob caught, ordinary code/prose not; contract: freeze+budget map+unknown-
         key preserve, invalid rejected, mid-run byte mutation detected)
       - test: `pnpm typecheck && pnpm test && pnpm lint` -> 6 packages green, 99 tests 0 fail;
         `scripts/check-core-vendor-free.sh` -> Ring 0+1 clean; core still ZERO runtime deps
       - viewports: n/a — logic-only
       - deviations: REQ-7.7 machine-config exclusion is PARAMETERIZED — core cannot name vendor
         config files (INV-7 grep hits 'CLAUDE'/'.claude'), so `buildContext` takes a caller-
         supplied `excludePath` predicate; the vendor-specific list is wired at the composition
         root in task 7. REQ-7.6 recall/waste is COMPUTED here (computeContextMetrics, unit-
         tested); the CONTEXT_BUILT event emission is wired into the loop in task 5

- [ ] 5. AALProposalSource + loop integration — `aal/src/source.ts` implementing core's
     ProposalSource (PROPOSAL_INTENT{requestId} before each send, crash-replay reuses id +
     accepts adapter replay, path-provenance context_violation rejection, AgentResponse →
     Proposal mapping); new fault-injection scenario: lying FakeAdapter behind AALProposalSource
     never yields PASSED; whole Phase-0 suite green UNCHANGED. Done = integration tests green
     both packages.
     Satisfies: REQ-5, REQ-12.2, REQ-12.3, REQ-12.4. Depends on: 3, 4.
     Verify: `pnpm --filter core test && pnpm --filter aal test`.

- [ ] 6. Human plane + supervised loop E2E (CI) — `core/src/human/`: ApprovalPackage generator
     (diff budget → split_required; attestations from goal approval_policy, default L2; timing
     recorded), Human Plane API on node:http (loopback-only, human-plane.json 0600, approvals
     drive REVIEWING→APPROVED / CHANGES_REQUESTED, redacted /events, kill full semantics with
     kill_adapter_wait_ms, steering 501, 401+rate limit); orchestrator transition enablement;
     supervised-loop E2E with FakeAdapter (fixture → REVIEWING → API approve → APPROVED) +
     calibration harness math (metrics computation + clean-checkout reproducibility re-run —
     numbers never reported as §12 metrics). Done = tests authored RED FIRST (observe fail) then
     E2E + unit green.
     Satisfies: REQ-9, REQ-10, REQ-11.1, REQ-11.2, REQ-11.5. Depends on: 5.
     Verify: `pnpm --filter core test` (human plane + E2E scenarios).

- [ ] 7. anthropic adapter + live gating — `adapters/src/anthropic.ts` (pinned SDK, tools:[] +
     settingSources:[] + core-owned system prompt per D-004, fixed cwd agent-sessions, usage →
     costUnits estimate, transcript capture with bounded poll + null fallback, quota_limited
     no-self-retry, auth_unavailable construction probe, determinism 'none', durable replay
     REQ-4.9), `platform loop run` subcommand (yaml parse at edge, FakeAdapter default,
     --live refuses on CI env / non-TTY, prints cap, typed confirmation phrase, initiator
     evidence). Done = adapter unit tests green with mocked SDK transport; conformance harness
     accepts the adapter type; NO live call in CI. (REQ-4.5 real-capture success path closes in
     task 11; mocked tests cover derivation logic + the 4.6 null fallback.)
     Satisfies: REQ-4, REQ-8.1 (edge-parse half — yaml at composition root), REQ-11.3.
     Depends on: 3, 6.
     Verify: `pnpm --filter adapters test`; `platform loop run --live` in CI env exits refused.

- [ ] 8. Console F-Term end-to-end — backend PtyManager (node-pty spawn real `claude`,
     claude-only default / full-shell opt-in, backend-owned attach/detach/ring buffer/reap,
     single active writer takeover, audit JSON per spawn/close, rate limit, WS single-use
     tickets with term_ticket_ttl_s, loopback-only hard 403 even with --insecure, resume via
     --resume, 503 when binary missing) + web Terminal page (xterm.js, project picker, resume
     list, attach flow). Done = backend lifecycle tests green (sh-based, no quota), web build +
     browser verify.
     Satisfies: REQ-13.1-13.7, REQ-13.9. Depends on: 1.
     Verify: `pnpm --filter console-backend test && pnpm --filter console-web build`.

- [ ] 9. Console governance — F-Set (multi-scope GET/PUT, managed RO by construction, schema
     validate + baseHash 409 + atomic rename, Effective View full chain + provenance + CLI
     parity check — the CLI-parity half of REQ-14.3 is a recorded observation against the
     installed CLI where CI cannot drive a configured CLI, honest per A4), F-Perm (rules
     builder, merged view, simulator, install-guards idempotent for test/golden/** +
     worktrees/), F-Auth full (method per project, shadowing red warning names-never-values,
     setup-token guidance, redacted env, negative token-route guarantee), F-Mem (CLAUDE.md
     editor + preview) + web views. Done = endpoint + negative + parity tests green, browser
     verify.
     Satisfies: REQ-14, REQ-15, REQ-16, REQ-17. Depends on: 8.
     Verify: `pnpm --filter console-backend test && pnpm --filter console-web test`.

- [ ] 10. Console observability — F-Usage full (indexer day/project/model, estimates labeling,
     cwd-based interactive/autonomous split, alert thresholds + labels), F-Act (one-click hook
     install/uninstall fail-open with activity_hook_timeout_ms, ingest token auth, WS fanout),
     F-Sess search (rebuildable FTS5 + endpoint) + web views. Done = endpoint/logic tests green,
     browser verify.
     Satisfies: REQ-18, REQ-19, REQ-20. Depends on: 8.
     Verify: `pnpm --filter console-backend test && pnpm --filter console-web test`.

- [ ] 11. Live conformance + calibration + Phase-1 DoD closure — FIRST run conformance P1–P8
     against the LIVE anthropic adapter (budget-capped, ~10 requests) and persist its real
     ConformanceRecord — this is the §14 "conformance ผ่าน" DoD gate and the REQ-12.4
     prerequisite (registering from a mocked record would make the gate theater); THEN the
     manual live supervised loop on the fixture goal via `platform loop run --live` (typed
     confirmation; budget cap from goal.yaml): record first calibration numbers as a RANGE
     (held-out pass rate + reproducibility) into evidence; billing proof (/usage moves on Max,
     no API bill — PARTIAL where unobserved, honest per A4); F-Term parity manual checklist vs
     real CLI (slash commands, plan mode, permission keystroke, --resume, detach/attach) each
     PASS/PARTIAL recorded; transcript capture success path verified live (REQ-4.5 flush
     observation). Machine outputs land in `.ai/calibration/` (seeds + harness output);
     human-readable live evidence lands in `docs/calibration/` (Phase-0 docs/spikes pattern).
     Done = ConformanceRecord + evidence recorded — never a hollow PASS.
     Satisfies: REQ-11.4, REQ-11.6, REQ-13.8, REQ-4.5 (live success path), REQ-2.1 + REQ-3
     (live-adapter verification; harness ownership stays with task 3). Depends on: 6, 7, 8.
     Verify: evidence files exist with observed output + honest PARTIAL remainders.

## Suggested execution batches

Coupled feature — DEFAULT: run ALL tasks in ONE session (`/spec-implement all`), dependency
order 1→2→3→4→5→6→7→8→9→10→11 (4 can interleave after 1; 8-10 after 1/8; 11 last, needs live
login + human-adjacent observation). No Batch tags: every task is big/foundational — each wants
focused context; all-in-one session covers the shared-cache benefit already.
