# Handoff: Task 64 — P0-09 review fixes

> From: Codex review-fix worker  To: parent / acceptance owner  Date: 2026-08-02

## Task Summary

แก้ High/Medium findings จาก Task 63 ของ P0-09 (`loop-engineering-phase0-conformance`)
โดย wire versioned convention policy และ core-observed RED provenance เข้า production
composition พร้อมปิด alias/control/re-hydration ช่องโหว่ งาน Task 9 ยังคง `[ ]`
และยังไม่มี Evidence block จนกว่าจะผ่าน acceptance review.

## Current Status

`IMPLEMENTED — READY FOR FRESH ACCEPTANCE REVIEW`.

## Files Changed

- `.ai/policies/convention.json` — ย้าย documented control ลง rule `lint-rule-disable` แบบ per-rule และจำกัด marker เป็น comment (edited).
- `core/src/gates/convention.ts` — parse/ตรวจ per-rule controls และ block legacy global controls; matching เป็น syntactic-only (edited).
- `core/src/gates/convention.test.ts` — paired blocking/allowed และ cross-rule near-miss regressions (edited).
- `core/src/gates/red-provenance.ts` — core-minted authenticated observation, evidence/report/artifact hash verification, current-artifact rehydration, latest replacement replay (edited).
- `core/src/gates/red-provenance.test.ts` — RED-first provenance, caller-boolean rejection, correction/rehydration regressions (edited).
- `core/src/executor/path-policy.ts` — exported canonical relative-path normalization (edited).
- `core/src/executor/executor.ts` — normalized frozen-RED lookup for all mutation preflight paths (edited).
- `core/src/executor/red-artifact-fault.test.ts` — frozen RED mutation and `..` alias coverage (edited).
- `core/src/index.ts` — exports observation and path-normalization APIs (edited).
- `console/backend/src/loop-run.ts` — copies versioned policy into target fixture; passes policy path and per-task rehydrated RED store to executor/policy; passes policy path to merge audit (edited).
- `console/backend/src/fusion.ts` — optional versioned policy path for candidate GateRunner composition (edited).
- `core/src/audit/oob.ts`, `console/backend/src/auditor-cli.ts`, `console/backend/bin/platform.ts` — production OOB convention-policy path plumbing (edited).
- `core/src/merge/auto-merge.ts` — convention-policy path for clean audit checkout (edited).

## Important Decisions

- `RedObservation` is not admitted from a caller-supplied `observedByCore: true` object. `createCoreRedObservation` verifies a signed failing GateReport and captures artifact/report bytes in `EvidenceStore`; freeze/replace validate the opaque observation token and recompute all hashes.
- Rehydration dereferences both `contentRef` and `reportRef`, verifies hashes/signature/failure fingerprint, and (when `worktreeDir` is supplied by production) verifies current artifact bytes before admission. A stale current artifact fails closed.
- Convention controls are explicit per rule and comment-only; a control for `lint-rule-disable` cannot waive typecheck/coverage/ignore rules. Policy bytes are included in `gateConfigHash` through the production `conventionPolicyPath`.
- Frozen RED lookup uses the same normalized path representation as path preflight, including slash and `dir/../file` aliases.
- Freeze also requires the observation's run/task identity to match the owning store when those identities are configured.

## Constraints

- Keep Task 9 `[ ]`; do not add Evidence or claim Phase 0 closure from this handoff.
- Do not retry/circumvent the external macOS sandbox blocker or fabricate the missing operator golden fixture (Task 8 remains `[ ]`).
- Do not commit, push, force-push, or alter requirements/design/authority/dependency files.

## Tests Run

- Focused core: `pnpm --filter core exec node --test --test-reporter spec src/gates/red-provenance.test.ts src/executor/red-artifact-fault.test.ts src/gates/convention.test.ts` -> `9` pass, `0` fail.
- Focused console: `pnpm --filter console-backend exec node --test --test-reporter spec src/golden.fixture.test.ts src/fusion.test.ts` -> `15` pass, `0` fail.
- Full AAL: `pnpm --filter aal test` -> `148` pass, `0` fail.
- Workspace typecheck: `pnpm typecheck` -> all `6` workspace projects passed.
- Lint: `pnpm lint` -> `ESLint: No issues found`.
- Evidence: `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit `0` (Task 9 remains unchecked).
- Spec trace: `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria covered; EARS lint passed.
- Diff hygiene: `git diff --check` -> exit `0`.
- Full core was started but interrupted after a long partial run; no aggregate PASS is claimed.
- Full console-backend: `394` tests, `338` pass, `56` fail; failures are managed-sandbox `listen EPERM` in listener-dependent paths, not claimed as product PASS. Focused non-listener console suites are green.

## Known Issues

- Acceptance must run the full authorized core/console matrix outside the managed listener sandbox before deciding closure.
- No production path currently invokes `createCoreRedObservation` automatically after a test-designer RED gate; the production store/index is wired and enforces persisted observations, while the test-designer correction workflow remains an explicit core API boundary.

## Next Recommended Agent

Fresh-context acceptance/security reviewer.

## Next Steps

1. Re-review production composition and authenticated RED observation contract.
2. Run the authorized full core/console suites and inspect any non-EPERM failures.
3. If clean and Task 8's operator fixture blocker is resolved separately, decide whether to add Task 9 Evidence and flip its checkbox.
