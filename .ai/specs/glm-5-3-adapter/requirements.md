# Requirements: glm-5-3-adapter — GLM-5.3 via an OpenAI-compatible Ring-2 adapter

> Status: approved 2026-08-16, amended 2026-08-16 (EARS grammar fixes required by spec-trace — 2.7/5.4/8.2/8.3 reworded, no semantic change)
> Upstream: unified-platform-spec.md v1.11 §7.4/§7.6 (GLM deferral lifted) + invariants §2
> (INV-5 no self-retry, INV-7 vendor-free Ring 0/1, INV-8 adapter = wire translation only).
> User decisions binding: clarifications.md (D1–D4 are flagged agent defaults, overridable at this gate).

## Overview

This spec executes the condition recorded since v1.2/v1.3 and resolved by v1.11:
GLM access is real (GLM-5.3, released 2026-08-14), so the platform gets its
third vendor lineage as an OpenAI-compatible chat-completions adapter —
`adapters/src/openai-compatible.ts` — under the same propose/dispose safety as
the existing adapters. Identity (D1): `adapterId: 'glm'`, `lineage: 'zai'`,
`model: 'glm-5.3'`. Scope (D2): conformance CLI + routing policy entry only;
PR-gate slotting and loop composition threading are follow-ups. All CI
evidence comes from fakes; live evidence comes from the LIVE task (D4),
conditional on a Z.ai API key.

Binding model facts (z.ai/blog/glm-5.3): context 1M tokens / max output 128K;
thinking always on — `thinking.type: "disabled"` is removed, so every request
MUST carry `reasoning_effort` (`low`/`high`/`max`).

## REQ-1: OpenAI-compatible adapter core (`adapters/src/openai-compatible.ts`)

**User Story:** As the platform operator, I want a third-lineage adapter that
proposes structured actions without executing, so the router gains a real
quota-survivability escape hatch and fusion gains a decorrelated lineage.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL provide `createOpenAICompatibleAdapter(opts)` implementing `AdapterInterface` (`manifest()` + `send()`) with an injected HTTP transport seam, so unit tests are hermetic (CI spends zero quota)
- 1.2 THE SYSTEM SHALL declare the manifest as `adapterId: 'glm'`, `structuredOutput: true`, `toolCalling: false`, `contextWindowTokens: 1_000_000`, `executionBackend: false`, `determinism: 'none'`, `lineage: 'zai'`
- 1.3 THE SYSTEM SHALL build the prompt with `buildProposePrompt(req, { fenceGuard: true })` (the Z.ai path has no wire-level schema enforcement equivalent to codex `--output-schema`) and parse the reply with `unfence` + `normalizeActions`
- 1.4 WHEN `send()` receives a `requestId` that already has a file in the durable replay dir THE SYSTEM SHALL return the recorded response without invoking the transport (P8 — a crash-resume retry cannot double-burn quota)
- 1.5 WHEN the transport throws THE SYSTEM SHALL throw a typed `AdapterError` classified via `classifyAdapterError` and SHALL NOT self-retry (INV-5)
- 1.6 WHEN `control.signal` is already aborted THE SYSTEM SHALL throw `cancelled` without invoking the transport; WHEN the timeout elapses mid-call THE SYSTEM SHALL throw `timed_out`
- 1.7 WHEN the reply text is not fenceable JSON THE SYSTEM SHALL set `structuredResult = { raw: <text> }` with zero actionRequests instead of throwing (the source repair loop handles it)
- 1.8 WHEN usage numbers are missing or non-finite THE SYSTEM SHALL throw `AdapterError('invalid_response')`
- 1.9 THE SYSTEM SHALL bill `costUnits` as `(prompt + completion tokens) / 1000 * costUnitsPer1k` (default 1) and pass unknown usage fields through in `usage.raw`

## REQ-2: Z.ai live seam (`adapters/src/openai-compatible-live.ts`)

**User Story:** As the platform operator, I want the real endpoint wiring kept
out of the unit-tested core, so a live network path exists only where it is
deliberately imported.

**Acceptance Criteria (EARS):**
- 2.1 THE SYSTEM SHALL provide `createLiveGlmAdapter(opts)` returning a configured adapter whose transport POSTs to the OpenAI-compatible chat-completions endpoint — default `https://api.z.ai/api/paas/v4/chat/completions`, overridable via `ZAI_BASE_URL`
- 2.2 WHEN `ZAI_API_KEY` is unset or empty THE live factory SHALL throw `AdapterError('auth_unavailable')` before any network call
- 2.3 THE SYSTEM SHALL send `model: 'glm-5.3'` and, in every request, `thinking: { type: 'enabled' }` plus `reasoning_effort` (default `high`, option-overridable to `low`/`max`) — GLM-5.3 removed `thinking.type: 'disabled'`, so omitting these is a wire error
- 2.4 WHEN the endpoint answers non-2xx THE SYSTEM SHALL throw an error whose message contains the HTTP status and response body text, so `classifyAdapterError` maps 429 → `quota_limited`, 401/403 → `auth_unavailable`, context-length errors → `context_limited`, and anything unmatched → `transport`
- 2.5 THE SYSTEM SHALL forward `control`'s AbortSignal/timeout to the fetch and classify abort/timeout per REQ-1.6
- 2.6 THE SYSTEM SHALL read the reply from `choices[0].message.content` and usage from the `usage` object (`prompt_tokens`, `completion_tokens`, plus unknown extra fields passed through as raw); WHEN the body is 2xx but has no usable choice THE SYSTEM SHALL throw `AdapterError('invalid_response')`
- 2.7 THE SYSTEM SHALL keep the live module import-free from every CI test path (same discipline as `codex-live.ts`)

## REQ-3: Credential hygiene

**User Story:** As the security plane, I want the Z.ai key treated like every
other provider credential, so no path leaks it into durable artifacts.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL read `ZAI_API_KEY` only inside the Ring-2 live module and SHALL NEVER include it in error messages, evidence blobs, replay files, transcripts, or conformance records
- 3.2 THE SYSTEM SHALL NOT extend `providerEnvironment` in `control.ts` in this round — the fetch seam runs in-process (no child-process env boundary); a future spawn-based wiring must add the key to `ProviderEnvironmentKey` at that time

## REQ-4: Ring-2 discipline + exports

**User Story:** As the invariant owner, I want the third lineage to land with
zero Ring 0/1 movement, so INV-7/INV-8 stay provable by the existing CI gates.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL export `createOpenAICompatibleAdapter` and `createLiveGlmAdapter` from `adapters/src/index.ts`
- 4.2 THE SYSTEM SHALL NOT import `core/executor` or any AAL internals beyond the public protocol types (INV-8)
- 4.3 WHEN `pnpm vendor-check` runs THE SYSTEM SHALL remain green with the vendor pattern unchanged (`glm`/`zai` strings appear only in Ring 2 and composition roots)

## REQ-5: Conformance in CI (fakes, zero quota)

**User Story:** As CI, I want the conformance gate exercised for the glm
adapter on every push, so the third lineage is held to the same P1–P8 bar
without spending provider quota.

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL pass conformance probes P1–P8 for the glm adapter against a compliant fake transport in `adapters/src/openai-compatible-conformance.test.ts`
- 5.2 WHEN a sabotaged fake transport returns prose without actions THE SYSTEM SHALL fail exactly probe P2 and no other
- 5.3 WHEN a conformance record is re-registered after a regressed re-run THE SYSTEM SHALL mark the adapter `stale` via the registry gate (same discrimination self-test as codex)
- 5.4 THE SYSTEM SHALL provide unit tests in `openai-compatible.test.ts` covering: manifest shape, replay idempotency (transport called once), usage math, the error matrix (429/401/403/context-length/unmatched non-2xx), abort/timeout, non-JSON → `{ raw }`, and WRITE_FILE inline content → `contentRef`

## REQ-6: Conformance CLI support

**User Story:** As the operator, I want `platform conformance` to know the new
lineage, so the LIVE gate for glm is runnable with the same guards as codex.

**Acceptance Criteria (EARS):**
- 6.1 THE SYSTEM SHALL accept `--lineage zai` in `platform conformance` (allowlist + construction branch in `console/backend/bin/platform.ts`) and SHALL refuse an unknown lineage before any live spend
- 6.2 WHEN live conformance runs for zai THE SYSTEM SHALL use a per-run, never-reused replay dir and persist the record at `.ai/calibration/conformance-glm-<stamp>.json`

## REQ-7: Routing policy entry (governance change)

**User Story:** As the governance plane, I want the new lineage rate-limited
before it ever serves traffic, so a runaway loop cannot burn Z.ai quota
unbounded.

**Acceptance Criteria (EARS):**
- 7.1 THE SYSTEM SHALL add a `glm` entry to `tokenBuckets` in `.ai/policies/routing.json` with the same defaults as existing lineages (capacity 4, refillPerSec 0.5) — a POLICY_FILES change, human-approved via PR review by construction
- 7.2 THE SYSTEM SHALL NOT modify `fusion-profiles.json` (adding `'zai'` to cross-lineage panels changes live fusion behavior — separate governance decision, follow-up)
- 7.3 THE SYSTEM SHALL NOT add a per-adapter `provider-data-policy.json` entry for the direct Z.ai endpoint (the default policy covers it — no extra data processor); WHEN an operator overrides `ZAI_BASE_URL` to an aggregator THEN a policy amendment per §7.6 is required before that path is legal

## REQ-8: LIVE conformance (manual task, conditional on key)

**User Story:** As the drift canary, I want a real recorded live run, so
"GLM-5.3 passed" is evidence, not assertion.

**Acceptance Criteria (EARS):**
- 8.1 WHEN a Z.ai API key with quota is available THE OPERATOR SHALL run `platform conformance --live --lineage zai` (TTY, confirmation phrase) and the task SHALL record per-probe results + the persisted record path as evidence
- 8.2 IF no key/quota is available THEN THE SYSTEM SHALL record the task as remaining open (phase-3 LIVE pattern) with REQ-5 CI readiness as this round's delivered evidence
- 8.3 WHEN REQ-8.1 lands THE SYSTEM SHALL treat the §7.4 routing-default flip (Test Designer → GLM-5.3, Reviewer ensemble + GLM-5.3) as follow-up work outside this spec's code scope (D2)

## Edge Cases & Open Questions

- **Usage field drift:** Z.ai may add reasoning-token detail fields to `usage`;
  parse the two load-bearing token counts defensively and pass everything
  else through raw (REQ-1.9) instead of asserting a fixed shape.
- **2xx with empty `choices`:** treated as `invalid_response` (REQ-2.6), never
  as a successful empty proposal.
- **`reasoning_effort` vs `determinismHint`:** this round pins a static
  default (`high`); mapping request-level hints to effort is follow-up.
- **Aggregator base URL:** allowed mechanically by `ZAI_BASE_URL` but gated by
  `provider_data_policy` (REQ-7.3) — not usable out of the box.
