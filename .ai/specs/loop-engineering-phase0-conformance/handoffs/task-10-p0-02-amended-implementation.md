# Handoff: Task 10 — P0-02 amended implementation recovery

> From: Codex teammate `/root/p0_02_amended_recovery`
> To: lead `/root`
> Date: 2026-07-27
> Scope: audit and complete the uncommitted P0-02 amendment implementation; no P0-03, commit, push, or Task-2 closure

## Task Summary

กระทบยอด uncommitted P0-02 implementation กับ approved amended
REQ-2.1–REQ-2.49, ปิด literal REQ-2.1 gap ที่ executor และ frozen-tree preparation
ยังเรียก fixed Git child process โดยตรง, เพิ่ม architecture regression, รัน
sandbox-safe verification matrix, จัดประเภท managed-sandbox failures และ append
amended evidence โดยรักษา historical Evidence เดิม

## Current Status

`IMPLEMENTATION READY FOR FRESH REVIEW — TASK 2 DELIBERATELY REMAINS [ ]`

- amended implementation และ sandbox-safe regression matrix ผ่าน
- `core` full suite ผ่านโดยมีเฉพาะ explicit external real-macOS skips
- `console-backend` full suite มีเฉพาะ managed-sandbox environmental failures ที่
  แยกสาเหตุได้; focused production composition tests ผ่าน
- real macOS external verification ยังทำไม่ได้เพราะ account usage limit ถึง
  August 2 เวลา 11:46 และไม่ได้ retry/circumvent
- ยังไม่มี independent fresh-context review หลัง implementation รอบนี้
- ไม่มี commit หรือ push

## Files Changed

ไฟล์ที่ Task 10 แก้โดยตรง:

- `core/src/security/command-runner.ts` — เพิ่ม package-private `runCoreTool` สำหรับ
  fixed absolute/config-isolated control-plane tooling ให้อยู่ใน shared
  child-process boundary
- `core/src/executor/executor.ts` — เอา direct `node:child_process` ออกและ route
  snapshot/hash/recovery Git tooling ผ่าน `runCoreTool`
- `core/src/gates/frozen-tree.ts` — เอา direct `node:child_process` ออกและ route
  freeze/materialize Git plumbing ผ่าน `runCoreTool`
- `core/src/security/amended-command-contract.test.ts` — เพิ่ม RED/GREEN architecture
  regression กัน executor/gate/workspace-prep bypass และยืนยัน low-level bridge
  ไม่หลุด public `core` package surface
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — append
  `Amended implementation evidence (awaiting fresh review)` โดยคง Task 2 เป็น `[ ]`
  และรักษา historical Evidence
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-10-p0-02-amended-implementation.md`
  — created; handoff นี้

P0-02 implementation/test/policy paths ที่มีอยู่ใน shared uncommitted worktree และ
ถูก audit/verify โดยรวม ห้าม revert:

- `.ai/policies/security-plane.json`
- `aal/test/integration.test.ts`
- `console/backend/bin/platform.ts`
- `console/backend/src/fusion.test.ts`
- `console/backend/src/fusion.ts`
- `console/backend/src/loop-cli.test.ts`
- `console/backend/src/loop-cli.ts`
- `console/backend/src/loop-run.ts`
- `core/src/audit/oob.test.ts`
- `core/src/audit/oob.ts`
- `core/src/deploy/stage.test.ts`
- `core/src/executor/command-executor.ts`
- `core/src/executor/executor.test.ts`
- `core/src/executor/executor.ts`
- `core/src/executor/path-policy.ts`
- `core/src/gates/frozen-tree.test.ts`
- `core/src/gates/frozen-tree.ts`
- `core/src/gates/runner.test.ts`
- `core/src/gates/runner.ts`
- `core/src/human/api.test.ts`
- `core/src/index.ts`
- `core/src/merge/auto-merge.test.ts`
- `core/src/merge/auto-merge.ts`
- `core/src/merge/queue.test.ts`
- `core/src/security/amended-command-contract.test.ts`
- `core/src/security/command-runner.test.ts`
- `core/src/security/command-runner.ts`
- `core/src/security/sandbox.test.ts`
- `core/src/security/sandbox.ts`
- `core/src/types.ts`
- `core/test/fault-injection.test.ts`
- `core/test/helpers/fixture.ts`
- `core/test/repair-loop.test.ts`
- `core/test/steering-loop.test.ts`

Durable spec context remains untracked in the worktree:

- `loop-engineering-implementation-spec.md`
- `.ai/specs/loop-engineering-phase0-conformance/requirements.md`
- `.ai/specs/loop-engineering-phase0-conformance/design.md`
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-01-audit.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-02-architecture-review.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-03-spec-artifacts.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-04-p0-01.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-05-p0-02.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-06-p0-02-review.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-07-p0-02-review-fixes.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-08-p0-02-rereview.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-09-p0-02-spec-amendment.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-10-p0-02-amended-implementation.md`

## Important Decisions

- REQ-2.1 scope คือ executor, gate และ command-workspace preparation ไม่ใช่
  merge queue, auto-merge หรือ OOB clone paths; architecture regression scan เฉพาะ
  production files ใน scope นี้
- fixed Git tooling ใช้ `/usr/bin/git`, environment สร้างใหม่, disable system/global
  config, hooks, fsmonitor และ excludes; configured filters ถูก neutralize ก่อน
  snapshot/hash operations
- `runCoreTool` อยู่ใน `security/command-runner.ts` และไม่ re-export จาก
  `core/src/index.ts`; public package surface ยังคงมีเพียง core-owned
  `createCoreCommandExecutor` สำหรับ `RUN_COMMAND`
- artifact-mutating command lifecycle ยังคง
  materialize → sandboxed spawn → pre-copy inventory → exclusive capture →
  post-copy inventory → capture inventory → policy → exact promotion → cleanup
- non-zero artifact command คือ `command_failed`, promote nothing; read-only
  test/probe คง exit/output semantics
- Phase 0 reject network grant ก่อน spawn และอนุญาต package install เฉพาะ exact
  offline policy ที่ production composition bind ให้
- macOS backend evidence ไม่ claim universal denial observation หรือ new-session
  termination; capability คง `direct_only`, containment `false`,
  `unproven_new_session`

## Constraints

- ห้ามเริ่ม P0-03
- ห้ามเปลี่ยน Task 2 เป็น `[x]` ก่อน independent fresh-context review และ real
  macOS verification
- ห้าม retry/circumvent external real macOS run ก่อน usage limit เปิด
- ห้าม claim managed-sandbox skips เป็น real macOS PASS
- ห้าม commit หรือ push; repo rules ต้อง review ก่อน commit และ PR ก่อน
  `main`/`develop`
- ห้าม revert shared uncommitted edits หรือ historical Task-2 Evidence
- `RTK.md` และ `karpathy.md` ไม่มีใน repo ตาม reconciliation จาก Task 02; ไม่ใช่
  blocker และไม่ต้อง broad-search ซ้ำ

## Tests Run

- REQ-2.1 RED:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'executor, gate, and workspace preparation' src/security/amended-command-contract.test.ts`
  -> `1` test, `0` pass, `1` fail; failure ชี้ direct child launch ใน
  `core/src/executor/executor.ts`
- REQ-2.1 GREEN: command เดิมหลังแก้ -> `1` pass, `0` fail
- final package/boundary regression:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'package exports one core RUN_COMMAND orchestrator|executor, gate, and workspace preparation' src/security/amended-command-contract.test.ts`
  -> `2` pass, `0` fail
- amended/frozen matrix:
  `pnpm --filter core exec node --test --test-reporter spec src/security/amended-command-contract.test.ts src/gates/frozen-tree.test.ts`
  -> `23` tests, `22` pass, `0` fail, `1` explicit real-macOS skip
- focused P0-02:
  `pnpm --filter core exec node --test --test-reporter spec src/security/amended-command-contract.test.ts src/gates/frozen-tree.test.ts src/security/command-runner.test.ts src/security/sandbox.test.ts src/executor/path-policy.test.ts src/executor/executor.test.ts src/gates/runner.test.ts src/audit/oob.test.ts test/fault-injection.test.ts`
  -> `108` tests, `100` pass, `0` fail, `8` explicit external real-macOS skips
- core full: `pnpm --filter core test`
  -> `350` tests, `341` pass, `0` fail, `9` explicit external real-macOS skips
- backend focused:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts`
  -> `11` pass, `0` fail
- AAL focused:
  `pnpm --filter aal exec node --test --test-reporter spec test/integration.test.ts`
  -> `3` pass, `0` fail
- backend full: `pnpm --filter console-backend test`
  -> `383` tests, `329` pass, `54` fail; `53` are
  `listen EPERM: operation not permitted 127.0.0.1`
- backend full count confirmation:
  `pnpm --filter console-backend exec node --test --test-reporter tap 'src/**/*.test.ts' 'test/**/*.test.ts'`
  -> `383` tests, `329` pass, `54` fail
- listener failure classification:
  `pnpm --filter console-backend exec node --test --test-reporter tap 'src/**/*.test.ts' 'test/**/*.test.ts' 2>&1 | rg 'EPERM|uv_uptime' | sort | uniq -c`
  -> `53 code: 'EPERM'` and `53 error: 'listen EPERM: operation not permitted 127.0.0.1'`
- remaining doctor failure classification:
  `node -e "console.log(require('node:os').uptime())"`
  -> exit `1`, `SystemError [ERR_SYSTEM_ERROR]`, `uv_uptime returned EPERM`
- typecheck:
  `pnpm --filter core typecheck && pnpm --filter aal typecheck && pnpm --filter console-backend typecheck`
  -> exit `0`
- repository gates:
  `pnpm lint && scripts/check-core-vendor-free.sh && scripts/spec-trace.sh loop-engineering-phase0-conformance && .ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md && git diff --check`
  -> exit `0`; lint clean, vendor scan pass, `144` criteria covered, EARS lint pass,
  strict Evidence pass, diff hygiene pass
- authority:
  `cmp -s /Users/king_developer/Downloads/loop-engineering-implementation-spec.md loop-engineering-implementation-spec.md`
  -> exit `0`
- authority hash:
  `shasum -a 256 loop-engineering-implementation-spec.md`
  -> `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- external real macOS: not run in Task 10; usage-limit blocker until August 2
  at 11:46, so no PASS claim

## Review Result

Local correctness/security review after the REQ-2.1 change found no remaining
actionable finding in the amended implementation scope.

Fresh reviewer focus:

1. Verify that routing fixed/config-isolated Git calls through package-private
   `runCoreTool` in the shared command boundary satisfies literal REQ-2.1 without
   exposing a second public spawn path.
2. Re-check that `createCoreCommandExecutor` derives classification, role roots and
   frozen input identity from trusted context and that caller-supplied action fields
   cannot widen them.
3. Attack two-inventory capture, exclusive destination, finite limits and promotion
   rollback for churn, unsupported shapes, ignored residue, delayed writes and TOCTOU.
4. Re-check production offline-policy binding for exact role, command, lockfile hash,
   approved source hashes, lifecycle suppression and `network: none`.
5. Re-check typed distinction among normal signal, `command_failed`,
   enforcement-owned `sandbox_violation` and `observedViolation:null`, including
   capability and policy/environment hash binding.
6. Treat direct child calls in merge/OOB modules as outside REQ-2.1 scope unless the
   approved spec is amended again; do not silently widen this task.

## Known Issues

- External real macOS evidence is blocked until August 2 at 11:46. The managed
  sandbox cannot validate real `sandbox-exec` behavior and explicitly skips those
  cases.
- `console-backend` full suite cannot bind loopback listeners in this managed
  sandbox; `53` failures are `listen 127.0.0.1 EPERM`. The remaining doctor test
  receives HTTP `500` because the same sandbox makes `node:os.uptime()` throw
  `uv_uptime returned EPERM`.
- A descendant that creates a new session can outlive direct process-group cleanup
  for CPU/process lifetime. The inherited SBPL profile and discarded disposable
  workspace still prevent unauthorized durable filesystem/network effects; this is
  an explicit availability residual, not a false-success or network-grant path.
- Operator-supplied golden fixture blocker for later Task 8/P0-10 remains unrelated
  and unchanged.

## Next Recommended Agent

Independent fresh-context correctness/security reviewer for P0-02, followed by a
real macOS verification runner after the usage limit opens.

## Next Steps

1. Read Task 08, Task 09 and this handoff, then review the current worktree diff
   against amended REQ-2.1–REQ-2.49 without relying on historical PASS claims.
2. Run the real macOS targeted matrix outside the managed sandbox after August 2
   at 11:46; record exact pass/fail and do not substitute skipped tests.
3. If fresh review and external verification pass, append review evidence and only
   then decide whether Task 2 can become `[x]`; otherwise keep `[ ]` and return
   precise actionable findings.
