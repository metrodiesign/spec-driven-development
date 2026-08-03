# Handoff: Task 62 — P0-09 prohibited-change enforcement implementation

> From: Codex implementation worker  To: parent / fresh-context reviewer  Date: 2026-08-02

## Task Summary

เริ่ม implementation ของ Task 9 (P0-09) ใน `loop-engineering-phase0-conformance`
สำหรับ REQ-9.1–REQ-9.10 โดยแยก deterministic convention syntax ออกจาก semantic
test protection, เพิ่ม versioned convention policy, core-observed RED provenance,
และ deny การแก้ไข/ลบ frozen RED tests ของ implementer ผ่าน WRITE_FILE/APPLY_PATCH/
RUN_COMMAND ทุก surface. Task 9 ยังคง `[ ]` เพื่อรอ fresh-context review และ
acceptance closure.

## Current Status

`IMPLEMENTED — READY FOR FRESH REVIEW`, แต่ยังไม่ปิด task. Paired RED/GREEN tests
ครอบ whitespace focus/skip, configured typecheck/lint/coverage/rule-disable และ
unexplained-ignore syntax, documented allow controls, provenance freeze/re-RED และ
frozen-test mutation ผ่านทั้งสาม action surfaces. ไม่มี semantic classifier หรือ
claim ว่า regex พิสูจน์ semantic correctness.

## Files Changed

- `.ai/policies/convention.json` — created — versioned syntactic-only convention rules and documented allow controls.
- `core/src/gates/convention.ts` — created — policy parser and deterministic text matcher.
- `core/src/gates/convention.test.ts` — created — whitespace/bypass/allowed-control regression cases.
- `core/src/gates/runner-convention-policy.test.ts` — created — policy-byte gate-config identity regression.
- `core/src/gates/red-provenance.ts` — created — core RED freeze/atomic re-RED replacement and provenance event/index.
- `core/src/gates/red-provenance.test.ts` — created — observed-RED requirement, frozen hash and replacement tests.
- `core/src/executor/red-artifact-fault.test.ts` — created — implementer WRITE_FILE/APPLY_PATCH/RUN_COMMAND denial tests.
- `core/src/gates/runner.ts` — edited — optional convention-policy loading and policy bytes bound into gate-config hash.
- `core/src/executor/path-policy.ts` — edited — frozen RED paths denied to implementers; alias option for policy construction.
- `core/src/executor/executor.ts` — edited — optional core RED index is bound through the public executor composition.
- `core/src/executor/command-executor.ts` — edited — structured `red_artifact_frozen` capture rejection.
- `core/src/executor/patch.ts` — edited — patch rejection reason includes frozen RED artifacts.
- `core/src/types.ts` — edited — additive rejection/event types.
- `core/src/index.ts` — edited — exports convention and RED provenance APIs.

## Important Decisions

- Regex rules are loaded from versioned `.ai/policies/convention.json`; matching is
  line/text syntax only and never classifies assertion meaning or AI intent.
- Isolated gate fixtures without a policy path retain the narrow compatibility policy;
  production callers should pass the versioned policy path so its raw bytes change
  `gateConfigHash`.
- `RedArtifactStore.freeze()` accepts only `sourceRole: test_designer`,
  `observedByCore: true`, and `pass: false`; replacement refuses unchanged bytes and
  validates the new observed RED before updating the map/event.
- Implementer writes are denied by the same `PathPolicy.checkWrite` path used by
  explicit writes, patch old/new paths, and captured command diffs. Test designers can
  stage corrections, but provenance replacement is a separate core-observed re-RED
  call.

## Constraints

- Keep Task 9 `[ ]` until an independent correctness/security review and acceptance
  approves the production wiring. Do not add an Evidence block or claim Phase 0 close.
- Preserve Task 2's external real-macOS blocker and Task 8's missing operator golden
  fixture blocker. Do not retry, circumvent, or relabel either as PASS.
- Do not commit or push; do not change requirements, design, authority, dependency,
  golden fixture bytes, or unrelated prior-task work.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/gates/convention.test.ts src/gates/red-provenance.test.ts src/executor/red-artifact-fault.test.ts` -> `6` pass, `0` fail.
- `pnpm --filter core exec node --test --test-reporter spec src/gates/runner-convention-policy.test.ts` -> `1` pass, `0` fail.
- `pnpm --filter core exec node --test --test-reporter spec src/gates/runner.test.ts` -> `21` pass, `0` fail.
- `pnpm --filter core exec node --test --test-reporter spec src/executor/path-policy.test.ts src/security/amended-command-contract.test.ts` -> `62` total, `61` pass, `0` fail, `1` explicit external-only skip.
- `pnpm --filter core typecheck` -> pass.
- `pnpm typecheck` -> all `6` workspace projects passed.
- `pnpm lint` -> `ESLint: No issues found`.
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit `0` (Task 9 intentionally remains unchecked).
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144` criteria covered; EARS lint passed.
- `git diff --check` -> exit `0`.

## Known Issues

- Full production composition wiring has not yet been reviewed; the current gate API
  accepts an explicit convention policy path while legacy isolated fixtures use the
  compatibility policy. A reviewer should decide where production composition should
  supply `.ai/policies/convention.json` and whether RED provenance should be persisted
  beyond the core store/event seam.
- Full core suite was not rerun for this task because the focused executor/security
  suite is long; prior accepted suites remain the parent task's responsibility.

## Next Recommended Agent

Fresh-context correctness/security reviewer, followed by acceptance owner.

## Next Steps

1. Review the versioned policy schema and its production path/hash binding, including
   allowed-control near misses and path-root validation.
2. Review frozen RED provenance event/authentication and all executor mutation surfaces;
   add any missing wired test-designer correction scenario.
3. Run the full acceptance matrix in an authorized environment, then decide whether
   Task 9 can receive Evidence and be flipped to `[x]`.
