# Implementation Tasks: platform-phase5-stage3 — Provenance + Drift Detection
> Status: approved 2026-07-12

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Schema: provenance `requirements_sha256` + `minLength:1` — governance
     copy (`.ai/schemas/goal.schema.json`) + embedded `GOAL_SCHEMA`
     (`console/backend/src/goal-schema.ts`) ขยับพร้อมกัน; ขยาย shape tests
     (4-field/3-field ผ่าน, empty-string/unknown-key reject); parity test เดิม
     ต้องเขียว. Done = ajv รับ/ปฏิเสธตรงตาราง REQ-1.
     Satisfies: REQ-1 (all criteria). Verify: pnpm -C console/backend test goal-schema.
     Evidence:
       - test: `pnpm -C console/backend test goal-schema` -> 323 passed / 0 failed
         (goal-schema.test.ts: 17/17 incl. parity + 4 new provenance cases for
         REQ-1.1/1.3/1.4/1.5)
       - typecheck: `pnpm -C console/backend typecheck` -> clean
       - viewports: n/a — logic-only
       - deviations: none

- [x] 2. Generator: structured `provenance:` block — `scripts/spec_to_goal.py`
     แทน comment header 4 บรรทัดด้วย flow mapping JSON-quoted บรรทัดเดียว
     (spec_path repo-root-relative + fallback as-given, requirements_commit,
     requirements_sha256 จาก raw bytes, generated_at); ขยาย `# HUMAN:` banner
     ด้วยคำสั่งห้าม reflow; อัปเดต + ขยาย
     `console/backend/src/spec-to-goal.e2e.test.ts` (สองกิ่ง spec_path ตาม
     critique D1). Done = draft ใหม่ผ่าน `validateGoalShape` ส่วน provenance
     และ e2e ทั้งชุดเขียว.
     Satisfies: REQ-2 (all criteria). Depends on: 1. Verify: pnpm -C console/backend test spec-to-goal.
     Evidence:
       - test: `pnpm -C console/backend test spec-to-goal` -> 325 passed / 0 failed
         (spec-to-goal.e2e.test.ts: all cases incl. 2 new — provenance
         structural/REQ-2.1/2.2/2.4/2.6 + spec_path two-branch critique D1)
       - typecheck: `pnpm -C console/backend typecheck` -> clean
       - manual: smoke-generated a draft in scratch, eyeballed `provenance:`
         line + confirmed `json.loads` parses it to exactly the 4 keys
       - viewports: n/a — logic-only
       - deviations: none

- [x] 3. Core: typed `provenance` + freeze validation —
     `core/src/contract/contract.ts` เพิ่ม `TaskContract.provenance?` + block
     ใน `freezeContract` (pattern deploy, helper เดิม); ขยาย
     `core/src/contract/contract.test.ts` (valid 4/3-field surface typed,
     absent = พฤติกรรมเดิม + fixtures ผ่าน, reject non-object/missing/empty/
     wrong-type, unknown key ไม่ reject ที่ freeze — pin A5). Done = core test
     เขียวทั้งชุด.
     Satisfies: REQ-3. Verify: pnpm -C core test.
     Evidence:
       - test: `pnpm -C core test` -> 251 passed / 0 failed (contract.test.ts:
         8 new provenance cases — absent/4-field/3-field/non-object/
         missing-empty/wrong-type-sha/unknown-key-A5/hash-coverage — plus
         every pre-existing deploy + budget + risk case still green)
       - typecheck: `pnpm -C core typecheck` -> clean
       - viewports: n/a — logic-only
       - deviations: none

- [x] 4. Drift checker + CI wiring — ใหม่ `scripts/spec_goal_drift.py` +
     `scripts/spec-goal-drift.sh` (advisory exit 0 / `--strict` exit 1 /
     usage exit 2, ตารางข้อความ 7 เงื่อนไขตาม design); test ใหม่
     `console/backend/src/spec-goal-drift.e2e.test.ts` (รวม end-to-end
     generate→promote→เงียบ→แก้ไฟล์→เตือน + A3 regression); step advisory ใน
     `.github/workflows/ci.yml` verify job. Done = e2e เขียว + CI ของ PR นี้
     เขียว (ศูนย์ goal.yaml = ผ่านเงียบ, REQ-5.3).
     Satisfies: REQ-4, REQ-5. Depends on: 2. Verify: pnpm -C console/backend test spec-goal-drift.
     Evidence:
       - test: `pnpm -C console/backend test spec-goal-drift` -> 335 passed / 0
         failed (spec-goal-drift.e2e.test.ts: 10 new — end-to-end
         generate/promote/silent/edit/warn(advisory+strict), no-parseable-
         provenance incl. malformed-JSON, lacks-sha256, missing-requirements.md,
         A3 regression, draft-only not-applicable, missing-feature-dir exit 2,
         wrapper happy path, CI-loop-zero-files precondition)
       - typecheck: `pnpm -C console/backend typecheck` -> clean
       - lint: `pnpm lint` (repo-wide eslint) -> no issues
       - manual: 10 scripted smoke scenarios run directly against
         `scripts/spec_goal_drift.py`/`.sh` in scratch (all 7 message/exit-code
         table rows + wrapper), plus the real CI loop body simulated via `bash`
         against the actual `.ai/specs/*/` tree -> 0 goal.yaml found, exit 0
       - viewports: n/a — logic-only
       - deviations: none

- [x] 5. Console read-only display + constitution v1.6 —
     `core/src/human/approval.ts` (ApprovalPackage/ApprovalInput + explicit
     copy), `console/backend/src/loop-run.ts` สองจุด (task ผ่าน input,
     deploy spread เข้า package literal — critique D3),
     `console/web/src/logic/loop.ts` (`goalProvenanceLine` pure projection —
     critique D2) + `Loop.tsx` thin render + i18n key `loopProvenanceHeading`
     (en+th); ขยาย `approval.test.ts` + `loop.test.ts`. พ่วง doc amendment:
     `unified-platform-spec.md` §11.1 example + §14 sha256 supersession note +
     §17 changelog v1.6 + แก้ banner ค้าง v1.4. Done = test เขียว (core + web) +
     typecheck ผ่าน + doc ครบ 4 จุด.
     Satisfies: REQ-6, REQ-7. Depends on: 3. Verify: pnpm -C core test && pnpm -C console/web test && pnpm typecheck.
     Evidence:
       - test: `pnpm -C core test` -> 253 passed / 0 failed (approval.test.ts:
         2 new — provenance copied verbatim / key absent when input has none);
         `pnpm -C console/web test` -> 74 passed / 0 failed (loop.test.ts: 2 new
         — goalProvenanceLine null/verbatim); `pnpm -C console/backend test` ->
         337 passed / 0 failed (loop-run.test.ts: 2 new end-to-end integration
         cases beyond what design's Testing Strategy named — full
         runSupervisedLoop harness proving contract.provenance reaches BOTH
         real approval-package sites, task via ApprovalInput and deploy via the
         direct literal, critique D3)
       - typecheck: `pnpm typecheck` (workspace, all 6 packages) -> clean
       - lint: `pnpm lint` (repo-wide eslint) -> no issues
       - trace: `scripts/spec-trace.sh platform-phase5-stage3` -> OK, 38/38 REQ
         criteria referenced in design.md + tasks.md, EARS lint clean (run
         before marking this LAST task per protocol)
       - viewports: n/a — the ApprovalCard change is one conditional `<p>` line
         inside the existing card, no layout/responsive surface; design's own
         Testing Strategy calls this "eyeball + typecheck พอ" (JSX is a thin
         branch off a pure, fully-tested projection). Verified by
         typecheck + `pnpm -C console/web build` (vite, clean production
         build) + the 2 goalProvenanceLine unit tests + reading the rendered
         JSX; did NOT drive it in a live browser — doing so would need a full
         promoted goal.yaml + a real run reaching an approval state,
         disproportionate to a one-line conditional text render
       - deviations: added 2 loop-run.test.ts integration tests beyond
         design's named file list (approval.test.ts + loop.test.ts only) to
         verify REQ-6.2's wiring end-to-end, not just at the unit level;
         everything else built exactly as designed, no other deviation

## Suggested execution batches

> Feature นี้ COUPLED (schema → generator → checker แชร์ contract shape เดียวกัน;
> core → console แชร์ typed field) — DEFAULT: รันทุก task ใน SESSION เดียว
> (`/spec-implement all` หรือ `scripts/pane-loop.sh platform-phase5-stage3 all-in-one`).
> ลำดับใน session: 1 → 2 → 3 → 4 → 5 (3 ขนานกับ 2 ได้แต่ไม่จำเป็น —
> session เดียวทำตามลำดับ). ไม่มี Batch: tag — ทุก task เป็น slice ใหญ่คนละ domain.
