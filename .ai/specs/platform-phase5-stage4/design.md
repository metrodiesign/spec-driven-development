# Design: platform-phase5-stage4 — Task Graph + Planning Gate (§11.2)
> Status: approved 2026-07-26 (quick-mode per operator /goal directive — fresh-context
> spec-architect audit substituted the human gate; design-review round 1 findings
> D1–D19 applied; operator post-hoc review pending)

## Architecture Overview

เจ็ดชิ้น ตามลำดับ dependency — core ใหม่ทั้งหมดอยู่ใน `core/src/graph/` (vendor-free,
INV-7), การตัดสินใจ policy/semantics ทุกอย่างจบที่ freeze/selection ที่เป็น pure logic,
composition (`loop-run.ts`) เป็นแค่คนต่อสาย:

1. **D1 Schema** — `.ai/schemas/task-graph.schema.json` + embedded `TASK_GRAPH_SCHEMA`
   (`console/backend/src/task-graph-schema.ts`) + `validateTaskGraphShape` (ajv, edge
   เท่านั้น — core ไม่มี dep ใหม่) + deep-equal parity test.
2. **D2 Generator** — `scripts/spec_to_goal.py` โต 1 ฟังก์ชันกลุ่ม: parse หัว block
   (ordinal/title) + `Depends on:` grammar แคบ + validate refs สองทาง (2.6/2.8/2.9)
   + emit `task-graph.draft.json` (atomic, per-file `--force` gate).
3. **D3 Core graph module** — `core/src/graph/graph.ts` (typed `TaskGraph`,
   `freezeTaskGraph`, `TaskGraphGateError` โครงสร้าง reasons) + `core/src/graph/select.ts`
   (`DEP_SATISFIED_STATES`, `selectNextTask` pure) + co-located unit tests.
4. **D4 Multi-task composition** — `loop-run.ts` แตก per-task execution ออกเป็น
   closure ที่ parameterized ด้วย `taskId` (refactor เชิงกล, single-task = เรียกครั้งเดียว
   ด้วยค่าเดิม → พฤติกรรม/result shape byte-identical), เพิ่ม multi-task driver loop
   (freeze→event→select→lease→execute→release) + `loadTaskGraph` ใน `loop-cli.ts` +
   wiring ใน `bin/platform.ts`.
5. **D5 Planner fusion graph piece** — `runPlannerFusion` รับ optional graph piece;
   comment/`$comment` sweep 3 จุด (fusion.ts, plan.schema.json, contract.ts:20-25).
6. **D6 Fault-injection + calibration fixture** — pure-gate scenarios ใน `core/test/`,
   composition scenarios ใน `console/backend/src/` + fixture คู่ใน `.ai/calibration/`.
7. **D7 Constitution v1.7** — `unified-platform-spec.md` banner/§14/§17/จุดเริ่ม.

หลักการคุมทั้ง stage: **absent graph = ศูนย์ diff เชิงพฤติกรรม** — ทุกจุดแตะของ D4/D5
key บน option ที่มีค่าเฉพาะเมื่อ CLI พบ `task-graph.json` ที่ promote แล้ว; ไม่มี
filesystem probing ใน loop (REQ-4.2/4.10); test เดิมทุกไฟล์ต้องเขียวโดยไม่แก้ (REQ-4.3).

## Sequence Diagrams

```mermaid
sequenceDiagram
    participant CLI as bin/platform.ts
    participant Edge as loop-cli.ts (edge)
    participant Loop as runSupervisedLoop
    participant Core as core/src/graph
    participant Lease as createLeaseManager
    participant Task as executeTask(taskId)

    CLI->>Edge: loadGoalContract(goalPath)
    CLI->>Edge: loadTaskGraphOption(goalPath)
    Edge->>Edge: readFileSync + JSON.parse + validateTaskGraphShape (ajv)
    Edge-->>CLI: {rawBytes, parsed} | throw shape errors (มนุษย์เห็นก่อนเปิด run)
    CLI->>Loop: runSupervisedLoop({..., taskGraph: {rawBytes, parsed}})
    Loop->>Core: freezeTaskGraph(rawBytes, parsed, contract)  — ครั้งเดียว หลังเปิด log
    alt gate ผ่าน
        Loop->>Loop: append TASK_GRAPH_FROZEN {graphHash, taskIds}
    else gate ตก
        Loop->>Loop: append TASK_GRAPH_REJECTED {reasons} → return BLOCKED (ก่อนสร้าง adapter)
    end
    loop จน kill หรือไม่มี eligible
        Loop->>Loop: poll kill switch — kill = break, ที่เหลือ NOT_STARTED, run CANCELLED
        Loop->>Core: selectNextTask(graph, projection)
        Core-->>Loop: task | null (null = จบ run)
        Loop->>Lease: claim(task.id, RUN_ID, ttlMs)
        alt claim ok
            Loop->>Loop: branch hygiene: checkout main → reset --hard → clean -fd → checkout -b task/<id>
            Loop->>Task: executeTask(task) — fresh budget, excerpt/ACs = satisfies
            Task-->>Loop: per-task finalState (worktree/gates/approval เดิมทั้งชุด)
            Loop->>Lease: release(task.id, RUN_ID)
        else held, unexpired
            Loop->>Loop: mark unselectable ตลอด run นี้ (fold เข้า projection.started) → NOT_STARTED
        end
    end
    Loop-->>CLI: result + tasks[] (multi-task only) → CLI พิมพ์ per-task summary
```

**Single-freeze (D5):** CLI ไม่ freeze — ajv shape validation เท่านั้น (ผิด shape =
มนุษย์เห็น error ก่อน run เปิด). Composition freeze ครั้งเดียวหลังเปิด event log →
`TASK_GRAPH_FROZEN`/`TASK_GRAPH_REJECTED` ทั้งสองเส้นอยู่บน production path จริง
(REQ-4.8) — fault-injection TG#1/TG#2 พิสูจน์เส้นจริง ไม่ใช่ test-only path.

## D1 Schema (governance + embedded + edge validation)

- `.ai/schemas/task-graph.schema.json` — draft-07, `$id: "task-graph.schema.json"`,
  `$comment` อ้าง §11.2 + stage นี้ + ประกาศ embedded copy ต้อง deep-equal.
  Top-level `required: ["goal_id", "tasks", "checks"]`, `additionalProperties: false`:
  - `goal_id`: `{ "type": "string", "minLength": 1 }`
  - `tasks`: `{ "type": "array", "minItems": 1, "items": {...} }` — item
    `required: ["id", "title", "satisfies"]`, `additionalProperties: false`:
    `id` string minLength 1 + `pattern` `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
    (branch-safe charset — id กลายเป็น branch `task/<id>`; `depends_on` items ใช้
    pattern เดียวกันเพราะมันชี้ไปที่ id, Codex P2 PR #124) · `title` string
    minLength 1 · `satisfies` array ของ string minLength 1
    (array ว่างได้ — orphan ตัดสินที่ freeze ไม่ใช่ shape) · `depends_on` array ของ
    string minLength 1 · `enabling` boolean · `risk` enum `["L0","L1","L2","L3","L4"]`
    · `diff_budget` integer minimum 1
  - `checks`: `required: ["max_diff_budget_per_task"]`, `additionalProperties: false`,
    `max_diff_budget_per_task` integer minimum 1
- `console/backend/src/task-graph-schema.ts` — `export const TASK_GRAPH_SCHEMA` (copy
  byte-equivalent) + `validateTaskGraphShape(parsed): string[]` (ajv `allErrors: true`,
  ข้อความ `instancePath: message` — สไตล์เดียวกับ `validateGoalShape` ใน
  `goal-schema.ts:163-173`; ajv instance ของไฟล์ตัวเอง ไม่แตะของ goal)
- Parity test ใน `task-graph-schema.test.ts` อ่าน governance จากดิสก์ +
  `assert.deepStrictEqual` (pattern `goal-schema.test.ts:29-34`) + shape cases ตาม
  REQ-1.3/1.4/1.5 (conforming ผ่าน, unknown key ทุกชั้น reject พร้อม path, tasks
  ว่าง/หาย reject)

## D2 Generator task-graph emission

ทุกอย่างอยู่ใน `scripts/spec_to_goal.py` (stdlib-only เช่นเดิม, ไม่มี PyYAML):

- **Parse หัว block (REQ-2.1/2.9):** `TASK_HEAD_RE =
  re.compile(r"^\s*- \[[ x]\]\s*(\d+)\.\s*")` วิ่งบนสตริง block จาก
  `spec_trace.iter_task_blocks` — รองรับ checkbox ที่ indent (iter_task_blocks รับ
  ผ่าน `lstrip` — D13); ไม่ match → `fail()` พร้อม 60 ตัวอักษรแรกของ block; ordinal
  ซ้ำ → `fail()`. `title` = ข้อความหลัง match จนถึงตำแหน่ง match แรกของ `MARKER_RE`
  (มีอยู่แล้ว `:31`) — block ที่ไม่มี marker เลย: title = ส่วนที่เหลือทั้งหมด (D13) —
  `.strip()` แล้ว truncate 120.
- **`Depends on:` grammar (REQ-2.6):** ทุก occurrence ของ marker ในบล็อก: match
  `\s*(\d+(?:\s*,\s*\d+)*)` ที่ตำแหน่งถัดไปทันที — run แรกต่อ occurrence, อักขระแรกที่
  ไม่เข้ารูปตัดจบ (prose/วงเล็บ/`.` ถูกทิ้ง), union ผลทุก occurrence (แบบเดียวกับ
  `Satisfies:` — marker ที่ถูก quote ใน prose คืนว่าง ไม่กลืนตัวจริง) → refs =
  `{T-<m>}`; ref ที่ไม่มี block → `fail()`.
  Test fixture pin บรรทัดจริง `Depends on: 1 (เฉพาะความครบของ 6.2/6.3 — โค้ด core
  ไม่ import อะไรจาก task 1).` → deps = `["T-1"]` เท่านั้น.
- **Validate `Satisfies:` (REQ-2.8):** หลัง `expand_refs` ตรวจทุก `(major, minor)`
  กับเซต criterion จริงจาก `parse_requirements` (มีอยู่ในมือ `main()` แล้ว) — id
  นอกเซต → `fail()` (symmetry กับ 2.6).
- **Emit (REQ-2.1/2.2/2.3):** dict ตามลำดับ key ที่ pin ไว้ (`goal_id, tasks, checks`;
  task: `id, title, satisfies, depends_on` — omit `depends_on` เมื่อว่าง) →
  `json.dumps(indent=2)` + `"\n"` → เขียน atomic ผ่าน temp + `os.replace` (path
  helper เดิม `:274-287`). `goal_id` = ค่าเดียวกับที่ goal draft stamp.
- **Per-file output gate (REQ-2.5, D17):** เช็ค exists แยกไฟล์ — เขียนไฟล์ที่เขียนได้,
  refuse ไฟล์ที่ชนด้วยข้อความ refusal เดิมของไฟล์นั้น แล้วจบ `exit 1`; `--force`
  เขียนทับทั้งคู่. `tasks.md` absent → warn + ข้าม graph (REQ-2.4, โค้ด warn เดิม
  `:234-240` ขยาย).
- **Pre-flight ต่อ spec เดิม (D18):** REQ-2.8/2.9 ทำให้ generator เข้มขึ้นกับ input
  ที่เคยผ่านเงียบ — e2e เพิ่ม case กวาดรัน generator (โหมด dry ใน temp dir) กับทุก
  `.ai/specs/*` ที่ `Status: approved` + มี tasks.md แล้ว assert ว่าไม่มี spec จริง
  ตัวไหน fail ด้วยกติกาใหม่ (เจอ = แก้ spec นั้นใน PR นี้ ไม่ลด validation)
- Tests: ขยาย `console/backend/src/spec-to-goal.e2e.test.ts` (spawn จริงตาม convention
  เดิม) — happy 3-task + deps, grammar fixture (A7), indented-checkbox fixture (D13),
  dangling dep, dangling satisfies, missing ordinal, duplicate ordinal, per-file gate,
  `--force`, tasks.md absent, pre-flight sweep, draft ผ่าน `validateTaskGraphShape` +
  `freezeTaskGraph` จริงจาก core (assert ด้วยของจริง ไม่ mock — convention ไฟล์นี้)

## D3 Core graph module (freeze + selection)

`core/src/graph/graph.ts` (ใหม่ — ภาษากลางล้วน, ห้าม vendor name แม้ใน comment):

```ts
export interface TaskGraphTask {
  id: string; title: string; satisfies: string[]; dependsOn: string[];
  enabling: boolean;              // default false
  risk: RiskClass;                // EFFECTIVE — freeze resolve จาก task.risk ?? contract.risk (D15)
  diffBudget: number;             // EFFECTIVE — freeze resolve จาก diff_budget ?? checks (D15)
}
export interface TaskGraph {
  goalId: string; tasks: TaskGraphTask[];
  checks: { maxDiffBudgetPerTask: number };
  graphHash: string;              // sha256 hex ของ raw bytes (INV-10)
}
export interface TaskGraphGateResult {   // เดินทางกับ frozen graph (REQ-3.9)
  graphHash: string; taskIds: string[];
  uncoveredAcs: string[]; orphanTasks: string[];   // ว่างเสมอเมื่อผ่าน
}
export class TaskGraphGateError extends Error {
  constructor(readonly reasons: string[]) { ... }  // ทุก violation รวบครบก่อน throw
}
export function freezeTaskGraph(rawBytes: Uint8Array, parsed: unknown,
  contract: TaskContract): { graph: TaskGraph; gate: TaskGraphGateResult }
```

- **Effective values bake ที่ freeze (D15):** frozen graph ไม่มี field optional —
  `risk`/`diffBudget` ถูก resolve เป็นค่า effective ตอน freeze หลังตรวจ 3.7/3.8 →
  selection/driver อ่านตรง ไม่ต้องรู้จัก contract; risk ไม่ใช่ input ของ selection
  (3.8 การันตีแล้ว — REQ-4.1)
- `RiskClass` import จาก `core/src/human/approval.ts` — ring เดียวกัน (INV-7 ผ่าน)

ลำดับตรวจใน `freezeTaskGraph` (รวบทุก violation ลง `reasons[]` แล้ว throw ครั้งเดียว —
คนแก้เห็นครบ; ต่างจาก `freezeContract` ที่ fail-fast โดยบันทึกเหตุผลไว้ใน comment):
structural re-check ขั้นต่ำ (เชื่อ ajv ที่ edge แต่ freeze ต้อง standalone ได้ —
fault-injection เรียกตรง) → 3.11 duplicate id → 3.15 branch-safe id (charset เดียว
กับ schema + `..` + `.lock` suffix ที่ charset เขียนไม่ได้ — Codex P2 PR #124) →
3.14 goal_id ↔ `contract.goal.id` →
3.2 unknown AC ids → 3.3 uncovered ACs → 3.4 orphans (`satisfies` ว่าง +
`enabling !== true`) → 3.5 unknown dep / 3.10 self-dep → 3.12 cycle (Kahn — เขียนเอง
~15 บรรทัด, ไม่มี dep ใหม่) → 3.6 `tasks.length > contract.budget.maxTotalTasks` →
3.7 `diff_budget > checks.maxDiffBudgetPerTask` → 3.8 task risk เกิน contract risk
(เทียบ index บนลิสต์ `['L0'..'L4']`) → 3.13 `contract.deploy` มีอยู่ → reject.
ผ่านหมด → คืน graph frozen (effective values baked) + gate result (arrays ว่าง).

**Event types ใหม่ (D7):** เพิ่ม `TASK_GRAPH_FROZEN` + `TASK_GRAPH_REJECTED` เข้า
`EventType` union ใน `core/src/types.ts` พร้อม comment block "Phase 5 stage-4
(append-only, INV-10)" ตาม precedent ของ stage ก่อน — ไม่มี union นี้ typecheck
ของ composition ไม่ผ่าน.

`core/src/graph/select.ts`:

```ts
export const DEP_SATISFIED_STATES: ReadonlySet<string> =
  new Set(['PASSED','REVIEWING','APPROVED','MERGE_QUEUED','AUDITED','COMPLETED']);
export interface TaskProjection { latestState(taskId: string): string | undefined;
  started(taskId: string): boolean; }
export function selectNextTask(graph: TaskGraph, proj: TaskProjection):
  TaskGraphTask | null
```

- eligible = `!proj.started(id)` ∧ ทุก dep: `DEP_SATISFIED_STATES.has(latestState(dep))`
  — แค่สองเงื่อนไข (risk จบที่ freeze — D15; lease/budget ไม่ใช่ input — REQ-4.1)
- คืนตัวแรกตามลำดับใน `graph.tasks` (file order — deterministic tie-break); ไม่มี
  eligible → `null`
- **Projection เป็นของ composition (D12/D19):** ไม่มี helper ใน core — composition
  สร้าง object literal implement `TaskProjection` จาก event log โดย **scope ที่
  `seq >= seq ของ TASK_GRAPH_FROZEN ที่รันนี้เพิ่ง append เอง`** (ตัวเลขเดียว จำไว้
  ตอน append — log เดิมที่ reuse ข้าม run จะมี FROZEN ซ้ำหลายตัวเป็นเรื่องปกติของ
  append-only; อ่านเฉพาะช่วงของตัวเอง) และ `started(id)` = มี TASK_STATE ในช่วงนั้น
  ∨ `unselectable.has(id)` (lease-fail fold เข้าที่นี่ — D4)

Unit tests co-located (`graph.test.ts`, `select.test.ts`): ทุกกิ่ง reject ราย criterion
+ ผ่าน happy + selection ordering/dep/started cases (test เขียน projection literal
เอง). ห้ามใช้คำ vendor ใน comment (lesson #vendor-scan-includes-comments).

## D4 Multi-task composition (loop-run + CLI)

การแตะ `runSupervisedLoop` แบ่งสองชั้นจงใจ ให้ task แรก (mechanical) พิสูจน์
zero-behavior-change ก่อนชั้นที่สองเพิ่มโหมดใหม่:

### ชั้น 1 — parameterize (ไม่มีพฤติกรรมใหม่)

**ขอบเขต per-run vs per-task ระบุตายตัว (D2 ของ review):**

- **per-run (สร้างครั้งเดียว อยู่นอก `executeTask` เสมอ):** `fx`, `log`, `evidence`,
  `adapter` + `reg` + `breaker` + `router` + `roundStats` (`:421-452`), `controller`
  (`:515`), `guidanceQueue`, `approvals` Map + `createHumanPlaneServer` (`:646-679`),
  `audit`, `ids`, `shadowProof`, planner fusion block (`:471-484`), lease manager
  (ชั้น 2)
- **per-task (ย้าย/สร้างใน `executeTask(task)`):** branch hygiene + `TASK_BRANCH`,
  `budget` (`createBudget` — ย้ายจาก `:430` เข้า executeTask; single-task เรียก
  ครั้งเดียว = เท่าเดิม, REQ-4.12), `source`, `executor`, `gates`, `runTaskLoop`,
  auto-merge / approval / escalate (`:786-795`) / deferred-quarantine early-return
  (`:405-416` — ย้ายเข้า executeTask ต่อ taskId), `mappedAcs` + `taskContractExcerpt`
  ต่อ task (D11), deploy stage (`:850-913` — single-task เท่านั้น; multi-task ไม่มีวัน
  ถึงเพราะ 3.13 reject contract ที่มี deploy ตั้งแต่ freeze)
- **literal `'T-1'`/`'RUN-LIVE'` ที่ hardcode ในสาย per-run และต้องเปลี่ยนเป็น
  getter:** breaker log callback `:425`, `exploreKey` + outcome/shadow wrapper
  `:445-448`, `:486-487`, human-plane handler `:684-685`, `:695-696`, `:700` —
  closure ระดับ run พวกนี้ต้องอ่าน `activeTaskId()` (getter ที่ driver อัปเดตก่อน
  execute แต่ละ task) ไม่ใช่ค่าที่ bind ตอนสร้าง; single-task: `activeTaskId()`
  คืน `'T-1'` ตลอด → พฤติกรรม/payload byte-identical
- **Definition of done ของชั้นนี้:** ทุก test เดิมเขียว **โดยไม่แก้ไฟล์ test แม้บรรทัด
  เดียว** (REQ-4.3)

### ชั้น 2 — multi-task driver

`opts.taskGraph?: { rawBytes: Uint8Array; parsed: unknown }` + `opts.leaseTtlMs?:
number` (default = `contract.budget.maxWallclockPerTaskMin * 60_000 + 5 * 60_000` —
lease ที่ไม่ renew มีอายุยาวกว่า task ที่ถูกกฎหมายเสมอ, D6). เมื่อ option มี:

1. **Freeze ครั้งเดียว (REQ-4.8, D5):** หลัง `openEventLog` ก่อนสร้าง adapter:
   `try { ({graph, gate} = freezeTaskGraph(...)) } catch (e: TaskGraphGateError) {
   log.append(TASK_GRAPH_REJECTED {reasons: e.reasons}); return {finalState:'BLOCKED',
   iterations: 0, tasks: [ทุก id → NOT_STARTED], ...} }` — ผ่าน → append
   `TASK_GRAPH_FROZEN {graphHash, taskIds}` แล้วจำ `frozenSeq` ไว้ scope projection
2. `const leaseOwner = `${RUN_ID}#${randomUUID()}`` (owner ต่อ invocation — CAS ใน
   `lease.ts` ยอมให้ owner เดิม reclaim lease ตัวเอง ดังนั้นสอง run ที่แชร์ persistDir
   ภายใต้ owner เดียวกันจะขโมย task ของกันเอง, Codex P1 PR #124; RUN_ID ยังเป็น
   identity ของ event log ตามเดิม) +
   `const lease = createLeaseManager(join(stateDir,'events.db'), clock, RUN_ID)` —
   db เดียวกับ event log (ตาราง `leases` อยู่ใน schema เดียวกันแล้ว)
3. **Driver:**
   ```
   const unselectable = new Set<string>();
   for (;;) {
     if (controller.port.poll() === 'kill') break;          // REQ-4.15 (D3)
     const t = selectNextTask(graph, projection);           // projection: seq>=frozenSeq + unselectable
     if (!t) break;
     if (!lease.claim(t.id, leaseOwner, ttl)) { unselectable.add(t.id); continue; }  // D4
     activeTask = t.id;
     branchHygiene(t.id);                                    // D1 (ล่าง)
     try { executeTask(t); } finally { lease.release(t.id, leaseOwner); }  // arity จริง (D6)
   }
   ```
4. **Branch hygiene ก่อนทุก task (D1):** `git checkout -q main` →
   `git reset -q --hard main` → `git clean -qfd` → `git checkout -q -b task/<id>` —
   เส้น approval-package จบที่ REVIEWING โดย worktree ค้างบน branch เก่า + อาจมีไฟล์
   ไม่ commit; ไม่มีขั้นนี้ diff ของ task ถัดไป (`git diff main...task/<id>` `:764`)
   จะรวมงานของ task ก่อน → diff budget/approval ผิดหมด. fixture เป็น throwaway —
   reset hard ปลอดภัยโดยนิยาม
5. **Per-task wiring ใน `executeTask(t)`:** fresh `createBudget(contract.budget,
   clock)` (REQ-4.12) · `mappedAcs = contract.acceptanceCriteria.filter(a =>
   t.satisfies.includes(a.id))` ใช้ทั้งใน `taskContractExcerpt` ต่อ task (D11 — agent
   ไม่ถูกเชิญทำ AC ของ task อื่น), เส้น auto-merge (`:733-736`), approval `acIds`
   (`:771`) · `maxDiffBudget = t.diffBudget` (effective จาก freeze — REQ-4.5) ·
   `enabling` task → `mappedAcs = []` → เข้าเส้น approval-package เสมอ (พฤติกรรม
   0-golden เดิมของ `auto-merge.ts:97`)
6. **Approval targeting (REQ-4.14, D14):** `approvals` Map ผูก package กับ taskId;
   `onDecision(taskId, ...)` ที่ระบุ task ที่ไม่มี package pending → คืน
   `{ok: false, detail: 'unknown_task'}` (shape เดิมของ `HandlerDeps` —
   `core/src/human/api.ts:34` — ไม่แก้ core port); steering/inject ผูกกับ
   `activeTaskId()` (sequential — มีตัวเดียวเสมอ)
7. **Result (REQ-4.11, D9/D10):** `tasks: [{id, finalState, iterations}]` เรียงตาม
   graph order — executed = state จริง; ไม่ถูกเลือก: dep จบนอกเซต → `SKIPPED`,
   lease-fail/kill/run จบก่อนคิว → `NOT_STARTED`. Run-level: `finalState` precedence
   CANCELLED > ESCALATED > BLOCKED > REVIEWING > COMPLETED โดย
   SKIPPED/NOT_STARTED/CHANGES_REQUESTED/QUARANTINED นับเป็น BLOCKED;
   `iterations` = Σ ของ executed tasks; `calibration =
   computeCalibration({heldOut: executed.map(reachedReviewing), reruns: [...]})`
   — field `tasks` มีเฉพาะโหมดนี้ (single-task shape byte-identical)

### CLI (REQ-4.10)

`loop-cli.ts` เพิ่ม `loadTaskGraphOption(goalPath)`: `task-graph.json` ข้าง
`goal.yaml` — ไม่มีไฟล์ → `undefined` (draft ถูกเมินโดย construction — REQ-4.7);
มี → read bytes → `JSON.parse` → `validateTaskGraphShape` (throw รวม error — มนุษย์
เห็นก่อน run เปิด) → คืน `{rawBytes, parsed}`. `bin/platform.ts` ส่งเป็น `taskGraph`
option + เมื่อ `result.tasks` มี → พิมพ์ตาราง per-task summary ต่อจาก
`result.finalState` เดิม.

## D5 Planner fusion graph piece

- `PlannerFusionOptions` เพิ่ม `taskGraphJson?: string` — เมื่อ composition อยู่ใน
  multi-task mode ส่ง `JSON.stringify({goalId, tasks, checks, graphHash})`;
  base request สร้าง piece จริงตาม `ContextPiece` type (`core/src/types.ts:198-205`,
  D16): `{ id: 'task-graph', kind: 'contract', content: json, reason: 'task_graph' }`
  → `contextBundle = { pieces: [piece], canaryToken, stats: { bytes: json.length,
  pieceCount: 1 } }` — `kind: 'contract'` เป็น pathless kind ตาม
  `.ai/policies/provider-data-policy.json:3`; piece นี้ไม่ผ่าน GOVERN secret-scan
  ของ context builder (ยอมรับได้: graph เป็น artifact ที่มนุษย์ promote — บันทึกไว้
  ใน comment); single-task = empty bundle เดิม byte-identical (REQ-5.1/5.2)
- Plan ยัง advisory: ไม่มีการแตะ resolve/validate path (REQ-5.3)
- `panelSize` ของ `PLAN_RESOLVED` อ่านจาก `FusionOutcome.panelSize` ที่ `runFusion`
  คืนมา (0 เมื่อ escalate ก่อนตั้ง panel) — log-scan หา FUSION_PANEL ตัวท้ายถูกลบทิ้ง
  เพราะบน log ที่ persist มันหยิบ panel ของ call ก่อนหน้ามารายงานเมื่อ call ปัจจุบัน
  ไม่ได้ append เลย (Codex P2 review PR #124)
- Comment sweep (REQ-5.4): `fusion.ts:173-185` doc comment + `:193-195` bundle
  comment เขียนใหม่เป็น "planning gate ตรวจ graph ที่ freeze แล้ว (§11.2); plan ยัง
  advisory" · `.ai/schemas/plan.schema.json` `$comment` ประโยคเพดานเดิมแทนด้วยคำ
  บรรยาย delivered mechanism · `contract.ts:20-25` deferral comment → pointer ไป
  `core/src/graph/` (3.6) — `PLAN_SCHEMA` shape ไม่เปลี่ยน → parity test เขียวเอง

## D6 Fault-injection + calibration fixture

Split ตาม package reality (D8 — `core/test` import จาก `console/` ไม่ได้):

- **Pure-gate halves — `core/test/task-graph.fault-injection.test.ts`:**
  - `TG#1a (REQ-6.1)`: graph ที่ AC หนึ่งไม่มี task รองรับ → `freezeTaskGraph` throw
    `TaskGraphGateError` ที่ reasons มี uncovered id
  - `TG#2a (REQ-6.2)`: orphan (satisfies ว่าง ไม่มี enabling) → throw พร้อม orphan id
- **Composition halves — `console/backend/src/loop-run-graph.fault-injection.test.ts`:**
  - `TG#1b/2b (REQ-6.1/6.2)`: ประกอบผ่าน `runSupervisedLoop` + taskGraph option ที่
    ตกเกณฑ์ → `TASK_GRAPH_REJECTED` ใน log, `finalState: 'BLOCKED'`, และไม่มี
    `ACTION_INTENT`/dispatch event ใดตามมา (เส้น production จริง — D5)
  - `TG#3 (REQ-6.3)`: A←B: stub adapter/source บันทึกอะไรไม่พอ — assert จาก event log
    ว่า TASK_STATE แรกของ B เกิดหลัง A ถึง PASSED (ลำดับ seq)
  - `TG#4 (REQ-6.4)`: 3 tasks (T-2 dep T-1, T-3 dep T-2); stub โกหก
    READY_FOR_VERIFICATION ที่ T-2 โดยไม่แก้ target file → core รัน gate เอง → T-2
    ไม่มีวัน PASSED, T-3 = `SKIPPED`, run precedence ตามเส้นที่ T-2 จบ
  - Branch isolation (D1): 2 tasks แตะคนละไฟล์ ทั้งคู่ถึง REVIEWING → assert diff
    ของ approval package task 2 ไม่มีไฟล์ของ task 1
- fixture: แผนเดิม (ขยาย `makeFixture` ต่อ task) ถูกแทนตอน implement — composition
  ไม่ได้ใช้ helper นั้น (`runSupervisedLoop` สร้าง fixture เองผ่าน `makeFixtureRepo()`
  และ core/test ↔ console import ข้ามกันไม่ได้ตาม D8) → per-task behavior inject ผ่าน
  scripted adapter แทน และ assert จาก diff bytes ใน evidence store จริง (amended
  during task 5, recorded in its Evidence)
- Calibration fixtures: `.ai/calibration/fixture-goal-graph.yaml` (ไม่มี `deploy:` —
  3.13; `max_total_tasks` ≥ จำนวน task) + `.ai/calibration/fixture-task-graph.json`
  (2 tasks, T-2 dep T-1, ครอบทุก AC, `goal_id` ตรง) — ผ่าน `freezeTaskGraph` จริง
- `console/backend/src/loop-run-graph.test.ts` (ใหม่): ขับ `runSupervisedLoop` ด้วย
  fixture คู่นี้ + Fake adapter ที่ทำงานถูก → ทั้ง 2 task ถึง REVIEWING (REQ-6.5);
  + case single-task regression (ไม่มี option → result ไม่มี `tasks` field, shape เดิม);
  + wiring tests ค่า non-default: budget fresh (`max_iterations_per_task` ต่ำ —
  task 2 ไม่โดนหนี้ task 1), lease TTL option, AC mapping (golden ของ AC นอก
  satisfies ไม่ถูกใช้ตัดสิน auto-merge ของ task), approval targeting
  `{ok:false, detail:'unknown_task'}`, kill ระหว่าง task → ที่เหลือ NOT_STARTED +
  run CANCELLED (REQ-4.15)

## D7 Constitution v1.7

แก้ `unified-platform-spec.md` 4 จุดใน PR เดียวกัน (REQ-7.1/7.2/7.3): banner v1.7 ·
§14 Stage-4 → "ส่งมอบแล้ว (spec: `.ai/specs/platform-phase5-stage4/`)" + ceilings ·
§17 changelog v1.7 (shape + supersessions 6 รายการ + ceilings 4 รายการ) · §17
"จุดเริ่ม" → ชี้ Stage 5 (Evidence backflow) เป็นงานถัดไป.

## Technology Decisions

| เรื่อง | เลือก | เหตุผล |
|---|---|---|
| รูปแบบไฟล์ graph | JSON (ไม่ใช่ YAML) | python stdlib `json` + TS `JSON.parse` — ศูนย์ dep ใหม่ทั้งสองฝั่ง; §14 layout ระบุ `task-graph.json` อยู่แล้ว |
| Edge validation | ajv เฉพาะ console (embedded schema + parity) | pattern goal.schema เดิมเป๊ะ; core ห้ามมี dep (INV-7) |
| Freeze site | ครั้งเดียว ใน run หลังเปิด log (CLI = shape only) | REJECTED ต้องอยู่บนเส้น production (D5); pure function บน bytes เดิมให้ผลเดิม |
| Semantic gate | hand-rolled ใน `freezeTaskGraph` รวบทุก reason | คนแก้เห็น violation ครบใน pass เดียว (ต่างจาก freezeContract ที่ fail-fast — บันทึกเหตุผลใน comment) |
| Cycle detection | Kahn's algorithm เขียนเอง | ~15 บรรทัด stdlib; dep ใหม่ไม่คุ้ม |
| Effective values | bake `risk`/`diffBudget` ตอน freeze | selection/driver ไม่ต้องรู้จัก contract; ไม่มีกิ่ง fallback ให้ diverge (D15) |
| Event union | เพิ่ม 2 type ใน `core/src/types.ts` | append ต้อง typecheck ผ่าน (D7); precedent stage ก่อน |
| Lease | `createLeaseManager` เดิมบน `events.db` เดียวกัน | ตาราง `leases` อยู่ใน schema เดียวกันแล้ว; CAS พิสูจน์แล้วใน DoD#8 |
| Lease TTL | default = `max_wallclock_per_task_min` + 5 นาที slack | lease ที่ไม่ renew ต้องอายุยาวกว่า task ที่ถูกกฎหมายเสมอ (D6 — 15 นาทีเดิมกลับหัว); ไม่มี renew/janitor ใน stage นี้ (sequential) |
| Multi-task parallelism | sequential เท่านั้น | single-threaded controller เดิม; parallel = ceiling บันทึกใน 7.3 |
| Result shape | additive `tasks[]` เฉพาะโหมดใหม่ | ห้ามแตะ shape เดิม (REQ-4.3/4.11) — เทสต์เก่า assert deep shape |

## Testing Strategy

- Pure ก่อน (pure-logic-first): `graph.test.ts`/`select.test.ts` ปิดทุกกิ่งของ REQ-3
  + 4.1 ก่อนแตะ composition (test เขียน projection object literal เอง — ไม่มี helper
  ใน core, D19)
- Composition: `loop-run-graph.test.ts` + `loop-run-graph.fault-injection.test.ts`
  (Fake adapter, in-process) — driver loop, branch hygiene isolation (D1), lease,
  budget-fresh non-default (lesson #wiring-test-nondefault-value), AC mapping,
  approval targeting, kill switch (4.15), result shape ทั้งสองโหมด
- e2e: generator cases + pre-flight sweep (D18) ใน `spec-to-goal.e2e.test.ts`
  (spawn python จริง)
- Fault-injection: D6 split — pure ใน core, composition ใน console (D8)
- Regression ศูนย์แตะ: suite เดิมทั้งหมดต้องเขียว **โดยไม่แก้ไฟล์ test เดิมแม้บรรทัดเดียว**
  — ถ้าพบว่าต้องแก้ = ชั้น 1 ของ D4 รั่ว ให้หยุดแล้วทบทวน design
- Lint/typecheck: `pnpm typecheck` + `pnpm lint` ทั้ง workspace ทุก task

## Requirement Traceability

| Design element | REQ | Section |
|---|---|---|
| governance schema ครบ field + required checks/goal_id + branch-safe id pattern | 1.1 | D1 Schema (governance + embedded + edge validation) |
| branch-safe charset ที่ edge (ครึ่งหนึ่งของกติกา, อีกครึ่งอยู่ที่ freeze) | 3.15 | D1 Schema (governance + embedded + edge validation) |
| embedded `TASK_GRAPH_SCHEMA` + deep-equal parity | 1.2 | D1 Schema (governance + embedded + edge validation) |
| `validateTaskGraphShape` accept/reject + failing path | 1.3, 1.4, 1.5 | D1 Schema (governance + embedded + edge validation) |
| emit ต่อ task block: ordinal id, title, satisfies, deps, goal_id | 2.1 | D2 Generator task-graph emission |
| JSON layout + key order + omit deps ว่าง | 2.2 | D2 Generator task-graph emission |
| stamp checks 400 | 2.3 | D2 Generator task-graph emission |
| tasks.md absent → warn + goal ต่อ | 2.4 | D2 Generator task-graph emission |
| per-file output gate + `--force` ทั้งคู่ + exit 1 | 2.5 | D2 Generator task-graph emission |
| `Depends on:` grammar แคบ + dangling → fail | 2.6 | D2 Generator task-graph emission |
| ไม่มี auto-promotion | 2.7 | D2 Generator task-graph emission |
| dangling `Satisfies:` → fail + pre-flight sweep | 2.8 | D2 Generator task-graph emission |
| ordinal หาย/ซ้ำ → fail (รวม indented checkbox) | 2.9 | D2 Generator task-graph emission |
| typed TaskGraph + freezeTaskGraph + sha256 + effective bake | 3.1 | D3 Core graph module (freeze + selection) |
| unknown AC / uncovered / orphan | 3.2, 3.3, 3.4 | D3 Core graph module (freeze + selection) |
| unknown dep / self-dep / duplicate id / cycle | 3.5, 3.10, 3.11, 3.12 | D3 Core graph module (freeze + selection) |
| max_total_tasks consumer | 3.6 | D3 Core graph module (freeze + selection) |
| diff budget ceiling + effective default | 3.7 | D3 Core graph module (freeze + selection) |
| task risk ≤ contract risk | 3.8 | D3 Core graph module (freeze + selection) |
| structured gate result เดินทางกับ frozen graph | 3.9 | D3 Core graph module (freeze + selection) |
| deploy + graph → reject | 3.13 | D3 Core graph module (freeze + selection) |
| goal_id binding | 3.14 | D3 Core graph module (freeze + selection) |
| branch-safe task id (charset ที่ edge + `..`/`.lock` ที่ freeze) | 3.15 | D3 Core graph module (freeze + selection) |
| `selectNextTask` pure + dep set + run-scoped projection + tie-break | 4.1 | D3 Core graph module (freeze + selection) |
| mode keys บน option {rawBytes, parsed} | 4.2 | D4 Multi-task composition (loop-run + CLI) |
| absent = byte-identical เดิม | 4.3 | D4 Multi-task composition (loop-run + CLI) |
| dependent ไม่ถูกเลือก + run จบเมื่อไม่มี eligible | 4.4 | D4 Multi-task composition (loop-run + CLI) |
| maxDiffBudget จาก graph (effective) | 4.5 | D4 Multi-task composition (loop-run + CLI) |
| lease claim/release arity + TTL wallclock+slack + claim-fail unselectable | 4.6 | D4 Multi-task composition (loop-run + CLI) |
| draft ถูกเมิน | 4.7 | D4 Multi-task composition (loop-run + CLI) |
| single freeze ใน run + FROZEN/REJECTED บนเส้น production | 4.8 | D4 Multi-task composition (loop-run + CLI) |
| driver loop sequential | 4.9 | D4 Multi-task composition (loop-run + CLI) |
| CLI shape-validate + ส่ง {rawBytes, parsed} + per-task summary | 4.10 | D4 Multi-task composition (loop-run + CLI) |
| result additive tasks[] + precedence + labels + iterations/calibration | 4.11 | D4 Multi-task composition (loop-run + CLI) |
| budget fresh ต่อ task | 4.12 | D4 Multi-task composition (loop-run + CLI) |
| mapped ACs = satisfies (excerpt + auto-merge + approval) | 4.13 | D4 Multi-task composition (loop-run + CLI) |
| taskId-scoped state + approval targeting shape เดิม | 4.14 | D4 Multi-task composition (loop-run + CLI) |
| kill switch หยุด driver + NOT_STARTED + CANCELLED | 4.15 | D4 Multi-task composition (loop-run + CLI) |
| graph piece MARKed เข้า planner bundle (ContextPiece จริง) | 5.1 | D5 Planner fusion graph piece |
| single-task bundle ว่างเดิม | 5.2 | D5 Planner fusion graph piece |
| plan ยัง advisory | 5.3 | D5 Planner fusion graph piece |
| comment sweep 3 จุด + parity เขียว | 5.4 | D5 Planner fusion graph piece |
| TG#1a/1b uncovered block ก่อน dispatch | 6.1 | D6 Fault-injection + calibration fixture |
| TG#2a/2b orphan block | 6.2 | D6 Fault-injection + calibration fixture |
| TG#3 dep ordering จาก event log | 6.3 | D6 Fault-injection + calibration fixture |
| TG#4 fake-green ต่อ task + dependents SKIPPED | 6.4 | D6 Fault-injection + calibration fixture |
| calibration fixture คู่ + 2-task ถึง REVIEWING | 6.5 | D6 Fault-injection + calibration fixture |
| banner/§14/§17/จุดเริ่ม | 7.1 | D7 Constitution v1.7 |
| supersessions 5 รายการใน §17 | 7.2 | D7 Constitution v1.7 |
| ceilings 4 รายการ | 7.3 | D7 Constitution v1.7 |

## Findings log — design review round 1 (fresh-context spec-architect, 2026-07-26)

Verdict ก่อนแก้: NEEDS-AMENDMENT → APPLIED ทั้งหมดในฉบับนี้:
- D1 (CRITICAL) worktree/branch ปนข้าม task → branch hygiene 4 ขั้นก่อนทุก task +
  isolation test
- D2 (CRITICAL) "ห่อ :396 ลงไป" ลาก per-run singleton → ตาราง per-run/per-task
  ตายตัว + literal 6 จุดเปลี่ยนเป็น `activeTaskId()` getter
- D3 (CRITICAL) kill กลายเป็น skip-task → driver poll kill ทุกต้นลูป (REQ-4.15 ใหม่)
- D4 (CRITICAL) markIneligibleThisRound busy-spin → fold เข้า projection.started +
  unselectable ตลอด run
- D5 double-freeze → freeze ครั้งเดียวใน run; CLI = shape only (REQ-4.2/4.8/4.10)
- D6 lease TTL กลับหัว + release arity → TTL = wallclock+5m; release(taskId, ownerId)
- D7 event union → เพิ่ม TASK_GRAPH_FROZEN/REJECTED ใน core/src/types.ts
- D8 test package split → TG#Na ใน core, TG#Nb+driver ใน console
- D9/D10 result fields/precedence → iterations Σ, calibration rule,
  CHANGES_REQUESTED/QUARANTINED→BLOCKED
- D11 excerpt ต่อ task + ตัด "gates" clause (REQ-4.13)
- D12 projection scope ที่ frozenSeq — reuse log ปลอดภัย
- D13 TASK_HEAD_RE รับ indent + title fallback
- D14 approval targeting ใช้ shape {ok:false, detail} เดิม
- D15 bake effective risk/diffBudget ตอน freeze — ไม่มี optional บน frozen graph
- D16 pin ContextPiece {kind:'contract', reason:'task_graph'} + บันทึก GOVERN-scan
  exemption
- D17 per-file gate exit 1 + เขียนไฟล์ที่เขียนได้
- D18 pre-flight sweep generator กับ approved specs เดิมทั้งหมด
- D19 ตัด projectionFromStates helper (YAGNI)
