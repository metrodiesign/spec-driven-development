# Requirements: opencode-glm — GLM-5.3 through the OpenCode CLI (fifth lineage)

> Status: draft 2026-08-16
> Upstream: unified-platform-spec.md v1.11 §7.4/§7.6 (multi-lineage routing, INV-8) + §5.4 quota-survivability rationale.
> Sibling spec: glm-5-3-adapter (PR #142, direct-API zai lineage). User decisions binding: clarifications.md (D1–D3 answered in-session; identity decisions follow existing conventions).

## Overview

The platform gains its fifth adapter lineage with near-zero new machinery:
GLM-5.3 served through the OpenCode Go gateway, driven by the existing
`opencode run --pure --format json` seam that `opencode-deepseek` already
proves in production. Identity: `adapterId 'opencode-glm'`, model
`opencode-go/glm-5.3`, lineage `'zai'` — deliberately shared with the
direct-API `glm` adapter because both serve the same model family and must
not be treated as decorrelated by fusion or susceptibility routing. Scope:
conformance CLI + LIVE run only (D2); the LIVE run is the point of this
spec — the credential already works on this machine, so "ทดสอบการทำงาน"
ends with a real P1–P8 record, not a deferred task.

## REQ-1: opencode-glm adapter (`adapters/src/reasoning-cli-live.ts`)

**User Story:** As the platform operator, I want GLM-5.3 reachable through
the OpenCode CLI on the credential this machine already holds, so the third
model family joins routing without waiting for Z.ai API balance.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL provide `createLiveOpenCodeGlmAdapter(opts)` returning a `reasoning-cli`-based `AdapterInterface` that spawns `opencode run --pure --format json --model opencode-go/glm-5.3 <prompt>` through the existing `ReasoningCliExec` seam
- 1.2 THE SYSTEM SHALL declare the manifest as `adapterId: 'opencode-glm'`, `lineage: 'zai'` (shared with the direct-API glm adapter — same model family, by design), `contextWindowTokens: 1_000_000`, `executionBackend: false`, `determinism: 'none'`, `structuredOutput: true`, `toolCalling: false`
- 1.3 THE SYSTEM SHALL reuse `createReasoningCliAdapter` unchanged — durable replay (P8), typed error classification, never self-retry (INV-5), and usage validation are inherited, not reimplemented
- 1.4 THE SYSTEM SHALL accept an option overriding the model id (default `opencode-go/glm-5.3`) so a future glm release or the zen gateway is a config change, not a code change
- 1.5 WHEN the opencode CLI exits non-zero THE SYSTEM SHALL throw a typed `AdapterError` classified from stderr via `classifyAdapterError` and SHALL NOT self-retry
- 1.6 THE SYSTEM SHALL apply a default kill timeout of 600 000 ms to the child process with SIGTERM-then-SIGKILL grace via the existing `terminateChild` helper

## REQ-2: Credential authentication inside the sandbox

**User Story:** As the security plane, I want the hosted-gateway credential
usable by the spawned CLI without loosening the deny-all config isolation,
 so untrusted content cannot influence OpenCode configuration.

**Acceptance Criteria (EARS):**
- 2.1 THE SYSTEM SHALL keep the existing deny-all config isolation for the spawned opencode process (permission deny, no plugins, no autoupdate — injected via `OPENCODE_CONFIG_CONTENT`, temp `HOME`/XDG dirs)
- 2.2 WHEN the OpenCode credential store exists at `<real data dir>/opencode/auth.json` THE SYSTEM SHALL make that credential available to the spawned process WITHOUT pointing the sandbox `HOME` or `XDG_DATA_HOME` at the real home directory
- 2.3 IF the credential store is missing THE SYSTEM SHALL fail fast with `AdapterError('auth_unavailable')` before spawning the child process
- 2.4 THE SYSTEM SHALL never copy credentials anywhere except the per-invocation sandbox directory and SHALL delete that directory when the invocation ends
- 2.5 THE SYSTEM SHALL NOT include credential content in error messages, transcripts, evidence blobs, or replay files

## REQ-3: Exports + Ring-2 discipline

**User Story:** As the invariant owner, I want the fifth lineage to land with
zero Ring 0/1 movement, so INV-7/INV-8 remain provable by the unchanged CI
gates.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL export `createLiveOpenCodeGlmAdapter` from `adapters/src/index.ts`
- 3.2 THE SYSTEM SHALL NOT import `core/executor` or any AAL internals beyond public protocol types (INV-8)
- 3.3 WHEN `pnpm vendor-check` runs THE SYSTEM SHALL remain green with the vendor pattern unchanged

## REQ-4: Conformance gate in CI (fake exec, zero quota)

**User Story:** As CI, I want P1–P8 exercised for the opencode-glm adapter on
every push against a fake exec seam, so the fifth lineage is held to the same
bar as codex and glm without spending gateway quota.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL pass conformance probes P1–P8 for the opencode-glm adapter against a compliant fake `ReasoningCliExec` in `adapters/src/opencode-glm-conformance.test.ts`
- 4.2 WHEN a sabotaged fake exec returns prose without actions THE SYSTEM SHALL fail exactly probe P2 and no other
- 4.3 WHEN a conformance record is re-registered after a regressed re-run THE SYSTEM SHALL mark the adapter `stale` via the registry gate
- 4.4 THE SYSTEM SHALL provide unit tests covering `buildOpenCodeGlmArgv` output shape (pure function, snapshot-style) and the credential-copy sandbox behavior (auth file present in sandbox, real HOME never referenced, missing store → `auth_unavailable`)

## REQ-5: Conformance CLI support

**User Story:** As the operator, I want `platform conformance` to know this
lineage, so the LIVE gate runs with the same guards as every other adapter.

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL accept `--lineage opencode-glm` in `platform conformance` (allowlist + construction branch in `console/backend/bin/platform.ts`) and SHALL refuse an unknown lineage before any live spend
- 5.2 WHEN live conformance runs for opencode-glm THE SYSTEM SHALL use a per-run, never-reused replay dir and persist the record at `.ai/calibration/conformance-opencode-glm-<stamp>.json`

## REQ-6: Routing policy + data-governance entries (governance change)

**User Story:** As the governance plane, I want the new adapter rate-limited
and its third-party processor named in policy before it ever serves traffic.

**Acceptance Criteria (EARS):**
- 6.1 THE SYSTEM SHALL add an `opencode-glm` entry to `tokenBuckets` in `.ai/policies/routing.json` with the same defaults as existing lineages (capacity 4, refillPerSec 0.5) — a POLICY_FILES change, human-approved via PR review by construction
- 6.2 THE SYSTEM SHALL add a per-adapter `opencode-glm` entry to `.ai/policies/provider-data-policy.json` recording that prompts transit the OpenCode Go gateway (an additional data processor vs the direct Z.ai endpoint) — a POLICY_FILES change approved the same way
- 6.3 THE SYSTEM SHALL NOT modify `fusion-profiles.json` (lineage `'zai'` already participates via cross-lineage profiles only when explicitly added later — separate governance decision)

## REQ-7: LIVE conformance run (the point of this spec)

**User Story:** As the drift canary, I want a real recorded live run through
the OpenCode Go gateway, so "GLM-5.3 works in this platform" is evidence,
not assertion.

**Acceptance Criteria (EARS):**
- 7.1 THE OPERATOR SHALL run `platform conformance --live --lineage opencode-glm` (TTY, confirmation phrase, `--force-quota-override` per the automation guard) and the task SHALL record per-probe results + the persisted record path as evidence
- 7.2 IF the OpenCode Go gateway is unavailable or its quota exhausted THEN THE OPERATOR SHALL record the failure shape and the task SHALL remain open with the CI conformance (REQ-4) as this round's evidence
- 7.3 WHEN REQ-7.1 lands THE SYSTEM SHALL treat PR-gate slotting, loop composition, and any §7.4 routing-default change as follow-up work outside this spec's code scope (D2)

## Edge Cases & Open Questions

- **Gateway model drift:** OpenCode may rename/retire `opencode-go/glm-5.3`;
  REQ-1.4's model override keeps that a config change. The zen gateway
  (`opencode/glm-*`) currently stops at 5.2 — not used.
- **Auth store format:** `auth.json` is copied verbatim (never parsed,
  never logged); if OpenCode moves it, REQ-2.3's fail-fast surfaces the
  break as `auth_unavailable`, not a silent auth failure mid-run.
- **Quota semantics:** OpenCode Go quota is the account's own (not the Z.ai
  Coding Plan) — recorded in clarifications D1/D3; conformance adds ~10
  short requests once.
