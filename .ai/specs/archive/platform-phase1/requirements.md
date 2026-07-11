# Requirements: Autonomous Engineering Platform — Phase 1 (Claude Adapter + AAL + First Calibration + Console Interactive/Governance)

> Status: approved 2026-07-06 (goal-mode AFK, spec-architect audit — 12 findings, all applied in-file)
> Derived from design.md (approved 2026-07-06, human) — each REQ cites its design section.
> Upstream: unified-platform-spec.md §14 Phase 1 DoD, §4.1, §5, §7, §9.4, §10.2–10.3, §11, §12, invariants §2.
> User decisions binding: clarifications.md (single spec; manual live + budget cap; F-Term loopback-only hard; fixture loop target).

## Overview

Phase 1 connects the first real model to the proven Phase-0 core through a vendor-neutral Agent
Abstraction Layer: conformance-gated adapter registration, deterministic context building, an
approval flow served by a Human Plane API, and one supervised loop on a synthetic fixture that
produces the platform's first honest calibration numbers. In parallel the Console becomes the
operator's interactive surface: a 100%-parity terminal (real `claude` binary via PTY) plus
governance editors (settings/permissions/memory), full auth and usage views, activity feed, and
session search — all fail-closed and loopback-only for the terminal.

## REQ-1: AAL protocol envelope (design: "AAL protocol", "New module responsibilities — aal/protocol")

**User Story:** As the platform operator, I want core to speak to every model through one
vendor-neutral envelope, so that models are swappable and Ring 0 never learns vendor details.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL define `AgentRequest` with requestId, agentRole, taskContract excerpt,
      contextBundle, manifestRef, outputSchema, toolDefs (always empty in Phase 1),
      budget.costUnits, and optional determinismHint — the ONLY request shape sent toward a model.
- 1.2 THE SYSTEM SHALL define `AgentResponse` with structuredResult, actionRequests (core Action
      DSL), usage {costUnits, raw}, rawTranscriptRef (nullable), and adapterMeta
      {adapterId, modelVersion, interactive:false}.
- 1.3 THE SYSTEM SHALL keep `aal/` vendor-name-free, enforced by the same CI grep that covers
      `core/`.
- 1.4 WHEN structuredResult does not conform to outputSchema THE SYSTEM SHALL run the bounded
      repair loop (schema-in-prompt re-ask, maximum 2 repair rounds).
- 1.5 IF the response is still non-conforming after the bounded repair THEN THE SYSTEM SHALL
      return structured `invalid_response` feedback for the round without crashing, and the round
      SHALL still count against the budget.

## REQ-2: Adapter registration gated by conformance (design: "aal/registry", "Conformance record")

**User Story:** As the operator, I want no adapter usable until it proves protocol compliance, so
that a misbehaving model integration is caught before it can touch the loop.

**Acceptance Criteria (EARS):**
- 2.1 THE SYSTEM SHALL refuse `register(adapter)` unless the supplied ConformanceRecord shows
      pass on every one of P1–P6 and P8 (P7 records a score, not pass/fail).
- 2.2 THE SYSTEM SHALL persist every conformance probe verdict with a content-addressed
      evidenceRef.
- 2.3 WHEN a conformance re-run (drift canary) fails a previously-passing probe or shifts the P7
      score THE SYSTEM SHALL emit a governance-visible event and mark the adapter
      `stale_conformance`.
- 2.4 WHILE an adapter is marked `stale_conformance` THE SYSTEM SHALL refuse live runs with it
      until a full re-pass is recorded.
- 2.5 THE SYSTEM SHALL store the P7 susceptibility score in the registry for later
      injection-aware routing.

## REQ-3: Conformance probes P1–P8 (design: "Probe semantics")

**User Story:** As the operator, I want each probe to test one real failure mode of a model
integration, so that passing conformance means something concrete.

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL verify P1 by requiring a nontrivial schema instance echoed back intact.
- 3.2 THE SYSTEM SHALL verify P2 by requiring a task response as actionRequests, not prose.
- 3.3 THE SYSTEM SHALL verify P3 by provoking a schema-broken first reply and requiring repair
      within at most 2 repair rounds.
- 3.4 THE SYSTEM SHALL verify P4 by setting budget to 1 costUnit and requiring a structurally
      valid response (conforms to outputSchema, no crash) — degraded content is acceptable;
      structural validity IS the deterministic verdict.
- 3.5 THE SYSTEM SHALL verify P5 by naming an unavailable tool and requiring a REQUEST_TOOL ask
      instead of fabricated results.
- 3.6 THE SYSTEM SHALL verify P6 primarily by the structural assertion that tool_use blocks in
      the in-memory message stream equal zero; absence of claimed execution output and the
      captured transcript are corroborating checks, not the verdict.
- 3.7 THE SYSTEM SHALL verify P7 by planting a canary instruction in low-trust context and
      recording a susceptibility score from the response.
- 3.8 THE SYSTEM SHALL verify P8 by sending the same requestId twice and requiring the second
      call served from the durable replay record with usage counted once.
- 3.9 THE SYSTEM SHALL prove probe discrimination via self-test: sabotaged FakeAdapter variants
      (prose-only, fabricated execution, schema-ignoring, double-burning) each fail exactly the
      probe that owns that behavior.

## REQ-4: anthropic adapter — isolation & behavior (design: "adapters/anthropic", Technology "Adapter isolation")

**User Story:** As the operator, I want the Claude adapter to be a thin, execution-stripped,
quota-honest translator, so that INV-9 propose-only holds with a real model attached.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL call the SDK `query()` with `tools: []`, `settingSources: []`, and a
      core-owned system prompt (D-004 mechanism).
- 4.2 THE SYSTEM SHALL run every adapter session with fixed cwd `.ai/runs/agent-sessions/` —
      this cwd is the interactive/non-interactive discriminator (no tagging API assumed).
- 4.3 THE SYSTEM SHALL normalize SDK usage to costUnits (1 costUnit = 1k tokens, labeled an
      estimate) and attach the raw usage for telemetry.
- 4.4 WHEN the SDK reports a rate/usage limit THE SYSTEM SHALL surface a structured
      `quota_limited` error without any adapter-level retry.
- 4.5 THE SYSTEM SHALL attempt transcript capture after each query: derive the JSONL path from
      the returned session id, poll for flush bounded by the policy keys
      `transcript_poll_interval_ms` / `transcript_poll_attempts` (boundary-tested), copy into
      the evidence store as rawTranscriptRef.
- 4.6 IF the transcript file is absent or incomplete after the bounded poll THEN THE SYSTEM
      SHALL set rawTranscriptRef to null with a structured reason and continue without crashing.
- 4.7 THE SYSTEM SHALL declare `determinism: 'none'`, ignore determinismHint, and label every
      adapter run non-interactive.
- 4.8 IF no usable credential is found at adapter construction THEN THE SYSTEM SHALL fail with
      `auth_unavailable` and a live run SHALL refuse to start with remediation guidance.
- 4.9 THE SYSTEM SHALL persist a durable replay record keyed by requestId at first completion
      (surviving process restart); a repeated send with the same requestId SHALL be served
      byte-identical from that record with usage counted once (the adapter owns wire-level
      idempotency).

## REQ-5: AALProposalSource — core port + idempotency (design: "aal/source", "Event types added in Phase 1")

**User Story:** As the operator, I want the AAL to plug into the untouched Phase-0 core port with
crash-safe request identity, so that retries never double-spend quota or duplicate proposals.

**Acceptance Criteria (EARS):**
- 5.1 THE SYSTEM SHALL implement core's existing `ProposalSource` port without modifying core's
      port or orchestrator semantics (INV-8).
- 5.2 THE SYSTEM SHALL record a `PROPOSAL_INTENT {requestId}` event BEFORE each adapter call, and
      crash-replay SHALL reuse the recorded requestId.
- 5.3 WHEN resending after a crash THE SYSTEM SHALL reuse the requestId recorded in
      PROPOSAL_INTENT and accept the adapter's replay-served response (REQ-4.9) so usage is
      counted once; aal/source SHALL NOT maintain its own response cache.
- 5.4 WHEN a returned action targets a path that is neither in the context-manifest nor
      previously requested via READ_FILE THE SYSTEM SHALL reject the result as
      `context_violation` structured feedback (path-provenance scope only; free-text references
      are a documented residual).
- 5.5 THE SYSTEM SHALL convert AgentResponse.actionRequests into a core Proposal carrying claim
      and costUnits.

## REQ-6: Router — minimal, clean no-capacity (design: "aal/router")

**User Story:** As the operator, I want routing to fail cleanly when nothing is eligible, so that
the loop never thrashes a dead or exhausted provider.

**Acceptance Criteria (EARS):**
- 6.1 THE SYSTEM SHALL select an adapter whose CapabilityManifest satisfies the requesting
      role's required capabilities (Phase-1 mapping: implementer requires structuredOutput;
      executionBackend is always false per §7.2).
- 6.2 IF no eligible adapter exists at selection time THEN THE SYSTEM SHALL surface structured
      `no_capacity` and the task SHALL become BLOCKED(no_capacity) with no retry loop.
- 6.3 WHEN the selected adapter fails a send with `quota_limited` or a transport error and no
      other eligible adapter exists THE SYSTEM SHALL surface `no_capacity` and the task SHALL
      become BLOCKED(no_capacity) without retrying the failed provider.

## REQ-7: Context Builder v1 (design: "core/context", "Context bundle + manifest")

**User Story:** As the operator, I want every model context deterministically built, secret-free,
and fully accounted for, so that what the model saw is always auditable.

**Acceptance Criteria (EARS):**
- 7.1 THE SYSTEM SHALL build context through SEED → EXPAND → COMPRESS → GOVERN → MARK → MANIFEST
      as a deterministic pipeline: identical inputs SHALL produce a byte-identical manifest.
- 7.2 THE SYSTEM SHALL implement COMPRESS v1 as whole-file inclusion with rule-based truncation
      only (symbol-level compression is a recorded later-phase upgrade).
- 7.3 WHEN GOVERN detects a secret-shaped string (core-own generic patterns + entropy heuristic,
      no vendor strings) THE SYSTEM SHALL fail the bundle build with a structured error naming
      the file — never redact-and-send — and the task SHALL be escalated with
      `secret_in_context`.
- 7.4 THE SYSTEM SHALL wrap every context piece in untrusted-data markers and plant a
      per-request injection canary token.
- 7.5 THE SYSTEM SHALL write `context-manifest.json` (each piece with its inclusion rule) into
      the evidence store content-addressed.
- 7.6 THE SYSTEM SHALL record contextRecall and contextWaste counters into the event log after
      each round.
- 7.7 THE SYSTEM SHALL exclude machine configuration (settings, CLAUDE.md, hooks) from the
      pipeline entirely.

## REQ-8: Goal contract — frozen at the edge (design: "core/contract", "goal.yaml", "Composition root")

**User Story:** As the operator, I want the goal contract parsed once at the edge and frozen by
byte hash, so that mid-run contract drift is detected and core stays dependency-free.

**Acceptance Criteria (EARS):**
- 8.1 THE SYSTEM SHALL parse goal.yaml at the composition root (the `yaml` dependency lives in
      console/backend) and hand core a validated plain object plus the raw file bytes; core
      SHALL record sha256(raw bytes) as the frozen-contract hash in the run's first event.
- 8.2 WHEN the goal file's byte hash changes mid-run THE SYSTEM SHALL escalate with
      `contract_changed`.
- 8.3 THE SYSTEM SHALL feed the contract's budget fields into the existing budget backstop.
- 8.4 THE SYSTEM SHALL preserve-and-ignore unknown goal.yaml keys with a logged notice.
- 8.5 THE SYSTEM SHALL keep `core/` at zero runtime dependencies.

## REQ-9: Approval package (design: "core/human", "ApprovalPackage")

**User Story:** As the operator, I want a reviewable, bounded approval package for every task
that reaches review, so that human approval is informed and rubber-stamping is measurable.

**Acceptance Criteria (EARS):**
- 9.1 WHEN a task reaches REVIEWING THE SYSTEM SHALL generate an ApprovalPackage containing goal
      excerpt, AC ids, diffRef, evidence (gate reports + worktreeHash), assumptions, unresolved
      risks, and an attestation checklist generated from the task's risk class — in Phase 1 the
      risk class comes from the goal contract's approval_policy mapping, defaulting to L2 when
      unmapped.
- 9.2 IF the diff exceeds the contract's max diff budget THEN THE SYSTEM SHALL create NO package
      and escalate the task with `split_required`.
- 9.3 THE SYSTEM SHALL require the full attestation checklist acknowledged for an approve
      decision and SHALL record decision timing (rubber-stamp metric input).

## REQ-10: Human Plane API (design: "Human Plane API" table)

**User Story:** As the operator, I want a local vendor-neutral API to approve, observe, and kill
runs, so that human control works without the Console owning core state.

**Acceptance Criteria (EARS):**
- 10.1 THE SYSTEM SHALL serve the Human Plane API on the `node:http` builtin, bind 127.0.0.1
       only (no flag to change it), and write `{url, token}` to
       `.ai/runs/RUN-*/human-plane.json` with mode 0600.
- 10.2 WHEN `POST /approvals/{id}` carries decision approve (with complete attestations) THE
       SYSTEM SHALL record APPROVAL_RECORDED and core SHALL transition REVIEWING → APPROVED;
       decision reject SHALL transition to CHANGES_REQUESTED.
- 10.3 THE SYSTEM SHALL serve `GET /events?since=` as a projection passed through core-own
       generic redaction (no cross-ring import of console redaction).
- 10.4 WHEN `POST /kill` is received THE SYSTEM SHALL let the current atomic action complete,
       release the lease, transition the worktree to QUARANTINED, revoke adapter dispatch for
       the run, and record KILL_REQUESTED (kill ≠ pause); an in-flight adapter call SHALL be
       awaited until the round completes or the policy key `kill_adapter_wait_ms` elapses,
       whichever comes first.
- 10.5 THE SYSTEM SHALL answer steering endpoints with 501 `not_enabled_phase1` — explicit,
       never silent.
- 10.6 IF the bearer token is wrong or absent THEN THE SYSTEM SHALL return a generic 401; all
       endpoints SHALL be rate-limited.

## REQ-11: Supervised loop + first calibration (design: "Composition root", "Testing Strategy" calibration rows)

**User Story:** As the operator, I want one supervised loop measured end-to-end by core with
honest numbers, so that Phase-1 trust is grounded in evidence, not vibes.

**Acceptance Criteria (EARS):**
- 11.1 THE SYSTEM SHALL run the full supervised loop in CI with the FakeAdapter: fixture repo +
       goal contract → REVIEWING → API approve → APPROVED, with every GATE_RESULT bound to a
       worktreeHash.
- 11.2 THE SYSTEM SHALL treat CI/FakeAdapter calibration output as harness verification only —
       those numbers SHALL never be reported as §12 metrics.
- 11.3 WHEN `--live` is requested THE SYSTEM SHALL refuse if the `CI` environment variable is
       set or stdin is not a TTY, and SHALL print the costUnits cap and require a typed
       confirmation phrase before the first request; the initiator and confirmation SHALL be
       recorded in evidence (the phrase is an accountability record, not a security boundary —
       residual documented in Edge Cases).
- 11.4 THE SYSTEM SHALL record at least one manual live-run calibration set on the fixture goal
       (held-out pass rate + reproducibility, reported as a range for small n) into the evidence
       store — Phase 1 does not close without it.
- 11.5 THE SYSTEM SHALL keep post-APPROVED transitions guarded `not_enabled_phase1`.
- 11.6 THE SYSTEM SHALL record billing-proof evidence with every live run: `/usage` movement
       against the Max subscription and absence of API billing (§15.4, INV-12) — manual
       observation recorded honestly, PARTIAL when unobserved, never auto-claimed.

## REQ-12: Ring discipline & core stability (design: "Dependency rules")

**User Story:** As the operator, I want the ring boundaries to survive the first real vendor
integration, so that vendor swap and quota survivability stay real options.

**Acceptance Criteria (EARS):**
- 12.1 THE SYSTEM SHALL extend the vendor-name CI check to cover `aal/`; a planted vendor word
       in `aal/` SHALL fail it demonstrably.
- 12.2 THE SYSTEM SHALL inject adapters into the registry only at the composition root; `aal/`
       SHALL NOT import from `adapters/` at build time.
- 12.3 THE SYSTEM SHALL keep the entire Phase-0 fault-injection suite green unchanged, and add
       one scenario: a lying FakeAdapter behind AALProposalSource never yields PASSED.
- 12.4 WHERE the composition root wires a live adapter THE SYSTEM SHALL do so only through the
       registry's conformance gate (REQ-2.1).

## REQ-13: F-Term — interactive terminal, 100% CLI parity (design: "console/backend PTY", "F-Term PTY lifecycle")

**User Story:** As the operator, I want the real `claude` CLI in my browser with full parity and
backend-owned sessions, so that interactive work needs no reimplementation and survives tab
closes.

**Acceptance Criteria (EARS):**
- 13.1 THE SYSTEM SHALL spawn the real `claude` binary through a PTY (node-pty) with cwd = the
       selected project; default mode "claude-only", full shell opt-in per session.
- 13.2 THE SYSTEM SHALL keep every PTY owned by the backend: closing the browser SHALL NOT
       terminate it; re-attach SHALL replay the ring buffer and resume streaming; explicit
       DELETE SHALL reap the process with no zombies.
- 13.3 THE SYSTEM SHALL gate WS attachment with a single-use ticket whose TTL is bounded by the
       policy key `term_ticket_ttl_s` (boundary-tested); reuse or expiry SHALL close with
       4403/4401.
- 13.4 WHILE the console is bound to a non-loopback host THE SYSTEM SHALL refuse every F-Term
       route with 403 even when `--insecure` is given (Phase-1 hard rule).
- 13.5 THE SYSTEM SHALL write a redacted JSON audit entry for every PTY spawn and close, and
       rate-limit spawns per source.
- 13.6 THE SYSTEM SHALL support resuming a prior session via `claude --resume <id>` from the
       terminal creation request.
- 13.7 IF the `claude` binary is not found THEN THE SYSTEM SHALL answer 503 with a degraded
       guidance card, not a crash.
- 13.8 THE SYSTEM SHALL record a manual parity checklist for F-Term against the real CLI —
       slash commands, plan mode, permission-prompt answered by keystroke, `--resume`,
       detach/attach — each item PASS or PARTIAL with the observation, never auto-claimed.
- 13.9 THE SYSTEM SHALL allow exactly one active writer attachment per PTY; a new ticketed
       attach SHALL take over as the writer and close the previous attachment.

## REQ-14: F-Set — settings governance (design: "console/backend governance", "Console additions")

**User Story:** As the operator, I want safe multi-scope settings editing with an honest
effective view, so that I can govern Claude Code without corrupting its files.

**Acceptance Criteria (EARS):**
- 14.1 THE SYSTEM SHALL provide GET/PUT per scope (user/project/local) with the managed scope
       read-only by construction (no PUT route registered).
- 14.2 WHEN writing THE SYSTEM SHALL validate against schema, compare the client's baseHash
       against the current file (mismatch → 409 with fresh content), then write via atomic
       rename.
- 14.3 THE SYSTEM SHALL compute the Effective View from live-read files across the full
       precedence chain with per-key provenance, label it "computed from files", and
       parity-check it against CLI output where the CLI exposes effective values.

## REQ-15: F-Perm — permissions builder + guards (design: "console/backend governance")

**User Story:** As the operator, I want permission rules built, simulated, and protective guards
installed in one click, so that golden files and worktrees are protected from interactive
sessions too.

**Acceptance Criteria (EARS):**
- 15.1 THE SYSTEM SHALL edit allow/deny/ask permission rules per scope with a merged
       cross-scope view.
- 15.2 THE SYSTEM SHALL provide a simulator: given a tool + path it returns the decision and the
       winning rule.
- 15.3 THE SYSTEM SHALL install deny rules protecting `test/golden/**` and `worktrees/` in one
       click, idempotently.

## REQ-16: F-Auth full (design: "console/backend auth (F-Auth FULL)")

**User Story:** As the operator, I want to see exactly which credential wins per project and be
loudly warned when an env var silently costs me API money, so that my Max subscription is
actually used.

**Acceptance Criteria (EARS):**
- 16.1 THE SYSTEM SHALL report the active auth method per project from the credential-chain
       heuristic (§5.1 precedence).
- 16.2 WHEN `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` shadows the subscription THE SYSTEM
       SHALL show a red warning naming the variables — names only, never values, and never
       unsetting them automatically.
- 16.3 THE SYSTEM SHALL provide setup-token guidance text (how-to only).
- 16.4 THE SYSTEM SHALL pass the env view through redaction before any response.
- 16.5 THE SYSTEM SHALL expose no route that accepts, returns, or stores a token or credential —
       a negative guarantee proven by tests probing the route table.

## REQ-17: F-Mem — memory editor (design: "console/backend governance")

**User Story:** As the operator, I want to edit CLAUDE.md at every level with preview, so that
guidance stays maintainable from one place.

**Acceptance Criteria (EARS):**
- 17.1 THE SYSTEM SHALL provide GET/PUT for CLAUDE.md at each level (user/project) with preview,
       using the same write-safety path as settings (validate where applicable → baseHash 409 →
       atomic rename).

## REQ-18: F-Usage full (design: "console/backend observability", "Console additions")

**User Story:** As the operator, I want full usage visibility split by day/project/model and by
interactive vs autonomous, so that quota surprises stop happening.

**Acceptance Criteria (EARS):**
- 18.1 THE SYSTEM SHALL index local transcripts per day, project, and model; every number SHALL
       be labeled an estimate with no hardcoded caps.
- 18.2 THE SYSTEM SHALL split interactive vs autonomous usage by session cwd — adapter sessions
       live under `.ai/runs/agent-sessions/`.
- 18.3 THE SYSTEM SHALL support user-configured alert thresholds with interactive /
       non-interactive labels on alerts.

## REQ-19: F-Act — activity feed (design: "console/backend observability")

**User Story:** As the operator, I want a live activity feed powered by removable hooks, so that
I can watch events without the hooks ever breaking Claude Code.

**Acceptance Criteria (EARS):**
- 19.1 THE SYSTEM SHALL install and uninstall the activity HTTP hooks in one click each; the
       installed hook entries SHALL be fail-open with timeout bounded by the policy key
       `activity_hook_timeout_ms` (boundary-tested).
- 19.2 THE SYSTEM SHALL require the per-install token on `POST /api/events/ingest` and broadcast
       accepted events over the WS feed.

## REQ-20: F-Sess search (design: "console/backend observability")

**User Story:** As the operator, I want full-text search across sessions, so that past work is
findable in seconds.

**Acceptance Criteria (EARS):**
- 20.1 THE SYSTEM SHALL provide full-text session search backed by a rebuildable SQLite FTS5
       index (INV-11-legal domain data) via `GET /api/sessions/search`.

## Edge Cases & Open Questions

- Transcript flush timing (REQ-4.5/4.6) is an assumption until observed live — verified inside
  Phase 1 with the same honesty rule as the spikes; the null-fallback path is CI-tested.
- Effective-view parity (REQ-14.3): the exact set of CLI-exposed effective values varies by CLI
  version; the parity check covers whatever the installed CLI exposes and records the version.
  Precedence chain the resolver enumerates: managed/enterprise → local → project → user, with
  CLI-args noted as out-of-band (not file-resolvable).
- Live-run guards residual (REQ-11.3): the typed confirmation phrase is an accountability
  record, not a security boundary — an operator (or an agent driving a real TTY under explicit
  delegation) can answer it; the binding guards are the CI env check, the TTY check, and the
  contract's costUnits budget. Initiator + confirmation are recorded in evidence so every live
  spend is attributable.
- P7 scoring scale (REQ-3.7) is a measurement definition, not a pass bar — thresholds for
  routing arrive with Phase-2 injection-aware routing.
- Windows/ConPTY (design ceiling): out of scope until a Windows host exists; recorded, not
  silently dropped.

### Audit findings log (spec-analyze, goal-mode AFK — anchor: requirements.md @ 054ed0f)

Fresh-context spec-architect audit, 12 findings; every decision made goal-mode ("ตอบเอง"),
all recommended options applied in-file:

1. GAP — DoD billing/parity spikes had no REQ home → APPLIED: added REQ-11.6 (billing proof)
   + REQ-13.8 (parity manual checklist).
2. INCONSISTENCY — durable replay owned by aal/source contradicted P8-at-adapter (wrong ring)
   → APPLIED: replay moved to REQ-4.9 (adapter owns wire idempotency); REQ-5.3 rewritten
   (source reuses requestId, no own cache).
3. GAP — send-time quota_limited had no BLOCKED(no_capacity) path → APPLIED: added REQ-6.3.
4. AMBIGUITY — "briefly"/"short" unmeasurable → APPLIED: named policy keys + boundary tests
   (REQ-4.5, 13.3, 19.1; also 10.4 kill_adapter_wait_ms).
5. AMBIGUITY — P4/P6 verdicts not deterministic → APPLIED: structural verdicts (REQ-3.4, 3.6).
6. ASSUMPTION — risk class origin undefined → APPLIED: REQ-9.1 names goal-contract
   approval_policy mapping, default L2.
7. GAP — GOVERN hit lacked task outcome → APPLIED: REQ-7.3 ends in ESCALATED secret_in_context.
8. ASSUMPTION — capability match + precedence chain not enumerated → APPLIED: REQ-6.1 names the
   Phase-1 mapping; chain enumerated in Edge Cases (REQ-14.3 note).
9. ATOMICITY — REQ-16.3 bundled guidance + security guarantee → APPLIED: split into 16.3/16.5.
   (REQ-13.2 left as one lifecycle criterion — deliberate.)
10. WEAK GUARD — --live confirmation defeatable by TTY-driving agent → APPLIED: REQ-11.3 typed
    phrase + initiator evidence; residual documented above honestly.
11. GAP — concurrent attach on one PTY undefined → APPLIED: REQ-13.9 single-writer takeover.
12. GAP — kill during in-flight adapter call undefined → APPLIED: REQ-10.4 bounded wait.
