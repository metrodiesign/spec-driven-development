# Handoff: Task 08 — P0-02 fresh-context re-review

> จาก: Codex reviewer
> ถึง: ผู้แก้ไข P0-02 และ fresh-context reviewer รอบถัดไป
> วันที่: 2026-07-27
> ขอบเขต: read-only review ของ Task 2 หลัง Task 07 remediation

## Task Summary

ตรวจซ้ำ finding และ residual ทั้งหมดจาก Task 06 เทียบกับ code/test ปัจจุบัน โดยเน้น frozen-tree, command runner, sandbox, recovery, environment/toolchain, process cleanup และ OOB aggregation พร้อมรัน focused diagnostics และ adversarial probes เพิ่มเติม

## Current Status

`REQUEST_CHANGES`

- Critical: 0
- High: 7
- Medium: 2

Task 07 แก้ finding เดิมได้หลายรายการ แต่ P0-02 ยังไม่พร้อมปิด เพราะยังมีช่องว่างด้าน security boundary, rollback integrity, role enforcement, production wiring และ availability บน input ปกติ

## Worktree Reconciliation

- Branch: `codex/loop-engineering-phase0-conformance`
- Worktree มีการเปลี่ยนแปลง P0-01/P0-02 ที่ยังไม่ commit อยู่ก่อนเริ่ม review นี้
- ไม่แก้ production code, test หรือ `tasks.md`
- การเปลี่ยนแปลงของ reviewer มีเพียง handoff ไฟล์นี้
- `git diff --check` ผ่านก่อนสร้าง handoff

## Task 06 Finding Dispositions

| # | Finding เดิม | สถานะรอบนี้ | หลักฐานย่อ |
|---|---|---|---|
| 1 | Gate Git materialization/filter/hook ทำงานนอก sandbox | ยังไม่ปิด | `frozen-tree.ts` ใช้ isolated plumbing ได้ดีขึ้น แต่ gate ยังเรียก inherited-PATH `git` ที่ `core/src/gates/runner.ts:117-119` และ executor ยังเรียก Git porcelain/plumbing นอก shared `CommandRunner` ที่ `core/src/executor/executor.ts:142-161` |
| 2 | Child ซ่อน sandbox denial แล้วจบเป็น success ได้ | ยังไม่ปิด | runner ผูก violation กับ signal ของ direct child เท่านั้นที่ `core/src/security/command-runner.ts:378-380`; descendant ถูกฆ่าแล้ว shell กลบ exit ยังรายงาน `completed` |
| 3 | Builtins ไม่ถูกผูกกับ frozen hash เดียวกัน | ปิดแล้ว | command และ builtins อ่านผ่าน `FrozenTree`; focused tests ผ่าน |
| 4 | Recovery ข้าม task/run และยกระดับเมื่อ role หาย | finding เดิมปิดแล้ว | terminal event ถูกกรองด้วย task/run/action และ invalid/missing role ถูก rollback/reject ที่ `core/src/executor/executor.ts:492-520`; พบ rollback gap ใหม่แยกด้านล่าง |
| 5 | Sanitized env/default gates/package install ใช้งานจริงไม่ได้ | ปิดบางส่วน | PATH/toolchain/scratch root ดีขึ้น แต่ production ไม่ส่ง `depPolicy`, hash ไม่ผูกกับ binary bytes และ frozen tree ไม่มี ignored dependencies |
| 6 | Descendant process อยู่ต่อหลัง action จบ | ปิดบางส่วน | same-process-group cleanup ผ่าน แต่ descendant ที่สร้าง session ใหม่ด้วย `setsid`/`detached` หลุดจาก cleanup |
| 7 | timeout validation/ceiling ไม่ครบ | ปิดแล้ว | validation และ ceiling/cancel อยู่ใน executor/runner; focused tests ผ่าน |
| 8 | SBPL path escaping ไม่ปลอดภัย | ปิดแล้ว | encoder ที่ `core/src/security/sandbox.ts:58-67`; focused tests ผ่าน |
| 9 | OOB flake precedence กลบ hard failure | ปิดแล้ว | precedence ที่ `core/src/audit/oob.ts:98-108,171-186`; mixed-result test ผ่าน |

## Prioritized Findings

### [High][Security boundary] 1. Core Git subprocesses ยังหลุด shared execution boundary

**Location**

- `core/src/gates/runner.ts:117-119`
- `core/src/executor/executor.ts:142-161`
- เปรียบเทียบกับ authority ใน `loop-engineering-implementation-spec.md` และ REQ-2.1

**Evidence**

`frozen-tree.ts` เปลี่ยนไปใช้ isolated temporary repository และ plumbing ที่ปลอดภัยขึ้น แต่ gate runner ยังเรียก `git` ผ่าน inherited `PATH` ขณะ executor ใช้ `git add`, `git commit`, `git write-tree`, `git reset` และ `git clean` นอก shared `CommandRunner` โดยยังเปิด user config, hooks และ clean/process filters

Adversarial gate probe วาง fake `git` ใน target `node_modules/.bin` แล้วได้:

```json
{"reportPass":true,"targetGitExecutedOutsideBoundary":true,"pathPrefix":"./node_modules/.bin"}
```

Adversarial executor probe ใส่ target-controlled clean filter แล้ว `WRITE_FILE` ถูก apply พร้อม marker นอก target:

```json
{"status":"applied","targetFilterExecutedBeforeAction":true}
```

**Impact**

Target-controlled executable/config/filter สามารถรันด้วยสิทธิ์ของ control plane นอก sandbox และนอก network/filesystem policy ที่ REQ-2.1 กำหนด

**Required fix**

- ห้าม resolve Core Git จาก target-controlled `PATH`
- งาน snapshot/diff/rollback ต้องใช้ filter-free, hook-free, config-isolated plumbing หรือรันใต้ core-owned containment ที่บังคับ policy จริง
- เพิ่ม adversarial tests สำหรับ fake PATH Git, hooks, clean/process filters และ network attempt
- การใช้ absolute Git binary อย่างเดียวไม่พอ หาก operation ยังเปิด repository filters/hooks/user config

### [High][Security observability] 2. Descendant sandbox denial ยังถูกกลบเป็น success ได้

**Location**

- `core/src/security/sandbox.ts:90,95,118-120`
- `core/src/security/command-runner.ts:378-380`
- coverage ปัจจุบันที่ `core/src/security/command-runner.test.ts:156-183`

**Evidence**

SBPL ส่ง `SIGKILL` ให้ process ที่ละเมิด แต่ runner สรุป `sandbox_violation` เมื่อ direct child ปิดด้วย `SIGKILL` เท่านั้น หาก external descendant ถูกฆ่าแล้ว parent shell ใช้ `|| true; exit 0` การละเมิดจะหายจาก structured result

Probe ที่จำลอง enforcement signal ต่อ descendant ให้ผล:

```json
{"status":"completed","exitCode":0,"reason":null}
```

Test ปัจจุบันใช้ shell builtin `printf` จึงฆ่า direct shell และไม่ครอบคลุม external descendant กรณีนี้ ส่วน real macOS nested-SBPL probe ใน harness นี้จบเป็น `sandbox_unavailable` จึงใช้ยืนยัน semantics ของ macOS โดยตรงไม่ได้

**Impact**

Gate/action สามารถรายงาน success ทั้งที่มี filesystem/network violation เกิดขึ้น ทำให้ audit trail และ fail-closed contract ไม่น่าเชื่อถือ

**Required fix**

- เพิ่ม enforcement-owned descendant violation channel หรือ descendant audit ที่ direct child กลบไม่ได้
- หาก backend ตรวจยืนยันไม่ได้ ให้ fail closed แทน success
- เพิ่ม regression ด้วย external `/usr/bin/touch ... || true` และ network descendant ที่ parent กลบ exit

### [High][Integrity] 3. Rollback ไม่คืน ignored files และ result hash ไม่ผูก hidden state

**Location**

- snapshot/diff: `core/src/executor/executor.ts:154-162`
- normal rejection rollback: `core/src/executor/executor.ts:392-399`
- recovery rollback: `core/src/executor/executor.ts:512,539`

**Evidence**

Snapshot ใช้ `git add -A`/`write-tree` และ rollback ใช้ `git clean -fd`; ignored files ไม่อยู่ใน tree และ `git clean -fd` ไม่ลบ ignored residue

Injected-boundary probe เขียน ignored file แล้วคืน rejection:

```json
{"status":"rejected","residueAfterRejectedRollback":true}
```

**Impact**

Rejected/crashed action ทิ้ง durable hidden partial state ได้ และ successful `resultHash` ไม่ได้ bind state ดังกล่าว ทำให้ deterministic rollback และ tamper evidence ไม่ครบ

**Required fix**

- กำหนด policy สำหรับ ignored writable roots แล้ว inventory/snapshot/restore อย่างแม่นยำ
- ห้ามแก้ด้วย `git clean -fdx` แบบตรง ๆ เพราะจะลบ ignored state ที่มีอยู่ก่อน action
- เพิ่ม normal-rejection และ recovery tests ที่มี pre-existing ignored content กับ newly-created ignored residue

### [High][Authorization] 4. Package-install grant ยกระดับ writable roots ให้ทุก role

**Location**

- `core/src/executor/executor.ts:438-466`
- pinned role authority และ REQ-2.4

**Evidence**

เมื่อ package-install ได้รับอนุมัติ executor เพิ่ม `node_modules` และ writable policy files โดยไม่ตรวจ role

Planner probe:

```json
{"status":"applied","writableRoots":["node_modules"]}
```

**Impact**

Role ที่ควรเป็น read-only โดยเฉพาะ planner สามารถได้รับ write capability ผ่าน package-install path ขัดกับ role boundary ที่ pinned spec กำหนด

**Required fix**

- จำกัด special package-install roots ให้ role ที่ได้รับอนุญาตอย่างชัดเจน
- derive และ validate roots ผ่าน `PathPolicy`
- เพิ่ม negative tests สำหรับ planner, reviewer, diagnostician และ test_designer

### [High][Process isolation] 5. Descendant ที่สร้าง session ใหม่หลุดจาก cleanup

**Location**

- spawn/cleanup: `core/src/security/command-runner.ts:287-321,388-396`

**Evidence**

same-process-group cleanup ทำงานตาม test แต่ descendant สามารถสร้าง process group/session ใหม่แล้วอยู่ต่อหลัง invocation resolve

Probe ใช้ Node `spawn(..., { detached: true, stdio: "ignore" })`:

```json
{"status":"completed","exitCode":0,"escapedPid":true,"aliveAfterResolve":true}
```

PID จาก probe ถูก terminate หลังยืนยันผลแล้ว

**Impact**

Process ที่หลุดสามารถใช้ CPU/memory ต่อ และ invocation ที่ได้ network grant อาจคง capability หลัง action จบ แม้ direct child จะเสร็จแล้ว

**Required fix หรือ contract decision**

- หาก backend รองรับ ให้ใช้ OS-owned containment ที่ kill descendants ข้าม session ได้
- หาก macOS backend ไม่สามารถรับประกันได้ ให้ narrow contract อย่างชัดเจนและ fail closed สำหรับ command ที่สามารถ daemonize แทนการอ้าง whole-tree cleanup
- เพิ่ม regression สำหรับ detached/session escape

### [High][Production compatibility] 6. Production loop ไม่ส่ง package-install policy เข้า executor

**Location**

- production construction: `console/backend/src/loop-run.ts:812-825`
- rejection path: `core/src/executor/executor.ts:340-346`
- declared policy: `.ai/policies/security-plane.json`

**Evidence**

Production สร้าง executor โดยไม่มี `depPolicy`; executor ปฏิเสธ package-install เมื่อไม่มี policy ดังนั้น allowlist ที่ประกาศไว้ไม่ถูกส่งถึง execution path จริง

**Impact**

Package installation ที่ควรอนุญาตตาม policy ใช้งานไม่ได้ใน production แม้ focused unit tests ที่ inject policy จะผ่าน

**Required fix**

- โหลดและ validate policy จาก authoritative config แล้วส่งผ่าน production composition root
- เพิ่ม non-default wiring/integration test ที่เริ่มจาก production constructor ไม่ใช่เฉพาะ injected unit fixture

### [High][Availability] 7. Frozen-tree ล้มเหลวกับ tracked blob ขนาดปกติและ buffer ข้อมูลแบบไม่จำกัด

**Location**

- synchronous Git helper: `core/src/gates/frozen-tree.ts:51-60`
- blob materialization: `core/src/gates/frozen-tree.ts:195-198`
- untrusted file reads: `core/src/gates/frozen-tree.ts:289-303`

**Evidence**

`execFileSync` ใช้ default `maxBuffer`; `cat-file` โหลด blob ทั้งก้อน และ worktree materialization ใช้ `readFileSync` ทีละไฟล์

Probe ด้วย tracked blob ขนาด 2 MiB:

```json
{"pass":false,"detail":"frozen tree materialization failed: spawnSync /usr/bin/git ENOBUFS"}
```

**Impact**

Repository ที่มี asset ขนาดไม่มากสามารถทำให้ T0/T1 ล้มเหลวถาวร ขณะที่ large/sparse/untrusted files สามารถกด memory ของ control plane ได้

**Required fix**

- stream blob/path data พร้อม bounded resource policy หรือกำหนด explicit size limit และ structured rejection
- เพิ่ม regression สำหรับ multi-MiB tracked blob, large index/tree output และ sparse/large file behavior

### [Medium][Integrity] 8. `environmentHash` ผูกเฉพาะ path/string ไม่ผูก toolchain bytes

**Location**

- `core/src/security/command-runner.ts:184-192`

**Evidence**

Hash ครอบคลุม platform/version/path strings แต่ไม่ครอบคลุม binary bytes, package-manager distribution หรือ resolved tool version ที่ executable path เดิม

**Impact**

Toolchain ที่ path เดิมแต่เนื้อหาเปลี่ยนสามารถได้ environment identity เดิม ทำให้ replay/audit assurance อ่อนกว่าที่ชื่อ field สื่อ

**Required fix**

Hash immutable toolchain manifest/digest หรือ resolved binary/distribution digests และเพิ่ม mutation test ที่ path เดิมแต่ bytes เปลี่ยน

### [Medium][Resource cleanup] 9. Frozen-tree temporary repository รั่วเมื่อ materialization throw

**Location**

- `core/src/gates/frozen-tree.ts:250-307`

**Evidence**

`freezeWorkingTree` สร้าง `snapshotRepo` แล้วไม่มี ownership wrapper หรือ `try/finally` ครอบทุก failure path ก่อน return กรณี unmerged index, unsupported object/FIFO หรือ Git error จึงทิ้ง temporary repository ได้

**Impact**

Worktree ที่ attacker ควบคุมรูปแบบได้สามารถทำให้ gate retry สะสม disk/resource leakage

**Required fix**

เพิ่ม `try/catch` หรือ ownership wrapper ที่ cleanup temp root ทุก exceptional path และ regression ที่ตรวจ temp cleanup หลัง deliberate materialization failure

## Fixable Blockers Versus Platform Ceiling

### Fixable ใน code/config/test ปัจจุบัน

- Core Git subprocess boundary
- Descendant violation reporting หากเพิ่ม enforcement-owned signal/audit channel
- Ignored-file snapshot/rollback
- Package-install role enforcement
- Production `depPolicy` wiring
- Frozen-tree streaming/bounds
- Stronger environment identity
- Frozen-tree exceptional cleanup

### Platform ceiling ที่ต้องมี architecture/contract decision

Detached/new-session descendant cleanup บน macOS ไม่ควรถูกซ่อนเป็น implementation detail หาก sandbox backend ไม่มี OS-owned primitive ที่ติดตาม process tree ข้าม session ได้ ต้องเลือกอย่างใดอย่างหนึ่ง:

1. เพิ่ม containment backend ที่รับประกัน cleanup ได้จริง
2. ปฏิเสธ execution class ที่หลุด containment ได้แบบ fail closed
3. ลด scope ของ security claim ใน requirement/design และเพิ่ม residual-risk test/evidence ให้ตรงกับสิ่งที่รับประกันได้

จนกว่าจะตัดสินใจและทำ contract ให้สอดคล้อง finding นี้ยังเป็น blocker ไม่ใช่ residual ที่ปิดได้ด้วย documentation อย่างเดียว เพราะ pinned authority ปัจจุบันอ้างการ dispose process tree/capability หลัง invocation

## Prior Residual Dispositions

- Gate ใช้ caller index: ปิดแล้วด้วย isolated snapshot repository
- Registered worktree cleanup: ปิดแล้ว
- Character cap แทน byte cap: ปิดแล้ว
- Network boolean ไม่ใช่ proof: ยังมีผลในรูป observability gap ตาม Finding 2; egress denial อาจเกิดจริงแต่ attempt ถูกกลบจาก structured outcome
- Self-`SIGKILL` false positive: ยอมรับได้ในฐานะ fail-closed availability tradeoff
- Non-darwin fail close: ยอมรับได้
- COREPACK/cache assumption: ยังเป็น residual compatibility risk; production provisioning ต้องมี integration evidence
- Frozen tree ไม่รวม ignored `node_modules`: ยังเป็น residual compatibility risk เพราะ disposable cwd อาจไม่มี target dependencies ขณะที่ PATH อาจชี้ control-plane toolchain

## Verification Performed

### Focused tests

คำสั่งหลัก:

```text
pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'enforcement signal|normal completion|capture ceiling|sanitized environment|AbortSignal|SBPL paths|SBPL rejects|SBPL denials|governed package-manager grant|governed package-install network semantics|RUN_COMMAND rejects|recovery ignores|recovery fails closed|recovery rolls back|freezing and materializing|convention and golden builtins|T2 fullGolden reads|freezing a dirty|frozen materialization|unsafe symlink|submodule gitlinks|envHash|mixed hard' src/security/command-runner.test.ts src/security/sandbox.test.ts src/executor/executor.test.ts src/gates/runner.test.ts src/audit/oob.test.ts
```

ผล: 24 passed, 0 failed

Real hidden-denial focused run: 3 passed, 1 failed เฉพาะ nested macOS sandbox case เพราะได้ `sandbox_unavailable` แทน `sandbox_violation`; จัดเป็นข้อจำกัดของ test harness นี้ ไม่ใช้เป็น proof ว่า production SBPL ปลอดภัย

### Static/project checks

- `pnpm --filter core typecheck` — ผ่าน
- `pnpm --filter console-backend typecheck` — ผ่าน
- `pnpm lint` — ผ่าน
- `scripts/check-core-vendor-free.sh` — ผ่าน
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` — 107 criteria covered, EARS ผ่าน
- `git diff --check` — ผ่าน

### Additional diagnostics

- fake PATH Git probe — พบ target-controlled Git execution นอก boundary
- clean-filter executor probe — พบ target filter execution ก่อน action
- descendant enforcement-signal simulation — พบ violation ถูกกลบเป็น completed
- ignored rollback probe — พบ residue หลัง rejected rollback
- planner package-install probe — พบ writable `node_modules`
- detached descendant probe — พบ process อยู่ต่อหลัง resolve และ cleanup PID หลัง probe
- 2 MiB tracked blob probe — ยืนยัน `ENOBUFS`
- actual-repository default-gate probe ไม่จบภายใน 90 วินาที จึงยกเลิก และตรวจแล้วไม่เหลือ child process; ไม่ใช้ผลนี้เป็น pass/fail assertion

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-08-p0-02-rereview.md` — เพิ่ม review handoff นี้เท่านั้น

## Important Decisions

- ไม่ reopen checkbox ใน `tasks.md` เพราะ reviewer ไม่มีสิทธิ์แก้ task state ในรอบ read-only นี้
- ให้ builder เป็นผู้แก้ blocker และปรับ Evidence จากนั้นต้องมี fresh-context re-review อีกครั้ง
- ผล focused tests ที่ผ่านไม่ override adversarial probes เพราะ test ปัจจุบันยังไม่ครอบคลุม boundary conditions ข้างต้น

## Constraints / Gotchas

- อย่าแก้ ignored rollback ด้วย broad `git clean -fdx`; จะทำลาย pre-existing ignored state
- อย่าแก้ Git boundary ด้วย absolute binary อย่างเดียว; hooks/filters/user config ยังทำให้ target code รันได้
- อย่าตีความ same-process-group cleanup ว่าเท่ากับ whole descendant-tree cleanup
- nested-SBPL ใน review harness นี้ unavailable จึงต้องมี dedicated macOS integration environment สำหรับ enforcement semantics

## Known Issues / Residual Risks

- Frozen disposable tree กับ ignored dependency tree ยังไม่มี end-to-end production proof
- COREPACK/package-manager cache availability ยังขึ้นกับ runtime provisioning
- `environmentHash` ยังไม่ใช่ content-addressed toolchain identity
- macOS process containment ต้องมี explicit architecture decision

## Verdict

`REQUEST_CHANGES`

P0-02 ไม่ควรถูกทำเครื่องหมายเสร็จจนกว่า High findings ทั้งหมดจะได้รับการแก้หรือมี approved requirement/design change ที่ลด contract อย่างโปร่งใส พร้อม adversarial regression tests และ fresh-context review ใหม่

## Next Recommended Agent

1. Builder/implementer แก้ fixable blockers และอัปเดต spec evidence
2. Architect/security owner ตัดสินใจ macOS detached-process containment contract
3. Fresh-context reviewer ตรวจ source, tests และ adversarial probes ใหม่โดยไม่อาศัยสรุปของ builder เพียงอย่างเดียว

