# Clarifications — platform-phase3

> Mode: user-gated. Spec source of truth: `unified-platform-spec.md` v1.2 in-repo
> (§0.1) — v1.2 amendment (commit 8bc8392) rescoped Phase 3 before this spec was
> opened. The scope/adapter/deliverable decisions and the four numbered decisions
> below were answered by the USER directly (2026-07-07/08); the rest is answered
> from the spec.

## Workflow chosen

Design-First (Design -> Requirements -> Tasks), same as Phases 0–2. Architecture
is fixed by the spec (§7.5 fusion pipeline + resolve rules, §7.3 conformance,
§6.5 merge queue/auditor rows, §10.4 learning shadow, §10.3 Human Plane API,
§13 auth gate/providers/hardening, §8 F-Loop/F-Sched rows, §14 Phase 3) — the
work is transcription onto the Phase-2 codebase, not architecture discovery.

## Pre-spec gates already passed

- **SPIKE-6 (docs/spikes/SPIKE-6.md): PASS** — `codex exec` headless returns
  schema-conforming proposals without executing (`--sandbox read-only` +
  `--output-schema`), bills to ChatGPT subscription, per-turn usage in JSONL.
  Caveats binding on the adapter design: stdin must be closed on spawn; NO
  headless quota signal (breaker for the codex lineage = error-rate-only);
  full config independence via `--ignore-user-config`/`-c`/`--ephemeral`;
  events do not echo model id (adapter records requested model itself).
- **unified-platform-spec v1.2** recorded: second lineage = Codex only;
  GLM-5.2 deferred to Phase 4 conditional on access; §5.3 non-interactive-usage
  policy review is an explicit gate before enabling fusion.

## Scope of this spec (§14 Phase 3, v1.2)

- Multi-model substrate: `adapters/codex.ts` + `adapters/_template.ts` (carried:
  arrives with second adapter) + FakeCodexAdapter in aal (CI stays fake-only,
  never spends quota) + conformance P1–P8; multi-lineage routing — lineage
  metadata, activation of the injection-aware routing no-op slots, per-provider
  token bucket + parallel dispatch (carried from Phase 2 deferral)
- Fusion plane (§7.5): PANEL -> EVIDENCE -> ANALYZE -> RESOLVE -> CAPTURE with
  per-artifact resolve rules (evidence-tournament for code — judge never
  overrules gate=0, no code synthesis; union+RED-check for tests; union+rank
  for hypotheses; weighted ensemble for reviews); entry via virtual `fusion:*`
  adapter / policy trigger / `fusion.deliberate` (budget cap, depth <= 1);
  decorrelation + uplift measurement into calibration (§12)
- Merge queue + T2 gate tier (carried: "T2 arrives with merge queue") +
  out-of-band auditor as a SEPARATE process runtime sampling COMPLETED tasks,
  re-running gates from clean checkout; flaky (retry-and-flag) distinguished
  from true non-repro
- Learning plane shadow (§10.4): outcome routing off -> shadow only (log
  would-be choice + retrospective compare); active = Phase 4; freeze on drift
  canary
- Console: F-Loop (client of the existing Human Plane API — approvals/
  steer/kill/task graph/latest calibration; owns no state, INV-11) + F-Sched
  (start/stop loop process or opaque scripts ONLY — no task scheduling/lease;
  reuses Phase-2 `guards.ts` + first-enable confirmation)
- Remote auth §13: provider plumbing + Basic (scrypt hash, stateless HMAC
  session token, rate-limit, generic 401) + Google OIDC (discovery, public
  PKCE S256, iss/aud pinning, refresh/revocation) + §13.3 hardening sweep as
  executable tests where possible
- Carried items ALL IN scope (decision #4): MCP OAuth browser round-trip
  (F-MCP), steering inject-without-pause, real-repo auto-merge (stretch in the
  LIVE task, not DoD), symbol-level COMPRESS upgrade for the context builder
- NOT in scope: GLM-5.2 / `adapters/openai-compatible.ts` (Phase 4, access-
  conditional — v1.2), F-Chat, lessons active, outcome routing ACTIVE, canary
  deploy, issue intake (Phase 4); F-Sys "update" action (decision: OUT)

## User decisions (2026-07-07/08)

1. **Remote exposure: Tailscale/VPN-only.** Console binds on the tailnet
   interface; no public internet surface. The §13 auth gate + providers still
   run in full (defense in depth) — DoD "login/approve from another machine"
   is satisfied over the tailnet from a real second device.
2. **Auth providers: Basic first, Google OIDC as the last auth task.** Basic
   alone already satisfies the remote-login DoD; Google OIDC (real discovery +
   PKCE, free, no self-hosted service to maintain) lands late so it never
   blocks other work.
3. **Fusion live budget: conservative, ~3 activations.** Self-panel
   (seed/temp diversity) proves the pipeline first, then 2–3 cross-vendor
   activations on calibration tasks. Uplift reported as an interval (small n,
   §12). Hard cap in `fusion-profiles.yaml` costUnits; manual-trigger only,
   never CI.
4. **Carried items: all four IN scope** — MCP OAuth round-trip, steering
   inject-without-pause, real-repo auto-merge stretch, symbol-level COMPRESS.
   (User chose completeness over the recommended deferral of symbol-level
   COMPRESS — quality over cost, consistent with prior phases.)

## Defaults accepted without objection (recorded)

- **F-Sys "update" action = OUT** (parked open question from Phase 2; triggering
  `claude update` from a web surface is a security decision — stays out).
- **Calibration corpus: 10 tasks minimum** for uplift numbers; growth toward 20
  is opportunistic, not DoD.
- **GLM deferral record = spec changelog v1.2** (done; no DEVIATIONS entry —
  DEVIATIONS records divergence from spec, and the spec itself was amended).

## Assumptions (decided here, recorded — reversible)

- **B1 Branch/PR:** work lands on `feat/platform-phase3` off `develop` (branch
  already carries the v1.2 amendment + SPIKE-6), PR back to `develop`.
- **B2 Live quota policy carried forward:** dev/test/CI run against fake
  adapters only (FakeAdapter + FakeCodexAdapter); LIVE runs are manual-trigger
  with costUnits caps, never CI; live replay/cache is per-run and never
  committed (Phase-1 lesson).
- **B3 Fusion enable gate:** the §5.3 Anthropic non-interactive-usage policy
  review is a HUMAN gate executed inside the LIVE task before the first real
  fusion activation; its outcome is recorded in the run evidence.
- **B4 Codex lineage health:** no quota probe exists (SPIKE-6) — the breaker
  for `codex@<model>` operates on error-rate only; this is recorded as a
  documented residual, not silently assumed parity with the Claude probe.
- **B5 INV-16 residual:** first live Codex conformance may re-hit the
  wire-vocabulary lesson from Phase 1 — fixes belong in the Ring 2 prompt
  vocabulary, never in weakened verdicts; the sabotage discrimination
  self-test must stay green.
- **B6 DoD (from §14 v1.2):** fusion shows uplift from calibration + auditor
  catches non-repro + F-Loop approves an approval package from the web +
  security checklist §13.3 complete + real login/approve from another machine
  (over tailnet) — gate numbers from Calibration (§12).
