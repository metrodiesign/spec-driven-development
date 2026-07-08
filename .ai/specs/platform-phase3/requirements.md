# Requirements: platform-phase3 — Multi-model + Fusion + Merge Queue/T2 + Auditor + F-Loop/F-Sched + Remote Auth

> Status: draft
> Derived from design.md (approved 2026-07-08) — design is upstream; each REQ cites its design section.
> Upstream: unified-platform-spec.md v1.2 §14 Phase 3 + invariants §2. User decisions binding: clarifications.md.
> SPIKE-6 caveats are binding adapter-design inputs.

## Overview

Phase 3 turns the single-lineage semi-autonomous platform (Phases 0-2) into a
multi-model system with measured fusion, integration-serializing merge
machinery, independent post-completion auditing, and a remotely operable
Console — while keeping every Phase 0-2 invariant intact: the model proposes,
core executes and measures (INV-1/2), Ring 0 stays vendor-free (INV-7), the
Console owns no state (INV-11), and remote access fails closed (INV-15).
Second lineage = Codex only; GLM-5.2 is deferred (spec v1.2). All CI evidence
comes from fakes; live evidence comes from the phase's LIVE task.

## REQ-1: Shared Ring-2 wire helpers (design: "Data Models & Interfaces — A: wire.ts")

**User Story:** As a platform maintainer, I want the proven Ring-2 wire
vocabulary in one shared module, so that a second adapter cannot drift from
the behavior the Claude adapter already proved live.

**Acceptance Criteria (EARS):**
- 1.1 THE SYSTEM SHALL provide `adapters/src/wire.ts` exporting `unfence`, `normalizeActions`, `buildProposePrompt`, and `classifyAdapterError` as pure functions
- 1.2 WHEN the extraction lands THE SYSTEM SHALL keep every pre-existing anthropic adapter test green without test modification
- 1.3 WHEN `buildProposePrompt` is called with `fenceGuard: false` THE SYSTEM SHALL omit the raw-JSON/no-fences clause while keeping the WRITE_FILE/REQUEST_TOOL vocabulary, the UNTRUSTED-DATA marking, and the no-execution statement
- 1.4 WHEN `normalizeActions` receives a WRITE_FILE action carrying inline `content` THE SYSTEM SHALL mint a `contentRef` through the provided put function
- 1.5 IF `classifyAdapterError` matches no known quota or auth pattern THEN THE SYSTEM SHALL classify the error as `transport`

## REQ-2: Codex adapter (design: "A: codex.ts + codex-live.ts")

**User Story:** As the platform operator, I want a Codex adapter that proposes
without executing, so that a second lineage joins the AAL under the same
propose/dispose safety and quota-survivability escape hatch.

**Acceptance Criteria (EARS):**
- 2.1 THE SYSTEM SHALL provide `createCodexAdapter` implementing `AdapterInterface` with an injectable `ExecFn` seam
- 2.2 THE SYSTEM SHALL declare the codex manifest as structuredOutput true, toolCalling false, executionBackend false, determinism none, lineage `openai`
- 2.3 WHEN a send completes THE SYSTEM SHALL normalize usage to costUnits as (input_tokens + output_tokens + reasoning_output_tokens) / 1000 x costUnitsPer1k
- 2.4 WHEN a requestId already has a stored replay THE SYSTEM SHALL return the stored response without invoking ExecFn
- 2.5 WHEN a send completes THE SYSTEM SHALL store the JSONL event stream in the evidence store and reference it as rawTranscriptRef
- 2.6 THE SYSTEM SHALL record the requested model as adapterMeta.modelVersion (codex events do not echo the model — SPIKE-6)
- 2.7 IF codex exec exits non-zero or its stderr matches a rate-limit or auth pattern THEN THE SYSTEM SHALL throw a typed AdapterError via classifyAdapterError and never self-retry
- 2.8 WHERE the live exec path runs THE SYSTEM SHALL spawn codex exec with `--sandbox read-only --ephemeral --skip-git-repo-check --ignore-user-config --output-schema` and stdin ignored
- 2.9 IF a live codex exec exceeds its kill timeout THEN THE SYSTEM SHALL terminate the child process and throw AdapterError transport
- 2.10 THE SYSTEM SHALL register the codex adapter without a healthProbe (no quota signal exists — its breaker operates on error rate only, recorded residual)

## REQ-3: Codex conformance + adapter template (design: "A: _template.ts" + Testing "A conformance")

**User Story:** As the platform operator, I want the second adapter to pass
the same conformance gate as the first, so that "add a model = adapter +
P1-P8 + register" stays true (INV-8).

**Acceptance Criteria (EARS):**
- 3.1 THE SYSTEM SHALL pass conformance probes P1-P8 for the codex adapter against a compliant fake ExecFn in CI
- 3.2 WHEN a sabotaged fake ExecFn returns prose without actions THE SYSTEM SHALL fail exactly probe P2 (discrimination self-test extended to the second adapter)
- 3.3 THE SYSTEM SHALL provide `adapters/src/_template.ts` as a non-registered skeleton composing wire.ts helpers with an INV-8 checklist header
- 3.4 IF a newer codex conformance record regresses any pass/fail probe THEN THE SYSTEM SHALL mark the registered adapter stale (existing registry semantics)

## REQ-4: Lineage metadata + reviewer role + registry enumeration (design: "B: protocol/registry + core/types Role")

**User Story:** As the routing layer, I want adapters to declare their lineage
and a reviewer role to exist, so that cross-lineage rules and the fusion blind
judge have real primitives to stand on.

**Acceptance Criteria (EARS):**
- 4.1 THE SYSTEM SHALL extend CapabilityManifest with an optional lineage field carried onto RegisteredAdapter with default `unknown`
- 4.2 THE SYSTEM SHALL add `reviewer` to the Role union with a roleRequires case that accepts any adapter
- 4.3 THE SYSTEM SHALL provide Registry.all() returning every registered adapter including stale ones
- 4.4 THE SYSTEM SHALL extend FakeAdapter with a lineage option surfaced through its manifest

## REQ-5: Routing hints (design: "B: router.ts RouteHints")

**User Story:** As the routing layer, I want susceptibility- and
lineage-aware filters, so that low-trust content avoids injection-prone
models and test designers never share the implementer's lineage.

**Acceptance Criteria (EARS):**
- 5.1 WHEN route or eligibleAdapters is called without hints THE SYSTEM SHALL behave identically to the Phase-2 router
- 5.2 WHEN hints.maxSusceptibility is provided THE SYSTEM SHALL exclude adapters whose susceptibilityScore exceeds it
- 5.3 WHEN hints.excludeLineages is provided THE SYSTEM SHALL exclude adapters whose lineage is listed
- 5.4 IF filtering leaves no eligible adapter THEN THE SYSTEM SHALL throw NoCapacityError surfacing as a clean BLOCKED no_capacity
- 5.5 WHILE composing a supervised loop THE SYSTEM SHALL pass the implementer's lineage as excludeLineages for the test_designer role as a hard rule that is never silently relaxed
- 5.6 WHERE the context bundle contains file pieces THE SYSTEM SHALL apply the maxSusceptibility cap from routing.json through the source routeHints

## REQ-6: Per-provider token bucket + bounded dispatch (design: "B: ratelimit.ts + dispatch.ts")

**User Story:** As the ops plane, I want provider rate limits respected before
dispatch, so that parallel fan-out (fusion panels) cannot stampede a provider.

**Acceptance Criteria (EARS):**
- 6.1 THE SYSTEM SHALL provide a token bucket with injected clock exposing tryTake and available
- 6.2 WHEN dispatchAll runs THE SYSTEM SHALL keep at most maxParallel sends in flight
- 6.3 WHILE an adapter's bucket is empty THE SYSTEM SHALL delay that adapter's items rather than dropping them
- 6.4 IF one dispatched item throws AdapterError THEN THE SYSTEM SHALL capture it in that item's result without failing the batch

## REQ-7: Outcome-routing shadow (design: "B: shadow.ts")

**User Story:** As the learning plane, I want routing outcomes logged in
shadow only, so that Phase 4 activation has retrospective evidence without
Phase 3 ever letting outcomes steer live routes (§10.4).

**Acceptance Criteria (EARS):**
- 7.1 WHEN a live route decision occurs in a supervised loop THE SYSTEM SHALL append a SHADOW_ROUTE event with the live choice, the would-be choice, and its basis
- 7.2 THE SYSTEM SHALL compute shadowWouldChoose deterministically from per-adapter reviewing-reached outcome stats
- 7.3 WHILE any registered adapter is stale THE SYSTEM SHALL freeze shadow recording (conformance drift canary)
- 7.4 THE SYSTEM SHALL keep live route results identical with and without the shadow recorder attached
- 7.5 IF a shadow append fails THEN THE SYSTEM SHALL log an ERROR event and continue the loop
- 7.6 THE SYSTEM SHALL provide compareShadow computing agreement rate and divergences from recorded events as a pure function

## REQ-8: Fusion profiles + new policy surface (design: "C: profiles.ts" + "Policies & schemas")

**User Story:** As the governance layer, I want fusion and routing knobs to be
versioned policy files, so that enabling fusion is a human-approved governance
event by construction (INV-16).

**Acceptance Criteria (EARS):**
- 8.1 THE SYSTEM SHALL load fusion profiles from `.ai/policies/fusion-profiles.json` validating each profile's resolve rule against the fixed §7.5 artifact mapping
- 8.2 THE SYSTEM SHALL load routing configuration (maxSusceptibility, maxParallel, tokenBuckets) from `.ai/policies/routing.json` with type-guarded fallbacks that never loosen
- 8.3 WHEN fusion-profiles.json and routing.json join POLICY_FILES THE SYSTEM SHALL refuse the next run as policy_unapproved until the operator approves the new snapshot
- 8.4 IF a profile's resolve rule contradicts the fixed artifact mapping THEN THE SYSTEM SHALL reject the profile at load with a structured error

## REQ-9: Fusion PANEL + EVIDENCE + ANALYZE (design: "C: run.ts / panel.ts / analyze.ts")

**User Story:** As the autonomous loop, I want independent candidates
generated, measured by core, and compared blind, so that fusion adds signal
without adding an execution authority.

**Acceptance Criteria (EARS):**
- 9.1 WHEN runFusion starts THE SYSTEM SHALL fan out N panel requests with distinct requestIds derived from the base requestId and the profile diversity (seeds or lineages)
- 9.2 WHERE the artifact is code_diff or tests THE SYSTEM SHALL obtain a core-produced GateReport per candidate through the CandidateEvidenceRunner port in separate worktrees
- 9.3 THE SYSTEM SHALL route the blind judge as role reviewer with anonymized candidates carrying no adapter identity and no persuasion text
- 9.4 WHEN the judge responds THE SYSTEM SHALL validate the response against deliberation-analysis.schema.json with one bounded repair round
- 9.5 IF the judge output remains invalid THEN THE SYSTEM SHALL fall back to gate-evidence-only ranking for code_diff and tests and escalate for plan and reviews
- 9.6 WHEN fusion runs THE SYSTEM SHALL append FUSION_PANEL, FUSION_CANDIDATE, and FUSION_RESOLVED events to the event log

## REQ-10: Fusion RESOLVE + CAPTURE + budget/depth guards (design: "C: resolve.ts + entry points")

**User Story:** As the correctness owner, I want resolve rules that
structurally cannot let a judge overrule gate evidence, so that consensus
never crosses a gate (§16).

**Acceptance Criteria (EARS):**
- 10.1 THE SYSTEM SHALL never select a code_diff or tests candidate whose GateReport is not pass true regardless of judge ranking
- 10.2 THE SYSTEM SHALL emit exactly one candidate's actions as the code_diff winner and never a synthesis of candidates
- 10.3 WHEN resolving tests THE SYSTEM SHALL union candidates with per-test dedupe and flag each test for downstream RED-check verification
- 10.4 WHEN resolving hypotheses THE SYSTEM SHALL union candidates and rank by probe count ascending
- 10.5 WHEN resolving reviews THE SYSTEM SHALL apply a weighted ensemble and raise an escalation marker on disagreement rather than letting a majority silence dissent
- 10.6 WHEN dissent exists after resolve THE SYSTEM SHALL capture it as FUSION_DISSENT events with evidence refs
- 10.7 IF the panel size times the per-candidate estimate exceeds the profile budget cap THEN THE SYSTEM SHALL shrink the panel or escalate budget_cap before dispatch
- 10.8 IF the remaining budget cannot cover the judge round THEN THE SYSTEM SHALL resolve on gate evidence alone for code_diff and tests or escalate for plan and reviews
- 10.9 IF a fusion.deliberate request arrives for a task that already consumed its fusion activation THEN THE SYSTEM SHALL reject it as structured feedback depth_exceeded
- 10.10 WHILE running under CI THE SYSTEM SHALL never activate fusion (live-run refusal path)

## REQ-11: Fusion calibration metrics (design: "C: core/calibration MOD")

**User Story:** As the operator, I want uplift and decorrelation as honest
numbers, so that fusion stays enabled only where calibration proves it (§12).

**Acceptance Criteria (EARS):**
- 11.1 THE SYSTEM SHALL compute uplift as fused pass rate minus single-model pass rate with an interval band clamped to valid range
- 11.2 THE SYSTEM SHALL compute decorrelation as mean pairwise panel disagreement labeled as a measurement and never as independence
- 11.3 IF the input has zero tasks THEN THE SYSTEM SHALL return a zero-n result without dividing by zero

## REQ-12: T2 gate tier (design: "D: gates/runner.ts MOD")

**User Story:** As the gate ladder owner, I want T2 to become a real tier
whose enablement is itself governance-visible, so that "what passed" always
names its tier and config hash (INV-10).

**Acceptance Criteria (EARS):**
- 12.1 WHEN the ladder t2 config is a status object THE SYSTEM SHALL keep returning not_enabled
- 12.2 WHEN the ladder t2 config provides build, scopedE2e, secretScan, or fullGolden entries THE SYSTEM SHALL execute them with the existing spawn, timeout, retry, and flaky-flag machinery
- 12.3 WHEN the ladder file changes THE SYSTEM SHALL change gateConfigHash in every subsequent GateReport
- 12.4 WHERE fullGolden is builtin THE SYSTEM SHALL verify through verifyGoldenManifest

## REQ-13: Merge queue (design: "D: merge/queue.ts + auto-merge MOD")

**User Story:** As the integration loop, I want candidate merges serialized
with T2 on the merged tree, so that integration failures have clean
attribution (§6.5).

**Acceptance Criteria (EARS):**
- 13.1 THE SYSTEM SHALL serialize merge candidates through the lease manager under a merge-queue lease
- 13.2 WHEN processing a candidate THE SYSTEM SHALL merge with no-ff onto an integration worktree and run T2 on the merged tree
- 13.3 WHEN T2 passes THE SYSTEM SHALL advance the main branch and append MERGE_RESULT merged with the merge commit
- 13.4 IF T2 fails THEN THE SYSTEM SHALL abort the merge leaving the main branch untouched and append MERGE_RESULT rejected_t2 with attribution and an ESCALATED event
- 13.5 IF the merge conflicts THEN THE SYSTEM SHALL abort and append MERGE_RESULT merge_conflict with an ESCALATED event and continue with the next candidate
- 13.6 WHEN auto-merge runs with a queue supplied THE SYSTEM SHALL route the merge through queue.process while keeping the in-band sampling audit and revert authority unchanged
- 13.7 WHEN a candidate enters the queue THE SYSTEM SHALL append MERGE_ENQUEUED
- 13.8 THE SYSTEM SHALL label approval-package gate evidence with its tier (T1-only before the queue — recorded deviation)

## REQ-14: Out-of-band auditor (design: "D: audit/oob.ts")

**User Story:** As the trust owner, I want an independent process re-proving
COMPLETED tasks from clean clones, so that a T1-invisible regression escaping
the in-band audit has a second, uncorrelated chance of detection.

**Acceptance Criteria (EARS):**
- 14.1 THE SYSTEM SHALL select audit targets from COMPLETED events using the salted fold hash of runId, taskId, and the oob salt modulo 100 under the configured rate
- 14.2 THE SYSTEM SHALL exclude targets already carrying an in-band sampled AUDIT_RESULT
- 14.3 WHEN auditing a target THE SYSTEM SHALL clone the repo into a private temp dir at the merge commit and re-run gates in the clone without opening worktrees in the live repo
- 14.4 IF a re-run divergence persists after one retry THEN THE SYSTEM SHALL record verdict non_repro and append OOB_AUDIT_RESULT reproduced false plus ESCALATED
- 14.5 IF a re-run fails then passes on the retry THEN THE SYSTEM SHALL record flaky_suspect without quarantining
- 14.6 THE SYSTEM SHALL never revert or mutate task state from the auditor
- 14.7 WHERE invoked as platform auditor run THE SYSTEM SHALL operate as a separate process holding its own EventLog handle
- 14.8 IF the clone hits a transient lock THEN THE SYSTEM SHALL retry once then skip the target with an ERROR event
- 14.9 WHEN a COMPLETED task's original gate result depended on state absent from the frozen artifact THE SYSTEM SHALL detect the non-reproduction (fault-injection proof)

## REQ-15: F-Loop (design: "E: loop-proxy.ts + app routes + web Loop")

**User Story:** As the operator, I want to read the loop and
approve/steer/kill from the web, so that autonomous supervision does not
require a terminal on the host (§8 F-Loop, DoD).

**Acceptance Criteria (EARS):**
- 15.1 THE SYSTEM SHALL discover runs by scanning human-plane.json discovery files and list them at GET /api/loop/runs
- 15.2 WHEN a loop route is called THE SYSTEM SHALL proxy to that run's Human Plane API injecting the Bearer token server-side
- 15.3 THE SYSTEM SHALL never include the Human Plane token in any response body or client-visible payload
- 15.4 WHEN an approval, steering, or kill mutation succeeds through the Console THE SYSTEM SHALL append an audit entry with kind, principal, and timestamp
- 15.5 IF the Human Plane API is unreachable THEN THE SYSTEM SHALL return 502 with upstream human_plane_unreachable
- 15.6 IF a run's discovery file is stale THEN THE SYSTEM SHALL list the run as ended and reject mutations with 409
- 15.7 THE SYSTEM SHALL render approval packages with the attestation checklist and Approve, Reject, Steer, and Kill controls backed by pure logic in logic/loop.ts
- 15.8 WHEN polling loop events THE SYSTEM SHALL use since-based pagination over the existing events route without adding a WS surface

## REQ-16: F-Sched (design: "E: sched.ts + app routes")

**User Story:** As the operator, I want to start and stop the loop process or
opaque scripts from the web under quota guards, so that automation stays
schedulable without the Console ever owning task scheduling (§8 F-Sched).

**Acceptance Criteria (EARS):**
- 16.1 THE SYSTEM SHALL start only the platform loop process or allowlisted opaque scripts and SHALL expose no task-scheduling or lease operation
- 16.2 WHEN a start is requested THE SYSTEM SHALL evaluate decideAutomationStart unchanged with the available estimate where a null estimate defers fail-closed
- 16.3 WHILE an automation defer is active THE SYSTEM SHALL require the two-step confirm token before spawning
- 16.4 IF start requests exceed the per-source rate limit THEN THE SYSTEM SHALL return 429 before the confirm flow
- 16.5 WHEN a scheduled child exits THE SYSTEM SHALL report the exit code at the status route without auto-respawn
- 16.6 WHEN stop is requested THE SYSTEM SHALL terminate the registered child with SIGTERM
- 16.7 IF a requested script is not an exact allowlist match THEN THE SYSTEM SHALL reject the request with a structured error
- 16.8 WHEN a sched start or stop occurs THE SYSTEM SHALL append an audit entry

## REQ-17: Steering inject-without-pause (design: "E: core/human/api.ts MOD")

**User Story:** As the operator, I want to hand the loop guidance at its next
boundary without pausing it, so that steering costs no wallclock (carried
item).

**Acceptance Criteria (EARS):**
- 17.1 WHEN an inject request carries atNextBoundary true in a steerable non-PAUSED state THE SYSTEM SHALL queue the guidance and return 202 with queued true and an evidence ref
- 17.2 WHEN the loop reaches its next iteration boundary THE SYSTEM SHALL drain queued guidance into context as marked data
- 17.3 THE SYSTEM SHALL record GUIDANCE_INJECTED with mode immediate or next_boundary
- 17.4 WHILE guidance touches acceptance criteria or scope THE SYSTEM SHALL require a contract amendment through governance
- 17.5 IF atNextBoundary is absent and the state is not PAUSED THEN THE SYSTEM SHALL keep the existing 409 not_paused behavior

## REQ-18: F-MCP OAuth via the real CLI (design: "E: F-MCP OAuth")

**User Story:** As the operator, I want MCP OAuth handled by the claude CLI
itself, so that the platform never touches or stores third-party tokens
(INV-12, carried item).

**Acceptance Criteria (EARS):**
- 18.1 WHEN the operator triggers Authenticate on an MCP server THE SYSTEM SHALL deep-link into the claude-only F-Term running the claude mcp flow for that server
- 18.2 THE SYSTEM SHALL store no MCP OAuth token and expose no token endpoint
- 18.3 WHILE the Console session is remote THE SYSTEM SHALL disable the Authenticate action with an explanatory hint

## REQ-19: Auth gate + Basic provider (design: "F: provider.ts + basic.ts")

**User Story:** As the operator, I want the Console to fail closed without
auth and accept scrypt-verified Basic login over the tailnet, so that remote
approval is possible without a public attack surface (INV-15, user decision).

**Acceptance Criteria (EARS):**
- 19.1 WHEN platform console starts THE SYSTEM SHALL compute hasAuthProvider from the 0600 console-auth config outside the repo and pass it to the unchanged decideStartup
- 19.2 IF the bind is non-loopback with no valid auth config THEN THE SYSTEM SHALL refuse startup with a pointer to the config path
- 19.3 WHERE an auth provider is active THE SYSTEM SHALL require a valid session on every route except the auth routes and login assets returning a generic 401 otherwise
- 19.4 THE SYSTEM SHALL mint stateless HMAC-SHA256 session tokens with expiry and reject tampered tokens
- 19.5 THE SYSTEM SHALL set session cookies HttpOnly and SameSite Lax and add Secure when the request arrived over TLS
- 19.6 WHEN a login fails THE SYSTEM SHALL return the same generic 401 for a wrong password and an unknown subject
- 19.7 IF login attempts exceed the rate limit THEN THE SYSTEM SHALL lock the source IP for a cooldown
- 19.8 THE SYSTEM SHALL verify Basic passwords via scrypt with a constant-time comparison
- 19.9 THE SYSTEM SHALL keep F-Term access loopback-hard regardless of auth state
- 19.10 WHEN insecure mode is set on a non-loopback bind THE SYSTEM SHALL start without auth printing the loud warning while F-Term stays unreachable remotely

## REQ-20: Google OIDC behind Tailscale Serve (design: "F: oidc.ts + feasibility path")

**User Story:** As the operator, I want real OIDC login through Google as the
final auth task, so that the DoD's second-machine login also works with a
standards-based provider (user decision #2).

**Acceptance Criteria (EARS):**
- 20.1 WHERE behind-proxy is set with a public URL THE SYSTEM SHALL force the auth gate on even on a loopback bind
- 20.2 WHERE behind-proxy is set THE SYSTEM SHALL allowlist the public URL host for host-header and CORS checks and mark session cookies Secure
- 20.3 WHEN the OIDC flow starts THE SYSTEM SHALL use discovery with PKCE S256 plus state and nonce
- 20.4 WHEN the callback returns THE SYSTEM SHALL verify the id_token issuer and audience pins and require the subject to equal allowedSub
- 20.5 IF state, nonce, issuer, audience, or subject verification fails THEN THE SYSTEM SHALL return a generic 401
- 20.6 THE SYSTEM SHALL read the client secret from the 0600 config outside the repo and never log or expose it
- 20.7 WHEN logout is requested THE SYSTEM SHALL delete the session cookie with stateless expiry as the recorded simplification

## REQ-21: §13.3 hardening sweep (design: "F" + Non-Functional security)

**User Story:** As the security owner, I want every testable §13.3 checklist
line to be an executable test, so that the phase's release gate is proven,
not asserted.

**Acceptance Criteria (EARS):**
- 21.1 THE SYSTEM SHALL cover every testable §13.3 checklist line with a named test
- 21.2 THE SYSTEM SHALL provide no endpoint that creates additional users
- 21.3 THE SYSTEM SHALL apply redaction to all new loop, sched, and auth responses through the global response hook
- 21.4 WHEN any run-spawning endpoint is called THE SYSTEM SHALL enforce both a rate limit and its token or confirm requirement

## REQ-22: Symbol-level COMPRESS (design: "G: context/builder.ts MOD")

**User Story:** As the context builder, I want oversized files reduced to
their symbol surface instead of blind truncation, so that context waste drops
without adding parser dependencies to Ring 0 (carried item).

**Acceptance Criteria (EARS):**
- 22.1 WHEN a file exceeds maxFileBytes THE SYSTEM SHALL attempt symbol-level reduction keeping import, export, and declaration header lines and dropping bodies with a compressed-symbols trailer
- 22.2 IF the heuristic yields fewer than two declarations THEN THE SYSTEM SHALL fall back to the existing byte truncation
- 22.3 THE SYSTEM SHALL run the secret scan on the full pre-compression content
- 22.4 THE SYSTEM SHALL record per piece whether symbols or truncation ran so context-waste metrics stay interpretable

## Edge Cases & Open Questions

- Codex error-classification regexes are trained on SPIKE-6 observations only;
  the first live conformance may surface new wire vocabulary — the recorded
  expectation (clarifications B5) is that fixes land in the Ring 2 prompt or
  classification table, never in weakened verdicts.
- POLICY_FILES growth (REQ-8.3) makes the FIRST Phase-3 run refuse
  policy_unapproved by design — the runbook must show the operator the
  one-time approve command, and tests must not "pre-approve" by committing
  governance events (repo ships an empty governance log; Phase-2 rule).
- Tailscale cert/Serve availability in the live environment is unverified;
  if unavailable, Basic satisfies the DoD and OIDC evidence is deferred with
  a recorded reason (design §F fallback).
- Two-lineage hard rule (REQ-5.5): with the codex breaker open, test_designer
  routing yields a clean BLOCKED — accepted trade-off, revisit only when a
  third lineage exists.
- The reviewer role joins eligible() semantics — existing Phase-2 tests that
  enumerate roles must be extended, not weakened.
- EventType union grows by eight members (design D) — append-only discipline;
  no renames of existing types.
- `codex exec` output contract (event names, usage fields) is pinned to
  codex-cli 0.139.0 observations; a CLI upgrade that changes the JSONL shape
  surfaces as invalid_response, and the fix is a versioned adapter change
  recorded in DEVIATIONS.md.
