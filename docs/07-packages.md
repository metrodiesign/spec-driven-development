# แต่ละ workspace: คืออะไร รับผิดชอบอะไร งานลงที่ไหน

เอกสารนี้อธิบายหน่วยงานหลักหกหน่วยของ monorepo ทีละตัว (`core/`, `aal/`, `adapters/`,
`console/backend`, `console/web`, `scripts/`) พร้อมตัวอย่างจากโค้ดจริงในรีโปนี้ และปิดท้าย
ด้วยตาราง "งานแบบนี้ลงที่ไหน" ที่บอกลำดับไฟล์ที่ต้องแตะจริง (`spikes/` เป็น pnpm workspace
ที่มีอยู่จริงใน `pnpm-workspace.yaml` แต่ไม่อยู่ในขอบเขตเอกสารนี้ เพราะเป็นสคริปต์
verification/spike ไม่ใช่ production code)

## เอกสารนี้ตอบอะไรและใช้ตอนไหน

`README.md` §2 ให้ตารางที่บอก workspace ละหนึ่งบรรทัด พอให้รู้ว่ามีอะไรอยู่บ้าง แต่ไม่พอ
ให้ตัดสินใจว่างานที่ถืออยู่ควรลงโค้ดที่ไหน เอกสารนี้ตอบสามคำถามต่อ workspace:

- **คืออะไร** — ชั้นไหนของสถาปัตยกรรม บทบาทหนึ่งประโยค
- **รับผิดชอบอะไร** — อะไรต้องอยู่ที่นี่ อะไรห้ามอยู่ที่นี่
- **งานแบบไหนควรลงที่นี่** — และงานแบบไหนไม่ควร

ใช้ตอนกำลังจะเพิ่ม/แก้ฟีเจอร์แล้วต้องตัดสินใจว่าโค้ดควรไปอยู่ workspace ไหน โดยเฉพาะเมื่อ
งานพาดหลายชั้น (เช่น เพิ่ม action type ใหม่ ที่ต้องแตะทั้ง adapters, aal และ core) —
กระโดดไป [ตาราง "งานแบบนี้ลงที่ไหน"](#งานแบบนี้ลงที่ไหน) ท้ายไฟล์ได้เลย

## แผนที่ ring กับทิศทาง dependency

สถาปัตยกรรมแบ่งเป็น ring ซ้อนกัน และ dependency **เดินทางเดียว** จากนอกเข้าใน:

```
core (Ring 0) ← aal (Ring 1) ← adapters (Ring 2)
```

อ่านลูกศรว่า "ถูก depend โดย": `adapters` depend `aal` และ `core`; `aal` depend `core`
อย่างเดียว; `core` ไม่ depend ใครเลย ทิศทางนี้ไม่ใช่ธรรมเนียม แต่พิสูจน์ได้จาก `package.json`
ของแต่ละตัว:

| workspace | dependencies (runtime) | หลักฐาน |
|---|---|---|
| `core` | ไม่มีเลย (มีแค่ `devDependencies`: `@types/node`, `typescript`) | `core/package.json:14-17` |
| `aal` | `"core": "workspace:*"` ตัวเดียว | `aal/package.json:12-14` |
| `adapters` | `@anthropic-ai/claude-agent-sdk`, `aal`, `core` | `adapters/package.json:12-16` |

จุดสำคัญ: ในบรรดาสาม ring นี้ `@anthropic-ai/claude-agent-sdk` (SDK ของ vendor) ปรากฏใน
`adapters/package.json` เท่านั้น ไม่ปรากฏใน `core` หรือ `aal` เลย ข้อห้ามที่บังคับด้วย
`scripts/check-core-vendor-free.sh` อยู่ที่ `core/` กับ `aal/` (สองตัวนี้ต้องปลอดชื่อ vendor) —
ไม่ใช่ว่า `adapters` เป็นที่เดียวในรีโปที่แตะ SDK: `console/backend` ก็ depend และ import SDK
ตัวเดียวกันในบทบาท operator surface (`console/backend/package.json:13`,
`console/backend/src/chat-runtime.ts:11`) นี่คือเหตุผลเชิงกลไกว่าทำไม `core`/`aal` ถึงปลอด
vendor name ได้ (ดูข้อห้าม vendor-free ใน [หัวข้อ `core/`](#core-ring-0))

เหนือสาม ring นี้ยังมี `console/backend` (Fastify server สำหรับคน — depend `core` ผ่าน public API
จริง: `console/backend/package.json:17` มี `"core": "workspace:*"`) และ `console/web` (React SPA
ที่ **ไม่ depend `core` เลย** — `console/web/package.json:11-15` มี dependency แค่ `@xterm/xterm`,
`react`, `react-dom` มันคุยกับ backend ผ่าน HTTP/WS และคัดลอก type ที่ต้องใช้ตาม convention
ดู comment `console/web/src/logic/loop.ts:22-23`) และ `scripts/` (utility ระดับ repo ที่ไม่ใช่ pnpm workspace)

---

## `core/` (Ring 0)

### คืออะไร

Ring 0 — deterministic core ที่เป็น "เจ้าของความจริง": โมเดลเสนอ (propose) แต่ core เป็นคน
รันและวัด (dispose) `core/src/ports.ts:1` เขียนไว้ตรง ๆ ว่านี่คือประตูเดียว:

```ts
// The ONLY doorway any agent has into Ring 0 (INV-1/8/9, REQ-11.3).
```

### รับผิดชอบอะไร

execution จริง (รันคำสั่ง/เขียนไฟล์ใน sandbox), state + event log, gates, audit, evidence
store, orchestrator loop, lease, security policy และ vendor-neutral PR gate decision kernel.
การ execute action ทุกชนิดเกิดที่นี่ **ที่เดียว** — ทั้ง `aal` และ `adapters` ห้ามรันอะไรเอง

ข้อห้ามที่บังคับจริง: **`core/` (และ `aal/`) ห้ามปรากฏชื่อ vendor** — regex
`claude|anthropic|codex|glm|openai` (case-insensitive ทั้งต้นไม้ รวม comment และ test) บังคับด้วย
`scripts/check-core-vendor-free.sh` ซึ่งรันใน CI ที่ `.github/workflows/ci.yml:41` **script
ตัวเดียวกันนี้สแกน `aal/` ด้วย ไม่ใช่แค่ `core/`** — ดูรายละเอียดที่ [หัวข้อ `aal/`](#aal-ring-1)

### โครงภายใน

`core/src/` แยกโฟลเดอร์ตามหน้าที่ กลุ่มที่หนักสุดคือ `executor/` (`executor.ts`,
`command-executor.ts`, `mutation-path.ts`, `path-policy.ts`) และ `gates/` (`runner.ts`,
`frozen-tree.ts`, `red-provenance.ts`, `golden.ts`) ที่เหลือได้แก่ `state/` (`event-log.ts`,
`lease.ts`), `orchestrator/` (`loop.ts`, `machine.ts`), `context/` (`builder.ts`), `evidence/`,
`security/`, `merge/`, `graph/`, `audit/`, `repair/`, `governance/`, `deploy/`, `budget/` และ
`pr-gate/` (`types.ts`, `kernel.ts`, `checks.ts`) รวมถึงไฟล์ราก `types.ts`, `index.ts`, `ports.ts`

### entry point / public API

`core/package.json:5-9` export สามช่อง:

```json
"exports": {
  ".": "./src/index.ts",
  "./ports": "./src/ports.ts",
  "./types": "./src/types.ts"
},
```

`core/src/index.ts:1` ประกาศตัวเองว่า `// Ring 0 public surface (vendor-neutral — INV-7).`
export หน้าบ้านสำคัญ: `createExecutor`, `runTaskLoop`, `createGateRunner`, `openEventLog`,
`acquireTaskLease`/`createLeaseManager`, `createEvidenceStore`, `buildContext`,
`createDefaultPathPolicy` และ PR gate exports เช่น `mergeEffectivePolicy`, `decideQuality`,
`transitionPrGateState`, `runPlannedChecks`

### ตัวอย่างจากโค้ดจริง

core บังคับ gate ตอน execute เอง — ตัวอย่างนี้ (`core/src/executor/executor.ts:1203-1211`,
อยู่ใน `createExecutor`) ปฏิเสธการเขียนทับ RED artifact ที่ถูก freeze:

```ts
checkWrite(role, path) {
  const decision = opts.policy.checkWrite(role, path);
  if (!decision.allowed) return decision;
  const normalizedPath = normalizeWorktreeRelativePath(path);
  if (role === 'implementer' && normalizedPath !== null && opts.redArtifacts?.get(normalizedPath) !== undefined) {
    return { allowed: false, reason: 'red_artifact_frozen' };
  }
  return decision;
},
```

ฝั่งผู้ใช้ core ประกอบผ่าน public API เท่านั้น — `console/backend/src/loop-run.ts:1158-1172`
ต่อ `createExecutor` เข้ากับ `runTaskLoop` และ `createGateRunner`:

```ts
const result = await runTaskLoop({
  runId: RUN_ID,
  taskId,
  role: 'implementer',
  source,
  executor,
  gates: createGateRunner({
    worktreeDir: fx.wt,
    configPath: fx.gateConfigPath,
    ...
```

### เหมาะกับงานแบบไหน / ไม่เหมาะกับอะไร

- **เหมาะ**: logic ของ execution/gate/state/evidence/audit, การเพิ่ม action type ในฝั่ง
  execute (ดู `types.ts` + executor), gate ใหม่, policy การเขียนไฟล์
- **ไม่เหมาะ**: อะไรก็ตามที่ต้องรู้จักชื่อ vendor หรือ wire format — นั่นต้องอยู่ `adapters`;
  protocol/routing/breaker — อยู่ `aal`

**test**: `*.test.ts` วางข้าง source 49 ไฟล์รวม `core/test/`, รันด้วย
`pnpm --filter core test`. Pattern คือ `node:test` + `node:assert/strict`; PR gate มี
table-driven policy/decision/check tests ใน `core/src/pr-gate/`.

---

## `aal/` (Ring 1)

### คืออะไร

Agent Abstraction Layer — ชั้นกลางระหว่าง core กับ adapters `aal/src/index.ts:1` ประกาศ:

```ts
// Ring 1 public surface (Agent Abstraction Layer — vendor-neutral by law, INV-7).
```

### รับผิดชอบอะไร

protocol envelope กลาง (`AgentRequest`/`AgentResponse`), capability manifest + fallback,
conformance P1-P8, routing/breaker/rate-limit, provenance check, repair loop, Fusion plane และ
blind PR review panel + Evidence Judge
เส้นแบ่งที่ต้องจำ:

- **protocol / routing / breaker / repair / provenance อยู่ `aal`**
- ในบรรดาสาม ring การแปล wire format และการเรียก SDK ของ vendor อยู่ `adapters` เท่านั้น
  (นอกสาม ring `console/backend` แตะ SDK ได้ในบทบาท operator surface — ดูหัวข้อถัดไป)
- **การ execute จริงอยู่ `core` เท่านั้น** — `aal` สั่งงาน core ผ่าน port แต่ไม่รันเอง

`aal/src/fusion/run.ts:1-2` ระบุ boundary นี้ชัด: `Ring 1 orchestration only — it executes
NOTHING itself` — candidate gate มาจาก core ผ่าน port ไม่ใช่ aal import executor เอง

เพราะ INV-7 บังคับให้ `aal` ปลอด vendor ด้วย `scripts/check-core-vendor-free.sh` จึงสแกน
**ทั้ง `core` และ `aal`** — ดูโค้ดจริง:

```bash
# from scripts/check-core-vendor-free.sh:13-16
pattern='claude|anthropic|codex|glm|openai'
status=0

for ring in core aal; do
```

### โครงภายใน

ไฟล์ใหญ่สุดคือ `source.ts` (orchestrate หนึ่งรอบเต็ม: build context → route → send → repair →
provenance → บันทึก event) ตามด้วย `router.ts`, `registry.ts`, `shadow.ts`, `breaker.ts`,
`protocol.ts`, `repair.ts`, `dispatch.ts`, `ratelimit.ts`, `fake-adapter.ts`,
`conformance/harness.ts`, `pr-review/panel.ts` และโฟลเดอร์ `fusion/` (`run.ts`, `resolve.ts`,
`profiles.ts`, `schema.ts`)

หมายเหตุ: `aal/src/fake-adapter.ts` เป็น **product code ไม่ใช่ test helper** — comment ที่
`fake-adapter.ts:1-3` อธิบายว่า `the composition root's default non-live path uses it, so it must
be product code` เป็น deterministic model simulator ที่ non-live path ใช้จริง

### entry point / public API

`aal/src/index.ts:59`:

```ts
export { createAALProposalSource, type AALSourceDeps } from './source.ts';
```

interface ที่ adapter ทุกตัวต้อง implement อยู่ที่ `aal/src/protocol.ts:104-108`:

```ts
export interface AdapterInterface {
  manifest(): CapabilityManifest;
  /** Sends one request. Throws AdapterError (typed) — NEVER retries itself (INV-5). */
  send(req: AgentRequest): Promise<AgentResponse>;
}
```

PR review public surface export `runBlindReviewPanel`, `runEvidenceJudge`,
`REVIEWER_OUTPUT_SCHEMA` และ `JUDGE_OUTPUT_SCHEMA` จาก `aal/src/index.ts`.

### ตัวอย่างจากโค้ดจริง

aal เรียกเข้า core ผ่าน port `buildContext` (`aal/src/source.ts:201-211`) — สร้าง context bundle
แต่ไม่แตะไฟล์เอง:

```ts
buildContext({
  taskId: deps.taskId,
  taskContract: deps.taskContract,
  worktreeDir: deps.worktreeDir,
  seedPaths: [...deps.seedPaths, ...accumulatedSeedPaths(readRequested, evictedAccumulated)],
  canaryToken,
  evidence: deps.evidence,
  ...
});
```

และ aal เป็นคนตัดสิน provenance: action ที่ WRITE ไฟล์นอก context bundle ถูก reject เป็น
`context_violation` โดยไม่ execute (`aal/src/source.ts:584-589`):

```ts
return {
  claim: 'WORKING',
  actions: [],
  costUnits,
  rejections: violations.map((a) => ({ actionId: a.actionId, reason: 'context_violation' as const, detail })),
};
```

### เหมาะกับงานแบบไหน / ไม่เหมาะกับอะไร

- **เหมาะ**: routing policy, breaker/rate-limit, conformance, provenance/repair, Fusion,
  blind reviewer/Judge orchestration, protocol envelope, capability manifest
- **ไม่เหมาะ**: การรัน command/เขียนไฟล์ (→ `core`), การแปล wire หรือเรียก SDK (→ `adapters`),
  อะไรที่ต้องรู้ชื่อ vendor (ผิด INV-7)

**test**: 16 ไฟล์ `*.test.ts` ข้าง source รวม `pr-review/panel.test.ts`
รันด้วย `pnpm --filter aal test`

---

## `adapters/` (Ring 2)

### คืออะไร

ชั้นแปล wire format ของแต่ละ vendor `adapters/src/index.ts:1-2` ประกาศ:

```ts
// Ring 2 public surface (adapters — wire-format translation only, INV-8).
// Vendor names are legal HERE and only here.
```

ในบรรดาสาม ring นี่คือชั้นเดียวที่ชื่อ vendor ถูกกฎหมาย

### รับผิดชอบอะไร

**แปล wire format/transport เท่านั้น**: ประกอบ prompt, normalize action/structured review,
map error ของ transport เป็น typed `AdapterError`, เรียก SDK/CLI ของ vendor, scrub environment,
link timeout/cancellation ห้ามมี business logic ห้าม import
`core/executor` หรือ internal ของ `aal` เกิน public protocol types (INV-8) — และ **ห้าม
execute อะไรเอง** (การรันเป็นของ core) ทุก action ที่ normalize ออกมาเป็นแค่ *ข้อเสนอ* ให้ core

### โครงภายใน

`anthropic.ts`, `codex.ts`, `reasoning-cli.ts`, live transports (`live.ts`, `codex-live.ts`,
`reasoning-cli-live.ts`), `control.ts`, `wire.ts` และ `_template.ts`. `wire.ts` รวม vocabulary กลาง:
`buildProposePrompt`, `normalizeActions`
(`wire.ts:22`), `classifyAdapterError`, `unfence` และ `protocolBlock()` (`wire.ts:55`) ที่สอน
action DSL ให้โมเดล

หมายเหตุสำคัญ: `adapters/src/_template.ts` **ตั้งใจไม่ถูก export และไม่ถูก register** — comment
ที่ `_template.ts:1-2` เขียนว่า `NOT registered anywhere and NOT exported from index.ts on
purpose; it is a documented starting point, not product` เป็นแม่แบบสำหรับเขียน adapter ตัวใหม่
เท่านั้น

การแยก `live.ts`/`codex-live.ts` ออกจากตัว testable ก็จงใจ: `live.ts:2-3` บอกว่า `CI and the
stub path never touch this, so no quota is spent in tests` — live wiring ถูก import เฉพาะ
`--live` path

### entry point / public API

`adapters/src/index.ts` เป็น public surface (ประกาศ `RING = 2`) และ export live adapter ที่ใช้จริง
สำหรับ Claude, Codex, Gemini CLI และ OpenCode DeepSeek รวม `providerEnvironment`/
`linkCallControl` — แต่ **ไม่** export `_template.ts`. แต่ละ adapter implement
`AdapterInterface` ของ `aal`.

### ตัวอย่างจากโค้ดจริง

การเรียก SDK จริงพร้อม execution ที่ถูก strip ออก (`adapters/src/anthropic.ts:168-178`) —
`tools: []` คือการถอด tool definition ทำให้โมเดลได้แต่ *เสนอ* action ไม่ได้ลงมือ:

```ts
for await (const msg of opts.query({
  prompt: buildProposePrompt(req, { fenceGuard: true }),
  options: {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    tools: [], // D-004 — strip tool DEFINITIONS (not allowedTools: [])
    settingSources: [], // isolate machine config (CLAUDE.md/settings/hooks)
    systemPrompt: opts.systemPrompt,
    cwd: opts.cwd,
    maxTurns: 4,
  },
})) {
```

### เหมาะกับงานแบบไหน / ไม่เหมาะกับอะไร

- **เหมาะ**: เพิ่ม vendor/adapter ใหม่, ปรับ prompt vocabulary (`wire.ts`), map error ของ SDK/CLI,
  ปรับ structured-output transport, environment allowlist และ cancellation
- **ไม่เหมาะ**: routing/breaker (→ `aal`), execution/gate (→ `core`), business logic ใด ๆ
  (ผิด INV-8)

**test**: 7 ไฟล์ `*.test.ts` รวม `reasoning-cli.test.ts`, รันด้วย
`pnpm --filter adapters test`. Live provider behavior ยืนยันด้วย manual conformance แยกจาก CI.

---

## `console/backend`

### คืออะไร

Fastify 5 server/composition root มีสามหน้าที่: (1) interactive surface — spawn binary
`claude` จริงผ่าน PTY/WS, (2) Human Plane API ของ autonomous loop และ (3) Universal PR Quality
Gate manager/API/CLI/GitHub trust boundary. Package ชื่อ `console-backend`.

### รับผิดชอบอะไร

เปิด/จัดการ PTY session, สตรีม terminal ผ่าน WS, เป็นหน้า HTTP ให้ loop run (approvals,
steering, kill, deploy decision), จัดการ PR run/list/detail/cancel/override, pin Git/verify
workflow artifact/publish Check Run และเป็น CLI dispatcher (`platform`) สำหรับ console, loop,
conformance, governance, auditor, pr-gate. ไม่ own deterministic decision ของ core.

### โครงภายใน

- entry จริงคือ `console/backend/bin/platform.ts` (CLI dispatcher) — `console/backend/src/index.ts`
  เป็น placeholder เปล่า (`export {};`) ไม่ใช่ entry
- `src/app.ts` มี `buildApp()` ที่ประกอบ route ทั้งหมด (PTY, loop, auth, memory ฯลฯ)
- `src/loop-run.ts` คือที่ประกอบ core (`createExecutor` + `runTaskLoop` + `createGateRunner`)
- `src/pr-gate/` คือ composition, manager, GitHub read/report, exact Git/snapshot, policy,
  context, checks, artifacts และ workflow provenance
- `src/pr-gate-cli.ts` คือ direct operator command; `app.ts` expose `/api/pr-quality/*`

### entry point / public API

`console/backend/package.json:5-7` ตั้ง bin ชื่อ `platform`:

```json
"bin": {
  "platform": "./bin/platform.ts"
},
```

`main()` ที่ `bin/platform.ts` แยก command; `platform console` เริ่ม Fastify default port
**9119** host **127.0.0.1** — bind non-loopback โดยไม่มี valid `0600` auth config จะ refuse
start (fail-closed, INV-15). Production invocation ดู `docs/08-pr-quality-gate-production.md`.

### ตัวอย่างจากโค้ดจริง

route เปิด PTY session (`console/backend/src/app.ts:285-308`) — มี rate limit (429), validate
input (400) และตอบ 503 เมื่อ spawn binary `claude` ไม่ได้ (REQ-13.7):

```ts
app.post<{ Body: Partial<CreateSessionInput> }>('/api/term/sessions', async (req, reply) => {
  if (!(await guardTerm(reply))) return reply;
  if (deps.termRateOk !== undefined && !deps.termRateOk()) {
    return reply.code(429).send({ error: 'too many terminal spawns; slow down' });
  }
  ...
  try {
    return term.create(input);
  } catch (err) {
    // node-pty throws when the `claude` binary is not on PATH (REQ-13.7).
    return reply.code(503).send({ error: 'terminal unavailable: could not spawn the CLI', ... });
  }
});
```

### เหมาะกับงานแบบไหน / ไม่เหมาะกับอะไร

- **เหมาะ**: route ใหม่ของ Console, PTY/WS, CLI subcommand, Git/GitHub/provider composition,
  PR gate lifecycle และการต่อ Console เข้า Human Plane ของ core
- **ไม่เหมาะ**: execution/gate logic (→ `core`), routing ของ agent (→ `aal`), UI (→ `console/web`)

**test**: 58 ไฟล์ `*.test.ts` ใต้ `src/`/`test/` รวม PR gate acceptance/trust/fault cases,
รันด้วย `pnpm --filter console-backend test`.

---

## `console/web`

### คืออะไร

React 19 SPA (Vite 7 + `@xterm/xterm`) เป็น dashboard ฝั่ง browser ที่คุยกับ `console/backend`
package ชื่อ `console-web`

### รับผิดชอบอะไร

presentation: component ของแต่ละ view (chat, loop, issues, terminal panel ฯลฯ) และ pure display
logic ที่แยกออกจาก DOM สถาปัตยกรรมนี้จงใจ — `src/logic/format.ts:1-2` เขียนว่า `Pure display
logic for the console views — testable without a DOM (ARCHITECTURE: logic separate from
presentation)`

### โครงภายใน

- component ระดับบน (`.tsx`): `App.tsx`, `Chat.tsx`, `I18nContext.tsx`, `Issues.tsx`,
  `Login.tsx`, `Loop.tsx`, `PrQuality.tsx`, `Sched.tsx`, `Surfaces.tsx`, `TerminalPanel.tsx`, `main.tsx`,
  และ hook `useFetch.ts`
- `src/logic/` — pure logic module 14 ตัว (`auth`, `chat`, `fetchState`, `format`, `govern`,
  `i18n`, `issues`, `loop`, `observe`, `pr-quality`, `sched`, `surfaces`, `term`, `theme`) แต่ละตัว
  มี `.test.ts` คู่ + `smoke.test.ts`

### entry point / public API

เป็น app ปลายทาง ไม่มี public API แบบ library `console/web/package.json:5-10` ให้คำสั่ง:
`dev` (`vite`), `build` (`vite build`), `typecheck` (`tsc -p tsconfig.json`), `test`

### ตัวอย่างจากโค้ดจริง

logic แยกจาก DOM ทดสอบได้ตรง ๆ — `console/web/src/logic/auth.ts:6-9`:

```ts
/** A 401 on the auth probe means no valid session; anything else lets the dashboard try. */
export function interpretAuthProbe(status: number): AuthGateState {
  return status === 401 ? 'unauthed' : 'authed';
}
```

### เหมาะกับงานแบบไหน / ไม่เหมาะกับอะไร

- **เหมาะ**: UI/view ใหม่, pure display/interpretation logic (วางใน `src/logic/` ให้ทดสอบได้),
  การต่อ API ของ backend
- **ไม่เหมาะ**: logic ฝั่ง server (→ `console/backend`), agent/execution (→ `aal`/`core`)

**test**: `console/web/package.json:7` จำกัด scope ไว้ที่ `src/logic/**/*.test.ts` (15 ไฟล์)
รันด้วย `pnpm --filter console-web test` เหตุผล: `node --test` ไม่มี DOM และรีโปนี้ไม่มี test
runner สำหรับ component จึงแยก pure logic ออกมาให้ทดสอบได้โดยไม่ต้องพึ่ง DOM — **ไฟล์ `.tsx`
ไม่มี unit test ในรีโปนี้** (ไม่มี `*.test.tsx` เลย)

---

## `scripts/`

### คืออะไร

utility ระดับ repo (shell + python) **ไม่ใช่ pnpm workspace** (ไม่มี `package.json` ไม่อยู่ใน
`pnpm-workspace.yaml`) เรียกโดย CI, Claude Code skill/command, SessionStart hook และคนรันเอง

### รับผิดชอบอะไร

งาน automation/tooling รอบ ๆ workflow: vendor/golden check, spec tooling, cost/session ledger,
pane-loop automation, GitHub label bridge หมายเหตุ: **`.githooks/pre-commit` และ `pre-push` ไม่
เรียก `scripts/` เลย** — git hook เรียก `.ai/bin/*` (คนละชั้น)

### โครงภายใน

24 ไฟล์ จัดกลุ่มตามหน้าที่:

| กลุ่ม | ไฟล์ |
|---|---|
| CI scope | `ci-secret-scope.sh`, `ci-test-scope.sh` |
| guard/check | `check-core-vendor-free.sh`, `check-golden-manifests.sh`, `lessons-coverage-check.sh` |
| spec tooling | `spec-trace.sh`→`spec_trace.py`, `spec-slice.sh`, `spec-state.sh`, `spec-archive.sh`, `spec-to-goal.sh`→`spec_to_goal.py`, `spec-goal-drift.sh`→`spec_goal_drift.py`, `spec-metrics.py` |
| cost/session | `cost_lib.py`, `cost-summary.py`, `inject-cost.py`, `session-cost.py`, `backfill-cost.sh` |
| automation | `pane-loop.sh` (+ `pane-loop.md`), `session-start-active-specs.sh` |
| GitHub bridge | `bootstrap-labels.sh` |

### entry point / public API

ไม่มี public API — แต่ละไฟล์เป็น executable เดี่ยว เรียกด้วย path ตรง แยกได้สองแบบตามผู้เรียก:

- **คนรันเองได้**: spec tooling ทั้งชุด, กลุ่ม cost, กลุ่ม guard/check, `pane-loop.sh`,
  `session-start-active-specs.sh`, `bootstrap-labels.sh` (ต้อง `gh auth login` ก่อน)
- **ออกแบบให้ CI เรียกเป็นหลัก**: `ci-test-scope.sh` และ `ci-secret-scope.sh` — รับ argument
  `<event_name> <base_ref>` ที่ปกติได้จาก GitHub Actions context (มี `CI_SCOPE_DRY_RUN=1` ให้
  print decision โดยไม่รันจริง)

### ตัวอย่างจากโค้ดจริง (caller จริง)

- CI: `.github/workflows/ci.yml:41` รัน `scripts/check-core-vendor-free.sh`, `:69` รัน
  `scripts/ci-test-scope.sh "$GITHUB_EVENT_NAME" "$GITHUB_BASE_REF"`, `:120` รัน
  `scripts/ci-secret-scope.sh ...`
- SessionStart hook: `.claude/settings.json:44` เรียก `scripts/session-start-active-specs.sh`
- skill: `.claude/skills/spec-implement/SKILL.md:24,33` เรียก `spec-state.sh` และ `spec-slice.sh`

`scripts/spec-metrics.py` เป็นกรณีพิเศษ: **ไม่พบ automated caller** (ไม่มีใน CI workflow, git
hook หรือ SessionStart) เท่าที่ตรวจได้ ที่พบใน `.claude/` มีสองจุดคือ (1) test harness ของมันเอง
`.claude/hooks/tests/spec-metrics.test.sh` และ (2) `.claude/skills/spec-retro/SKILL.md:50-51,88`
ที่แนะนำให้ **รันมือ** `python3 scripts/spec-metrics.py --feature <active feature>` ระหว่าง retro
— จึงเป็นเครื่องมือที่รันมือเท่านั้นเท่าที่ตรวจได้ (ไม่มีตัวไหนเรียกอัตโนมัติ)

### เหมาะกับงานแบบไหน / ไม่เหมาะกับอะไร

- **เหมาะ**: automation/tooling ระดับ repo, spec/cost tooling, CI helper
- **ไม่เหมาะ**: logic ของ platform เอง (execution/routing/wire → core/aal/adapters);
  enforcement floor ที่ต้องครอบทั้ง human+agent ที่ commit/push (นั่นอยู่ `.ai/bin/*` + git hook)

**test**: `scripts/` ไม่มี `pnpm test` ของตัวเอง (ไม่ใช่ workspace) — guard บางตัวถูกครอบด้วย
guard regression test ที่ `.claude/hooks/tests/*.test.sh` ซึ่ง CI job `verify` รัน ส่วน
`spec-metrics.py` มี test harness เดี่ยวที่ `.claude/hooks/tests/spec-metrics.test.sh`

---

## งานแบบนี้ลงที่ไหน

ตารางนี้คือหัวใจของเอกสาร — บอก **ลำดับไฟล์ที่ต้องแตะจริง** ต่อชนิดงานที่พาดหลายชั้น:

| ชนิดงาน | ลำดับไฟล์ที่ต้องแตะ |
|---|---|
| **เพิ่ม action type ใหม่** | ดูรายละเอียดด้านล่าง |
| **เพิ่ม vendor/adapter ใหม่** | 1) เริ่มจาก `adapters/src/_template.ts` หรือ reuse `reasoning-cli.ts` → 2) implement `AdapterInterface` ด้วย helper `wire.ts`/`control.ts` → 3) ตั้ง exact lineage → 4) export จาก `adapters/src/index.ts` → 5) ผ่าน P1-P8 → 6) register เฉพาะ composition root ที่ใช้มัน; ห้ามเพิ่ม vendor logic ใน Ring 0/1 |
| **เพิ่ม route ใหม่ใน Console** | 1) เพิ่ม route ใน `buildApp()` ที่ `console/backend/src/app.ts` (ฝั่ง server) → 2) ถ้ามี UI: เพิ่ม pure logic ใน `console/web/src/logic/` (+ `.test.ts`) แล้วต่อ component `.tsx` → ไม่แตะ core/aal/adapters |
| **แก้ PR quality gate** | decision/policy/state → `core/src/pr-gate/`; panel/Judge → `aal/src/pr-review/`; provider transport → `adapters/src/`; Git/GitHub/manager/API → `console/backend/src/pr-gate/` + `app.ts`; UI → `console/web/src/{PrQuality.tsx,logic/pr-quality.ts}`; production workflow/policy เปลี่ยนผ่าน approved spec + governance |

### เพิ่ม action type ใหม่ (ลำดับเต็ม)

action type เดินทางจากคำที่สอนโมเดล ไปจนถึงตัว execute จริง ต้องแตะตามลำดับ:

1. **`adapters/src/wire.ts`** — `protocolBlock()` (`wire.ts:55`) ประกาศ vocabulary ให้โมเดล
   (โมเดลจะเสนอ action type ที่ไม่ถูกสอนไม่ได้) และ `normalizeActions` (`wire.ts:22`) ต้องรู้จัก
   shape ใหม่
2. **`aal/src/source.ts`** — provenance/`pathOf()` (`source.ts:84`) และ logic ตรวจ action
   (`source.ts:552,584`) ต้องรู้จัก action ใหม่ว่าจัดเป็น path action หรือไม่ และเข้า
   provenance check อย่างไร
3. **`normalizeActions` ที่ `adapters/src/wire.ts:22`** — เป็น helper ตัวเดียวที่ทุก adapter
   import ร่วมกัน (`anthropic.ts:12`, `codex.ts:12`) ไม่มี `normalizeActions` แยกต่อ adapter ให้แก้
   โดย default action type ที่ไม่รู้จักจะถูกส่งผ่านตรง ๆ ไม่แตะ (validation เป็นของ core) จึง
   **ต้องแก้ที่นี่เฉพาะเมื่อ** action ใหม่มี field ที่ต้องแปลงก่อนถึง core — เทียบ WRITE_FILE ที่
   map inline `content` → `contentRef` ผ่าน evidence putter (`wire.ts:28-30`) ถ้า vendor ไหนตอบ
   shape ต่างจากมาตรฐาน ให้จัดการที่ตัว adapter นั้น มิฉะนั้นไม่ต้องแตะขั้นนี้เลย
4. **`core/src/types.ts` + executor** — `Action` union ที่ `core/src/types.ts:11` ต้องมี variant
   ใหม่ และ executor ต้องแตะ **สองจุด**: (ก) `validate()` (`core/src/executor/executor.ts:1103`)
   ต้องเพิ่ม `case` ให้ action ใหม่ ไม่งั้นตกไปโดน `default: return 'unknown action type'`
   (`:1167-1168`) ถูกปัดเป็น schema_violation ตั้งแต่ก่อนถึงตัว execute; (ข) `executeValidAction()`
   (`:1514` เป็นต้นไป — เทียบ branch `if (action.type === 'WRITE_FILE')` ที่ `:1567`) คือทางเดิน
   execute จริงที่ต้องรู้วิธีลงมือทำ action นั้น — core คือฝั่งที่ลงมือจริง ถ้า core ไม่รู้จัก
   action นั้นก็ execute ไม่ได้

> สรุปทิศทาง: **สอนที่ `adapters` → คัด/ตรวจที่ `aal` → execute ที่ `core`** — พลาดชั้นใดชั้นหนึ่ง
> action จะถูก drop เงียบหรือ reject
