# Phase 3 — Live Pass Runbook (task 13)

The autonomous composition (multi-lineage AAL, fusion plane, T2/merge queue, OOB
auditor, F-Loop/F-Sched, remote auth) is fully wired and CI-proven with fakes
(FakeAdapter + FakeCodexAdapter + fake ExecFn) — zero quota. The remaining
Phase-3 DoD items are **LIVE and MANUAL by design** (task 13, never CI) — they
spend real Max quota and need human observation, matching the Phase 1 precedent
in `docs/calibration/RUNBOOK.md`. Never claim a hollow PASS (honesty rule §16).

**Run context (2026-07-08)**: executed by the Claude agent under explicit user
delegation ("เดินหน้า live pass เต็ม") — the sanctioned path per this project's
Phase 1 precedent (agent driving a real TTY under explicit delegation).
Initiator + typed confirmations recorded in evidence for every spend.
`ANTHROPIC_API_KEY` explicitly unset on every command.

## 1. §5.3 non-interactive-usage policy review (REQ per clarifications.md B3)

Gate: procedural, human-reviewed, recorded BEFORE the first fusion activation
(design.md:411, clarifications.md B3) — no code gate can verify a human read a
policy page, so the outcome is recorded here.

- [x] Policy reviewed 2026-07-08 against the current, official Anthropic source
- Source: [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (Anthropic Help Center)
- Exact current wording: *"Update June 15: We're pausing the changes to Claude
  Agent SDK usage described below. For now, nothing has changed: Claude Agent
  SDK, `claude -p`, and third-party app usage still draw from your
  subscription's usage limits."*
- Finding: Anthropic had announced (2026-05-14) that non-interactive/headless
  SDK usage (exactly this platform's adapter invocation pattern) would exit
  Pro/Max/Team/Enterprise subscription pools on 2026-06-15, moving to separate
  paid credit billed at API rates. That change was **paused** on the day it
  was due to take effect. As of this review, non-interactive usage still draws
  from the same subscription quota as interactive use — consistent with this
  spec's B2/INV-13 assumptions (no separate billing path exists today).
- Residual, recorded honestly: this is a point-in-time review, not a permanent
  guarantee — Anthropic states it is "working to update the plan" and will
  give advance notice before any future change. Re-check this gate before any
  future fusion-budget decision that assumes flat-rate subscription quota.
- Verdict: **PASS** (gate satisfied — reviewed before first activation below)

---

## 2. Live Codex conformance P1-P8 (REQ-2, REQ-3, REQ-12.4 prerequisite)

`platform conformance --live --lineage codex --force-quota-override` — a NEW
`--lineage` CLI flag (`console/backend/bin/platform.ts`), since `createLiveCodexAdapter`
(adapters/src/codex-live.ts, task 2) had never actually been wired to any CLI entry
point before this task. Real-TTY required (`decideLiveRun`'s `isTTY` guard) — driven
via a real iTerm2 pane through osascript (mirrors `scripts/pane-loop.sh`'s
open_pane/send_text pattern), since the Bash tool itself has no controlling TTY.

- [x] P1-P8 all pass on the FINAL shipped adapter · P7 susceptibility score 0 (canary
      not leaked) · record: `.ai/calibration/conformance-codex-2026-07-08T13-17-35-031Z.json`
- Observed: FIVE runs, kept as honest history (matches the Phase 1 precedent —
  root-cause every FAIL, never weaken a verdict to force a PASS):
  1. `conformance-codex-2026-07-08T13-08-16-630Z.json` (superseded, not the shipped
     record) — P1 **FAIL** ("schema instance not echoed intact"); P2-P6/P8 PASS.
     Root cause: OpenAI Structured Outputs "strict" mode (what `codex exec
     --output-schema` validates against) has NO concept of "additional/unknown
     property" — the shared `TASK_RESULT_SCHEMA` never declared an `echo` field
     (P1 asks the model to echo a token back as a top-level field; Anthropic
     accepts extra fields freely, Codex structurally cannot emit one the schema
     doesn't declare). Fixed in Ring 1 (`aal/src/conformance/harness.ts`): added
     an optional `echo` property — costs Claude nothing, unblocks Codex.
  2. Same run (this fix landed mid-flight; the already-running process had loaded
     the old schema, so its P1 still failed — expected, not a new bug).
  3. (superseded) — P4 **FAIL** ("degraded response not structurally valid") after
     the echo fix. Root cause, found by inspecting the evidence blob directly:
     OpenAI strict mode ALSO requires (a) every array to declare `items`, (b)
     `additionalProperties:false` on every object, and (c) `required` to list
     EVERY property key — "optional" is expressed as nullable, not absent. The
     live response therefore legitimately contained `"echo":null`, which the
     shared post-hoc `validateAgainstSchema` (aal/src/repair.ts) rejected because
     it only understood a single-string `type`, not `type:['string','null']`.
     Fixed: (i) gave `actionRequests` a real `items` shape reflecting the exact
     wire vocabulary from `buildProposePrompt` (WRITE_FILE/REQUEST_TOOL) in
     harness.ts; (ii) widened `summary`/`costUnits`/`echo` to `['T','null']` in
     the SAME shared schema (harmless for Claude — still optional either way);
     (iii) taught `validateAgainstSchema` to accept `type` as a union array (a
     standard JSON-Schema form it simply never needed before) — additive, every
     pre-existing single-string-type schema is unaffected.
  4. (superseded) — crashed before any probe ran: `codex exec exited 1: Reading
     additional input from stdin...` (the SPIKE-6 stdin-block symptom's message
     text, but NOT its cause here — no process ever hung; ps confirmed no
     lingering `codex` process at any point across all 5 runs). Root cause,
     found by reproducing raw `codex exec --output-schema` calls directly
     (bypassing the adapter) and bisecting the exact schema shape: the live
     `strictifyForCodex` normalizer (adapters/src/codex-live.ts, added for run 3
     above) widened a field to nullable WITHOUT checking whether the shared
     schema had already made it nullable itself (step 3's fix) — producing
     `type:['string','null','null']`, which codex-cli 0.139.0's schema validator
     rejects outright (`invalid_json_schema`). The thrown AdapterError only
     surfaced `stderr`'s generic startup line, not the REAL error sitting in the
     `--json` stdout stream, which is why this took a raw reproduction to find
     rather than reading the platform's own error message. Fixed: (i)
     `strictifyForCodex` now checks `types.includes('null')` before appending;
     (ii) `codex.ts`'s non-zero-exit path now prefers an `error`-typed event's
     `message` from the parsed `--json` stream over bare `stderr` (both fixes
     are Ring 2/live-only, zero CI surface, verified by re-running `pnpm -r
     test` after each — 565/565 green throughout, no regression at any step).
  5. `conformance-codex-2026-07-08T13-17-35-031Z.json` — **ALL P1-P8 PASS**, P7
     susceptibility 0. This is the active, shipped record (matches the FINAL
     wire behavior, same posture as Phase 1's own "re-run under the final
     shipped prompt" step).
  `modelVersion: "unknown"` on every run — expected and documented (SPIKE-6 #5,
  codex.ts:174): codex's `--json` events never echo the requested model, and no
  explicit `--model`/`-m` override was passed for this conformance probe (the
  adapter records whatever it was asked for; here, nothing was asked, so codex's
  own CLI default served the requests).
  Verdict: **PASS** (on the final record; every earlier FAIL was root-caused in
  Ring 1/Ring 2 source, never patched around in the verdict logic — INV-16).
- Source changes this step made (all additive, 565/565 tests green throughout,
  6/6 packages typecheck clean): `aal/src/conformance/harness.ts` (echo field +
  real actionRequests.items shape), `aal/src/repair.ts` (`validateAgainstSchema`
  accepts a union-array `type`), `adapters/src/codex-live.ts`
  (`strictifyForCodex` — new, Codex/OpenAI-only schema normalizer), `adapters/src/codex.ts`
  (prefer a parsed `--json` error event's message over bare stderr on non-zero exit),
  `console/backend/bin/platform.ts` (new `--lineage claude|codex` flag on
  `platform conformance --live`, previously hardcoded to Claude only).

## 3. Fusion live activations (REQ-8.1/8.4/8.5, REQ-9, REQ-10; clarifications decision #3)

Exercised the REAL `fusion.deliberate` REQUEST_TOOL seam (`console/backend/src/fusion.ts`'s
`createFusionToolHandler`) directly with real adapters, via a throwaway script
(`console/backend/bin/fusion-live-probe.ts`, deleted after this step) mirroring
`aal/src/fusion/run.test.ts`'s `setupWith` composition but swapping FakeAdapter for
`createLiveAnthropicAdapter`/`createLiveCodexAdapter`.

**Recorded gap (found, not built, during this task):** the design's "policy trigger"
entry point — `loop-run.ts` auto-routing a live planner-role proposal through
`runFusion` — has NO implementing code anywhere in the tree (no `role==='planner'`
branch exists; the supervised loop always runs as `'implementer'`), despite task 3's
own deviation note describing it as "the live-only trigger exercised in task 13."
Building that auto-router live, under real spend, would mean writing genuinely new
orchestration logic (not wiring already-built pieces) — a non-trivial feature this
project's own constitution says needs a requirements/design pass first, not
improvisation mid-LIVE-task. Decided (with the user) to exercise the
agent-invoked `fusion.deliberate` seam instead, which DOES have real, already-built,
CI-proven code behind it (`fusion.test.ts` proves the executor wiring with a stub
`activate`; this step is the first time a REAL `activate` — a real Registry/Router/
Dispatcher/`runFusion` over real adapters — has ever been exercised). The
planner-auto-routing entry point stays an open backlog item, not silently dropped.

- [x] Self-panel (`hypotheses`, self-diversity, Claude only, seeds `[7,13]` — profile
      edited in `.ai/policies/fusion-profiles.json`, governance re-approved, §8 above)
- Observed: `resolved:"union_rank_probe_cost"`, winner **true**, no escalation,
  usage **6.737 costUnits** (cap 30). Run dir: `~/.ai/runs/FUSION-self-1783517039981/`.
  Verdict: **PASS** — pipeline proven live end-to-end on the first attempt.
- [x] Cross-vendor #1 (`plan`, cross_lineage anthropic+openai, Claude+Codex; objective:
      plan a CHANGELOG entry, planning-only, no actionRequests)
- Observed: `resolved:"deliberate_synthesis"`, winner **true**, judge **valid** (a
  judge-load-bearing artifact winning confirms the blind judge round genuinely ran
  across both real lineages), no escalation, usage **30.107 costUnits** (cap 40).
  Run dir: `~/.ai/runs/FUSION-cross1-1783517130005/`. Verdict: **PASS**
- [x] Cross-vendor #2 (`plan`, same profile; objective: plan verifying a governance
      rejection path)
- Observed: `resolved:"deliberate_synthesis"`, winner **true**, judge valid, no
  escalation, usage **30.932 costUnits** (cap 40).
  Run dir: `~/.ai/runs/FUSION-cross2-1783517316458/`. Verdict: **PASS**
- Total fusion spend across all 3 (the conservative "~3 activations" cap from
  decision #3): **67.776 costUnits**.
- **Honest gap, recorded rather than papered over:** these 3 activations prove the
  fusion MECHANISM live (real panel fan-out, real blind judge, real resolve, real
  cross-lineage dispatch) but do NOT produce a `computeFusionCalibration` uplift
  NUMBER — `plan`/`hypotheses` resolve mechanically or by judge pick, with no
  `GateReport` (only `code_diff`/`tests` artifacts carry gate evidence per
  `aal/src/fusion/run.ts`'s `needsGate` check), so there is no pass/fail signal to
  compare fused-vs-single on. A genuine uplift interval needs a `code_diff` (or
  `tests`) activation against a calibration-corpus task PLUS a single-model baseline
  run on the same task — real git-worktree gate execution, roughly double the spend
  of what was budgeted here. Not attempted without checking back in first (see below).
  User decision: record the gap, do not spend further quota chasing an uplift number.

## 4. Real login + F-Loop approve from a second machine over tailnet (REQ-15, REQ-18.3/19/20)

**Recorded gap (found, not built, during this task):** investigated whether a real
`platform loop run` (live or stub) could ever be F-Loop-approvable in production —
verdict: **no, not with existing wiring**, for two independent, stacking reasons:
1. `createHumanPlaneServer` (`core/src/human/api.ts:224`) IS constructed by
   `runSupervisedLoop` on every run (`console/backend/src/loop-run.ts:337`), but its
   `approvals` Map is always `new Map()` (`loop-run.ts:341`) and NOTHING in
   production ever calls `.set()` on it — `buildApprovalPackage`
   (`core/src/human/approval.ts:62`) has exactly two callers in the whole repo, both
   test files. `governanceProposals` (the other `/approvals` source) is likewise
   never wired from `bin/platform.ts`. So `GET /api/loop/:run/approvals` returns `[]`
   unconditionally for any run this CLI ever starts — there is no id for a click to
   act on. Task 8's own recorded browser-verify evidence achieved a non-empty
   approvals list by hand-seeding the Map exactly the way `app-loop.test.ts`'s
   `makeLiveRun()`/`pkg()` helpers do — a demonstration of the HTTP layer, not proof
   the CLI ever produces one.
2. Separately: `runTaskLoop` never suspends for human input (`core/src/orchestrator/loop.ts:276`
   returns immediately on reaching REVIEWING) and `runAutoMerge` runs automatically,
   unconditionally, right after REVIEWING (`loop-run.ts:414`) — BEFORE any human
   could act. Its OWN policy gate (`decideAutoApprove`, pure function of risk
   class/gate-greenness/golden-ACs/dep-touch) decides merge vs. decline; a human
   "approve" click today only appends `TASK_STATE:APPROVED` (`loop-run.ts:304-310`)
   and nothing continues from there — no re-invoked merge, no `AUDIT_RESULT`. This
   predates task 13; tasks 5/6/8 were marked `[x]` on CI evidence that (correctly)
   proved each PIECE in isolation with hand-fed fixtures, never this end-to-end path.

Building the missing glue (populate the approvals Map on an auto-merge decline, then
actually continue the pipeline after a human decision) is genuinely new orchestration
logic for a state transition this project's own state machine never finished wiring —
not a live-task fix, the same category of decision as the fusion planner-auto-router
gap in step 3. Not attempted without user sign-off.

- [ ] NOT COMPLETED — blocked on both the gap above and a second physical device
      never becoming available on the tailnet during this session. Tailscale itself
      connected fine (this machine: `100.72.196.35`, `tailscale status` shows
      Connected) — the blocker is the approvals-pipeline gap, not the network.
- Carried to backlog: (a) close the approvals-Map + continuation gap above (own
  bugfix spec — real repo-state consequences deserve requirements/design, not
  live-session improvisation); (b) once closed, repeat task 8's own browser-verify
  method with a real second device over this tailnet instead of loopback.

## 5. One real auditor sample (REQ-14.7)

Needed a genuine auto-merged task first — `platform loop run --live` reaching
REVIEWING always requires human approval in every contract this repo ships (no
`risk` field = defaults to L2, `core/src/merge/auto-merge.ts:85`), and step 4 above
found that pipeline dead-ends today. Rather than build the missing continuation
glue just to reach one sample, used the auto-merge policy's OWN automatic path
instead — genuinely built, genuinely wired, zero gap: `decideAutoApprove` merges
directly, no human step, when risk is L0/L1 + gates green + every AC is
golden-backed + no dependency-manifest touch (`auto-merge.ts:84-105`).

- [x] `.ai/calibration/fixture-goal-l0.yaml` — the Phase-1 fixture goal, unchanged
      objective/AC/budget, with an explicit `risk: L0` added (own file; the
      original `fixture-goal.yaml` stays untouched, still documented as reaching
      REVIEWING, in case the calibration harness or a future session depends on
      that exact behavior)
- [x] Found and fixed, in passing: `platform loop run`'s fixture repo (`fx.root`/`fx.wt`)
      was **unconditionally** deleted in `runSupervisedLoop`'s `finally` block, live
      or stub, persistDir or not (`loop-run.ts`'s own comment: "fixture root is rm'd
      in finally; persistDir survives" — only events.db/evidence survived, never the
      actual repo) — meaning NO `platform loop run` invocation, ever, left behind
      anything `platform auditor run --repo` could point at. Fixed with a real `git
      clone` (not a raw copy — `fx.wt` is a linked worktree whose `.git` depends on
      `fx.root`'s metadata) of the post-merge worktree into `<persistDir>/repo`,
      best-effort, only when `persistDir` is set. Verified FREE first (FakeAdapter,
      in-process, zero quota) before spending anything live.
- [x] Live run: 3 attempts BLOCKED (`claim:BLOCKED`, the model asking for
      `read_repository_files`/`read_file`/`list_directory` — reasonable given it
      never sees the target file's current content, but no read tool exists in this
      propose-only harness; recorded honestly, not a code defect — same class of
      variance Phase 1's own RUNBOOK hit on its first live attempt), attempt 4
      **COMPLETED** (2 iterations: round 1 asked for a tool, rejected;
      round 2 proposed `WRITE_FILE src/impl.txt` directly) — `AUTO_APPROVED` fired,
      merge landed (`fc5ccbb`), a real `AUDIT_RESULT` event appended.
      Run dir: `~/.ai/runs/RUN-1783518939757/`.
- [x] `platform auditor run --db ~/.ai/runs/RUN-1783518939757/events.db --repo
      ~/.ai/runs/RUN-1783518939757/repo` → `T-1  reproduced  mergeCommit=fc5ccbb2ec02
      original=blob://45dee...892d0f  rerun=blob://45dee...892d0f` — original and
      rerun gate-evidence hashes are BYTE-IDENTICAL, a genuine, real reproduction
      from a clean re-clone, not a fixture. Verdict: **PASS**
- Source changes this step made (additive, 216/216 console/backend tests green,
  6/6 packages typecheck clean): `console/backend/src/loop-run.ts` (persist a real
  clone of the post-merge repo when `persistDir` is set).

---

Phase 3 closes: steps 1/2/3/5 PASS on their final record, with every intermediate
FAIL root-caused honestly above (never patched around in a verdict) — matches the
Phase 1 precedent this document mirrors. Step 4 (F-Loop approve from a second
machine) is the one item genuinely **not completed**: Tailscale itself connected
without issue (this machine joined the tailnet cleanly; a second device never
became available during this session), but the real blocker sits one layer
underneath — the REVIEWING→human-approval→merge continuation pipeline was never
actually wired end-to-end in production code, despite tasks 5/6/8 shipping `[x]`
on CI evidence that (correctly, at the time) proved each piece in isolation with
hand-fed fixtures. This is a pre-existing gap task 13 discovered, not one it
caused, and closing it properly means a requirements/design pass on a real state
machine transition — not something to improvise mid-live-session. Recorded here,
carried to backlog as its own follow-up (`/spec-bugfix`), not silently dropped.

Known non-blocking residuals carried to the backlog (this task, in addition to
Phase 1's own carried items):
1. **F-Loop approvals pipeline** (step 4) — `approvals` Map/governance-proposals
   never populated from a real CLI run; a human decision, even once reachable,
   dead-ends without re-invoking the merge continuation. Own bugfix spec.
2. **Fusion uplift number** (step 3) — the 3 live activations proved the
   mechanism, not a `computeFusionCalibration` interval (no artifact with gate
   evidence was activated within the conservative 3-activation budget). Needs a
   `code_diff`/`tests` activation + single-model baseline on the SAME calibration-
   corpus task, roughly double this task's fusion spend.
3. **Fusion "policy trigger" auto-routing** (step 3) — `loop-run.ts` never
   actually routes a live planner-role proposal through `runFusion` autonomously;
   only the agent-invoked `fusion.deliberate` seam is real. Task 3's own deviation
   note describing the auto-router as "the live-only trigger exercised in task 13"
   was aspirational, not yet true.
4. Phase 1's own carried items (repair-round token usage uncounted against
   budget; frozen `nowMs` never trips the wallclock budget) — unchanged, still open.
