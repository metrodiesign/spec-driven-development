# Handoff: Task 09 — P0-02 spec amendment

> From: Codex teammate `/root/p0_02_spec_amendment`
> To: lead `/root`
> Date: 2026-07-27
> Scope: approved-artifact amendment only; no production, test, or pinned-authority edit

## Task Summary

แก้ approved `requirements.md`, `design.md`, และ `tasks.md` ของ
`loop-engineering-phase0-conformance` ให้ P0-02 ตรงกับข้อจำกัดจริงของ deprecated
macOS sandbox backend และ pinned §0/§12 claim discipline เปิด Task 2 กลับเพื่อให้
implementation ปิด Task 08 findings ตาม contract ใหม่ โดยรักษา Evidence เดิมทุกบรรทัด

## Current Status

`DONE — SPEC APPROVED/AMENDED; TASK 2 REOPENED`

- artifact ทั้งสาม re-stamp เป็น
  `> Status: approved 2026-07-27, amended 2026-07-27`
- REQ-2 มี 49 atomic EARS criteria (`2.1`–`2.49`)
- Task 2 เป็น `[ ]`; Task 1 และ Task 3–10 ไม่เปลี่ยน checkbox
- prior Task-2 Evidence คงอยู่ verbatim และมี note ชัดว่าเป็น historical evidence
  ไม่ใช่ proof ของ amended criteria
- fresh-context `spec-architect` รอบแรกพบ 7 finding; apply ครบทุกข้อ
- re-review หลังแก้ให้ verdict `APPROVE` และไม่เหลือ actionable finding

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/requirements.md` — edited;
  re-stamp header, amend REQ-2/REQ-10.3/DoD mapping/closed decisions
- `.ai/specs/loop-engineering-phase0-conformance/design.md` — edited;
  amend architecture, sequence, interfaces, policy decisions, error taxonomy,
  testing matrix, and multi-section traceability
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — edited;
  reopen only Task 2, replace description/verification, preserve all prior Evidence
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-09-p0-02-spec-amendment.md`
  — created; this handoff

## Important Decisions

- macOS backend รับประกัน unauthorized filesystem/network effect denial ผ่าน inherited
  profile แต่ไม่ใช่ universal attempt audit และไม่รับประกัน terminate descendant หลัง
  process สร้าง session ใหม่
- `sandbox_violation` เกิดได้เฉพาะ enforcement-owned direct/backend observation
  เท่านั้น Child output หรือ absence of effect ห้ามใช้ fabricate attribution
- command evidence ต้องบันทึก policy hash, content-bound environment hash,
  `denialObservation: direct_only`, `revocableDescendantContainment: false`,
  `descendantTermination: unproven_new_session`, และ `observedViolation` ที่เป็น typed
  observation หรือ `null`
- Phase 0 macOS reject network grant ทุกชนิดก่อน spawn Package install ใช้ offline
  เท่านั้นภายใต้ `network: none`
- conflict ระหว่าง pinned §4.1/§8.1 กับ §11 repository map ถูก resolve แบบเล็กและ
  ย้อนกลับได้: คง minimal Phase 0 dependency-policy floor คือ allowed role, exact
  frozen lockfile, approved offline source content hashes, และ disabled lifecycle
  scripts; ไม่มี registry/online resolution หรือ full later-phase plane
- agent ตั้ง execution mode/roots/input hash เองไม่ได้ Public entry มีเพียง
  core-owned command executor; low-level sandbox spawn เป็น module-private และ
  artifact executor เป็นเจ้าของ materialize → spawn → capture → validate → promote →
  cleanup ทั้ง flow
- artifact-mutating `RUN_COMMAND` รันใน disposable frozen workspace Core ใช้ bounded
  two-inventory capture ไปยัง exclusive destination นอก sandbox writable roots แล้ว
  promote เฉพาะ exact frozen diff ที่ policy อนุญาต
- เฉพาะ normal `exitCode === 0` เข้าสู่ capture Non-zero/signal เป็น
  `command_failed`, promote nothing, และ cleanup ส่วน sandbox/preflight/capture
  failure มี typed variant แยก
- read-only tests/probes คง exit/output evidence behavior เดิมโดยไม่เข้า artifact
  promotion
- detached/new-session descendant ยังอาจใช้ CPU ต่อ นี่เป็น explicit residual/follow-up;
  inherited profile + discarded workspace ต้องยังป้องกัน unauthorized durable
  filesystem/network effect และเอกสารห้าม claim whole-descendant cleanup

## Constraints

- ห้ามแก้ production/tests/root authority ใน amendment นี้; ไม่มีไฟล์เหล่านั้นถูกแก้
  โดย Task 09
- ห้ามเพิ่ม Phase 1+ capability, mutation gate, semantic sandbox audit หรือ fake
  descendant-attempt attribution
- ห้ามลบ/แก้ prior Evidence ของ Task 2 เมื่อ implement รอบถัดไป ให้ append amended
  Evidence หลัง GREEN เท่านั้น
- Task 2 ต้องคง `[ ]` จน amended RED/GREEN matrix, full regression และ fresh-context
  review ผ่าน
- worktree มี production/test changes จาก P0-02 sessions ก่อนหน้าอยู่แล้วและ active
  spec folder ยัง untracked; อย่าใช้ `git diff --stat` อย่างเดียวในการ reconcile
- ไม่มี commit หรือ push

## Tests Run

- `scripts/spec-trace.sh loop-engineering-phase0-conformance`
  -> `OK`, 144 criteria covered, EARS lint passed
- `scripts/spec-slice.sh loop-engineering-phase0-conformance 2 | awk '/MISSING:/{n++} END{print "Task-2 slice MISSING=" (n+0)}'`
  -> `Task-2 slice MISSING=0`
- `rg -n '^- \[[ x]\]' .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> Task 1 `[x]`; Task 2 `[ ]`; Task 3–10 `[ ]`
- `rg -n '^> Status:' .ai/specs/loop-engineering-phase0-conformance/{requirements,design,tasks}.md`
  -> ทั้งสามไฟล์เป็น `approved 2026-07-27, amended 2026-07-27`
- `shasum -a 256 loop-engineering-implementation-spec.md`
  -> `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- `git diff --check` -> exit `0`, no output
- `git diff --no-index --check /dev/null <each amended artifact>`
  -> no whitespace errors; exit `1` เฉพาะ expected content difference จาก `/dev/null`
- fresh-context `spec-architect` critique -> first `REQUEST_CHANGES`; all 7 finding
  applied; final re-review `APPROVE`
- typecheck/unit/integration: not run — spec-only amendment, production/test execution
  was outside Task 09 scope

## Known Issues

- P0-02 implementation ยังไม่ conform กับ amended contract จึงเปิด Task 2 ไว้
- Task 08 fixable blockers ต้องปิดด้วย code/test จริง โดยเฉพาะ child tooling boundary,
  production offline-policy wiring, immutable capture race/resource handling,
  environment identity, typed signal/non-zero behavior, และ cleanup failpoints
- macOS new-session CPU/process lifetime เป็น residual ที่ยังต้อง track แต่ไม่ใช่
  permission ให้เพิ่ม false detection หรือ network grant
- operator-supplied golden fixture blocker ของ Task 8/P0-10 ไม่เกี่ยวกับ amendment นี้
  และยังคงอยู่ตาม spec

## Next Recommended Agent

Builder/implementer สำหรับ P0-02 ที่อ่าน Task 08 + Task 09 ก่อน แล้ว fresh-context
security/correctness reviewer หลัง amended RED/GREEN suite ผ่าน

## Next Steps

1. รัน `scripts/spec-slice.sh loop-engineering-phase0-conformance 2` และอ่าน
   `handoffs/task-08-p0-02-rereview.md` ตามด้วย handoff นี้
2. Reconcile production/test changes ปัจจุบันกับ REQ-2.1–REQ-2.49 และเขียน
   discriminating RED tests ก่อนแก้ implementation
3. Implement Task 2 ทั้ง flow โดยไม่เริ่ม P0-03 จากนั้นรัน targeted real macOS,
   full core/console/typecheck/lint/vendor/spec gates
4. Append amended Evidence โดยรักษา Evidence เดิม แล้วให้ fresh-context review ก่อน
   mark Task 2 `[x]`
