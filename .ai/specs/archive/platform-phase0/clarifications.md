# Clarifications — platform-phase0

> Mode: goal-driven autonomous run (user delegated end-to-end via /goal).
> Questions answered from `unified-platform-spec.md` (v1.1, normative) — not guessed.
> Anything the spec does not decide is listed under Assumptions and is reversible.

## Workflow chosen

Design-First (Design -> Requirements -> Tasks). Architecture is fixed by the spec
(3 Rings x 4 Planes, INV-1..17); the work is transcription into an implementable
design, not architecture discovery.

## Scope of this spec

- SS15 spikes (1-5) as runnable scripts + recorded results (gate for Phase 1, run early per SS17)
- Phase 0 per SS14: Deterministic Core (executor+egress, event log+lease, gate ladder
  T0-T1 with T2/T3 stubs, golden harness) driven by a stub agent through the
  9-item fault-injection DoD (tests written FIRST — RED before core turns them GREEN)
- Console Foundation: `platform console` launcher, F-Proj, F-Sess (read), F-Auth
  (detect + warn env shadowing), F-Usage mini card, F-Status
- NOT in scope: anything Phase 1+ (AAL runtime, real adapters, F-Term/PTY, context
  builder, approval packages). Interfaces may be *declared* per SS7 ("interface
  วางได้ตั้งแต่ Phase 0") but no runtime wiring to Claude.

## Q&A (from spec)

1. **Who is the user?** Single operator, owner of the Claude Max 20x account,
   running the platform on their own machine (SS0 context, INV-15 single-operator).
2. **What do they want (Phase 0)?** A deterministic core proven safe against a lying
   / over-reaching /flaky /crashing agent BEFORE any real model is connected, plus a
   local web console that shows projects/sessions/auth-shadowing/quota estimate
   (SS14 Phase 0 DoD).
3. **Success criteria?** Fault-injection scenarios 1-9 all pass as tests; console
   starts, lists projects/sessions, red-warns when `ANTHROPIC_API_KEY` shadows
   subscription; spikes 1-5 have recorded pass/fail evidence (SS14, SS15).
4. **Edge cases?** Defined by the fault-injection list itself (crash between
   INTENT/APPLIED, duplicate actionId, lease contention, budget exhaustion...) and
   SS13.1 fail-closed console gate (non-loopback bind without auth provider -> refuse start).
5. **Constraints?** INV-1..17; core/ vendor-name-free (CI-checked, INV-7); egress
   default-deny (INV-14); fail-closed (INV-15); append-only event log (INV-10);
   no shadow state of Claude Code (INV-11); tests before implementation (SS0.4).

## Assumptions (decided here, recorded — reversible)

- **A1 Repo layout:** this repo acts as the `platform/` root of SS14 — `core/`,
  `aal/`, `adapters/`, `console/`, `src/`, `test/` created at repo root beside the
  existing framework dirs; spec copied to `./unified-platform-spec.md` (SS14 shows it
  at root). Framework `.ai/` coexists: platform runtime data uses the SS14 `.ai/`
  paths (`.ai/policies/`, `.ai/schemas/`, `.ai/calibration/`, `.ai/runs/`) which do
  not collide with framework files.
- **A2 Stack:** TypeScript strict on Node 26 + pnpm workspaces. Test runner =
  `node:test` (builtin); SQLite = `node:sqlite` (builtin, WAL) — zero new runtime
  deps for core, per CODING_STANDARDS dependency rules. Console backend = Fastify
  (SS14 names Fastify/Hono; pick one), web = React SPA (SS14) built with Vite.
- **A3 Phase 0 F-Sess reads `~/.claude/projects/*.jsonl` directly** (read-live,
  INV-11); SDK `listSessions` path is spike 1 and becomes primary in Phase 1.
- **A4 Spikes 2/4/5 need the live `claude` login + quota on this machine**; they are
  executed here with minimal prompts and results recorded in `docs/spikes/`. If an
  interactive-only step blocks (e.g. reading `/usage` visually), the spike records
  PARTIAL with exact manual step remaining — never claimed as passed.
- **A5 Approval gates:** user delegated end-to-end via /goal; each artifact is
  adversarially reviewed by the `spec-architect` subagent (fresh context) before its
  status flips, and the status line records `approved (goal-mode, spec-architect
  review)` — the review replaces the absent human at the gate, honestly labeled.
