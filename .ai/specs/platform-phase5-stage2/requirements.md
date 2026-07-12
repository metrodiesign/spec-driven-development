# Requirements: platform-phase5-stage2 — goal.schema.json + Typed Contract
> Status: approved 2026-07-12, amended 2026-07-12 (design-critique round: added 3.7, widened 5.4/6.6 — see findings log AD1-AD6)

## Overview

Stage 2 ของ Phase 5 (SDD Integration) ตาม `unified-platform-spec.md` v1.4 §14: ปิด gap
ที่ audit พบใน Goal Contract layer — `freezeContract`
(`core/src/contract/contract.ts:82-88`) แปลง budget แค่ 3 field และทิ้ง
`max_hypotheses_per_failure` / `max_total_tasks` / `max_parallel_agents` เงียบ, `risk`
ไม่มีใน type เลย, ไม่มี `goal.schema.json`, และ convention `.ai/goal.yaml` เป็น
convention กำพร้า (ไฟล์ไม่เคยมีจริงใน repo). Stage นี้เพิ่ม JSON Schema เป็น governance
copy + validation ที่ composition root (ajv — จุดเดียวกับที่ parse YAML), ทำ contract
เป็น typed เต็ม (budget ครบ 6 + `risk`), wire budget field ใหม่เข้า consumer ที่มีจริง,
และ retire convention `.ai/goal.yaml` อย่างเป็นทางการ.

การตัดสินใจจาก clarifying phase (2026-07-12, บันทึกใน spec นี้):
`.ai/goal.yaml` retire → canonical path = `.ai/specs/<feature>/goal.yaml` ·
ajv validate ที่ composition root, core คง hand-rolled checks เป็น final gate ·
wire 2 consumer ที่มีจริง (repair, dispatch), defer `max_total_tasks` ไป Stage 4 ·
`risk` top-level default L2 · `additionalProperties: false` ทุกชั้น (ยกเว้นเดียว:
`constraints.stack` string map — D2) · budget required ครบ 6 · Python generator
ไม่ validate schema (TS edge + CI เท่านั้น) · supersede Phase-1 REQ-8.4
preserve-and-ignore (D1) · promote draft = human rename act (D4).

ข้อเท็จจริงจากโค้ดที่ requirements นี้อิง: edge parse เดียวของ goal.yaml คือ
`loadGoalContract` (`console/backend/src/loop-cli.ts:14`) — `yaml` dep อยู่ console,
core zero-runtime-dependency (ajv จึงลง core ไม่ได้) · consumer ที่มีจริง:
`RepairPolicy.maxHypotheses` (`core/src/orchestrator/loop.ts:40`, static default 3) และ
dispatch `maxParallel` (`aal/src/dispatch.ts:16`; dispatcher ตัวเดียวในระบบสร้างที่
`console/backend/src/loop-run.ts:361` สำหรับ planner-fusion fan-out; routing-config
default `maxParallel: 1`) · `max_total_tasks` ยังไม่มี consumer (single-task ceiling,
`console/backend/src/fusion.ts:194` — ยกใน Stage 4) · loopManaged banner =
`existsSync(cwd/.ai/goal.yaml)` (`console/backend/src/claude-data.ts:79`) ·
schema governance convention: `.ai/schemas/*.json` + embedded copy + parity test
(precedent: `console/backend/src/fusion.test.ts:283`) · generator draft ที่ unresolved
มี key `pending_acceptance_criteria` (นอก §11.1) + `risk: "TODO"`
(`scripts/spec_to_goal.py:140`) — strict schema reject ทั้งคู่โดยธรรมชาติ ซึ่งเสริม
human gate เดิม · legacy 3-key budget มีจริง 6 จุด (ดู 6.6) — การ migrate เป็นส่วน
ของ stage นี้.

## REQ-1: Goal Contract JSON Schema (governance copy)

**User Story:** As the platform operator, I want a machine-checkable JSON Schema for
the Goal Contract, so that a typo'd or wrong-shaped goal file is rejected with a
named path instead of silently losing fields.

**Acceptance Criteria (EARS):**
- 1.1  THE SYSTEM SHALL provide a JSON Schema draft-07 document at
       `.ai/schemas/goal.schema.json` covering the full §11.1 contract shape:
       `goal`, `business_outcomes`, `scope`, `constraints`,
       `acceptance_criteria`, `quality_gates`, `budget`, `approval_policy`,
       `deploy`, `risk`, `provenance`                                        (ubiquitous)
- 1.2  THE SYSTEM SHALL declare `additionalProperties: false` on every object
       node of the schema (top-level and nested), with exactly ONE
       exception: `constraints.stack` is a free-form string map
       (`additionalProperties: { "type": "string" }`)                        (ubiquitous)
- 1.3  THE SYSTEM SHALL require exactly `goal`, `acceptance_criteria`, and
       `budget` at the top level — every other §11.1 key is optional but
       shape-checked when present (mirrors what `freezeContract` requires)   (ubiquitous)
- 1.4  THE SYSTEM SHALL require all six budget keys
       (`max_iterations_per_task`, `max_hypotheses_per_failure`,
       `max_total_tasks`, `max_parallel_agents`, `max_cost_units_per_task`,
       `max_wallclock_per_task_min`), each an integer >= 1                   (ubiquitous)
- 1.5  THE SYSTEM SHALL define `risk` as an optional top-level enum limited
       to `L0` `L1` `L2` `L3` `L4` (case-sensitive)                          (ubiquitous)
- 1.6  THE SYSTEM SHALL define `provenance` as an optional object requiring
       `spec_path`, `requirements_commit`, `generated_at` (all strings) —
       schema-ready now so Stage 3 stamps without a schema bump              (ubiquitous)
- 1.7  THE SYSTEM SHALL define `acceptance_criteria` as a non-empty array
       whose items require `id` and `description` with optional
       `verification` (string) and `golden` (boolean)                        (ubiquitous)
- 1.8  THE SYSTEM SHALL define `deploy` (optional) mirroring the frozen
       shape: four non-empty command strings (`canary_cmd`, `observe_cmd`,
       `expand_cmd`, `rollback_cmd`) plus
       `observe { probes, failure_threshold, interval_ms }` — cross-field
       rules (e.g. `failure_threshold < probes`) remain in `freezeContract`,
       not the schema                                                        (ubiquitous)
- 1.9  THE SYSTEM SHALL define the remaining inner shapes: `goal` requires
       non-empty `id` with optional `title`/`objective` strings;
       `business_outcomes` is a string array; `scope` allows `include` and
       `exclude` string arrays; `constraints` allows `stack` (string map per
       1.2) and `forbidden` (string array); `quality_gates` allows `ladder`
       (string), `mutation { min_score_on_changed_files: number, tier:
       string }`, `security` (string), `fusion` (string); `approval_policy`
       requires `require_human_approval` (string array)                      (ubiquitous)

## REQ-2: Edge Validation at the Composition Root

**User Story:** As the platform operator, I want every goal file validated against
the schema at the same edge that parses it, so that shape errors surface with
precise paths before any freeze or run, while core stays zero-dependency.

**Acceptance Criteria (EARS):**
- 2.1  WHEN `loadGoalContract` receives a goal file THE SYSTEM SHALL
       validate the parsed YAML against the Goal Contract schema BEFORE
       calling `freezeContract`                                              (event-driven)
- 2.2  IF schema validation fails THEN THE SYSTEM SHALL refuse with an error
       naming every failing instance path (not just the first)              (error handling)
- 2.3  THE SYSTEM SHALL perform schema validation with `ajv` added to
       `console/backend` ONLY — `core/` and `aal/` SHALL gain no new
       dependency (INV-7 / zero-runtime-dependency unchanged)                (ubiquitous)
- 2.4  THE SYSTEM SHALL keep `freezeContract`'s hand-rolled structural and
       cross-field checks as the final gate — schema validation is additive
       defense at the edge, never a replacement                              (ubiquitous)
- 2.5  THE SYSTEM SHALL validate against an embedded schema copy (no
       filesystem read of `.ai/schemas/` at runtime), following the
       embedded-copy convention                                              (ubiquitous)
- 2.6  THE SYSTEM SHALL supersede Phase-1 REQ-8.4 (preserve-and-ignore
       unknown goal.yaml keys) at the load edge: unknown keys are rejected
       by schema validation, and forward-compat proceeds via schema
       amendment instead — `freezeContract`'s raw passthrough (3.6) is
       unchanged, so the Phase-1 freeze-layer unit test stays valid          (ubiquitous)

## REQ-3: Typed Contract — Budget ครบ 6 + Risk

**User Story:** As the platform operator, I want every budget field and the risk
level to survive freezing as typed values, so that no governance number I wrote in
the contract is silently discarded.

**Acceptance Criteria (EARS):**
- 3.1  THE SYSTEM SHALL extend `BudgetLimits` (or the frozen contract type)
       so the frozen contract carries typed values for all six budget keys   (ubiquitous)
- 3.2  IF any of the six budget keys is missing or is not an integer >= 1
       THEN `freezeContract` SHALL throw `ContractInvalidError` naming the
       offending key                                                         (error handling)
- 3.3  WHEN `risk` is absent THE SYSTEM SHALL freeze the contract with
       `risk = L2`                                                           (event-driven)
- 3.4  IF `risk` is present but not one of `L0` `L1` `L2` `L3` `L4`
       (case-sensitive) THEN `freezeContract` SHALL throw
       `ContractInvalidError`                                                (error handling)
- 3.5  THE SYSTEM SHALL expose `risk` as a typed field on `TaskContract`     (ubiquitous)
- 3.6  THE SYSTEM SHALL keep `TaskContract.raw` and the frozen-hash
       semantics (sha256 of raw bytes) byte-for-byte unchanged               (ubiquitous)
- 3.7  THE SYSTEM SHALL supersede Stage-1 REQ-4.5's freeze-unchanged
       guarantee: generator output carries `risk: "TODO"` by design, so a
       verification-resolved draft now freezes ONLY after the human sets a
       valid risk level — the risk gate is intentional (D5), recorded in
       the v1.5 changelog alongside the other supersessions                  (ubiquitous)

## REQ-4: Consumer Wiring — เฉพาะ Consumer ที่มีจริง

**User Story:** As the platform operator, I want the budget caps I set in the
contract to actually bound the runtime mechanisms that already exist, so that the
contract is an enforcement document rather than documentation.

**Acceptance Criteria (EARS):**
- 4.1  WHEN a run executes under a frozen contract THE SYSTEM SHALL bound
       the hypothesis-driven repair cycle by the contract's
       `max_hypotheses_per_failure` (replacing the static default 3 in
       `RepairPolicy`)                                                       (event-driven)
- 4.2  WHILE dispatching concurrent agent work of any kind under a frozen
       contract (today: planner-fusion candidate fan-out; Stage 4: task
       workers) THE SYSTEM SHALL treat `max_parallel_agents` as the
       governance ceiling — effective concurrency =
       `min(routing-config maxParallel, contract max_parallel_agents)`; the
       ceiling binds whenever operational parallelism is raised above it
       (routing default 1 means it is dormant, not dead, in default config)  (state-driven)
- 4.3  THE SYSTEM SHALL store `max_total_tasks` on the frozen contract
       WITHOUT wiring runtime enforcement in this stage — enforcement lands
       with the Stage 4 task graph (single-task ceiling documented at
       `console/backend/src/fusion.ts:194` still holds)                      (ubiquitous)
- 4.4  THE SYSTEM SHALL document the Stage-4 deferral of 4.3 as a code
       comment at the field's definition site (grep-able, not only in this
       spec)                                                                 (ubiquitous)

## REQ-5: Retire `.ai/goal.yaml` Convention

**User Story:** As the platform operator, I want one canonical location for goal
files, so that tooling, docs, and the Console banner all agree on where a goal
contract lives.

**Acceptance Criteria (EARS):**
- 5.1  THE SYSTEM SHALL amend `unified-platform-spec.md` §11.1 so the
       template header names `.ai/specs/<feature>/goal.yaml` as the
       canonical path (draft = `goal.draft.yaml`, same folder — Stage 1
       unchanged), retiring root `.ai/goal.yaml`                             (ubiquitous)
- 5.2  THE SYSTEM SHALL redefine the Console `loopManaged` flag as: true
       iff at least one `.ai/specs/*/goal.yaml` exists under the project
       cwd (one directory level — `.ai/specs/archive/**` is structurally
       unmatched by design); root `.ai/goal.yaml` no longer consulted        (ubiquitous)
- 5.3  THE SYSTEM SHALL NOT count `goal.draft.yaml` toward `loopManaged`
       (a draft is pre-approval by definition)                               (ubiquitous)
- 5.4  THE SYSTEM SHALL record the `.ai/goal.yaml` retirement, the Phase-1
       REQ-8.4 supersession (2.6), AND the Stage-1 REQ-4.5 supersession
       (3.7) in the v1.5 changelog entry of `unified-platform-spec.md` §17   (ubiquitous)
- 5.5  THE SYSTEM SHALL define promotion as the human act of renaming
       `goal.draft.yaml` to `goal.yaml` upon approval — stated in §11.1 and
       appended as the final `# HUMAN:` banner step emitted by
       `scripts/spec_to_goal.py` (banner text change only; no new tooling)   (ubiquitous)

## REQ-6: Schema Parity & Regression Tests

**User Story:** As the platform operator, I want the governance schema, its
embedded copy, and the freeze checks proven consistent by tests, so that the three
layers cannot drift apart silently.

**Acceptance Criteria (EARS):**
- 6.1  THE SYSTEM SHALL include a parity test asserting the embedded schema
       copy is deep-equal to `.ai/schemas/goal.schema.json` — the test
       fails when either side changes alone                                  (ubiquitous)
- 6.2  THE SYSTEM SHALL include tests proving budget enforcement: a goal
       file missing any of the six keys, or carrying a zero, negative, or
       fractional value, is rejected at BOTH layers (schema validation and
       `freezeContract` — the freeze layer exercised by direct unit call,
       since the edge validates first)                                       (ubiquitous)
- 6.3  THE SYSTEM SHALL include tests proving risk handling: absent → L2,
       each valid level round-trips, invalid value rejected at both layers   (ubiquitous)
- 6.4  THE SYSTEM SHALL include a test proving an unresolved Stage-1 draft
       is rejected with error paths that INCLUDE the empty-
       `acceptance_criteria` violation specifically (the Stage-1 human gate)
       — not merely rejected for any incidental reason (`pending_...` key,
       `risk: "TODO"`), AND rejected by `freezeContract` directly            (ubiquitous)
- 6.5  THE SYSTEM SHALL include a test simulating the FULL human fill of a
       Stage-1 generator draft (fill unresolved verifications, rename
       `pending_acceptance_criteria` → `acceptance_criteria` and drop the
       empty placeholder, set `risk` to a valid level, resolve remaining
       TODO governance fields) and proving the result passes schema
       validation and freezes successfully                                   (ubiquitous)
- 6.6  THE SYSTEM SHALL update every fixture, test, and doc template this
       stage breaks — at minimum the six known 3-key-budget sites
       (`.ai/calibration/fixture-goal.yaml`, `fixture-goal-deploy.yaml`,
       `fixture-goal-l0.yaml`, `fixture-goal-lesson.yaml`,
       `core/src/contract/contract.test.ts`,
       `console/backend/src/loop-cli.test.ts`), the path-based
       `loopManaged` fixtures in `console/backend/src/claude-data.test.ts`,
       the literal `TaskContract` fixtures in
       `console/backend/src/loop-run.test.ts` (risk-via-`raw` → typed
       `risk` field + 6-key `ContractBudget` — the L1 auto-merge case must
       stay L1, not silently default to L2), and the
       `spec-to-goal.e2e.test.ts` assertions touched by 3.7 and the 5.5
       banner — repo-wide green, no fixture left behind                      (ubiquitous)
- 6.7  THE SYSTEM SHALL include `loopManaged` tests: true when
       `.ai/specs/<feature>/goal.yaml` exists; false when only
       `goal.draft.yaml` exists, when no goal file exists, and when only
       legacy root `.ai/goal.yaml` exists                                    (ubiquitous)
- 6.8  THE SYSTEM SHALL include a wiring test proving a NON-default
       `max_hypotheses_per_failure` (e.g. 5) observably bounds the repair
       cycle — a default-valued test (3 == static default) cannot pass with
       the wire disconnected                                                 (ubiquitous)
- 6.9  THE SYSTEM SHALL include a wiring test proving the dispatch cap:
       with routing `maxParallel` raised ABOVE the contract's
       `max_parallel_agents`, effective concurrency equals the contract
       value                                                                 (ubiquitous)

## Edge Cases & Open Questions

- **Breaking change (ตั้งใจ):** goal file 3-key budget ที่เคย freeze ผ่าน จะถูก
  reject หลัง stage นี้ — fail-closed ตามเจตนา Q6(a); legacy จริงมี 6 จุด (enumerate
  ใน 6.6) และถูก migrate ใน stage เดียวกัน; template ทุกจุดใส่ครบ 6 อยู่แล้ว
  (`issues.ts` `goalDraftYaml`, `spec_to_goal.py` scaffold, §11.1 example)
- **Schema กับ freeze ไม่ duplicate หน้าที่:** schema = shape (named-path errors,
  unknown-key rejection), freeze = semantics + cross-field (`failure_threshold <
  probes`) + hash. Layer สอง strict กว่าใน domain ของตัวเอง — 6.2/6.3 พิสูจน์ว่า
  overlap ส่วน budget/risk สอดคล้องกันจริง
- **ajv = dependency ใหม่** ใน `console/backend` เท่านั้น (MIT, มาตรฐาน de-facto,
  maintenance active) — บันทึกเหตุผลที่นี่ตาม dependency rule; การ approve PR ของ
  stage นี้ = การอนุมัติ dependency
- **`quality_gates`:** freeze วันนี้ไม่อ่าน (อยู่ใน `raw` เท่านั้น) — schema ตรวจ shape
  เมื่อ present (1.9) แต่ stage นี้ไม่ wire consumer (ไม่อยู่ใน roadmap stage ไหน —
  ถ้าจะ wire เป็น spec ใหม่)
- **`business_outcomes` / `scope` / `constraints`:** shape-checked ตาม 1.9, ยังเป็น
  raw passthrough; generator emit TODO string ใน `scope`/`forbidden`/`objective`
  ซึ่งเป็น string ถูก type — ผ่าน schema ได้; ยกเว้น `risk: "TODO"` ที่ไม่ผ่าน enum
  (1.5) — เจตนา: risk เป็น human decision ที่ต้องตั้งจริงก่อน promote (สอดคล้อง
  human gate)
- **Amended-draft hazard:** ถ้า human เติม `acceptance_criteria` แล้วลืมลบ
  `pending_acceptance_criteria` → strict schema reject พร้อม path ชัด — บังคับ
  cleanup, เจตนา
- **`max_wallclock_per_task_min` เป็น integer:** template ใช้ 30; fractional minute
  ไม่มี use case จริง — ตัดสิน integer >= 1 ทั้ง 6 ตัวเพื่อกฎเดียวจำง่าย (ผ่อนทีหลัง
  ได้ถ้าเจอเคสจริง, การผ่อน = amend schema + spec); กฎนี้ tighten 3 field เดิมด้วย
  (เดิม `Number()` ยอม fractional) — ยืนยันแล้ว (L4)
- **Risk ยังไม่มี consumer ใน stage นี้:** typed + stored + exposed เท่านั้น; การผูก
  risk เข้า gate tier / approval policy = งานอนาคต (ไม่ silent — บันทึกที่นี่)
- **Rollout ลำดับ commit เดียว:** schema + freeze + fixtures ต้อง land พร้อมกัน
  (6.6) มิฉะนั้น CI แดงกลางทาง — stage เล็กพอที่จะเป็น PR เดียว

### Analyze findings log (anchor: HEAD 326dc9c, requirements.md ยัง uncommitted ณ ตอน audit 2026-07-12)

Audit 2026-07-12 (spec-architect fresh-context + cross-set pass) — ทุก finding มี
decision แล้ว:

- **F-A** REQ-1.8 เขียน "five command strings" แต่ frozen shape มี 4
  (`contract.ts:121-126`) — **APPLIED**: แก้เป็น four + enumerate ชื่อ
- **F-B** Overview/Edge Case อ้าง "ไม่มี legacy 3-key" — ผิด (มีจริง 6 จุด) —
  **APPLIED**: แก้ข้อความ + enumerate ใน 6.6
- **D1** strict schema กลับด้าน Phase-1 REQ-8.4 preserve-and-ignore (test
  `some_future_key` `contract.test.ts:21,37`) — **APPLIED (a)**: supersede อย่างเป็น
  ทางการ (2.6) + changelog (5.4); freeze-layer raw passthrough คงเดิม → unit test
  เดิมยัง valid
- **D2** `constraints.stack` free-form + `quality_gates` ไม่มี sub-shape ชน strict —
  **APPLIED (a)**: exception เดียว stack = string map (1.2), quality_gates enumerate
  ใน 1.9
- **D3** `max_parallel_agents` dormant ใน default config (routing maxParallel=1) +
  semantics — **APPLIED (a)**: 4.2 reword เป็น governance ceiling ครอบ concurrent
  dispatch ทุกชนิด, dormant-not-dead, พิสูจน์ด้วย 6.9
- **D4** canonical `goal.yaml` ไม่มีตัวเขียน → orphan ซ้ำรอย — **APPLIED (a)**: 5.5
  promote = human rename act + banner step ใน generator
- **D5** generator emit `risk: "TODO"` → 6.5 เดิมเป็นไปไม่ได้ + Edge Case text ผิด —
  **APPLIED (a)**: 6.5 นิยาม full human fill; Edge Case แก้แล้ว
- **D6** `claude-data.test.ts` loopManaged fixtures พังนอก scope 6.6 เดิม —
  **APPLIED (a)**: ขยาย 6.6 + เพิ่ม 6.7
- **D7** ไม่มี wiring test + default ชนกัน (3==3 ผ่านแม้สายขาด) — **APPLIED (a)**:
  เพิ่ม 6.8 (non-default value) + 6.9 (routing > contract)
- **D8** 6.4 confounded (reject ได้ 3 เหตุผลอิสระ) — **APPLIED (a)**: assert error
  paths รวม empty-AC violation โดยเฉพาะ
- **D9** inner shapes ไม่มี criterion — **APPLIED (a)**: เพิ่ม 1.9
- **L1** issues.ts เขียน `.ai/issues/<id>.goal.yaml` (draft แต่ชื่อ `.goal.yaml`) —
  **LOGGED, no change**: นอก scope (`.ai/issues/` ไม่ใช่ `.ai/specs/*` — ไม่กระทบ
  loopManaged); ถ้า flow อนาคตย้าย path ค่อยแก้ naming ตอนนั้น
- **L2** malformed YAML / non-object root ที่ edge — **LOGGED, no change**:
  pre-existing behavior (`yaml` throw ตรง), นอก scope stage นี้
- **L3** "both layers" ใน 6.2/6.3 — freeze layer ต้อง test ด้วย direct unit call
  เพราะ edge validate ก่อนเสมอ — **APPLIED**: ระบุใน 6.2
- **L4** integer >= 1 tighten 3 field เดิมด้วย — **CONFIRMED**: เจตนา, บันทึกใน
  Edge Cases
- **L5** stage-1 requirements text อ้าง `.ai/goal.yaml` banner (REQ-4.1 เดิม) —
  **LOGGED, no retro-edit**: historical record ของ spec ที่ปิดแล้ว; ความจริงใหม่อยู่
  ใน spec นี้ + §11.1 + changelog v1.5
- **L6** archive glob — `.ai/specs/archive/<f>/goal.yaml` อยู่สองระดับ ไม่ match
  glob ระดับเดียวโดยโครงสร้าง — **APPLIED**: ระบุเจตนาใน 5.2

Design-critique round 2026-07-12 (spec-architect วิจารณ์ design.md — findings ที่
สะท้อนกลับเข้า requirements):

- **AD1** `loop-run.test.ts` fixture ตั้ง risk ผ่าน `raw` + literal 3-field budget —
  migrate ผิดจะพลิก L1 auto-merge เป็น L2 เงียบ — **APPLIED**: enumerate ใน 6.6
  พร้อมคำเตือน L1-stays-L1
- **AD2** generator emit `risk: "TODO"` เสมอ → freeze ใหม่ reject → stage-1 REQ-4.5
  "resolved draft freezes unchanged" ถูก supersede — **APPLIED**: 3.7 (supersession
  อย่างเป็นทางการ, เจตนา D5: risk = human gate) + 5.4 widened + e2e ใน 6.6
- **AD3** `DEFAULT_REPAIR_POLICY` ต้อง re-export ผ่าน `core/src/index.ts` barrel —
  design-level, แก้ใน design.md C5
- **AD4** 6.5 อ้าง phase4 corpus ซึ่ง resolved เต็ม (ไม่มี `pending_...` ให้ rename) —
  design-level: Testing Strategy ใช้ unresolved fixture สำหรับ rename clause + corpus
  สำหรับ resolved-scale
- **AD5** C7 snippet ขาด try/catch ที่ตาราง error handling สัญญาไว้ (ENOENT = common
  case ใน home-dir scan) — design-level, แก้ snippet
- **AD6** REQ-4.2 min() vs guard refuse — ยืนยัน: composed rule = ceiling (clamp ผ่าน
  `min()`), guard refuse = fail-closed เมื่อ caller ประกอบผิด (ลืม ceiling) — คนละ
  เหตุการณ์ ไม่ขัดกัน; rationale ใน design C6
