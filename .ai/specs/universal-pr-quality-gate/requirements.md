# Requirements: Universal PR Quality Gate

> Status: approved 2026-08-10, amended 2026-08-10

## Overview

Universal PR Quality Gate ขยายแพลตฟอร์ม self-hosted single-operator ให้ตรวจ GitHub Pull Request ด้วย deterministic core, immutable evidence และ independent model review โดยรักษาหลัก propose/dispose: AI ค้นหา defect ได้ แต่ Ring 0 และ policy ที่ตรวจซ้ำได้เป็นผู้ตัดสินผล gate

## REQ-1: Immutable Pull Request Identity

**User Story:** ในฐานะ repository maintainer ฉันต้องการให้ทุกขั้นตรวจ PR เดียวกันบน Git state ที่ตรึงแล้ว เพื่อไม่ให้ผลจาก commit เก่าถูกนำไปใช้กับ code ปัจจุบัน

**ที่มาใน design:** Architecture Overview, Sequence Diagrams, Data Models & Interfaces

**Acceptance Criteria (EARS):**

- 1.1 WHEN an operator requests a run for a repository and PR number THE SYSTEM SHALL capture a descriptor containing the repository, PR number, base ref, base SHA, head SHA, and fork status
- 1.2 WHEN the PR descriptor is captured THE SYSTEM SHALL resolve the merge-base, diff, and trusted repository policy from the pinned Git objects
- 1.3 WHILE a run is acquiring or classifying a change THE SYSTEM SHALL read source content only through the pinned base SHA or head SHA
- 1.4 WHEN Stage 1 begins THE SYSTEM SHALL materialize a detached worktree from the pinned head SHA
- 1.5 WHEN Stage 1 completes THE SYSTEM SHALL persist a snapshot manifest containing the repository, PR number, base SHA, head SHA, merge-base SHA, diff hash, policy hash, and changed-file hashes
- 1.6 THE SYSTEM SHALL bind every deterministic report, reviewer result, Judge result, and final decision to one `SnapshotIdentity`
- 1.7 WHEN snapshot creation completes, before Stage 3, before Stage 5, and before final reporting THE SYSTEM SHALL compare the run head SHA with the current PR head SHA
- 1.8 IF the current PR head SHA differs from the run head SHA THEN THE SYSTEM SHALL produce a `CANCELLED_STALE` terminal record with no quality decision
- 1.9 WHEN a run becomes `CANCELLED_STALE` THE SYSTEM SHALL enqueue a new run for the current head SHA
- 1.10 IF a required PR ref or Git object cannot be read after bounded transport retries THEN THE SYSTEM SHALL return `INFRASTRUCTURE_FAILURE` before dispatching any reviewer
- 1.11 IF a snapshot manifest hash or artifact binding does not verify THEN THE SYSTEM SHALL produce an `INFRASTRUCTURE_FAILURE` quarantine record for the affected evidence

## REQ-2: Adaptive Change Classification

**User Story:** ในฐานะ repository maintainer ฉันต้องการให้ระบบเลือกการตรวจตาม change จริง เพื่อได้ coverage ที่เกี่ยวข้องโดยไม่รัน check ที่ไม่เกี่ยวข้อง

**ที่มาใน design:** Architecture Overview, Data Models & Interfaces, Testing Strategy

**Acceptance Criteria (EARS):**

- 2.1 WHEN Stage 0 completes THE SYSTEM SHALL produce a classification containing technologies, change categories, affected components, and affected public contracts
- 2.2 WHERE a change matches multiple categories or profiles THE SYSTEM SHALL retain every applicable category and profile
- 2.3 WHEN affected components are identified THE SYSTEM SHALL produce impact edges that state the source, destination, and reason for each dependency impact
- 2.4 WHEN classification completes THE SYSTEM SHALL assign `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL` risk together with machine-readable reasons
- 2.5 WHERE a repository contains Node.js or TypeScript, documentation or configuration, or OpenAPI artifacts THE SYSTEM SHALL use the corresponding Phase 1 analyzer
- 2.6 WHEN analyzers return the same logical facts in different orders THE SYSTEM SHALL produce the same normalized, deduplicated, and sorted classification
- 2.7 IF an analyzer proposes risk below the effective policy floor THEN THE SYSTEM SHALL retain the policy-floor risk
- 2.8 IF the changed technology has no supported analyzer or deterministic profile THEN THE SYSTEM SHALL produce a `LIMITED` coverage record containing every omitted path and reason
- 2.9 WHEN profiles are activated THE SYSTEM SHALL resolve only checks applicable to the detected technologies, components, contracts, and risk
- 2.10 WHERE a PR changes only documentation or configuration THE SYSTEM SHALL omit code build checks from the resolved plan
- 2.11 WHEN an OpenAPI change affects a public contract THE SYSTEM SHALL activate the configured contract-diff check
- 2.12 WHERE a monorepo PR affects one component THE SYSTEM SHALL include that component and its configured dependents in impact analysis

## REQ-3: Trusted Quality Policy

**User Story:** ในฐานะ platform operator ฉันต้องการให้ policy จาก repository เพิ่มความเข้มได้แต่ลด security floor ไม่ได้ เพื่อให้ PR ไม่สามารถอนุมัติตัวเองด้วย policy ที่แก้มาใน commit เดียวกัน

**ที่มาใน design:** Technology Decisions, Error Handling Strategy, Non-Functional Considerations

**Acceptance Criteria (EARS):**

- 3.1 THE SYSTEM SHALL resolve effective policy in the order hard security invariants, organization policy floor, repository policy, and detected profile activation
- 3.2 WHILE evaluating a PR THE SYSTEM SHALL read repository policy from the pinned base SHA rather than the PR head SHA
- 3.3 WHERE repository policy adds stricter checks, shorter timeouts within the allowed ceiling, higher risk, or additional human approval THE SYSTEM SHALL retain those stricter settings
- 3.4 IF repository policy enables command network access or package installation THEN THE SYSTEM SHALL reject that policy value
- 3.5 IF repository policy lowers the required reviewer floor or blocking severity threshold THEN THE SYSTEM SHALL reject that policy value
- 3.6 IF repository policy disables required secret scanning THEN THE SYSTEM SHALL reject that policy value
- 3.7 IF repository policy permits `PASS` for a stale head SHA THEN THE SYSTEM SHALL reject that policy value
- 3.8 WHEN `.ai/policies/pr-quality-gate.json` is created or changed THE SYSTEM SHALL require approval of the new `POLICY_FILES` governance snapshot before a run may proceed
- 3.9 IF effective policy is missing, malformed, or unapproved THEN THE SYSTEM SHALL return `INFRASTRUCTURE_FAILURE` before dispatching any reviewer
- 3.10 THE SYSTEM SHALL expose no Console route that modifies `.ai/policies/pr-quality-gate.json`

## REQ-4: Deterministic Quality Analysis

**User Story:** ในฐานะ repository maintainer ฉันต้องการให้ build, test, security และ contract evidence มีอำนาจแน่นอนเหนือ AI opinion เพื่อไม่ให้ model ผ่าน defect ที่เครื่องมือพิสูจน์แล้ว

**ที่มาใน design:** Architecture Overview, Data Models & Interfaces, Error Handling Strategy

**Acceptance Criteria (EARS):**

- 4.1 WHEN Stage 2 begins THE SYSTEM SHALL execute the resolved check plan against the immutable snapshot through the enforcing core sandbox
- 4.2 WHILE running a deterministic check THE SYSTEM SHALL execute only the exact command selected from trusted effective policy without interpolating PR-controlled data
- 4.3 WHILE running a deterministic check THE SYSTEM SHALL enforce the isolation policy `{ network: 'none', install: false }`
- 4.4 WHEN a deterministic check finishes THE SYSTEM SHALL record its status, required flag, duration, and evidence reference in a signed report
- 4.5 IF a required build, test, security, or contract check exits unsuccessfully THEN THE SYSTEM SHALL set the quality-decision floor to `FAIL`
- 4.6 IF a required deterministic check exceeds its configured timeout THEN THE SYSTEM SHALL set the quality-decision floor to `FAIL`
- 4.7 IF the enforcing sandbox cannot start THEN THE SYSTEM SHALL return `INFRASTRUCTURE_FAILURE` without executing the command unsandboxed
- 4.8 IF a required deterministic check fails while run budget and deadline remain THEN THE SYSTEM SHALL continue Stage 3 blind review
- 4.9 WHERE deterministic evidence sets a `FAIL` floor THE SYSTEM SHALL retain `FAIL` regardless of reviewer silence, Judge output, or reviewer coverage

## REQ-5: Four Blind Reviewers

**User Story:** ในฐานะ repository maintainer ฉันต้องการ independent defect discovery จาก reviewer ต่าง lineage เพื่อเพิ่มโอกาสพบ defect โดยไม่ให้ reviewer ชี้นำกัน

**ที่มาใน design:** Architecture Overview, Sequence Diagrams, Data Models & Interfaces

**Acceptance Criteria (EARS):**

- 5.1 WHEN Stage 3 begins THE SYSTEM SHALL dispatch one slot each to Claude, Codex, Gemini CLI, and OpenCode with DeepSeek through provider adapters
- 5.2 WHILE Stage 3 is active THE SYSTEM SHALL run all available reviewer slots in parallel
- 5.3 WHEN reviewer requests are constructed THE SYSTEM SHALL give every slot one shared model-visible envelope containing the context digest and output schema
- 5.4 WHILE a reviewer slot is active THE SYSTEM SHALL prevent that reviewer from receiving peer findings, consensus output, Judge output, or provider identities
- 5.5 WHILE acting as a reviewer THE SYSTEM SHALL require `actionRequests` to be empty
- 5.6 WHILE acting as a reviewer THE SYSTEM SHALL require `toolUseCount` to equal zero
- 5.7 WHEN a reviewer response arrives THE SYSTEM SHALL validate one review envelope containing its structured schema and snapshot identity before counting it as successful
- 5.8 IF a reviewer returns invalid JSON, an action request, or tool use THEN THE SYSTEM SHALL classify the slot as `INVALID_RESPONSE`
- 5.9 IF a provider times out, is rate-limited, lacks authentication, fails transport, exceeds context, is unavailable, or is cancelled THEN THE SYSTEM SHALL record the corresponding typed status rather than an empty successful result
- 5.10 WHEN a reviewer call is aborted THE SYSTEM SHALL terminate the underlying SDK request or child process before the run reaches a terminal state
- 5.11 IF a provider adapter cannot prove deny-all tools and `toolUseCount === 0` under conformance testing THEN THE SYSTEM SHALL classify that provider slot as `UNAVAILABLE`
- 5.12 WHERE manual `review-fanout` is used as human assistance THE SYSTEM SHALL classify its output as ineligible for automated gate authority

## REQ-6: Evidence Judge and Finding Integrity

**User Story:** ในฐานะ repository maintainer ฉันต้องการให้ finding ทุกข้อผูกกับหลักฐานจริงและผ่าน Judge แบบ anonymous เพื่อไม่ให้ wording หรือ provider reputation กลายเป็นผลตัดสิน

**ที่มาใน design:** Data Models & Interfaces, Error Handling Strategy

**Acceptance Criteria (EARS):**

- 6.1 WHEN a reviewer finding is normalized THE SYSTEM SHALL validate its category, severity, title, finding, root cause, trigger, impact, suggested fix, and confidence in the range `0..1`
- 6.2 WHEN a reviewer finding cites code THE SYSTEM SHALL validate the file path, line range, and excerpt hash against the immutable snapshot
- 6.3 IF a finding fails required-field, location, range, or hash validation THEN THE SYSTEM SHALL classify the reviewer response as invalid before Judge dispatch
- 6.4 WHEN Judge input is constructed THE SYSTEM SHALL replace provider identities with anonymous labels `C0` through `C3`
- 6.5 WHEN the Judge returns a verdict THE SYSTEM SHALL require a canonical finding key, verification class, severity, evidence references, and rationale reference
- 6.6 WHEN a Judge result arrives THE SYSTEM SHALL revalidate its snapshot identity, canonical key shape, and evidence references in Ring 0
- 6.7 WHEN multiple findings share a validated canonical finding key THE SYSTEM SHALL group them without using wording similarity as the grouping authority
- 6.8 IF the Judge cannot establish that two findings share one defect THEN THE SYSTEM SHALL retain them as separate findings
- 6.9 IF the Judge times out, is unavailable, or returns invalid output THEN THE SYSTEM SHALL require human review unless deterministic evidence already requires `FAIL`
- 6.10 WHILE a Judge request is active THE SYSTEM SHALL require `actionRequests` to be empty and `toolUseCount` to equal zero

## REQ-7: Consensus and Quality Decision

**User Story:** ในฐานะ repository maintainer ฉันต้องการ deterministic decision policy ที่แยก evidence coverage ออกจาก vote count เพื่อให้ unavailable reviewer ไม่ถูกตีความว่าไม่พบ defect

**ที่มาใน design:** Data Models & Interfaces, Error Handling Strategy

**Acceptance Criteria (EARS):**

- 7.1 THE SYSTEM SHALL count only schema-valid reviewer results with status `SUCCEEDED` as available reviewers
- 7.2 WHEN four reviewers succeed THE SYSTEM SHALL classify reviewer coverage as `FULL`
- 7.3 WHEN three reviewers succeed THE SYSTEM SHALL produce a `DEGRADED` coverage outcome whose decision ceiling is `PASS_WITH_WARNINGS`
- 7.4 WHEN two reviewers succeed THE SYSTEM SHALL produce an `INSUFFICIENT` coverage outcome of `HUMAN_REVIEW_REQUIRED` unless stronger evidence requires `FAIL`
- 7.5 WHEN zero or one reviewer succeeds THE SYSTEM SHALL return `INFRASTRUCTURE_FAILURE` unless deterministic evidence or a `VERIFIED` `HIGH` or `CRITICAL` finding requires `FAIL`
- 7.6 WHEN any `HIGH` or `CRITICAL` finding is `VERIFIED` THE SYSTEM SHALL return `FAIL`
- 7.7 WHEN any `HIGH` or `CRITICAL` finding is `PARTIALLY_VERIFIED` or `UNVERIFIED` THE SYSTEM SHALL return `HUMAN_REVIEW_REQUIRED`
- 7.8 WHEN only `MEDIUM` or `LOW` verified findings remain THE SYSTEM SHALL return `PASS_WITH_WARNINGS`
- 7.9 WHERE one reviewer supplies a Judge-verified blocking finding THE SYSTEM SHALL retain that blocker regardless of the other reviewer outputs
- 7.10 WHEN classified risk is `CRITICAL` THE SYSTEM SHALL return `HUMAN_REVIEW_REQUIRED` even if deterministic checks and reviewers report no blocker
- 7.11 WHEN analysis coverage is `LIMITED` THE SYSTEM SHALL return at least `HUMAN_REVIEW_REQUIRED`
- 7.12 WHEN coverage is acceptable and no blocker, warning, unresolved high-risk finding, or mandatory human condition exists THE SYSTEM SHALL return `PASS`
- 7.13 THE SYSTEM SHALL represent run lifecycle state separately from `QualityDecision`
- 7.14 WHEN analysis coverage is `PARTIAL` THE SYSTEM SHALL limit the quality decision to `PASS_WITH_WARNINGS` or a stricter outcome

## REQ-8: Lifecycle, Budget, and Recovery

**User Story:** ในฐานะ platform operator ฉันต้องการ run ที่ยกเลิกได้, มี deadline, resume ได้ และไม่คิด cost ซ้ำ เพื่อให้ระบบควบคุมทรัพยากรและ recover หลัง crash ได้

**ที่มาใน design:** Data Models & Interfaces, Non-Functional Considerations

**Acceptance Criteria (EARS):**

- 8.1 THE SYSTEM SHALL allow the normal state order `QUEUED`, `ACQUIRING`, `CLASSIFYING`, `SNAPSHOT_ATTESTING`, `CHECKING`, `REVIEWING`, `JUDGING`, `DECIDING`, `REPORTING`, and `COMPLETED`
- 8.2 IF a requested state transition is outside the transition allowlist THEN THE SYSTEM SHALL reject it without mutating the run projection
- 8.3 WHEN the system decision is `HUMAN_REVIEW_REQUIRED` THE SYSTEM SHALL move from `REPORTING` to `AWAITING_HUMAN`
- 8.4 WHEN an active run is cancelled THE SYSTEM SHALL propagate cancellation to deterministic gates, reviewer dispatch, and the Judge
- 8.5 WHILE a provider call is active THE SYSTEM SHALL enforce a timeout no greater than `600000 ms`
- 8.6 WHILE a run is active THE SYSTEM SHALL enforce a total deadline no greater than `1800000 ms`
- 8.7 IF the total deadline expires before a deterministic blocker exists THEN THE SYSTEM SHALL return `INFRASTRUCTURE_FAILURE`
- 8.8 WHEN a model request is first dispatched THE SYSTEM SHALL persist one stable `requestId` for replay within that run
- 8.9 WHEN a request is replayed within the same run THE SYSTEM SHALL apply idempotency to publication and `costUnits` projection
- 8.10 IF a replay request belongs to a different run or head SHA THEN THE SYSTEM SHALL reject reuse of the old `requestId`
- 8.11 IF reported `costUnits` are negative, non-finite, or not representable within the configured numeric bound THEN THE SYSTEM SHALL mark that provider result invalid
- 8.12 WHEN aggregate cost reaches the policy cap THE SYSTEM SHALL stop further model spending and pass the resulting coverage to deterministic decision policy
- 8.13 WHEN a PR gate event is appended THE SYSTEM SHALL store large source, transcript, and report payloads as evidence references rather than inline event data
- 8.14 WHEN evidence or a final report is persisted THE SYSTEM SHALL bind it to content hashes and existing Ed25519 run metadata
- 8.15 WHEN the process restarts during a run THE SYSTEM SHALL recover the event-log projection to an idempotent stage or typed terminal state

## REQ-9: Secure GitHub Reporting

**User Story:** ในฐานะ repository maintainer ฉันต้องการให้ fork PR ตรวจได้โดยไม่เปิด write token หรือ secrets ให้ untrusted code เพื่อให้ Check Run เชื่อถือได้โดยไม่เพิ่ม repository takeover risk

**ที่มาใน design:** Sequence Diagrams, Technology Decisions, Non-Functional Considerations

**Acceptance Criteria (EARS):**

- 9.1 WHEN a `pull_request` workflow handles an untrusted PR THE SYSTEM SHALL perform unprivileged analysis consisting of snapshot acquisition and deterministic checks
- 9.2 WHEN the trusted `workflow_run` job receives an analysis artifact THE SYSTEM SHALL verify its workflow run id, repository, event type, PR identity, head SHA, and schema against GitHub provenance
- 9.3 BEFORE a trusted job dispatches reviewers THE SYSTEM SHALL revalidate the artifact manifest and deterministic report integrity against source and policy hashes independently fetched through read-only Git access
- 9.4 THE SYSTEM SHALL NOT treat a self-generated artifact signature alone as a trust anchor
- 9.5 WHILE a trusted workflow holds provider or GitHub credentials THE SYSTEM SHALL avoid checking out or executing the untrusted PR head
- 9.6 THE SYSTEM SHALL grant `checks: write` authority only to the GitHub reporter boundary
- 9.7 WHILE spawning a reviewer, Judge, or deterministic child process THE SYSTEM SHALL remove the GitHub reporter credential from the child environment
- 9.8 WHERE a PR originates from a fork THE SYSTEM SHALL use the same artifact-verification contract without executing fork code through `pull_request_target`
- 9.9 WHEN creating or completing a Check Run THE SYSTEM SHALL bind its lifecycle to the exact reviewed head SHA, including a current-head check before completion
- 9.10 WHEN publishing a completed Check Run THE SYSTEM SHALL map `PASS` and `PASS_WITH_WARNINGS` to `success`, `HUMAN_REVIEW_REQUIRED` to `action_required`, `FAIL` and `INFRASTRUCTURE_FAILURE` to `failure`, and cancellation states to `cancelled`
- 9.11 WHEN an old run becomes stale THE SYSTEM SHALL keep its Check Run permanently `cancelled`
- 9.12 WHEN publishing a Check Run summary THE SYSTEM SHALL produce a bounded, redacted projection that excludes credentials, private paths, PII, and provider secrets
- 9.13 IF GitHub reporting fails after decision persistence THEN THE SYSTEM SHALL persist a `REPORTING_FAILED` recovery record containing the durable decision and idempotent retry state without claiming publication
- 9.14 IF workflow provenance, artifact schema, deterministic report integrity, source hashes, policy hash, or exact head SHA fails verification THEN THE SYSTEM SHALL return `INFRASTRUCTURE_FAILURE` before exposing provider or GitHub write credentials to any child process

## REQ-10: Operator Control and Human Authority

**User Story:** ในฐานะ single operator ฉันต้องการสั่ง run, ตรวจ evidence, ยกเลิก และ override แบบ audit ได้ เพื่อคง human authority โดยไม่ลบผลระบบเดิม

**ที่มาใน design:** Data Models & Interfaces, Technology Decisions, Non-Functional Considerations

**Acceptance Criteria (EARS):**

- 10.1 WHERE CLI operation is enabled THE SYSTEM SHALL start the shared run manager through `platform pr-gate run --repo <owner/name> --pr <number>`
- 10.2 WHERE Console operation is enabled THE SYSTEM SHALL start the same run manager through `POST /api/pr-quality/runs`
- 10.3 WHERE Console operation is enabled THE SYSTEM SHALL expose bounded run-list and run-detail projections through the documented GET routes
- 10.4 WHERE Console operation is enabled THE SYSTEM SHALL allow an operator to cancel an active run through the documented cancel route
- 10.5 IF `PrGateManager` is not configured THEN THE SYSTEM SHALL omit all PR quality routes
- 10.6 WHILE PR quality routes are registered THE SYSTEM SHALL enforce the existing host, authentication, and startup guards
- 10.7 WHEN an operator submits a human override THE SYSTEM SHALL derive actor and timestamp from the authenticated server context and require reason, exact head SHA, action, and referenced finding ids
- 10.8 IF a human override head SHA differs from the current PR head SHA THEN THE SYSTEM SHALL reject the override
- 10.9 WHEN a human override is accepted THE SYSTEM SHALL maintain an immutable system decision alongside a separate effective decision
- 10.10 WHEN an `APPROVE` override is accepted THE SYSTEM SHALL set the effective decision to `PASS` and update the exact-head Check Run to `success` with an audit summary referencing actor, reason, and original report
- 10.11 WHEN a `REJECT` override is accepted THE SYSTEM SHALL set the effective decision to `FAIL` and update the exact-head Check Run to `failure` with an audit summary referencing actor, reason, and original report
- 10.12 WHEN displaying run detail THE SYSTEM SHALL separate deterministic failures, AI findings, coverage, cost, publication status, and override history
- 10.13 WHEN an override request repeats an existing idempotency key for the same run and head SHA THE SYSTEM SHALL return the existing override without appending or publishing a duplicate

## REQ-11: Security, Observability, and Support Ceiling

**User Story:** ในฐานะ platform operator ฉันต้องการให้ trust boundaries, coverage limits และ metrics เปิดเผยชัด เพื่อไม่ให้ prompt injection, truncation หรือ unsupported stack สร้าง false confidence

**ที่มาใน design:** Architecture Overview, Non-Functional Considerations, Deferred Scope

**Acceptance Criteria (EARS):**

- 11.1 WHILE processing PR title, description, source, tests, generated files, or head policy THE SYSTEM SHALL treat that content as untrusted data that cannot alter action authority or effective policy
- 11.2 WHILE spawning any child process THE SYSTEM SHALL construct its environment from an explicit allowlist rather than forwarding all of `process.env`
- 11.3 WHILE deterministic repository commands are active THE SYSTEM SHALL prevent access to provider egress routes
- 11.4 IF review context exceeds its byte or token budget THEN THE SYSTEM SHALL report `PARTIAL` or `LIMITED` coverage together with every omitted path and reason
- 11.5 THE SYSTEM SHALL NOT silently truncate review context while reporting `FULL` coverage
- 11.6 WHEN recording observability data THE SYSTEM SHALL include repository, PR, SHAs, technologies, categories, profiles, risk, coverage, stage duration, provider status, usage, finding counts, overrides, and final decision
- 11.7 WHEN recording logs, transcripts, metrics, or GitHub summaries THE SYSTEM SHALL exclude credentials, raw secrets, and PII
- 11.8 WHEN a provider cancellation completes THE SYSTEM SHALL record cancellation latency without recording provider credentials
- 11.9 WHEN rendering Console status THE SYSTEM SHALL present semantic status text in addition to color
- 11.10 WHILE an operator uses Console controls THE SYSTEM SHALL satisfy the accessible-control contract for keyboard navigation, visible focus, and labels
- 11.11 BEFORE accepting an override THE SYSTEM SHALL display stale/current head identity and publication status to the operator
- 11.12 WHERE a repository uses technology outside Node.js/TypeScript, documentation/configuration, or OpenAPI Phase 1 support THE SYSTEM SHALL produce an explicit support-limitation outcome that is ineligible for `PASS`

## Edge Cases & Open Questions

ไม่มี open question ที่ขวางการทดสอบ ร่างนี้ยึด decisions ที่อนุมัติใน design:

| กรณี | ผลที่กำหนด |
|---|---|
| deterministic check fail แต่ budget/deadline ยังเหลือ | รัน blind review ต่อ; final floor คง `FAIL` |
| reviewer สำเร็จ 3/4 | coverage `DEGRADED`; ผลดีที่สุด `PASS_WITH_WARNINGS` |
| reviewer สำเร็จ 2/4 | `HUMAN_REVIEW_REQUIRED` เว้น evidence บังคับ `FAIL` |
| reviewer สำเร็จ 0–1/4 | `INFRASTRUCTURE_FAILURE` เว้น evidence บังคับ `FAIL` |
| unsupported technology หรือ silent-truncation risk | coverage `LIMITED`; ห้าม `PASS` |
| head SHA เปลี่ยนระหว่าง run | cancel run เก่าและเริ่ม run ใหม่ |
| fork PR | unprivileged analysis + trusted artifact verification; privileged job ไม่ execute head |
| manual `review-fanout` | human assistance เท่านั้น; ไม่นับ automated coverage |

### Requirements audit decisions

Audit anchor: repository `926cc20`; requirements artifact ยัง untracked ที่ baseline นี้

| Finding | หมวด | Decision |
|---|---|---|
| A-1: REQ-7.5 ขัดกับ REQ-7.6/7.9 เมื่อ reviewer สำเร็จ 0–1 รายแต่มี verified blocker | logical inconsistency | ให้ deterministic blocker หรือ `VERIFIED HIGH/CRITICAL` มี precedence เป็น `FAIL` |
| A-2: `PARTIAL` coverage ไม่มี decision ceiling | gap | จำกัดผลดีที่สุดเป็น `PASS_WITH_WARNINGS` |
| A-3: Judge ไม่มี read-only contract ชัด | unstated assumption | บังคับ zero tool use และ zero action request |
| A-4: trusted workflow ตรวจ source/policy แต่ไม่ระบุ deterministic report integrity | gap | ตรวจ report integrity ก่อนเปิด provider/reporter boundary; fail closed เมื่อ binding ใดไม่ผ่าน |
| A-5: override รับ actor/timestamp จาก request และผล `REJECT` ไม่ deterministic | ambiguity/security | derive identity/time ฝั่ง server, map `APPROVE` เป็น effective `PASS`, `REJECT` เป็น effective `FAIL`, deduplicate ด้วย idempotency key |
