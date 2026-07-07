# Clarifications — platform-phase2

> Mode: user-gated (decision #4). Spec source of truth: `unified-platform-spec.md`
> v1.1 in-repo (§0.1). The four scope decisions below were answered by the USER
> directly (2026-07-07); the rest is answered from the spec.

## Workflow chosen

Design-First (Design -> Requirements -> Tasks), same as Phase 0 and Phase 1.
Architecture is fixed by the spec (§9.3 hypothesis repair, §10.1 security plane,
§10.2 breaker/degraded + quota-aware routing, §10.3 steering, §8 Console F-* rows,
§14 Phase 2) — the work is transcription onto the existing Phase-1 codebase, not
architecture discovery.

## Scope of this spec (§14 Phase 2)

- Security plane full: injection canary (runtime tripwire), dependency policy
  (registry allowlist + lockfile + `--ignore-scripts`), data governance
  (`provider_data_policy`)
- Ops plane: circuit breaker per (adapter, model) closed/open/half-open,
  degraded-mode handling, quota-aware routing via probe (§5.4) — single adapter
  in Phase 2, so breaker-open with no eligible fallback = clean
  `BLOCKED(no_capacity)` (fallback lineages arrive Phase 3)
- Hypothesis-driven repair (§9.3): FAILED -> DIAGNOSING -> probes -> CONFIRMED
  patch / REFUTED -> ESCALATED with hypothesis log
- Auto-merge L0–L1 + sampling audit; meta-governance (INV-16 approval path);
  steering (§10.3 PAUSE_REQUESTED -> GUIDANCE_INJECTED -> RESUMED; AC/scope
  guidance = contract amendment)
- Console: F-MCP, F-Hook (builder/validator + consent gate), F-Sub, F-Skill,
  F-Sys + automation guards (INV-13 yield-to-interactive, 85% threshold default)
- Carried backlog from Phase-1 live pass (all four IN scope — decision #2):
  1. repair-round token usage not charged to budget
  2. frozen `nowMs` clock never trips the wallclock budget
  3. first attach after `--resume` create can render blank until re-attach
  4. nested claude under an agent-launched backend leaves no session JSONL
- NOT in scope: Phase 3+ (Codex/GLM adapters, fusion, merge queue, out-of-band
  auditor, outcome routing shadow, F-Loop, F-Sched, remote auth §13 beyond the
  existing gate), Phase 4 (F-Chat, lessons active, canary deploy)

## User decisions (2026-07-07)

1. **Scope cut:** ONE spec covering all of Phase 2 (autonomous + Console share
   substrate/events; all-in-one batching proven in Phase 0/1).
2. **Carried backlog:** all 4 items enter Phase 2 scope — items 1–2 touch the
   budget backstop that hypothesis repair / degraded mode must handle anyway;
   items 3–4 grouped as one F-Term/observability fix task.
3. **Auto-merge L0–L1 target:** synthetic fixture repo (same harness family as
   fault-injection, human-written golden) — real auto-merge with zero blast
   radius, clean calibration numbers. Real repo is a later stretch, not DoD.
4. **Approval gates:** human gate on every artifact (design -> requirements ->
   tasks), constitution default. May switch to goal-mode AFK mid-flight by
   explicit user instruction only.

## Assumptions (decided here, recorded — reversible)

- **B1 Branch/PR:** work lands on `feat/platform-phase2` off `develop`, PR back
  to `develop`.
- **B2 Live quota policy carried from Phase 1 decision #2:** dev/test/CI run
  against stub adapters only; LIVE runs are manual-trigger with a `costUnits`
  cap from `goal.yaml`, never CI.
- **B3 F-Term exposure unchanged:** loopback-only HARD (Phase 1 decision #3)
  stays; Phase 2 adds no remote surface (remote auth is Phase 3).
- **B4 Single-lineage survivability:** quota-aware routing is tested with the
  one registered adapter — breaker/probe behavior verified by stub fault
  injection; multi-lineage failover is Phase 3.
- **B5 DoD (from §14):** loop runs L0–L1 auto with sampling audit + breaker
  sidesteps quota/provider failure + hook/MCP/subagent created via Console
  produce valid files — gate numbers from Calibration (§12) + security
  checklist §13.3.
