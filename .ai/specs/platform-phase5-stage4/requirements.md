# Requirements: platform-phase5-stage4 — Task Graph + Planning Gate (§11.2)
> Status: approved 2026-07-26 (quick-mode: operator pre-authorized the full run via
> /goal overnight directive — human gates waived for this run; fresh-context
> spec-architect audit substituted at each gate, round-1 findings A1–A21 applied
> below; operator post-hoc review pending)

## Overview

Stage 4 ของ Phase 5 (SDD Integration) ตาม `unified-platform-spec.md` v1.6 §14 (บรรทัด 575)
และ §11.2: multi-task Goal Contract ผ่าน `task-graph.json` (DAG ต่อ feature), planning gate
(`uncovered_acs` / `orphan_tasks` / `max_diff_budget_per_task`), scheduler ที่เลือกเฉพาะ
task ที่ READY + deps PASSED + risk permitted + budget available + lease ว่าง, ยก
single-task ceiling ที่ documented ไว้ใน planner fusion, generator ขยาย emit task entries
จาก tasks.md, และ fault-injection ต่อ task ตาม DoD (บรรทัด 578). Stage 1–3 ปิดแล้ว
(PR #102/#110/#117) — stage นี้เป็น consumer แรกของ `max_total_tasks` ที่ Stage 2 ฝากไว้.

การตัดสินใจ scope (operator AFK — เลือกทางเล็กกว่า+ย้อนกลับได้ ตาม §0.7, บันทึกที่นี่):
- **Canonical path ต่อ feature + promotion โดย human** ตาม precedent goal.yaml เป๊ะ:
  generator emit `.ai/specs/<feature>/task-graph.draft.json`; promotion = human rename
  เป็น `task-graph.json`; loop composition อ่านเฉพาะไฟล์ที่ promote แล้ว (INV-3/INV-16 —
  draft รันไม่ได้จนมนุษย์ตัดสิน, ห้าม auto-start)
- **Opt-in ต่อ feature, absent = พฤติกรรมเดิม 100%:** ไม่มี `task-graph.json` →
  `runSupervisedLoop` เดิน path single-task เดิม (`RUN-LIVE`/`T-1`) ทุก byte เดิม —
  ไม่มี migration บังคับ; test เดิมทั้งชุดต้องเขียวโดยไม่แก้ (รวม result shape — 4.11)
- **Task execution เป็น sequential:** scheduler เลือกทีละ task (single-threaded ตาม
  `core/src/orchestrator/control.ts:3-5`); task-level parallelism = ceiling ที่บันทึกไว้
  ไม่ใช่ scope นี้ (`max_parallel_agents` ยังคุม agent fan-out ภายใน task ตาม Stage-2
  REQ-4.2 เดิม — ความหมายไม่เปลี่ยน; clause "Stage 4: task workers" ของมันถูกเลื่อน
  โดยบันทึก ดู 7.3)
- **"deps PASSED" นิยามเดียวทั้ง spec (A3):** dep ของ task ถือว่า satisfied ก็ต่อเมื่อ
  TASK_STATE ล่าสุดของ dep ใน run นี้ (event-log projection ต่อ taskId — INV-2)
  ∈ `{PASSED, REVIEWING, APPROVED, MERGE_QUEUED, AUDITED, COMPLETED}` — เซตนี้เป็น
  นิยามอ้างอิงของ 4.1/4.4; ESCALATED/BLOCKED/FAILED/ROLLED_BACK/CANCELLED/QUARANTINED
  ไม่อยู่ในเซต → dependent ไม่มีวัน eligible
- **"risk permitted" =** effective risk ของ task (`task.risk` หรือ default = contract
  risk) ต้องไม่เกิน `contract.risk` — ตรวจสองจุด: planning gate (block ตั้งแต่ freeze)
  และ scheduler (re-check ตอนเลือก); L3/L4 approval flow เดิมที่ approval package
  ไม่เปลี่ยน (§6.6 คงเดิม)
- **"budget available" =** budget tracker ต่อ task สร้างใหม่ทุก task จาก field per-task
  ของ contract (A1); bound ระดับ run มีตัวเดียวคือขนาด graph เทียบ `max_total_tasks`
  ซึ่งตัดจบที่ planning gate (3.6) — ไม่มี predicate ซ้ำตอน runtime (A17)
- **Lease = claim-then-verify (A10):** pure selection ไม่รู้จัก lease; composition
  พยายาม claim หลังเลือก — claim ไม่ผ่าน (มีคนถืออยู่ยังไม่หมดอายุ) = task นั้น
  ineligible รอบนี้; lease ใช้เฉพาะ multi-task mode (single-task path วันนี้ไม่ claim
  lease เลย — ห้ามเพิ่มเข้าไป มิฉะนั้นขัด 4.3)
- **planning gate ตรวจ graph ไม่ใช่ตรวจ fusion plan:** ผล resolve ของ planner fusion
  ยังเป็น advisory + structural validation ตามเดิม (Phase-4 REQ-16.5 ส่วน plan validation
  คงเดิม) — สิ่งที่เกิดใหม่คือ deterministic gate บน task-graph artifact ก่อน run เริ่ม
- **Deploy + multi-task = reject ที่ planning gate (A12):** semantics ของ `deploy:`
  เป็น per-goal (`loop-run.ts:850-913` รันทุกครั้งที่ task ถึง COMPLETED) — กราฟหลาย
  task จะ canary/expand ซ้ำหลายรอบ; stage นี้ประกาศไม่รองรับ ชัดเจนตั้งแต่ gate
  (recorded ceiling, ดู 3.13/7.3) แทนที่จะ deploy ซ้ำเงียบ ๆ
- **Drift check ของ tasks.md ↔ task-graph = นอก scope** (Stage-3 drift anchor ครอบ
  requirements.md↔goal.yaml เท่านั้น) — บันทึกเป็น backlog ไม่ตัดเงียบ

Supersession ที่ประกาศใน stage นี้ (ตาม lesson #supersede-old-guarantees-explicitly):
- **Stage-2 REQ-4.3/4.4** (`max_total_tasks` stored-only + deferral comment ที่
  `core/src/contract/contract.ts:20-25`) — superseded: consumer จริง land ใน stage นี้
  (planning gate 3.6); deferral comment ถูกแทนด้วย pointer ไปกลไกจริง
- **Phase-2 REQ-7.2 (วลี "the Phase-2 single-task loop maps ALL of them") + REQ-7.7
  ที่อิง mapped-AC ชุดเต็ม** — superseded เฉพาะ multi-task mode (A2): mapped ACs ของ
  task = `task.satisfies` ไม่ใช่ AC ทั้ง contract — มิฉะนั้น auto-merge ของ task หนึ่ง
  จะผ่านด้วย golden ของ AC ที่ task นั้นไม่เคยแตะ (safety regression ตรง §6.6);
  single-task mode คงพฤติกรรม "maps ALL" เดิมทุกประการ
- **Phase-4 REQ-16.2** (panel input pinned to frozen goal+ACs — nothing else; empty
  `contextBundle` ที่ `console/backend/src/fusion.ts:193-195`) — superseded บางส่วน:
  WHERE task graph ถูก promote, panel input เพิ่ม task-graph piece เป็น MARKed data;
  composition ที่ไม่มี graph คงพฤติกรรมเดิมเป๊ะ
- **Phase-4 REQ-16.5 (วงเล็บ "no full planning gate exists in this composition")** —
  superseded เฉพาะประโยคเพดาน: planning gate มีจริงแล้วใน composition (บน graph);
  การ validate ผล plan ยัง structural-only ตามเดิม · ข้อความเพดานเดียวกันใน
  `.ai/schemas/plan.schema.json:4` `$comment` และ doc comment
  `console/backend/src/fusion.ts:183-184` ต้องอัปเดตพร้อมกัน
- **Stage-1 REQ-4.2 (output gate เอกพจน์ "the output file")** — superseded scope (A15):
  gate กันเขียนทับแยกต่อไฟล์ output (goal draft / task-graph draft) — draft กราฟที่
  ค้างอยู่ไม่บล็อกการ regenerate goal draft; `--force` เขียนทับทั้งคู่
- **Stage-1 REQ-4.1/4.6 ("generator เขียน `goal.draft.yaml` ไฟล์เดียว" — e2e เดิม
  assert `readdirSync` ว่ามีไฟล์ใหม่ไฟล์เดียวหลัง generate)** — superseded โดย 2.1:
  generation ที่สำเร็จเขียนสอง draft; ส่วนที่ไม่เปลี่ยนของเกณฑ์เดิม (ไม่มี temp file
  ค้าง, input ไม่ถูกแตะ, ไม่ promote เอง) ยังถูก assert ตามเดิม — พบตอน implement
  task 2 (นอกรอบ audit A1–A21); §17 ของ task 6 ต้องบันทึกเป็นรายการที่ 6

ข้อเท็จจริงจากโค้ดที่ requirements นี้อิง (ยืนยันบน develop @ `3f0915c` — ทุก
file:line ผ่านการตรวจซ้ำโดย fresh-context audit):
single-task ceiling บังคับจริงที่ `console/backend/src/loop-run.ts:393-395`
(hardcode `RUN_ID = 'RUN-LIVE'`, `TASK_ID = 'T-1'`; literal `'T-1'` ปรากฏซ้ำ 40+ จุด) —
`fusion.ts` แค่ document เพดาน · `runSupervisedLoop` = ฟังก์ชันประกอบเดียว ~690 บรรทัด
(`loop-run.ts:275-966`); helper ระดับ composition ที่ยังไม่ scope ต่อ taskId (A4):
`currentState()` (`:520-521` อ่าน TASK_STATE ล่าสุดทั้ง log), `onDecision` (`:540-547`
ทิ้ง argument taskId), `onInject` (`:548-558`), `escalateTask` (`:786-790`),
deferred-quarantine (`:405-409`); pattern การ filter ที่ถูกมีแล้วในไฟล์เดียวกัน
(`log.all({ type:'OUTCOME_ROUTE', taskId })`, `:445`) · budget tracker สร้างครั้งเดียว
ต่อ run ที่ `loop-run.ts:430` ทั้งที่ contract field เป็น per-task โดยชื่อ
(`contract.ts:124-126`) — A1 · auto-merge/approval ใช้ AC ทั้งชุดที่
`loop-run.ts:733-736`/`:771` — A2 · deploy stage รันต่อ COMPLETED ทุกครั้งที่
`loop-run.ts:850-913` — A12 · path `planning` ไม่เคยถูกประกอบจาก CLI
(`console/backend/bin/platform.ts:413-439` ไม่ส่ง `planning`) — `runPlannerFusion`
reachable จาก test เท่านั้นวันนี้ (A21) · ผล run วันนี้ = `{finalState, iterations,
calibration, ...}`; `bin/platform.ts:441-448` พิมพ์ `result.finalState` (A13) ·
core ไม่มี scheduler/graph ใด ๆ (grep = 0 hit; greenfield) · lease รองรับ multi-task
แล้วเชิงกลไก (`core/src/state/lease.ts` keyed ด้วย `taskId`, CAS ใน `BEGIN IMMEDIATE`;
`leases.task_id PRIMARY KEY` ที่ `core/src/state/schema.ts:20-24`) แต่
`createLeaseManager` ไม่มี caller นอก test — `runSupervisedLoop` วันนี้ไม่ claim lease
(A10) · state machine เป็น per-task ล้วน (`core/src/orchestrator/machine.ts`);
PASSED→REVIEWING→escalate ที่ `loop-run.ts:786-795` (ทั้ง `split_required` และ
`approval_timeout`) — ESCALATED เข้าถึงได้หลัง PASSED (A3) · `maxTotalTasks` typed
แล้วแต่ไม่มี consumer (`core/src/contract/contract.ts:20-25,128`) · `maxParallelAgents`
fail-closed guard ที่ `loop-run.ts:381-387` + ceiling resolve ที่
`aal/src/dispatch.ts:23,44-51` · approval diff budget วันนี้ =
`opts.approval?.maxDiffBudget ?? 400` ที่ `loop-run.ts:774` (comment `:301` อ้าง §11.2
แต่ไม่ได้อ่านจาก contract/graph); `buildApprovalPackage` refuse `split_required` ที่
`core/src/human/approval.ts:69-75`; `countChangedLines()` ที่ `loop-run.ts:99` ·
generator: `scripts/spec_to_goal.py` `MARKER_RE:31` รู้จัก `Depends on:`/`Batch:` แล้ว
แต่ `task_maps():85-109` ทิ้ง; `iter_task_blocks` (`spec_trace.py:121-158`) yield
สตริงเดียว join แล้วต่อ block — เลข task/title ต้อง parse จากหัว block เอง (A8);
AC id คือ `AC-<criterion>` (`spec_to_goal.py:119`) ซ้ำกันได้ข้าม feature — ต้องมี
`goal_id` binding (A5); spec จริงมี `Depends on:` ปน prose + เลขอื่น
(`.ai/specs/platform-phase5-stage2/tasks.md:37`) — grammar ต้อง pin แคบ (A7);
atomic write temp+`os.replace` ที่ `:274-287`; `--force` output gate ที่ `:266-269` ·
schema convention: draft-07, `$id` = ชื่อไฟล์, `$comment` อ้าง §/REQ, embedded copy +
deep-equal parity test (`console/backend/src/goal-schema.test.ts:29-34`); ยังไม่มี
task-graph schema (`.ai/schemas/` มี 5 ไฟล์) · test framework = `node:test` +
`node:assert/strict` flat `test()` เท่านั้น; fault-injection convention =
`core/test/fault-injection.test.ts` (DoD#N naming, `makeFixture()` จาก
`core/test/helpers/fixture.ts` — สัญญา "target tests ผ่านก็ต่อเมื่อ `src/impl.txt`
มี `correct`"), inject ผ่าน port (stub `ProposalSource`) ไม่ mock internals ·
`*.e2e.test.ts` = spawn process จริง · CI: `.github/workflows/ci.yml` job `platform`
(macos, pnpm, vendor-free check INV-7) + job `verify` (guard regression + spec-trace
loop + drift advisory loop) · ไม่มี goal.yaml/task-graph.json จริงบนดิสก์สักไฟล์
(fixtures อยู่ `.ai/calibration/` 4 ตัว) — schema/gate ใหม่ไม่พังของเดิม.

## REQ-1: Task-Graph Schema (governance + embedded + parity)

**User Story:** As the platform operator, I want a strict JSON Schema for
`task-graph.json`, so that a malformed or hand-mangled graph is rejected at the edge
before any run logic sees it.

**Acceptance Criteria (EARS):**
- 1.1  THE SYSTEM SHALL add `.ai/schemas/task-graph.schema.json` (draft-07,
       `$id: "task-graph.schema.json"`, `additionalProperties: false` on
       every object level, `$comment` citing §11.2 + this stage) defining:
       required `goal_id` (string, minLength 1 — binds the graph to one
       contract, A5), required `tasks` (array, minItems 1) of task objects —
       required `id` (string, minLength 1), required `title` (string,
       minLength 1), required `satisfies` (array of AC-id strings, may be
       empty), optional `depends_on` (array of task-id strings), optional
       `enabling` (boolean), optional `risk` (enum L0..L4), optional
       `diff_budget` (integer >= 1) — and required `checks` object with
       required `max_diff_budget_per_task` (integer >= 1, A14)                (ubiquitous)
- 1.2  THE SYSTEM SHALL embed a byte-equivalent copy as `TASK_GRAPH_SCHEMA`
       in `console/backend/src/task-graph-schema.ts` with a deep-equal
       parity test against the governance file (same pattern as
       `goal-schema.test.ts:29-34`)                                           (ubiquitous)
- 1.3  WHEN a graph file conforms to the schema THE SYSTEM SHALL accept it
       at edge validation (`validateTaskGraphShape`, ajv, all failing paths
       reported — same error style as `validateGoalShape`)                    (event-driven)
- 1.4  IF a graph file carries an unknown key at any level THEN THE SYSTEM
       SHALL reject it at edge validation with the failing instance path      (error handling)
- 1.5  IF `tasks` is empty or missing THEN THE SYSTEM SHALL reject at edge
       validation (a graph with no tasks is not a graph)                      (error handling)

## REQ-2: Generator Emits Task Entries from tasks.md

**User Story:** As the platform operator, I want `spec_to_goal.py` to also emit a
task-graph draft from the spec's tasks.md, so that the DAG the scheduler runs is
generated from the same SDD artifacts as the goal — never hand-authored from scratch.

**Acceptance Criteria (EARS):**
- 2.1  WHEN generation succeeds THE SYSTEM SHALL additionally write
       `.ai/specs/<feature>/task-graph.draft.json`: `goal_id` = the same
       `goal.id` the goal draft carries (A5), plus one entry per task block
       from `spec_trace.iter_task_blocks` in file order — `id` = `T-<n>`
       where `<n>` is the ordinal written in the block head (parsed from
       the joined block's leading `- [ ]|[x] <n>.` form, A8), `title` = the
       text between that ordinal and the block's first marker
       (`Satisfies:`/`Verify:`/`Depends on:`/`Batch:`), trimmed and
       truncated to 120 chars, `satisfies` = the AC ids (`AC-N.M`) expanded
       from the block's `Satisfies:` refs via `expand_refs`, `depends_on` =
       `T-<m>` entries parsed from the block's `Depends on:` marker           (event-driven)
- 2.2  THE SYSTEM SHALL emit the draft as pretty-printed JSON (2-space
       indent, trailing newline; top-level key order `goal_id, tasks,
       checks`; task-entry key order `id, title, satisfies, depends_on` —
       `depends_on` omitted when the block has none, A19)                     (ubiquitous)
- 2.3  THE SYSTEM SHALL stamp `checks: { "max_diff_budget_per_task": 400 }`
       in the draft (§11.2 default) — a human may tighten or relax it at
       promotion                                                              (ubiquitous)
- 2.4  IF `tasks.md` is absent THEN THE SYSTEM SHALL skip task-graph
       emission with a warning on stderr and still generate the goal draft
       (existing Stage-1 degradation, extended)                               (error handling)
- 2.5  IF an output file already exists and `--force` is not given THEN THE
       SYSTEM SHALL refuse writing THAT file only — the gate is per output
       file (a stale `task-graph.draft.json` does not block regenerating
       `goal.draft.yaml`, and vice versa); `--force` overwrites both
       (supersedes Stage-1 REQ-4.2's singular output-gate scope, A15)         (error handling)
- 2.6  IF a `Depends on:` ref names a task ordinal that has no task block
       THEN THE SYSTEM SHALL fail generation with the offending ref on
       stderr (exit 1 — a dangling edge must never reach the draft); the
       `Depends on:` grammar reads ONLY the first run of
       `\d+(\s*,\s*\d+)*` immediately after each marker occurrence and
       stops at the first non-conforming character, so prose/parenthetical
       text after the number list is ignored; ALL occurrences in the block
       are read and their refs unioned — same accumulation `Satisfies:`
       already has (a backtick-quoted mention of the marker in prose
       yields nothing and cannot silently swallow the real one — amended
       during task 2, recorded in its Evidence) (pinned against
       `.ai/specs/platform-phase5-stage2/tasks.md:37` as a test fixture, A7)  (error handling)
- 2.7  THE SYSTEM SHALL NOT auto-promote: the generator never writes
       `task-graph.json` (promotion = human rename, mirroring goal.yaml —
       INV-3/INV-16)                                                          (ubiquitous)
- 2.8  IF a `Satisfies:` ref expands to a criterion id that does not exist
       in requirements.md THEN THE SYSTEM SHALL fail generation with the
       offending id on stderr (exit 1 — symmetry with 2.6; today
       `expand_refs` would silently mint e.g. `AC-9.9`, A16)                  (error handling)
- 2.9  IF a task block's head carries no ordinal, or the same ordinal
       appears on two blocks, THEN THE SYSTEM SHALL fail generation with
       the offending block's first 60 chars on stderr (exit 1, A8)            (error handling)

## REQ-3: Core Typed Task Graph + Planning Gate

**User Story:** As the platform operator, I want core to freeze and gate the task
graph deterministically, so that an uncovered AC, an orphan task, a cycle, or an
oversized task blocks the run at the source instead of surfacing mid-run.

**Acceptance Criteria (EARS):**
- 3.1  THE SYSTEM SHALL add a vendor-free core module (`core/src/graph/`)
       exporting a typed `TaskGraph` (goalId; tasks: id, title, satisfies,
       dependsOn, enabling, risk?, diffBudget?; checks:
       maxDiffBudgetPerTask; graphHash) and `freezeTaskGraph(rawBytes,
       parsed, contract)` returning the frozen graph with a sha256 content
       hash of the raw bytes (INV-10 pattern, same as `freezeContract`)       (ubiquitous)
- 3.2  IF any task's `satisfies` cites an AC id absent from the frozen
       contract's `acceptanceCriteria` THEN THE SYSTEM SHALL reject with
       the unknown id(s)                                                      (error handling)
- 3.3  IF any contract AC id is cited by no task THEN THE SYSTEM SHALL
       reject listing the uncovered AC ids (`uncovered_acs` must be empty —
       §11.2)                                                                 (error handling)
- 3.4  IF any task has empty `satisfies` and `enabling` is not `true` THEN
       THE SYSTEM SHALL reject listing the orphan task ids (`orphan_tasks`
       must be empty — §11.2)                                                 (error handling)
- 3.5  IF `depends_on` contains a task id that exists nowhere in the graph
       THEN THE SYSTEM SHALL reject naming the offending edge (A11 split —
       self-reference 3.10, duplicate id 3.11, cycle 3.12)                    (error handling)
- 3.6  IF the number of tasks exceeds the frozen contract's
       `budget.max_total_tasks` THEN THE SYSTEM SHALL reject (first runtime
       consumer — supersedes Stage-2 REQ-4.3's stored-only deferral)          (error handling)
- 3.7  IF any task's declared `diff_budget` exceeds
       `checks.max_diff_budget_per_task` THEN THE SYSTEM SHALL reject; a
       task without its own `diff_budget` takes
       `checks.max_diff_budget_per_task` as its effective budget (§11.2 —
       บังคับ task เล็ก กัน rubber-stamp ที่ต้นทาง; `checks` is required so
       no fallback branch exists, A14)                                        (error handling)
- 3.8  IF any task's `risk` exceeds the frozen contract's `risk` THEN THE
       SYSTEM SHALL reject (planning-time risk ceiling; runtime L3/L4
       approval flow unchanged)                                               (error handling)
- 3.9  WHEN the graph passes every check THE SYSTEM SHALL return a frozen
       graph whose structured gate result carries `graphHash`, the task id
       list, and empty `uncovered_acs`/`orphan_tasks` arrays — never free
       text (event append is the composition's job, 4.8)                      (event-driven)
- 3.10 IF `depends_on` contains the task's own id THEN THE SYSTEM SHALL
       reject naming the task (A11)                                           (error handling)
- 3.11 IF two tasks carry the same `id` THEN THE SYSTEM SHALL reject naming
       the duplicated id (A11)                                                (error handling)
- 3.12 IF the dependency edges contain a cycle THEN THE SYSTEM SHALL reject
       naming at least one task id on the cycle (the artifact must be a
       DAG, A11)                                                              (error handling)
- 3.13 IF the frozen contract carries a `deploy` block and a task graph is
       being frozen THEN THE SYSTEM SHALL reject (multi-task deploy
       semantics undefined this stage — recorded ceiling, A12/7.3)            (error handling)
- 3.14 IF the graph's `goal_id` differs from the frozen contract's
       `goal.id` THEN THE SYSTEM SHALL reject (AC ids like `AC-1.1` recur
       across features — the binding must be explicit, A5)                    (error handling)

## REQ-4: Scheduler Selection + Multi-Task Composition

**User Story:** As the platform operator, I want the loop to execute every task in
the promoted graph in dependency order under the existing per-task safety machinery,
so that a multi-task feature runs end-to-end without a human hand-feeding task ids.

**Acceptance Criteria (EARS):**
- 4.1  THE SYSTEM SHALL add a pure, deterministic core selection function
       (`selectNextTask(graph, projection)`): eligible = not yet started in
       this run (projection scoped to events at/after THIS run's
       `TASK_GRAPH_FROZEN` append — a reused event log never bleeds prior
       runs' states in, D12) + every `depends_on` satisfied per the
       Overview's dep-satisfied set (latest in-run per-taskId TASK_STATE ∈
       {PASSED, REVIEWING, APPROVED, MERGE_QUEUED, AUDITED, COMPLETED} —
       A3); risk needs no selection input — 3.8 already guarantees every
       frozen task's effective risk within contract risk (D15); among
       eligible, graph file order wins (deterministic tie-break); lease
       state is NOT an input — the composition claims after selection
       (claim-then-verify, A10/A17)                                           (ubiquitous)
- 4.2  WHERE the composition receives a task graph option (edge-validated
       `{rawBytes, parsed}` — freezing happens inside the run, 4.8/D5) THE
       SYSTEM SHALL run `runSupervisedLoop` in multi-task mode (mode
       selection keys on the option, not on filesystem probing inside the
       loop — A9/A11)                                                         (optional)
- 4.3  WHERE no promoted task-graph file exists THE SYSTEM SHALL preserve
       the existing single-task behavior unchanged (`RUN-LIVE`/`T-1` path;
       result shape untouched; every pre-existing test green without
       modification)                                                          (optional)
- 4.4  WHEN a task's run ends outside the dep-satisfied set (ESCALATED,
       BLOCKED, CANCELLED, QUARANTINED) THE SYSTEM SHALL never select its
       transitive dependents (they end as SKIPPED — 4.11), continue
       independent eligible tasks, and end the run when no task is
       eligible                                                               (event-driven)
- 4.5  WHEN building a task's approval package in multi-task mode THE
       SYSTEM SHALL pass the task's effective `diff_budget` from the frozen
       graph as `maxDiffBudget` (replacing the hardcoded `?? 400` for this
       mode; single-task mode default unchanged)                              (event-driven)
- 4.6  WHERE multi-task mode runs THE SYSTEM SHALL claim the task's lease
       via `createLeaseManager` before executing it (ownerId = the run id;
       TTL from a composition option defaulting to the contract's
       `max_wallclock_per_task_min` + 5 minutes slack, so an un-renewed
       lease outlives any legal task — D6) and release it
       (`release(taskId, ownerId)`) when the task's loop ends; a failed
       claim (held, unexpired) makes the task permanently unselectable for
       the remainder of this run (sequential mode releases nothing mid-run
       — D4) and it ends labeled `NOT_STARTED`; the single-task path stays
       lease-free as today (A10)                                              (optional)
- 4.7  IF the draft file (`task-graph.draft.json`) exists but no promoted
       file does THEN THE SYSTEM SHALL ignore the draft entirely (drafts
       are pre-human artifacts — INV-3/INV-16)                                (error handling)
- 4.8  WHEN multi-task mode starts THE SYSTEM SHALL freeze the graph
       EXACTLY ONCE, inside the run after the event log opens and before
       any adapter/agent construction: on pass append `TASK_GRAPH_FROZEN
       {graphHash, taskIds}`; on failure append `TASK_GRAPH_REJECTED` with
       the gate's structured reasons and end the run `BLOCKED` before any
       dispatch — both outcomes live on the production path (the CLI does
       shape validation only, never freezes — D5) (INV-10, A6/A11)            (event-driven)
- 4.9  WHILE eligible tasks remain THE SYSTEM SHALL repeatedly
       select-claim-execute them sequentially through the existing per-task
       loop (worktree, gates, approval, repair — per-task machinery
       unchanged except where 4.5/4.12/4.13/4.14 say otherwise), ending the
       run when no task is eligible (A11)                                     (state-driven)
- 4.10 WHEN the CLI loads a promoted `goal.yaml` whose directory also holds
       a `task-graph.json` THE SYSTEM SHALL edge-validate (ajv) the graph
       and pass `{rawBytes, parsed}` into `runSupervisedLoop` as the 4.2
       option — shape errors surface to the human before a run opens, but
       the semantic freeze belongs to the run (4.8/D5); the CLI prints the
       per-task summary when `result.tasks` is present (A9)                   (event-driven)
- 4.11 WHERE multi-task mode runs THE SYSTEM SHALL extend the run result
       additively with `tasks: [{id, finalState, iterations}]` — labels
       `NOT_STARTED` (run ended before selection, incl. failed lease
       claims and kill-switch stop) and `SKIPPED` (a dependency ended
       outside the dep-satisfied set) for never-executed tasks — derive
       the run-level `finalState` by precedence CANCELLED > ESCALATED >
       BLOCKED > REVIEWING > COMPLETED over per-task end states
       (SKIPPED/NOT_STARTED/CHANGES_REQUESTED/QUARANTINED count as BLOCKED
       for precedence — D10), set run-level `iterations` = the sum over
       executed tasks, and compute `calibration` over executed tasks
       (heldOut = reached-REVIEWING per task — D9); the single-task result
       shape stays byte-identical (A13)                                       (optional)
- 4.12 WHEN starting each task in multi-task mode THE SYSTEM SHALL
       construct a fresh per-task budget tracker from the frozen contract's
       per-task budget fields (`max_iterations_per_task`,
       `max_cost_units_per_task`, `max_wallclock_per_task_min`) — task N's
       spend never depletes task N+1 (A1)                                     (event-driven)
- 4.13 WHEN mapping ACs for a task's agent-facing task-contract excerpt,
       auto-merge decision, and approval package in multi-task mode THE
       SYSTEM SHALL use ONLY the task's `satisfies` set resolved against
       the contract's ACs (the excerpt narrows too — an agent is never
       invited to implement another task's ACs, D11; the gate runner takes
       no AC input, so no "gates" clause exists — D11); an `enabling` task
       (empty `satisfies`) maps zero ACs and therefore always takes the
       approval-package path, never auto-merge (supersedes Phase-2
       REQ-7.2's "maps ALL" for this mode; single-task unchanged — A2)        (event-driven)
- 4.14 WHILE multi-task mode runs THE SYSTEM SHALL scope every task-state
       read and write to an explicit taskId (no whole-log `currentState()`
       reads), and an approval/steering decision SHALL name its target
       task — a decision naming a non-pending task returns the existing
       port shape `{ok: false, detail: 'unknown_task'}` (no core port
       signature change — D14), never applied to the currently active
       task (A4)                                                              (state-driven)
- 4.15 WHEN the operator kill switch fires between tasks THE SYSTEM SHALL
       stop selecting (driver polls the controller before each selection),
       label remaining tasks `NOT_STARTED`, and end the run `CANCELLED` —
       kill never degrades into "skip current task and continue" (D3)         (event-driven)

## REQ-5: Planner Fusion — Lift the Single-Task Ceiling

**User Story:** As the platform operator, I want the planner fusion panel to see the
promoted task graph, so that planning deliberation finally has a task structure to
plan over instead of a pinned goal-only view.

**Acceptance Criteria (EARS):**
- 5.1  WHERE the composition runs in multi-task mode THE SYSTEM SHALL
       include exactly one additional `contextBundle` piece in
       `runPlannerFusion`'s base request: the frozen task graph serialized
       as JSON, MARKed as data with the request's canary token, with real
       `stats` (bytes, pieceCount 1) — supersedes Phase-4 REQ-16.2's
       empty-bundle pin for this mode only                                    (optional)
- 5.2  WHERE the composition runs single-task THE SYSTEM SHALL keep the
       empty `contextBundle` byte-identical to today (Phase-4 REQ-16.2
       behavior preserved outside multi-task mode)                            (optional)
- 5.3  THE SYSTEM SHALL keep the resolved plan advisory: structural
       validation against `PLAN_SCHEMA` only, `winner:false` never blocks
       the task loop (Phase-4 REQ-16.5 plan-validation semantics unchanged)   (ubiquitous)
- 5.4  THE SYSTEM SHALL update the three stale ceiling texts in the same
       change — `console/backend/src/fusion.ts` doc comment + empty-bundle
       comment, `.ai/schemas/plan.schema.json` `$comment`, and the Stage-4
       deferral comment at `core/src/contract/contract.ts:20-25` — to state
       the delivered mechanism (planning gate on the graph; plan still
       advisory), keeping `PLAN_SCHEMA` shape parity green                    (ubiquitous)

## REQ-6: Fault-Injection + Multi-Task Calibration Fixture

**User Story:** As the platform operator, I want the task-graph mechanisms proven
against a lying/misbehaving agent per task, so that COMPLETED-per-task keeps meaning
"core measured it" (INV-1/INV-2) at multi-task scale.

**Acceptance Criteria (EARS):**
- 6.1  THE SYSTEM SHALL add fault-injection tests (DoD-named, `makeFixture`
       conventions; pure-gate halves in `core/test`, composition halves —
       no-dispatch, ordering, driver — in `console/backend` where
       `runSupervisedLoop` lives, D8) proving: a graph with an uncovered
       AC is blocked at the planning gate before any dispatch                 (ubiquitous)
- 6.2  THE SYSTEM SHALL prove: a graph with an orphan task (empty
       `satisfies`, no `enabling` tag) is blocked at the planning gate        (ubiquitous)
- 6.3  THE SYSTEM SHALL prove dep ordering: with tasks A<-B, B is never
       dispatched before A reaches PASSED (event-log order asserted, not
       agent claims)                                                          (ubiquitous)
- 6.4  THE SYSTEM SHALL prove per-task fake-green: an agent claiming
       READY_FOR_VERIFICATION on task 2 of a 3-task graph without making
       target tests pass never yields PASSED for that task, and its
       dependents are not selected (DoD#1 semantics at graph scale)           (ubiquitous)
- 6.5  THE SYSTEM SHALL add a multi-task calibration fixture (a
       `fixture-task-graph.json` + matching goal fixture under
       `.ai/calibration/`) and a test driving a >= 2-task run through the
       multi-task composition to REVIEWING for every task (§14 Stage-4 DoD)   (ubiquitous)

## REQ-7: Constitution Sync v1.7

**User Story:** As the platform operator, I want the unified spec to record Stage 4
as delivered with its real shape, so the next session starts from truth.

**Acceptance Criteria (EARS):**
- 7.1  THE SYSTEM SHALL amend `unified-platform-spec.md` in the same PR:
       version banner to v1.7, §14 Stage-4 entry marked delivered with the
       derived-spec pointer, §17 changelog entry describing the delivered
       shape (canonical path + promotion rename, opt-in absent-unchanged,
       sequential execution, gate checks, supersessions), and the §17
       "จุดเริ่ม" line updated past Stage 4 (A18)                              (ubiquitous)
- 7.2  THE SYSTEM SHALL record the declared supersessions (Stage-2
       REQ-4.3/4.4, Phase-2 REQ-7.2 "maps ALL" for multi-task, Phase-4
       REQ-16.2 partial, Phase-4 REQ-16.5 ceiling sentence, Stage-1 REQ-4.2
       output-gate scope, Stage-1 REQ-4.1/4.6 single-output-file assertion
       — six items) in the §17 entry explicitly                               (ubiquitous)
- 7.3  THE SYSTEM SHALL note the recorded ceilings in §14/§17: task-level
       parallelism not built (sequential by design; Stage-2 REQ-4.2's
       "Stage 4: task workers" clause deliberately not exercised — A20),
       tasks.md<->task-graph drift check deferred (backlog, not silent),
       deploy + multi-task rejected at the planning gate (A12), and the
       planner-fusion graph piece reachable only from tests today (no
       production `planning` composition — A21, §16 claim discipline)         (ubiquitous)

## Findings log — /spec-analyze round 1 (fresh-context spec-architect, 2026-07-26)

Verdict ก่อนแก้: NEEDS-AMENDMENT → ทุก finding ถูก APPLY ในฉบับนี้:
- A1 per-task budget ไม่ reset (CRITICAL) → APPLIED: 4.12 + Overview "budget available"
- A2 mapped ACs ทั้งชุดต่อทุก task / Phase-2 REQ-7.2 ไม่ถูกประกาศ supersede (CRITICAL)
  → APPLIED: 4.13 + supersession list
- A3 นิยาม deps PASSED ขัดกันระหว่าง 4.1/4.4 (CRITICAL) → APPLIED: นิยามเดียวใน
  Overview, 4.1/4.4 อ้างเซตเดียวกัน
- A4 helper composition ไม่ scope ต่อ taskId → APPLIED: 4.14 + ข้อเท็จจริงจากโค้ด
- A5 graph↔contract binding เป็นโมฆะ (AC id ซ้ำข้าม feature) → APPLIED: `goal_id`
  ใน 1.1/2.1/3.14
- A6 ไม่มี event บังคับ (INV-10) → APPLIED: 4.8 (TASK_GRAPH_FROZEN/REJECTED), 3.9
  เขียนใหม่เป็น structured return
- A7 `Depends on:` grammar พังกับ spec จริง → APPLIED: 2.6 pin grammar + fixture
- A8 `T-<n>`/title ดึงจาก iter_task_blocks ตรง ๆ ไม่ได้ → APPLIED: 2.1 parse หัว
  block, 2.9 เพิ่ม fail paths
- A9 ไม่มีใคร resolve path graph → APPLIED: 4.10 (CLI/composition root), 4.2 key
  บน option
- A10 lease semantics ผิดข้อเท็จจริง + ตัวแปรไม่นิยาม → APPLIED: 4.6 เขียนใหม่
  (WHERE multi-task, ownerId=runId, TTL default 15m, claim-then-verify), 4.1 ตัด
  lease ออกจาก pure predicate
- A11 เกณฑ์ไม่ atomic → APPLIED: 3.5/3.10/3.11/3.12 แตก; 4.2/4.8/4.9 แตก
- A12 deploy ใน multi-task ไม่นิยาม → APPLIED: 3.13 reject + Overview + 7.3
- A13 รูปผลลัพธ์ระดับ run ไม่นิยาม → APPLIED: 4.11 (additive tasks[], precedence,
  NOT_STARTED/SKIPPED)
- A14 checks optional ทำ 3.7 ไม่นิยาม → APPLIED: 1.1 required + 3.7 ตัด fallback
- A15 output gate scope เปลี่ยนเงียบ → APPLIED: 2.5 per-file + ประกาศ supersede
  Stage-1 REQ-4.2
- A16 Satisfies dangling เงียบ → APPLIED: 2.8
- A17 max_total_tasks runtime predicate = dead code → APPLIED: ตัดจาก 4.1 (3.6
  เป็นผู้ตัด)
- A18 §17 "จุดเริ่ม" ค้าง → APPLIED: 7.1
- A19 "keys in the schema order" ตรวจไม่ได้ → APPLIED: 2.2 ระบุลำดับตรง
- A20 Stage-2 REQ-4.2 "task workers" clause ไม่ถูก exercise → APPLIED: 7.3
- A21 planner fusion reachable จาก test เท่านั้น → APPLIED: 7.3 (§16 claim
  discipline)

## Findings log — design review round 1 (fresh-context spec-architect, 2026-07-26)

Design audit (D1–D19) พลิกเกณฑ์ฝั่ง requirements เหล่านี้ — APPLIED ในฉบับนี้:
- D3 kill switch ต้องหยุด driver → เพิ่ม 4.15
- D4 "ineligible this round" นิยามไม่ได้ → 4.6 = permanently unselectable this run,
  label NOT_STARTED
- D5 double-freeze ไม่ซื่อสัตย์ → 4.2/4.8/4.10 freeze ครั้งเดียวใน run, CLI ทำ shape
  validation อย่างเดียว
- D6 lease TTL 15m กลับหัว (สั้นกว่า wallclock 30m) → 4.6 TTL = wallclock + 5m slack;
  `release(taskId, ownerId)` arity จริง
- D9/D10 result fields/precedence ไม่ครบ → 4.11 เพิ่ม iterations sum, calibration
  rule, CHANGES_REQUESTED/QUARANTINED→BLOCKED
- D11 excerpt ยังชุดเต็ม + "gates" clause ไม่มี consumer → 4.13 narrow excerpt,
  ตัด gates
- D12 projection ไม่มีขอบเขต run → 4.1 scope ที่ seq ของ TASK_GRAPH_FROZEN ของรันนี้
- D14 return shape approval targeting → 4.14 ใช้ `{ok:false, detail:'unknown_task'}`
- D15 risk re-check ใน selection เป็น dead branch → 4.1 ตัด (3.8 การันตี)
- D8 ที่อยู่ test แยก package → 6.1 ระบุ split
(ที่เหลือ D1/D2/D7/D13/D16/D17/D18/D19 เป็นการแก้ฝั่ง design.md — ดู findings log
ใน design.md)
