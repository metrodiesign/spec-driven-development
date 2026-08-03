# Handoff Note: Task 20 P0-03 APPLY_PATCH และ READ_FILE

> Schema ตาม `.ai/shared/AGENT_HANDOFF_PROTOCOL.md`

## Task Summary

ดำเนิน Task 3 ของ spec `loop-engineering-phase0-conformance` สำหรับ REQ-3.1–REQ-3.11:
เพิ่ม textual `APPLY_PATCH` ที่ hash-verified, Git-parsed, ตรวจทุก old/new path,
อยู่ใต้ snapshot/intent/recovery/dedup lifecycle เดียวกับ mutating actions และยืนยัน
`READ_FILE` เป็น non-mutating exception ที่บันทึก content ref โดยไม่มี snapshot หรือ
`ACTION_INTENT`

## Current Status

implementation, tests, local correctness/security review และ enforcement floor ผ่านแล้ว
Task 3 ยังเป็น `[ ]` และระบุ `Implementation evidence (awaiting fresh review)` เพื่อรอ
independent fresh-context review ห้ามถือว่า Task 3 accepted หรือเริ่ม P0-04 จาก handoff นี้

## Files Changed

- `core/src/executor/patch.ts` — Git-backed textual patch inspection/check/apply, NUL path parsing, unsupported-shape handling และ bounded fixed child boundary (new)
- `core/src/executor/executor.ts` — public APPLY_PATCH preflight/lifecycle/recovery/dedup และ descriptor-safe READ_FILE (edited; preserves P0-02 work)
- `core/src/types.ts` — structured patch rejection reasons (edited)
- `core/src/executor/executor.test.ts` — public executor REQ-3 matrix (edited)
- `core/test/fault-injection.test.ts` — wired crash/recovery/dedup/read faults (edited)
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — Task 3 implementation evidence while checkbox remains open (edited)
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-20-p0-03-apply-patch.md` — this handoff (new)

## Important Decisions

- `diffRef` is dereferenced through `EvidenceStore.get` before any Git/path inspection, so
  missing or hash-mismatched evidence returns `evidence_invalid`
- Git owns syntax and applicability checks; supported path discovery comes from an isolated
  inspection repository and NUL-delimited `git diff --raw -z`, not patch-line path regexes
- only textual add/update/delete/rename operations are supported in Phase 0; binary,
  symlink-bearing and copy-metadata patches fail closed
- copy metadata is detected through Git operation summary rather than hand-parsing its paths;
  this closes a demonstrated `copy from test/golden/` to `src/` bypass
- every supported old/new path is checked for role allowlist, golden protection, lexical
  containment and existing-ancestor realpath containment before snapshot or intent
- APPLY_PATCH uses the existing public monotonic operation control and
  snapshot -> intent -> apply -> artifact identity -> applied lifecycle; recovery re-verifies
  evidence and policy after rollback before deterministic replay
- READ_FILE uses the existing descriptor-relative `O_NOFOLLOW` reader with pre/post `fstat`
  instead of a check-then-`readFileSync` sequence, closing the local TOCTOU window
- no dependency, policy, API export, commit or push was added

## Constraints

- preserve all pre-existing uncommitted P0-02 work and unrelated dirty paths; do not revert,
  reset, clean, stage, commit or push them
- Task 2 remains open because the external real-macOS evidence is blocked by the recorded
  account usage limit until August 2 at 11:46 Asia/Bangkok
- do not retry or circumvent that external suite and do not claim its managed-sandbox skips
  as a real-macOS PASS
- Task 3 remains open pending fresh review; do not start P0-04 from this implementation handoff
- do not edit the pinned authority, old master, blueprint or archive files
- no direct push to `main` or `develop`, no force push, and no commit without review

## Tests Run

- initial RED: focused add test -> `0` pass, `1` fail (`rejected` instead of `applied`)
- review RED: copy-from-golden subtest -> `applied` instead of structured rejection
- focused final: `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts` -> `32` pass, `0` fail
- full executor file -> `55` pass, `0` fail, `1` explicit external real-macOS skip
- full wired fault file -> `18` pass, `0` fail, `5` explicit external real-macOS skips
- test: `pnpm --filter core test` -> `423` pass, `0` fail, `9` explicit external real-macOS skips
- test: relevant `console-backend` production composition -> `11` pass, `0` fail
- test: `pnpm --filter aal test` -> `143` pass, `0` fail
- typecheck: `pnpm typecheck` -> all `6` workspace projects pass
- lint/vendor/trace: `pnpm lint`, `scripts/check-core-vendor-free.sh`, and `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> pass; trace covers `144` criteria and EARS lint passes
- repository floor: strict Evidence, `.ai/bin/check-secrets.sh --all`, and `git diff --check` -> exit `0`
- authority: external/root `cmp` -> exit `0`; root SHA-256 is `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

## Known Issues

- no known unresolved actionable P0-03 finding
- external P0-02 real-macOS suite remains blocked as recorded above; no retry or PASS claim
- full tests intentionally report real-macOS skips under the managed nested sandbox

## Next Recommended Agent

fresh-context reviewer ที่อ่าน authority, approved requirements/design/tasks และ handoffs
Task 01–20 ตามลำดับ แล้วตรวจ P0-03 diff แบบ read-only โดยเน้น Git operation/path
interpretation, copy/binary/symlink fail-closed behavior, evidence-before-path ordering,
snapshot/recovery/dedup semantics และ READ_FILE descriptor containment

## Next Steps

1. ทำ independent fresh-context correctness/security acceptance review เฉพาะ Task 3 โดยไม่แก้ไฟล์
2. หากมี finding ให้เพิ่ม discriminating public/wired RED ก่อนแก้ และ rerun focused/full gates
3. หากไม่มี finding ให้ผู้มี authority ตัดสิน Task 3 acceptance; อย่า mark Task 2 หรืออ้าง external real-macOS PASS
