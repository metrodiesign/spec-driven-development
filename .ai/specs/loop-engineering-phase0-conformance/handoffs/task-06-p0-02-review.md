# Handoff: Task 06 — P0-02 fresh-context security and correctness review

> From: Codex teammate `/root/p0_02_review`
> To: lead `/root`
> Date: 2026-07-27
> Scope: read-only review ของ P0-02 เท่านั้น

## Task Summary

ตรวจ P0-02 แบบ fresh context และ adversarial source-to-sink ครอบคลุม shared
`CommandRunner`, SBPL profile, executor/path policy/recovery, GateRunner disposable
worktree, OOB caller integration, tests และ fault suite โดยไม่แก้ production code,
tests หรือ `tasks.md`

## Current Status

`CHANGES_REQUESTED`

พบ 6 High และ 3 Medium findings ที่ควรแก้ก่อนรับ P0-02 โดย findings หลักเป็น
boundary bypass/false attestation ไม่ใช่เพียง test gap

## Prioritized Findings

### [High][Security] 1. Git materialization รัน clean/smudge/filter process นอก shared sandbox

- Location: `core/src/gates/runner.ts:116-133`
- Source-to-sink:
  - source คือ target repository metadata ได้แก่ `.gitattributes`, repository/global
    Git config และ filter helpers
  - sink คือ `execFileSync('git', ...)` สำหรับ `git worktree add` และ
    `git read-tree --reset -u`
  - Git materialization สามารถ spawn configured filter process ก่อน
    `CommandRunner.run()` ที่ `core/src/gates/runner.ts:165-176` จะเริ่ม
- `-c core.hooksPath=/dev/null` ปิดเฉพาะ hooks และไม่ได้ปิด
  `filter.<name>.clean`, `filter.<name>.smudge` หรือ `filter.<name>.process`
- Exploit/failure path: สร้าง fixture repository ที่มี tracked `.gitattributes` และ
  local smudge filter ซึ่งเขียน marker นอก disposable workspace จากนั้นรัน T1 ผ่าน
  injected no-op runner ผลคือ gate รายงานผ่านและ marker ถูกเขียน 3 ครั้ง
  (`SMUDGE` 3 บรรทัด) นอก sandbox
- Impact: target-controlled checkout path ข้าม file/network policy ของ shared child
  boundary ได้ก่อน gate command เริ่ม จึงไม่เป็น fail-closed ตาม REQ-2.1/2.2/2.8
- Required fix: materialize frozen tree โดยไม่เรียก user-configured filters เช่นอ่าน
  tree/blob ผ่าน plumbing แล้วเขียนด้วย core-owned code หรือรัน materialization ทั้งชุด
  ใน restrictive core-owned sandbox พร้อม sanitized Git config/environment ที่ปิด
  external filters อย่างพิสูจน์ได้ ห้ามถือว่า `core.hooksPath=/dev/null` เพียงพอ
- Regression test: filter command ต้องไม่ถูก execute เลย หรือถูก sandbox ปฏิเสธแบบ
  structured; ทดสอบทั้ง write marker และ network attempt

### [High][Security/Correctness] 2. Child ซ่อน sandbox denial แล้วได้สถานะ `completed`

- Location: `core/src/security/command-runner.ts:46`, `:155-190`
- Source-to-sink:
  - kernel/SBPL เป็นผู้ deny operation
  - runner อนุมาน violation จากข้อความ `stdout`/`stderr` ที่ child ควบคุมด้วย regex
    `operation not permitted|permission denied`
  - หาก child redirect `stderr`, กลืน error ด้วย `|| true` และ exit 0 จะไม่มีสัญญาณให้
    regex ตรวจ
- Exploit/failure path ที่ยืนยันบน macOS sandbox จริง:
  `exec 2>/dev/null; printf hidden > src/hidden.txt || true` ภายใต้
  `writableRoots: []` ไม่สร้างไฟล์ แต่ runner คืน
  `status:"completed", exitCode:0` และ evidence ระบุ `status:completed`
- Impact: REQ-2.5 ต้องได้ structured rejection เมื่อพยายามเขียนนอก role root แต่
  event/log ชั้นบนจะบันทึก action ว่าสำเร็จ นอกจากนี้ child ที่เพียงพิมพ์คำว่า
  `permission denied` ยังทำให้เกิด false-positive rejection ได้
- Required fix: รับ violation จาก enforcement-owned channel ที่ child redirect/ปลอม
  ไม่ได้ เช่น sandbox audit/trace result หรือ wrapper-owned control FD หาก platform
  ไม่มีช่องทางดังกล่าวต้อง fail closed ตาม contract แทนการเดาจาก output
- Regression tests: denial ที่ redirect ทั้งสอง stream และ exit 0 ต้อง rejected;
  benign command ที่พิมพ์ข้อความเดียวกับ regex ต้องไม่ถูกจัดเป็น sandbox violation

### [High][Correctness] 3. Built-in gate checks ไม่ผูกกับ frozen `worktreeHash`

- Location: `core/src/gates/runner.ts:251-261`, `:284`, `:329-345`
- Command checks ใช้ disposable tree จาก `worktreeHash` แต่ `conventionCheck`,
  `verifyGoldenManifest` และ T2 `fullGolden` อ่าน `opts.worktreeDir` ซึ่งยัง mutate
  ได้ระหว่าง gate run
- Failure path ที่ยืนยัน:
  1. ทำ golden ใน authoritative worktree ให้เสียก่อน `write-tree`
  2. injected runner คืน authoritative golden ให้ดีระหว่าง `fullTests`
  3. T1 คืน `pass:true` แม้ `report.worktreeHash` ชี้ไปยัง tree ที่ golden เสีย
- Probe กลับทิศก็ยืนยันว่า report สามารถใช้ hash ของ tree A แต่ตัดสิน built-in จาก
  mutable tree B
- Impact: gate attestation ไม่ได้พิสูจน์ artifact เดียวตาม REQ-2.8/2.9 และสร้าง
  false-green report ที่อ้าง hash ผิดเนื้อหา
- Required fix: รัน command checks และ built-in checks กับ materialization ของ
  `worktreeHash` เดียวกัน หรือให้ built-in อ่าน Git blobs/tree โดยตรงจาก hash ห้ามอ่าน
  authoritative worktree หลัง freeze
- Regression test: mutate authoritative worktree หลัง freeze ทั้งดีไปเสียและเสียไปดี
  แล้วผล built-in/evidence ต้องขึ้นกับ frozen hash เท่านั้น

### [High][Correctness/Security] 4. Recovery ใช้ terminal event ข้าม task และขยายสิทธิ์ legacy intent

- Location: `core/src/executor/executor.ts:453-485`
- Failure path A:
  - `lastIntent` ถูกกรองด้วย `taskId`
  - แต่ `terminalAfterLastIntent` เรียก `opts.log.all()` โดยไม่กรอง `taskId`
  - `ACTION_APPLIED` ของ TASK-B ที่มี `actionId` ซ้ำกับ dangling intent ของ TASK-A
    ทำให้ recovery ของ TASK-A คืน `action:"none"` และทิ้ง partial mutation ไว้
- Probe ยืนยันด้วย TASK-A/TASK-B ที่ใช้ `actionId:"shared-action-id"`:
  TASK-A เหลือเพียง `ACTION_INTENT`, TASK-B มี `ACTION_APPLIED`, recovery คืน
  `"log and worktree consistent"` และ partial file ยังอยู่
- Failure path B: intent จาก log รุ่นก่อนที่ไม่มี `payload.role` ถูก fallback เป็น
  `implementer` ที่ `:476-484`; probe ยืนยันว่า replay ได้
  `writableRoots:["src","test/ai-generated"]`
- Impact: exactly-once recovery ตัดสินจาก event คนละ task และ legacy/corrupt log สามารถ
  เปลี่ยน read-only role เป็น role ที่เขียนได้
- Required fix:
  - ค้น terminal event ด้วย `{ taskId: opts.taskId }` และตรวจ identity อย่างน้อย
    `runId + taskId + actionId`
  - role ที่หาย/invalid ต้อง fail closed เป็น structured recovery error หรือ resolve
    จาก trusted task metadata ที่ถูก bind/hash ไว้ ห้าม default เป็น `implementer`
- Regression tests: cross-task action-ID collision, cross-run collision และ legacy
  intent ที่ไม่มี/มี role ผิดรูปต้องไม่ replay ด้วยสิทธิ์ที่กว้างขึ้น

### [High][Compatibility] 5. Sanitized environment ทำให้ policy ที่ ship มารันไม่ได้

- Location:
  - `core/src/security/command-runner.ts:45`, `:119-124`
  - `.ai/policies/gate-ladder.json:3-11`
  - `core/src/executor/path-policy.ts:22-30`
  - `core/src/executor/executor.ts:417-435`
- `COMMAND_ENV` มีเพียง `PATH=/usr/bin:/bin:/usr/sbin:/sbin` แต่ default gate policy
  ใช้ `pnpm lint`, `pnpm typecheck`, `pnpm test`
- Probe บน environment ปัจจุบันพบ `pnpm` ที่
  `/Users/king_developer/.nvm/versions/node/v22.19.0/bin/pnpm`; เรียกผ่าน real runner
  ได้ exit 127 พร้อม `/bin/sh: pnpm: command not found`
- CI ติดตั้ง pnpm ผ่าน `pnpm/action-setup` ซึ่งใช้ path นอก system directories เช่นกัน
- Governed `allowlist:package_install` ยังไม่มี writable scratch/cache/install roots;
  role `implementer` เขียนได้เพียง `src` และ `test/ai-generated` จึงไม่สามารถเขียน
  `node_modules`, package-manager store หรือ lockfile ได้
- Impact: T0/T1 policy ที่ ship มากับ repo และ network grant ที่ประกาศว่ารองรับไม่
  สามารถสำเร็จผ่าน production boundary
- Required fix: composition root ต้อง resolve toolchain เป็น absolute paths แล้วส่ง
  policy-owned deterministic environment เข้า runner โดยไม่ inherit environment ทั้งชุด;
  bind environment/toolchain identity เข้า `envHash` ด้วย สำหรับ governed install ให้ใช้
  isolated writable cache/scratch/output roots ที่ lifecycle และ promotion ชัดเจน
- Regression tests: รัน default gate commands ด้วย package manager ที่อยู่ใน
  non-system path และรัน allowed frozen-lockfile install จริงภายใน isolated fixture

### [High][Integrity/Resource] 6. Background descendants อยู่ต่อหลัง runner รายงานสำเร็จ

- Location: `core/src/security/command-runner.ts:119-136`, `:192-202`
- `stopChildTree()` ถูกเรียกเฉพาะ timeout หรือ output overflow; `close` ปกติเรียก
  `finish()` โดยไม่ terminate process group
- Probe ด้วย fake passthrough sandbox และ `sleep 30 & echo $!` ยืนยันว่า runner resolve
  `exitCode:0` แล้ว descendant PID ยังมีชีวิตอยู่; probe cleanup PID ใน `finally`
- Impact: command สามารถทิ้ง process ที่ใช้ CPU ต่อ หรือ mutate allowed roots หลัง
  `worktreeHash`/`ACTION_APPLIED` ถูกบันทึก ทำให้ evidence กับ artifact diverge และใน
  network-authorized invocation อาจยืดอายุ grant เกินหนึ่ง command
- Required fix: terminate และ reap process group ใน completion paths ทุกแบบก่อน resolve;
  ระบุ policy สำหรับ daemon/session escape และเพิ่ม bounded cleanup timeout
- Regression test: parent exit 0 หลัง spawn background writer; หลัง runner resolve ต้อง
  ไม่มี descendant และ delayed file ต้องไม่เกิด

### [Medium][Correctness/Availability] 7. `timeoutMs` จาก untrusted action ไม่มี validation หรือ policy ceiling

- Location:
  - `core/src/types.ts:14-22`
  - `core/src/executor/executor.ts:160-176`, `:425-435`
  - `core/src/security/command-runner.ts:133-136`
- `validate()` ตรวจเพียง `cmd` และ `network`; ค่า `timeoutMs` ถูกส่งตรงเข้า
  `setTimeout()` โดยไม่ตรวจ finite, integer, positive หรือ maximum
- Failure path: action สามารถขอค่าที่ Node ยังรับได้แต่ยาวหลายวัน ทำให้ executor await
  อยู่ใน child boundary และไม่มี cancellation/heartbeat hook ใน runner interface
- Required fix: validate และ clamp ด้วย core-owned per-command/per-role ceiling ก่อน
  snapshot/INTENT; reject invalid values แบบ structured และรองรับ cancellation/heartbeat
  ที่ enforcement boundary
- Regression tests: `0`, negative, `NaN`, `Infinity`, fraction และค่ามากกว่า ceiling
  ต้อง rejected; timeout ปกติต้องฆ่า descendants และเก็บ bounded evidence

### [Medium][Compatibility] 8. SBPL string interpolation ไม่ escape legal filesystem paths

- Location: `core/src/security/sandbox.ts:43-52`, `:55-73`
- `containedRoot()` ปฏิเสธเฉพาะ `"` แต่ใส่ path ลง SBPL quoted string โดยตรงโดยไม่
  escape backslash/control characters
- Probe บน macOS จริงด้วย workspace ชื่อ `workspace\segment`, `writableRoots:['.']`
  และคำสั่งเขียนไฟล์ที่ควรอนุญาต ได้ `sandbox_violation` และไฟล์ไม่เกิด
- Impact: ไม่มี observed containment bypass แต่ legal workspace path ทำให้ false denial
  และระบบใช้งานไม่ได้
- Required fix: ใช้ SBPL encoder ที่ผ่าน test สำหรับ `"`, `\` และ control characters
  หรือปฏิเสธทุก path ที่ represent ไม่ได้ก่อน spawn ด้วย structured
  `sandbox_unavailable`; ห้าม interpolate raw path
- Regression tests: quote, trailing backslash, newline/control character และ Unicode;
  ทดสอบทั้ง allowed write กับ protected-root deny

### [Medium][Correctness] 9. OOB verdict ให้ flake มี precedence เหนือ deterministic hard failure

- Location: `core/src/audit/oob.ts:158-172`
- หาก T1 report เดียวมี check หนึ่ง `flakySuspect:true` และอีก check fail ซ้ำอย่าง
  deterministic เงื่อนไข `some(flakySuspect)` จะคืน `flaky_suspect` ทันทีโดยไม่ประเมิน
  hard failure หรือทำ rerun path
- Impact: deterministic failure อาจถูกลดระดับเป็น flake และไม่เข้าสู่ escalation path
  ที่ควรเกิด
- Required fix: aggregate verdict แบบ fail-closed โดย deterministic failing checks มี
  precedence; ประเมิน flake ต่อ check หรือกำหนด `mixed_failure` ที่ escalate
- Regression test: report ผสม fail-then-pass หนึ่ง check กับ fail-fail อีกหนึ่ง check
  ต้องไม่คืน verdict เป็น flake-only

## Verification Performed

Focused checks ที่ผ่าน:

```text
pnpm --filter core typecheck
  PASS

pnpm --filter core exec node --test --test-reporter spec \
  src/security/command-runner.test.ts
  3 passed

pnpm --filter core exec node --test --test-reporter spec \
  --test-name-pattern \
  'planner RUN_COMMAND|test_designer RUN_COMMAND|recovery rolls back partial allowed writes' \
  src/executor/executor.test.ts
  3 passed

pnpm --filter core exec node --test --test-reporter spec \
  --test-name-pattern \
  'T1 raw-IP egress uses|gate mutation is disposable|gate fails closed|empty T0 and T1|malformed Phase 0' \
  src/gates/runner.test.ts
  5 passed

git diff --check
  PASS
```

Adversarial probes ที่ยืนยัน findings:

- real macOS SBPL denial ที่ child ซ่อน stderr: forbidden write ไม่เกิดแต่ runner
  รายงาน `completed`
- Git smudge filter: เขียน marker นอก disposable workspace 3 ครั้ง
- frozen-hash mismatch: T1 รายงานผ่านโดย hash ชี้ tree ที่ golden เสีย
- recovery cross-task collision: partial file คงอยู่และ recovery คืน `none`
- legacy missing-role recovery: replay ด้วย implementer roots
- non-system pnpm: exit 127 ผ่าน real runner
- background child: PID ยัง alive หลัง runner resolve
- workspace path ที่มี backslash: allowed write ถูก reject
- symlink escape probe: `src` symlink ไปนอก workspace ถูก SBPL deny และไม่สร้างไฟล์

## Controls Confirmed

- sandbox-unavailable path fail closed พร้อม core-owned evidence
- stdout/stderr capture ถูก bound และ output overflow ฆ่า process group
- planner/diagnostician/reviewer มี empty durable write roots ตาม policy ปัจจุบัน
- test designer และ implementer ได้ roots ตามที่ประกาศ และ `test/golden` ถูก protect
- `cwd` และ lexical writable/protected roots มี workspace containment check
- symlink-through-allowed-root probe ไม่ escape macOS SBPL
- empty/malformed T0/T1 config fail อย่าง explicit
- command retry เป็นหนึ่ง retry และ fail-then-pass ถูก flag
- disposable command checks ใช้ tree hash ที่ freeze ตอน gate entry

## Residual Risks / Follow-up

- `core/src/gates/runner.ts:251-257` ใช้ authoritative Git index เป็น scratch
  (`git add -A`/`write-tree`) จึงเปลี่ยน staged state และไม่มี concurrency isolation;
  ควรใช้ temporary `GIT_INDEX_FILE` หรือ core-owned tree builder
- `core/src/gates/runner.ts:134-144` กลืน `git worktree remove` failure แล้วลบ directory
  ตรง ๆ ซึ่งอาจทิ้ง `.git/worktrees/*` metadata; ควรมี bounded retry และ cleanup เฉพาะ
  registration ที่ตัวเองสร้าง
- output cap ปัจจุบันนับ JavaScript characters ไม่ใช่ encoded bytes; ยัง bounded แต่
  evidence blob อาจใหญ่กว่า 1 MiB เมื่อเป็น multibyte text ควรกำหนด contract เป็น bytes
- actual network suppression ไม่ควรถือว่าพิสูจน์จาก `egressBlocked` boolean ในผลลัพธ์;
  boolean นี้สะท้อน request เท่านั้น การรับ P0-02 ควรมี real denied-connect probe ที่
  enforcement-owned observation ยืนยัน

## Verdict

`CHANGES_REQUESTED`

ห้าม mark P0-02 complete ในสถานะนี้ Findings 1-6 เป็น merge blockers เพราะทำให้
untrusted execution ออกจาก boundary, ทำให้ structured enforcement/attestation เป็น
false result, ทำให้ recovery ข้าม trust scope หรือทำให้ default production policy
ใช้งานไม่ได้ หลังแก้แล้วควรรัน focused suite เดิมร่วมกับ regression probes ข้างต้น และ
ให้ fresh-context security/code review อีกรอบ
