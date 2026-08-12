# Requirements: Cross-Harness SDD Closure

> Status: approved 2026-08-12, amended 2026-08-12

## Overview

ปิดช่องว่างที่ทำให้ Claude Code, Codex, OpenCode และ Pi ยังบังคับ workflow แบบ
spec-driven development ได้ไม่เท่ากัน โดยคง shared `.ai/` engines เป็น source of truth,
ใช้ deterministic CI แทน model calls และบันทึกข้อจำกัดที่แต่ละ harness ทำไม่ได้จริง.

## REQ-1: Credential Hygiene

**User Story:** As a repository owner, I want leaked credentials revoked and removed
from persistent shell configuration, so that harness setup cannot reuse compromised secrets.

**Acceptance Criteria (EARS):**

- 1.1 WHEN a plaintext credential is found during harness verification THE SYSTEM SHALL remove
  that credential from persistent local configuration.
- 1.2 WHEN a plaintext credential is exposed during harness verification THE SYSTEM SHALL record
  whether its provider has revoked it.
- 1.3 IF revocation cannot be performed with available authenticated tooling THEN THE SYSTEM SHALL
  report the exact provider and required operator action without printing the credential.
- 1.4 THE SYSTEM SHALL NOT commit credentials or credential-bearing configuration.

## REQ-2: Protected Integration Branches

**User Story:** As a repository owner, I want server-side branch rules, so that every harness must
use the same reviewed and CI-green merge path.

**Acceptance Criteria (EARS):**

- 2.1 THE SYSTEM SHALL apply one active GitHub ruleset to `main` and `develop`.
- 2.2 THE SYSTEM SHALL require pull requests for changes targeting protected branches.
- 2.3 THE SYSTEM SHALL require the
  `platform (vendor check + typecheck + lint + tests)` status check before protected branches can
  update.
- 2.4 THE SYSTEM SHALL block branch deletion and non-fast-forward updates on protected branches.
- 2.5 THE SYSTEM SHALL permit only squash merges through the protected-branch pull-request rule.
- 2.6 IF repository ownership makes one approving reviewer impossible THEN THE SYSTEM SHALL keep
  required approvals at zero while requiring pull requests, resolved review threads and CI checks.
- 2.7 THE SYSTEM SHALL require the `guards + spec-trace` status check before protected branches can
  update.

## REQ-3: Deterministic Cross-Harness Conformance

**User Story:** As a framework maintainer, I want one conformance fixture for all supported
harnesses, so that adapter drift fails CI before users observe different SDD behavior.

**Acceptance Criteria (EARS):**

- 3.1 THE SYSTEM SHALL define one deterministic conformance fixture covering Claude Code, Codex,
  OpenCode and Pi.
- 3.2 WHEN CI runs the fixture THE SYSTEM SHALL verify each harness routes supported guard behavior
  to the canonical `.ai/bin` policy engines.
- 3.3 WHEN CI runs the fixture THE SYSTEM SHALL verify each harness exposes the canonical SDD phase
  entry points required by the parity matrix in `.ai/README.md` without contradiction from its
  adapter documentation.
- 3.4 THE SYSTEM SHALL run conformance without model API calls or harness credentials.
- 3.5 IF a harness adapter omits a required supported behavior THEN THE SYSTEM SHALL fail the fixture
  with the harness name and missing behavior.
- 3.6 WHERE an operator requests runtime confirmation THE SYSTEM SHALL provide an optional manual
  probe that reports installed harness versions and adapter discovery without joining the CI gate.

## REQ-4: Pi Enforcement and Capability Exceptions

**User Story:** As a Pi user, I want automatic policy enforcement where Pi supports it and explicit
fallbacks where it does not, so that unsupported parity is never implied.

**Acceptance Criteria (EARS):**

- 4.1 WHERE Pi project extensions are supported THE SYSTEM SHALL automatically run the canonical
  destructive-command and bypass checks before matching tool calls execute.
- 4.2 WHEN a Pi `write` or `edit` tool call proposes a completed checkbox in a spec `tasks.md` file
  THE SYSTEM SHALL run the canonical task gate before that tool call executes.
- 4.3 IF a Pi policy engine returns a blocking verdict or cannot be executed THEN THE SYSTEM SHALL
  prevent the governed action and report the reason.
- 4.4 THE SYSTEM SHALL declare Pi fresh-context subagents as an unsupported capability.
- 4.5 THE SYSTEM SHALL declare Pi MCP/browser integration as an unsupported capability.
- 4.6 WHEN work requires an unsupported Pi capability THE SYSTEM SHALL instruct the operator to stop
  the Pi path and route that work to Claude Code, Codex or OpenCode rather than claim Pi parity.
- 4.7 THE SYSTEM SHALL test each supported Pi enforcement path with one blocked case and one allowed
  case.
- 4.8 WHEN a Pi `bash` tool call attempts to modify a spec `tasks.md` file THE SYSTEM SHALL block the
  call and require the governed `write` or `edit` path.

## REQ-5: Diff-Aware CI Evidence Gate

**User Story:** As a reviewer, I want CI to reject newly completed tasks with placeholder Evidence,
so that task completion always carries an observed verification result.

**Acceptance Criteria (EARS):**

- 5.1 WHEN a pull request diff from the merge base of `origin/${GITHUB_BASE_REF}` to `HEAD` newly
  adds a completed task checkbox THE SYSTEM SHALL require non-placeholder Evidence in that task
  region.
- 5.2 WHEN a protected-branch push diff from the event `before` SHA to `HEAD` newly adds a completed
  task checkbox THE SYSTEM SHALL require non-placeholder Evidence in that task region.
- 5.3 THE SYSTEM SHALL reuse the canonical Evidence parser instead of implementing a second parser
  in CI.
- 5.4 IF diff-base resolution fails THEN THE SYSTEM SHALL fail closed rather than skip the Evidence
  gate.
- 5.5 IF a changed `tasks.md` file adds no completed task checkbox THEN THE SYSTEM SHALL not fail it
  for historical Evidence content.
- 5.6 IF a newly completed task contains empty or placeholder Evidence THEN THE SYSTEM SHALL fail CI
  with the affected file and task opening line.
- 5.7 THE SYSTEM SHALL test valid multiline Evidence, valid inline Evidence, placeholder Evidence,
  unrelated task edits and diff-base failure.

## REQ-6: Adapter and Version Drift Removal

**User Story:** As a harness user, I want adapters to reference existing canonical files and pinned
tool versions, so that setup is reproducible and documentation does not route to missing paths.

**Acceptance Criteria (EARS):**

- 6.1 THE SYSTEM SHALL remove every supported adapter reference to the absent
  `.ai/shared/stack/nextjs.md` file.
- 6.2 THE SYSTEM SHALL describe optional stack guidance consistently across Claude Code, Codex,
  OpenCode and Pi adapters.
- 6.3 WHERE `chrome-devtools-mcp` is configured THE SYSTEM SHALL use one exact package version rather
  than a floating `latest` tag.
- 6.4 WHEN the configured MCP package version changes THE SYSTEM SHALL require an explicit repository
  diff that the conformance fixture can inspect.
- 6.5 IF an adapter claims a capability absent from its runtime integration THEN THE SYSTEM SHALL
  fail conformance or mark that capability as an explicit exception.

## Edge Cases & Open Questions

- Behavioral parity means equal policy outcome for declared supported capabilities; mechanism may
  differ by harness.
- Pi lacks fresh-context subagents and MCP/browser integration in current repository setup; these
  remain explicit exceptions with routing fallback.
- CI conformance stays deterministic and credential-free; live CLI probes remain operator-run.
- Evidence enforcement applies only to task checkboxes newly completed by the current diff; old
  completed tasks are not retroactively rejected.
- GitHub ruleset approval count remains zero because repository has one operator; CI and review-thread
  requirements still apply.
- GitHub PAT revocation is verified. Operator confirmed the exposed Gemini key was deleted and
  replaced; an HTTP 200 from the current environment identifies the active replacement, not the
  deleted value. No credential value, suffix or fingerprint is retained.

## Requirements Analysis Log

Audit anchor: repository commit `d52e3b5`; this requirements file was untracked at that commit.

| Finding | Category | Decision | Result |
|---|---|---|---|
| AN-1 | Ambiguity | Use Pi pre-execution `tool_call` interception | REQ-4.2 now gates `write` and `edit`; REQ-4.8 blocks shell mutation of `tasks.md` |
| AN-2 | Unstated assumption | Keep `.ai/README.md` parity matrix and adapter docs as capability contract | REQ-3.3 names existing sources; no new JSON manifest |
| AN-3 | Ambiguity | Pin both current GitHub check contexts | REQ-2.3 and REQ-2.7 name exact required checks |
| AN-4 | Gap | Use merge-base for pull requests and event `before` SHA for pushes | REQ-5.1 and REQ-5.2 define diff baselines; REQ-5.4 remains fail-closed |
| AN-5 | Logical inconsistency | None found | Existing requirements remain compatible after AN-1 through AN-4 |
| AN-6 | Conflicting constraint | None found | Credential-free CI and optional live probe remain separate paths |
