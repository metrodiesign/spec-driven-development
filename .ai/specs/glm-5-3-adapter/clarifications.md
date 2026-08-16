# Clarifications: glm-5-3-adapter

> Status: draft 2026-08-16 — answers below bind the requirements; agent-chosen
> defaults (D1–D4) were not individually confirmed by the operator at question
> time and can be overridden at the requirements approval gate.

## Workflow choice

**Requirements-First** (Requirements → Design → Tasks). The target behavior is
known and precedented (INV-8 checklist in `adapters/src/_template.ts`; phase-3
REQ-2/REQ-3 delivered `codex.ts` the same way), and the architecture is already
dictated by the rings + `wire.ts` helpers — there is no open architectural
question that Design-First would need to answer first.

## Upstream + binding inputs

- `unified-platform-spec.md` **v1.11** §7.6 (adapter slot `adapters/openai-compatible.ts`,
  GLM-5.3 + compat), §7.4 (target defaults: Test Designer GLM-5.3, Reviewer
  ensemble + GLM-5.3 — only after conformance), INV-5 (never self-retry),
  INV-7 (vendor names Ring 2 only), INV-8 (adapter = wire translation only,
  pass P1–P8, register; never touch Ring 0/1).
- Deferral history: v1.2/v1.3 deferred GLM-5.2 for "no access"; v1.11 records
  access as real (GLM-5.3, 2026-08-14, GLM Coding Plan/ZCode) — this spec is
  the recorded condition being executed.
- Model facts (source: z.ai/blog/glm-5.3, binding design inputs):
  - Same base model as GLM-5.2; all gains from post-training; open-weights.
  - Context **1M tokens**, max output **128K** → `contextWindowTokens: 1_000_000`.
  - **`thinking.type: "disabled"` is removed** — the request MUST carry
    `reasoning_effort` (`low`/`high`/`max`); thinking is always on.
  - OpenAI-compatible chat-completions API at `https://api.z.ai/api/paas/v4`.
- Precedent: `.ai/specs/archive/platform-phase3/` (REQ-2 codex adapter, REQ-3
  conformance, LIVE task as its own manual task). All CI evidence from fakes.

## Operator decisions (from the 2026-08-16 session)

- **Scope: build the adapter for real** ("ยกเลื่อน + สร้าง adapter เลย") — full
  spec-first flow with approval gates, not a docs-only change.
- **Secondary specs synced** to GLM-5.3 (done in the same branch, commit
  `docs(spec)` v1.11 sync).

## Agent-chosen defaults (flagged — override at the requirements gate if wrong)

- **D1 — identity:** `adapterId: 'glm'`, `lineage: 'zai'`, `model: 'glm-5.3'`.
  Version-agnostic ids match the codex pattern (`id: 'codex'` + separate
  `model`); the model version is recorded in `adapterMeta.modelVersion` and the
  conformance record. Lineage `'openai'` is already taken by codex, and GLM via
  the Z.ai API is a distinct vendor lineage for fusion decorrelation.
- **D2 — registration scope (round 1):** conformance CLI (`platform conformance
  --live --lineage zai`) + `tokenBuckets` entry only. PR-gate reviewer slotting
  and loop composition threading are explicitly OUT of scope (follow-up work —
  loop is Claude-only today and threading a second lineage through `runLoop`
  is a separate console/backend change).
- **D3 — endpoint:** default `https://api.z.ai/api/paas/v4/chat/completions`
  with a base-URL override through an env var (no code change needed to point
  at another OpenAI-compatible endpoint later; aggregator use remains subject
  to `provider_data_policy` per §7.6).
- **D4 — LIVE task:** in scope but conditional — it runs only when a Z.ai API
  key is available in the environment; otherwise it stays an open task exactly
  like phase-3's LIVE task pattern. Coding Plan/ZCode access does not by itself
  guarantee API quota.

## Assumptions

- **B1 Branch/PR:** work lands on `feat/glm-5-3-adapter` (already created off
  `origin/develop`), PR back to `develop`, squash merge.
- **B2 Env key name:** `ZAI_API_KEY`; base-URL override `ZAI_BASE_URL`
  (defaults to the Z.ai endpoint when unset).
- **B3 No `core/` or `aal/` source changes.** The conformance-CLI allowlist
  edit is `console/backend/bin/platform.ts` (composition root). The live seam
  is in-process `fetch` (no child process), so `control.ts`'s
  `providerEnvironment` is NOT extended this round — `ZAI_API_KEY` is read
  only inside the Ring-2 live module (REQ-3.2).
- **B4 fusion-profiles.json untouched** — adding `'zai'` to cross-lineage
  panels changes live fusion behavior and is a separate governance decision.
