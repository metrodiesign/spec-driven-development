# Requirements: Loop Engineering Phase 0 Conformance

> Status: approved 2026-07-27, amended 2026-07-27

## Overview

เอกสารนี้กำหนดเฉพาะการแก้ conformance gaps ของ Phase 0 ที่ตรวจพบ ณ HEAD
`078e039` เทียบกับ normative source เพียงไฟล์เดียวคือ
`/Users/king_developer/Downloads/loop-engineering-implementation-spec.md`
(SHA-256 `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`)
โดยต้องคงพฤติกรรม DoD ที่ผ่านอยู่แล้วและต้องไม่สร้าง capability ของ Phase 1–4
ล่วงหน้า

Amendment วันที่ 2026-07-27 ทำให้ claim ของ macOS sandbox backend ตรงกับสิ่งที่
พิสูจน์ได้จริง: inherited profile ป้องกัน unauthorized filesystem/network effects
ได้ แต่ไม่ได้ authenticate denial ของ arbitrary descendant ทุกตัว และไม่รับประกัน
การ terminate descendant หลังสร้าง session ใหม่

## REQ-1: Durable Normative Authority and Phase Boundary

**User Story:** ในฐานะ platform maintainer ฉันต้องการ authority ที่ versioned และ
scope boundary ที่ชัด เพื่อให้ทุก implementation decision อ้างแหล่งเดียวกัน

**Acceptance Criteria (EARS):**

- 1.1 WHEN Phase 0 conformance implementation begins THE SYSTEM SHALL contain a repository-root `loop-engineering-implementation-spec.md` whose bytes match the external normative source exactly.
- 1.2 THE SYSTEM SHALL record the pinned authority SHA-256 as `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`.
- 1.3 IF either the byte comparison or SHA-256 comparison fails THEN THE SYSTEM SHALL block every implementation task after P0-01.
- 1.4 THE SYSTEM SHALL treat the verified repository-root copy as the sole normative product-behavior authority for this Phase 0 conformance work.
- 1.5 THE SYSTEM SHALL preserve every old master, blueprint, and archived platform specification byte-for-byte.
- 1.6 THE SYSTEM SHALL limit this work to Phase 0 mechanisms plus safeguards required to prevent an existing later-phase path from bypassing a Phase 0 invariant.
- 1.7 THE SYSTEM SHALL leave mutation gating, impact mapping, model adapters, calibration expansion, fusion, out-of-band auditing expansion, and learning-plane expansion outside this work.

## REQ-2: Unified Fail-Closed Child-Process Execution

**User Story:** ในฐานะ security maintainer ฉันต้องการให้ทุก child process ใช้
deterministic boundary เดียวกัน เพื่อไม่ให้ gate path ข้าม egress หรือ path policy

**Acceptance Criteria (EARS):**

- 2.1 WHEN the executor, a gate, or command-workspace preparation launches a child process THE SYSTEM SHALL launch it through one shared command-execution primitive.
- 2.2 WHILE a T0 or T1 command is running THE SYSTEM SHALL deny network egress.
- 2.3 IF an execution backend cannot prove revocable containment of every descendant that could retain a network grant THEN THE SYSTEM SHALL reject the network-allow request before spawning the command.
- 2.4 WHILE an agent-proposed command is running THE SYSTEM SHALL restrict durable writes to the normalized roots allowed for that role. _(Superseded in part by unified-platform-spec.md changelog v1.10 — role allowlist gate before spawn; ดู note ใต้ 2.26 ด้านล่าง)_
- 2.5 WHEN a direct-child result or another enforcement-owned channel observes an unauthorized filesystem or network denial THE SYSTEM SHALL return structured `sandbox_violation` feedback.
- 2.6 IF a command attempts a write outside its allowed roots THEN THE SYSTEM SHALL leave the protected artifact tree unchanged.
- 2.7 IF the enforcing sandbox is unavailable THEN THE SYSTEM SHALL fail the command closed with a structured reason.
- 2.8 WHEN a gate command runs THE SYSTEM SHALL run it against a disposable copy of one frozen input-tree hash.
- 2.9 WHEN a gate command terminates THE SYSTEM SHALL leave the original tested artifact tree byte-identical to its pre-command state.
- 2.10 IF the Phase 0 T0 or T1 configuration is missing a required check or contains an empty tier THEN THE SYSTEM SHALL emit an explicit failing gate report.
- 2.11 WHEN a child process terminates THE SYSTEM SHALL capture its exit status and output directly into core-owned evidence.
- 2.12 WHILE a gate command is running THE SYSTEM SHALL keep `test/golden/` non-writable.
- 2.13 WHILE Phase 0 uses the deprecated macOS sandbox backend THE SYSTEM SHALL reject every package-install request whose network mode is not `none`.
- 2.14 IF a Phase 0 package-install request lacks pre-provisioned offline inputs THEN THE SYSTEM SHALL reject it without granting network access.
- 2.15 WHEN an agent-proposed `RUN_COMMAND` has artifact-write authority THE SYSTEM SHALL execute it in a disposable workspace materialized from a frozen task-tree hash.
- 2.16 WHEN an artifact-mutating command returns THE SYSTEM SHALL freeze its output artifact before reading promotion input from it.
- 2.17 WHEN a post-command output artifact is frozen THE SYSTEM SHALL capture its diff with a core-owned bounded mechanism.
- 2.18 IF the captured command diff contains a path or artifact shape forbidden by role or golden policy THEN THE SYSTEM SHALL reject promotion of that diff.
- 2.19 WHEN a captured command diff passes role and golden policy THE SYSTEM SHALL core-promote exactly that frozen diff only after the command has returned.
- 2.20 WHEN an artifact-mutating command reaches a terminal promotion decision THE SYSTEM SHALL discard its disposable workspace without reusing it.
- 2.21 WHILE a descendant outlives its direct command process THE SYSTEM SHALL prevent that descendant from creating an unauthorized filesystem or network effect outside the disposable command boundary.
- 2.22 IF no enforcement-owned observation identifies a denied operation THEN THE SYSTEM SHALL NOT classify the execution as `sandbox_violation` solely from child-controlled output or the absence of an unauthorized effect.
- 2.23 THE SYSTEM SHALL make no Phase 0 claim that the macOS backend observes every descendant denial.
- 2.24 THE SYSTEM SHALL make no Phase 0 claim that the macOS backend terminates descendants after they establish a new session.
- 2.25 WHERE a command is core-classified as a read-only test or probe THE SYSTEM SHALL execute it without entering the artifact-promotion path.
- 2.26 WHEN a core-classified read-only test or probe terminates THE SYSTEM SHALL preserve its exit-status and output-evidence contract.

> **Superseded in part (unified-platform-spec.md changelog v1.10, spec `.pipeline/run-command-prompt-contract/`):**
> RUN_COMMAND ได้ role allowlist gate (`checkCommand`) ก่อน spawn — เฉพาะ `implementer`/`diagnostician`
> รันได้; `planner`/`test_designer`/`reviewer` ถูกปฏิเสธด้วย `command_role_denied` ก่อนถึงจุดรัน ผลต่อ AC
> กลุ่มนี้: **2.4** ยังจำกัด durable write ตาม role สำหรับ role ที่รันได้ แต่ role นอก allowlist ไม่ถึงจุดรัน
> อีกต่อไป (ถูกตัดก่อน spawn ไม่ใช่ตอนตรวจ mutation diff ปลายทาง) · **2.25/2.26** read-only test/probe คง
> exit/output contract เดิมสำหรับ role ที่รันได้ แต่ "read-only" ไม่เป็นข้ออนุญาตให้ role นอก allowlist สั่ง
> ได้อีกต่อไป · ส่วนที่ไม่ขยับ: mutation-diff / `writeRoots(role)` / `read_only_probe` classification ที่
> Ring 0 คงเดิมทุกประการ รายละเอียดเต็ม + เหตุผลดู changelog v1.10 ใน `unified-platform-spec.md`

- 2.27 IF a frozen or captured command artifact cannot be materialized and inventoried within core-owned resource limits THEN THE SYSTEM SHALL fail closed with a structured reason.
- 2.28 WHEN a command-artifact attempt fails before returning a promotable artifact THE SYSTEM SHALL clean up every core-owned temporary artifact from that attempt.
- 2.29 WHEN core starts a command under `network: none` THE SYSTEM SHALL record the enforced network-policy hash in core-owned evidence.
- 2.30 WHEN core records an environment hash for child-process evidence THE SYSTEM SHALL bind the policy bytes and content hashes of resolved control-plane toolchain executables into that hash.
- 2.31 WHEN production composition authorizes a Phase 0 offline package install THE SYSTEM SHALL bind the validated role-scoped offline dependency policy into the executor request.
- 2.32 IF a requesting role lacks package-install permission THEN THE SYSTEM SHALL reject the request without adding any writable root.
- 2.33 WHEN a Phase 0 offline package install is authorized THE SYSTEM SHALL verify its requested dependency graph against the exact frozen lockfile before spawning the command.
- 2.34 IF an offline package source is not approved by the content-hash policy THEN THE SYSTEM SHALL reject the package-install request.
- 2.35 WHEN a Phase 0 offline package-install command is spawned THE SYSTEM SHALL disable dependency lifecycle scripts.
- 2.36 IF the required lockfile is missing or mismatched THEN THE SYSTEM SHALL reject the package-install request before spawn.
- 2.37 WHEN the macOS backend publishes command evidence THE SYSTEM SHALL record its denial-observation scope as `direct_only`.
- 2.38 WHEN the macOS backend publishes command evidence THE SYSTEM SHALL record revocable descendant containment as `false`.
- 2.39 WHEN the macOS backend publishes command evidence THE SYSTEM SHALL record descendant termination as `unproven_new_session`.
- 2.40 IF no enforcement-owned observation identifies a denied operation THEN THE SYSTEM SHALL record `observedViolation: null` in command evidence.
- 2.41 WHEN command-artifact capture begins THE SYSTEM SHALL enforce versioned finite limits for file count, single-file bytes, total bytes, diff bytes, and capture time.
- 2.42 IF the disposable source inventory changes between the pre-copy and post-copy observations THEN THE SYSTEM SHALL reject the captured artifact.
- 2.43 IF any exclusive capture-destination content hash differs from the corresponding pre-copy inventory hash THEN THE SYSTEM SHALL reject the captured artifact.
- 2.44 IF a changed command artifact contains a symlink, submodule, device, socket, FIFO, or another unsupported shape THEN THE SYSTEM SHALL reject promotion of that artifact.
- 2.45 WHEN core creates a command capture destination THE SYSTEM SHALL keep that destination outside every command-sandbox writable root.
- 2.46 WHEN core accepts an agent-proposed `RUN_COMMAND` THE SYSTEM SHALL derive execution mode, write roots, and frozen input hash from trusted policy rather than agent-controlled fields.
- 2.47 THE SYSTEM SHALL expose artifact-mutating command execution only through one core-owned orchestration contract.
- 2.48 IF an artifact-mutating command returns a non-zero exit status THEN THE SYSTEM SHALL classify the outcome as `command_failed`.
- 2.49 WHEN an artifact-mutating outcome is `command_failed` THE SYSTEM SHALL promote no captured diff.

## REQ-3: Complete Phase 0 Action Lifecycle

**User Story:** ในฐานะ loop operator ฉันต้องการให้ Action DSL ของ Phase 0 ทำงานครบ
ภายใต้ policy และ recovery เดียวกัน เพื่อไม่ให้ patch เป็นช่องว่างของ executor

**Acceptance Criteria (EARS):**

- 3.1 WHEN an `APPLY_PATCH` action references a valid textual patch whose affected paths are permitted for the role THE SYSTEM SHALL apply that patch to the task worktree.
- 3.2 WHEN the core receives an `APPLY_PATCH` action THE SYSTEM SHALL dereference and hash-verify `diffRef` before parsing any path.
- 3.3 WHEN the core evaluates an `APPLY_PATCH` action THE SYSTEM SHALL apply role policy to every old path and every new path named by the patch.
- 3.4 IF a patch names `test/golden/`, an absolute path, a traversal path, or a path outside the role allowlist THEN THE SYSTEM SHALL reject the action before mutation.
- 3.5 IF a patch is missing, hash-mismatched, malformed, binary, symlink-bearing, empty, or conflicting THEN THE SYSTEM SHALL return a structured rejection.
- 3.6 WHEN an accepted mutating action executes THE SYSTEM SHALL record snapshot, `ACTION_INTENT`, side effect, and `ACTION_APPLIED` in that order.
- 3.7 WHEN recovery finds an `ACTION_INTENT` without `ACTION_APPLIED` THE SYSTEM SHALL restore the snapshot before deterministically replaying the action.
- 3.8 WHEN an already-applied `actionId` is proposed THE SYSTEM SHALL skip its side effect idempotently.
- 3.9 WHEN an allowed `READ_FILE` action executes THE SYSTEM SHALL omit snapshot and `ACTION_INTENT` because the action is non-mutating.
- 3.10 WHEN an allowed `READ_FILE` action succeeds THE SYSTEM SHALL record `ACTION_APPLIED` with a content-addressed output reference.
- 3.11 IF a `READ_FILE` path escapes the worktree THEN THE SYSTEM SHALL return structured rejection feedback.

## REQ-4: Authenticated Evidence at Every Trust Boundary

**User Story:** ในฐานะ verifier ฉันต้องการหลักฐานที่ทั้งตรวจ integrity และ
authenticate แหล่งกำเนิดได้ เพื่อไม่ให้ hash ที่ไม่เคย dereference หรือ fake report
ขับ state transition

**Acceptance Criteria (EARS):**

- 4.1 WHEN a new run is initialized THE SYSTEM SHALL create one Ed25519 keypair using the Node built-in cryptography API.
- 4.2 THE SYSTEM SHALL store the run private key outside every agent worktree under the run-state directory with filesystem mode `0600`.
- 4.3 WHEN a new run is initialized THE SYSTEM SHALL freeze the public key and its SHA-256 fingerprint in immutable run metadata.
- 4.4 WHEN a run recovers THE SYSTEM SHALL reuse the same private key identified by the frozen public-key fingerprint.
- 4.5 THE SYSTEM SHALL canonicalize signed evidence metadata with one versioned deterministic byte encoding.
- 4.6 WHEN the core creates a gate report THE SYSTEM SHALL sign canonical metadata containing the run, task, tier, gate-config hash, commit hash, worktree hash, environment hash, check verdicts, evidence references, and referenced content hashes.
- 4.7 WHEN the evidence store publishes a blob THE SYSTEM SHALL use atomic exclusive creation.
- 4.8 IF a content-addressed blob already exists THEN THE SYSTEM SHALL verify its bytes before returning its reference.
- 4.9 WHEN a report reaches a state-advancement, approval, merge, audit, or completion boundary THE SYSTEM SHALL dereference every evidence reference before trusting the report.
- 4.10 WHEN a report reaches a trust boundary THE SYSTEM SHALL verify its Ed25519 signature against the frozen run public key.
- 4.11 IF an evidence reference, content hash, signing key, public-key fingerprint, or signature is missing or mismatched THEN THE SYSTEM SHALL transition the task to `ESCALATED` with a structured reason.
- 4.12 IF evidence authentication fails THEN THE SYSTEM SHALL prevent every subsequent state advancement for that report.
- 4.13 THE SYSTEM SHALL add no third-party dependency for evidence authentication.

## REQ-5: Phase 0 Gate Semantics

**User Story:** ในฐานะ controller maintainer ฉันต้องการให้ T0/T1 ทำงานตาม timing
ที่กำหนดและ fail closed เพื่อให้ claim ของ agent ไม่มีทางข้าม core verification

**Acceptance Criteria (EARS):**

- 5.1 WHEN an implementer or repair proposal finishes its action batch THE SYSTEM SHALL run T0 exactly once for that iteration.
- 5.2 WHEN a proposal contains zero actions THE SYSTEM SHALL still apply the T0 rule for its implementer or repair iteration.
- 5.3 WHEN a diagnostician proposal or hypothesis probe does not modify the artifact THE SYSTEM SHALL exclude that round from the T0 iteration count.
- 5.4 WHEN a `READY_FOR_VERIFICATION` iteration has a passing T0 report THE SYSTEM SHALL run T1 exactly once against the same frozen artifact.
- 5.5 IF T0 or T1 fails THEN THE SYSTEM SHALL enter the deterministic failure and diagnosis flow.
- 5.6 IF a gate check fails once and passes on its single retry THEN THE SYSTEM SHALL report `flakySuspect: true` with `pass: false`.
- 5.7 IF a gate check remains failing after its retry THEN THE SYSTEM SHALL keep the failure active without automatic quarantine.
- 5.8 WHEN any gate tier is evaluated THE SYSTEM SHALL append a `GATE_RESULT` containing the gate-config hash.
- 5.9 WHILE Phase 0 is active THE SYSTEM SHALL report T2 and T3 as `not_enabled` stubs.
- 5.10 WHEN T2 or T3 is requested in Phase 0 THE SYSTEM SHALL append its explicit stub report to the event log.

## REQ-6: Lease Lifecycle and Fencing

**User Story:** ในฐานะ scheduler maintainer ฉันต้องการ lease ครอบทุก task lifecycle
เพื่อให้ single-task และ graph mode เป็น single-writer จริง

**Acceptance Criteria (EARS):**

- 6.1 WHEN any single-task or graph-task loop starts THE SYSTEM SHALL acquire a task lease before requesting the first proposal.
- 6.2 IF another owner holds an unexpired task lease THEN THE SYSTEM SHALL prevent the losing loop from producing proposal, intent, applied-action, or gate events.
- 6.3 IF configured lease TTL is not greater than the maximum atomic-operation duration plus its safety margin THEN THE SYSTEM SHALL refuse to start the task loop.
- 6.4 WHILE a task loop owns a lease THE SYSTEM SHALL heartbeat that lease during asynchronous waits.
- 6.5 WHEN the loop is about to start an executor action or gate THE SYSTEM SHALL verify current fenced ownership.
- 6.6 IF lease renewal or fenced ownership verification fails THEN THE SYSTEM SHALL stop new side effects with a structured task outcome.
- 6.7 WHEN a paused task resumes THE SYSTEM SHALL reacquire fenced ownership before requesting another proposal.
- 6.8 IF a resumed task cannot reacquire fenced ownership THEN THE SYSTEM SHALL remain non-executing.
- 6.9 WHEN a task reaches any terminal or error path THE SYSTEM SHALL release its lease if it still owns that lease.
- 6.10 WHEN an expired owner is replaced THE SYSTEM SHALL allow only the new fencing token to authorize subsequent side effects.

## REQ-7: Non-Bypassable Budget Arithmetic

**User Story:** ในฐานะ operator ฉันต้องการ budget ที่รับเฉพาะ normalized usage
เพื่อไม่ให้ untrusted negative หรือ non-finite cost ทำให้ลูปเพิ่มงบเอง

**Acceptance Criteria (EARS):**

- 7.1 WHEN AAL accepts per-response usage THE SYSTEM SHALL require a finite non-negative `costUnits` value.
- 7.2 WHEN core receives a proposal from any `ProposalSource` THE SYSTEM SHALL require a finite non-negative `costUnits` value.
- 7.3 WHEN repair or fusion usage is aggregated THE SYSTEM SHALL reject a non-finite or overflowed total.
- 7.4 IF usage validation fails THEN THE SYSTEM SHALL transition the task to `ESCALATED` with reason `invalid_response`.
- 7.5 IF usage validation fails THEN THE SYSTEM SHALL leave accumulated cost unchanged.
- 7.6 WHEN usage equals zero THE SYSTEM SHALL accept it as a valid charge.
- 7.7 IF any iteration, cost, or active-wallclock limit is exhausted THEN THE SYSTEM SHALL emit `BUDGET_EXCEEDED`.
- 7.8 IF any budget limit is exhausted THEN THE SYSTEM SHALL stop requesting proposals.

## REQ-8: Operator-Supplied Golden Truth and Paired Coverage

**User Story:** ในฐานะ product owner ฉันต้องการ golden truth ที่ระบบแก้เองไม่ได้
พร้อม coverage denominator เพื่อให้ held-out pass rate ไม่ถูกอ่านเกินสิ่งที่ครอบ

**Acceptance Criteria (EARS):**

- 8.1 THE SYSTEM SHALL provide a deterministic verifier for every `_MANIFEST.sha256` under configured golden roots.
- 8.2 WHEN CI runs THE SYSTEM SHALL invoke the golden-manifest verifier directly.
- 8.3 WHEN a loop target fixture is provisioned THE SYSTEM SHALL copy operator-supplied golden bytes and manifest bytes without regeneration.
- 8.4 THE SYSTEM SHALL expose no runtime or agent API that generates or weakens golden truth.
- 8.5 WHILE any agent role is active THE SYSTEM SHALL keep `test/golden/` read-only.
- 8.6 IF operator-supplied golden fixture bytes are absent THEN THE SYSTEM SHALL keep the golden operationalization task explicitly `BLOCKED`.
- 8.7 WHEN golden coverage is computed THE SYSTEM SHALL count unique golden-backed in-scope acceptance-criterion IDs as the numerator.
- 8.8 WHEN golden coverage is computed THE SYSTEM SHALL count all unique in-scope acceptance-criterion IDs as the denominator.
- 8.9 WHEN held-out pass rate is reported THE SYSTEM SHALL report golden coverage beside it.
- 8.10 IF a golden file is added, edited, deleted, or disagrees with its manifest THEN THE SYSTEM SHALL fail verification.
- 8.11 THE SYSTEM SHALL describe copied fixture bytes by source and hash without attributing agent-created content to a human author.

## REQ-9: Deterministic Prohibited-Change Enforcement

**User Story:** ในฐานะ test maintainer ฉันต้องการแยก syntactic convention checks
ออกจาก semantic test protection เพื่อให้ enforcement ไม่อ้างความสามารถเกินจริง

**Acceptance Criteria (EARS):**

- 9.1 THE SYSTEM SHALL restrict convention regular expressions to deterministic syntactic patterns.
- 9.2 WHEN convention policy changes THE SYSTEM SHALL bind the versioned policy bytes into the gate-config hash.
- 9.3 IF a test contains a focused or skipped-test syntax variant prohibited by policy THEN THE SYSTEM SHALL fail the convention check.
- 9.4 IF a configured typecheck, lint, coverage, rule-disable, or unexplained-ignore bypass syntax appears THEN THE SYSTEM SHALL fail the convention check.
- 9.5 WHEN a syntactic convention rule is added THE SYSTEM SHALL include paired blocking and allowed regression cases.
- 9.6 WHEN core observes the expected RED failure for an AI-generated test THE SYSTEM SHALL freeze that test artifact hash with provenance.
- 9.7 IF an implementer action edits or deletes a frozen RED test artifact THEN THE SYSTEM SHALL reject the action.
- 9.8 WHEN a test designer corrects a frozen RED test THE SYSTEM SHALL require a new observed RED result before replacing its frozen provenance.
- 9.9 THE SYSTEM SHALL enforce deletion, assertion weakening, and test-edit-to-pass prohibitions through frozen RED provenance rather than a semantic classifier.
- 9.10 THE SYSTEM SHALL make no Phase 0 claim that regex matching proves semantic correctness.

## REQ-10: Fault-Injection Closure and Regression Guarantees

**User Story:** ในฐานะ release owner ฉันต้องการ DoD 1–9 พิสูจน์บน production wiring
จริง เพื่อให้ suite เขียวหมายถึง Phase 0 conformance แทนการทดสอบ primitive ที่หลุดจากลูป

**Acceptance Criteria (EARS):**

- 10.1 WHEN a stub agent falsely claims success THE SYSTEM SHALL prevent success unless core-run T0 and T1 evidence passes.
- 10.2 WHEN a fault proposes an out-of-role or golden mutation THE SYSTEM SHALL reject it as structured feedback.
- 10.3 WHEN a fault attempts network egress through either executor or gate command paths THE SYSTEM SHALL prevent the network effect.
- 10.4 WHEN a fault supplies fake-green, missing, tampered, or wrongly signed evidence THE SYSTEM SHALL prevent state advancement.
- 10.5 WHEN a fault produces fail-then-pass test behavior THE SYSTEM SHALL retry once and flag the test without silently quarantining it.
- 10.6 WHEN a fault crashes between `ACTION_INTENT` and `ACTION_APPLIED` THE SYSTEM SHALL resume without applying the action twice.
- 10.7 WHEN a fault repeats an applied `actionId` THE SYSTEM SHALL skip the duplicate side effect.
- 10.8 WHEN two real task loops contend for one task THE SYSTEM SHALL permit one side-effecting owner.
- 10.9 WHEN a fault exhausts any budget THE SYSTEM SHALL reach `ESCALATED` without another proposal.
- 10.10 WHEN Phase 0 closure is evaluated THE SYSTEM SHALL execute all nine fault scenarios through wired production paths.
- 10.11 WHEN live kernel egress behavior is evaluated THE SYSTEM SHALL use an enforcing macOS environment rather than a mock sandbox.
- 10.12 THE SYSTEM SHALL keep Ring 0 and Ring 1 free of prohibited vendor names.
- 10.13 WHILE Phase 0 closure is evaluated THE SYSTEM SHALL preserve human control over L3 and L4 decisions.
- 10.14 IF any DoD scenario, direct golden-manifest check, typecheck, lint, or full relevant test suite fails THEN THE SYSTEM SHALL withhold the Phase 0 conformance claim.
- 10.15 IF operator-supplied golden fixture bytes remain unavailable THEN THE SYSTEM SHALL report Phase 0 conformance as blocked rather than fabricate the fixture.

## Phase 0 DoD Mapping

| §11 DoD | Primary criteria | Regression status entering this work |
|---|---|---|
| 1. False success claim | 5.1-5.5, 10.1 | Existing pass; must remain green |
| 2. Out-of-policy or golden action | 2.4-2.6, 2.15-2.21, 2.31-2.36, 2.41-2.49, 3.3-3.5, 10.2 | Partial gap on command and patch surfaces |
| 3. Hidden network egress | 2.1-2.3, 2.5, 2.7-2.9, 2.13-2.14, 2.21-2.24, 2.29, 2.31, 2.33-2.40, 10.3, 10.11 | Gap on gate child processes |
| 4. Fake-green or evidence mismatch | REQ-4, 10.4 | Gap at trust boundaries and authenticity |
| 5. Flaky retry-and-flag | 5.6-5.7, 10.5 | Existing pass; must remain green |
| 6. Crash between intent/applied | 3.6-3.7, 10.6 | Existing pass; extend to patch |
| 7. Duplicate action ID | 3.8, 10.7 | Existing pass; extend to patch/read |
| 8. Lease contention | REQ-6, 10.8 | Partial gap outside current graph claim |
| 9. Budget exhaustion | REQ-7, 10.9 | Iteration pass; cost validation gap |

## Edge Cases & Open Questions

- Decision closed: evidence authenticity uses one per-run Node built-in Ed25519 keypair;
  the private key lives outside agent worktrees with mode `0600`; recovery reuses it.
- Decision closed: missing evidence, key, fingerprint, or signature fails closed into
  structured `ESCALATED`.
- Decision closed: `READ_FILE` is the sole non-mutating lifecycle exception in this
  scope; it records `ACTION_APPLIED` with the content reference but no snapshot or
  `ACTION_INTENT`.
- Decision closed: syntactic convention rules use deterministic matching only;
  semantic prohibited changes use frozen RED provenance.
- Decision closed: golden verification tooling may be implemented by the system, but
  golden truth bytes must come from an operator. Absence is a blocker, not permission
  to synthesize truth.
- Decision closed: old master, blueprint, and archived specs remain untouched and are
  not product-behavior authority.
- Decision closed by amendment: the deprecated macOS sandbox backend is an
  effect-denial boundary, not a universal attempt-attribution or whole-descendant
  cleanup system. Only direct or enforcement-owned observations produce
  `sandbox_violation`; an unobserved descendant attempt is never reported as detected.
- Decision closed by amendment: Phase 0 grants no network allowlist on macOS because
  the backend cannot prove revocable descendant containment. Package installation is
  offline-only under `network: none`; missing offline inputs fail closed. To resolve
  the pinned §4.1/§8.1 versus §11 repository-map conflict conservatively, the minimal
  Phase 0 dependency policy remains active: exact frozen-lockfile matching,
  content-hash-approved offline sources, role-scoped write roots, and lifecycle scripts
  disabled. Registry access, online resolution, and the later full dependency-policy
  plane remain out of scope.
- Decision closed by amendment: an artifact-mutating `RUN_COMMAND` operates on a
  disposable frozen workspace. Core freezes and policy-checks the captured diff before
  promoting exactly that diff; a leaked descendant remains confined to the discarded
  workspace/profile. Read-only tests and probes retain their existing result/evidence
  behavior without promotion.
- Execution constraint: live `sandbox-exec` denial proof must run outside the nested
  managed sandbox or on CI `macos-latest`; exit 71 from nested sandboxing is not a
  product verdict.

### Quick-mode self-audit

| Category | Result |
|---|---|
| Logical inconsistencies | Resolved the apparent “every action has INTENT” conflict by documenting `READ_FILE` as a non-mutating exception while retaining `ACTION_APPLIED` evidence. |
| Ambiguities | Closed signing-key lifecycle, golden provenance, lease fencing, T0 iteration counting, and semantic-prohibition mechanisms above. |
| Conflicting constraints | Preserved Phase 0 scope while allowing only safeguards on existing later-phase trust boundaries that could otherwise mint `COMPLETED`. |
| Gaps | Added explicit criteria for command/gate isolation, honest denial observation/evidence, deterministic bounded disposable command promotion, minimal offline dependency policy, `APPLY_PATCH`, evidence authentication, lease lifecycle, cost validation, golden coverage, and frozen RED provenance. |
| Unstated assumptions | The external source must retain the recorded SHA-256; Node 26 supplies built-in Ed25519; kernel-level effect denial is performed on macOS. The deprecated backend cannot prove arbitrary-descendant attempt attribution or new-session cleanup, so those are explicit non-claims rather than fabricated audit evidence. Any failed enforcement assumption blocks rather than degrades conformance. |
