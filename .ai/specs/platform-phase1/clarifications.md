# Clarifications — platform-phase1

> Mode: goal-driven with user checkpoints. Spec source of truth confirmed by user
> (2026-07-06): `unified-platform-spec.md` v1.1 in-repo — the older
> `loop-engineering-implementation-spec.md` in Downloads is superseded (spec §0.1).
> The four scope decisions below were answered by the USER directly; the rest is
> answered from the spec.

## Workflow chosen

Design-First (Design -> Requirements -> Tasks), same as Phase 0. Architecture is
fixed by the spec (§7 AAL protocol, §5.2 adapter, §4.1 F-Term PTY parity, P1–P8
conformance) and by verified spike evidence (D-004: `tools: []` +
`settingSources: []`); the work is transcription onto the existing Phase-0
codebase, not architecture discovery.

## Scope of this spec (§14 Phase 1)

- Ring 1 AAL: `AgentRequest`/`AgentResponse` envelope, capability manifest +
  fallback matrix, registry/router skeleton (single adapter), conformance suite
  P1–P8 (drift-canary re-runnable)
- Ring 2: `adapters/anthropic.ts` — primary adapter over Agent SDK `query()`
  (`tools: []` + `settingSources: []` per D-004), propose-only (INV-9/P6)
- Context builder v1 (SEED → EXPAND → COMPRESS → GOVERN → MARK → MANIFEST)
- Approval package + Human Plane API (approve/reject at task level)
- One supervised loop end-to-end, measured by core — first calibration numbers
- Console: F-Term (100% CLI parity via PTY, node-pty proven in SPIKE-2), F-Set,
  F-Perm, F-Auth full, F-Mem, F-Usage full, F-Act, F-Sess search
- NOT in scope: Phase 2+ (breaker/degraded, hypothesis repair, steering,
  auto-merge, canary/data-govern beyond Phase-1 subset), Codex/GLM adapters,
  fusion, merge queue, auditor, learning plane

## User decisions (2026-07-06)

1. **Scope cut:** ONE spec covering all of Phase 1 (console + autonomous share
   substrate/events; same all-in-one-session batching that worked for Phase 0).
2. **Live quota policy:** manual trigger + budget cap. Dev/test run against a
   stub adapter everywhere including CI; LIVE conformance/loop runs are launched
   manually only (never CI), each with a `costUnits` cap from `goal.yaml`.
3. **F-Term exposure:** loopback-only, HARD. F-Term refuses every non-loopback
   bind even under `--insecure` (INV-17 full-shell risk); other console views
   keep the existing fail-closed gate semantics.
4. **First supervised loop target:** synthetic fixture repo (same harness family
   as fault-injection, human-written golden) — clean, repeatable first
   calibration numbers under controlled quota. Real scratch-repo feature is a
   later stretch, not Phase-1 DoD.

## Assumptions (decided here, recorded — reversible)

- **B1 Branch/PR:** Phase 1 work lands on `feat/platform-phase1`, stacked on
  `feat/platform-phase0` until PR #41 merges, then rebased onto develop.
- **B2 AAL package:** new `aal/` pnpm workspace (Ring 1), vendor-name-free like
  core (extend `check-core-vendor-free.sh` coverage to `aal/`); `adapters/` is a
  separate workspace where vendor names are legal (Ring 2).
- **B3 Core unchanged in principle (INV-8):** AAL implements `ProposalSource`
  from `core/src/ports.ts`; core additions are limited to what §14 Phase 1 names
  (approval package/Human Plane hooks), each entering through the same
  RED-first discipline.
- **B4 PTY dependency:** `node-pty` (SPIKE-2 preflight passed on Node 26) added
  to console/backend only, `allowBuilds` entry in `pnpm-workspace.yaml`.
- **B5 Live-run evidence:** every manual live run records its transcript ref +
  usage into the event log/evidence store like any other run — no unrecorded
  quota spend.
- **B6 Approval gates:** user reviews each artifact (design → requirements →
  tasks) before the next; spec-architect subagent adversarial review runs before
  every status flip, recorded in the status line.
