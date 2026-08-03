# Handoff: Task 21 — P0-03 fresh-context correctness/security review

> From: Codex review agent
> To: P0-03 remediation agent and final re-review agent
> Date: 2026-07-27

## Task Summary

ตรวจ P0-03 (`APPLY_PATCH`, `READ_FILE`, recovery และ P0-02 integration) แบบ fresh context
เทียบกับ authority SHA-256
`ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`,
ข้อกำหนด `REQ-3.1` ถึง `REQ-3.11`, approved design/tasks และ handoff Task 01–20
โดยไม่แก้ production code, tests, requirements, design หรือ tasks

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 3
- Medium: 1
- Low: 0

P0-03 ยังไม่ผ่าน acceptance เพราะมีช่องว่างด้าน path authorization, การรัน
target-controlled Git filter และ recovery identity ส่วน external blocker ของ P0-02
ยังคงเดิมและไม่ใช่เหตุผลของ verdict นี้

## Findings

### High 1 — Git filter ของ target repository รัน subprocess นอก sandbox ก่อนและระหว่าง mutation

- Location:
  - `core/src/executor/patch.ts:51-72`
  - `core/src/executor/patch.ts:81-102`
  - `core/src/executor/patch.ts:310-341`
- Dimension: Security boundary / command execution / `REQ-3.6`
- Failure scenario:
  1. Target repository กำหนด `.gitattributes` เป็น `src/*.txt filter=evil`
  2. Local Git config กำหนด `filter.evil.clean` และ `filter.evil.smudge` ให้เขียน marker
     ออกนอก worktree แล้วส่งข้อมูลต่อด้วย `cat`
  3. ส่ง textual patch ที่แก้ `src/impl.txt`
  4. `git apply --check` รัน clean filter ก่อน snapshot/`ACTION_INTENT`
  5. `git apply` รัน clean และ smudge filter ระหว่าง mutation
- Evidence: probe จริงให้ผล `status=applied`, event เป็น
  `ACTION_INTENT,ACTION_APPLIED` และ marker ยืนยัน `filterRan=true`; เมื่อแยก stage
  พบว่า marker ยังไม่มีหลัง `preparePatch`, เป็น `clean` หลัง `checkPatch` และเป็น
  `clean,smudge` หลัง `applyPatch`
- Impact: repository ที่ไม่ไว้วางใจควบคุม subprocess ซึ่งรันผ่าน control-plane
  `runCoreTool` ได้ สามารถเขียนไฟล์นอก worktree, อ่าน credential หรือทำ network I/O
  ตามสิทธิ์ process ได้ อีกทั้ง side effect แรกเกิดก่อน snapshot/INTENT จึงขัดกับ
  ลำดับ durability ที่กำหนด
- Root cause: environment ปิด global/system config, hooks, fsmonitor และ excludes
  แต่ยังยอมให้ local `filter.*` config ของ repository มีผลต่อ `git apply`
- Required fix:
  - enumerate และ neutralize local clean/smudge/process filters ทุกตัวก่อน Git operation
    ที่แตะ actual worktree หรือใช้ Git plumbing/config isolation ที่รับประกันว่า filter
    ไม่ถูกเรียก
  - คง fixed Git binary, hook isolation และ config isolation เดิม
  - เพิ่ม regression test แบบ real repository ซึ่งพิสูจน์ว่า clean, smudge และ process
    filter ไม่ถูก execute ทั้งใน check/apply และไม่มี marker นอก worktree

### High 2 — Policy ไม่ตรวจทุก old/new path ที่ patch ระบุ เมื่อ forbidden hunk เป็น no-op

- Location:
  - `core/src/executor/patch.ts:298-303`
  - `core/src/executor/executor.ts:637-700`
- Dimension: Authorization / integrity / `REQ-3.3`, `REQ-3.4`
- Failure scenario:
  1. Patch เดียวมี no-op hunk บน `test/golden/expected.txt`
     (`-golden truth` แล้ว `+golden truth`)
  2. Patch เดียวกันเพิ่ม `src/allowed.txt` จริง
  3. Inspector ใช้เฉพาะ effective cached diff จาก
     `git diff --cached --raw -z -M HEAD`
  4. Golden path หายจาก `prepared.paths`; policy เห็นเฉพาะ allowed path
  5. Executor apply patch สำเร็จ
- Evidence: probe จริงให้ผล `status=applied`, `src/allowed.txt` ถูกสร้าง,
  golden content ไม่เปลี่ยน แต่ inode ของ golden file เปลี่ยน และ event เป็น
  `ACTION_INTENT,ACTION_APPLIED`
- Impact: ข้อกำหนดบังคับตรวจทุก named old/new path ไม่ใช่เฉพาะ effective final diff;
  patch สามารถแตะ golden หรือ path นอก role allowlist โดยหลบ authorization ผ่าน
  no-op hunk และทำ filesystem mutation บน path ที่ต้องห้าม
- Required fix:
  - ดึง complete declared path set จาก Git parser แบบ NUL-safe โดยต้องเก็บ old/new path
    ของทุก patch entry รวม rename/copy metadata แล้วตรวจ policy กับชุดนี้
  - ใช้ effective diff เพิ่มเติมเพื่อตรวจ semantic effect ได้ แต่ห้ามใช้แทน declared paths
  - เพิ่ม mixed-patch regression: allowed real change พร้อม forbidden no-op สำหรับ
    golden path, role-disallowed path, quoted/newline/Unicode path และ rename old/new path

### High 3 — `ACTION_REJECTED` ของ attempt ภายหลังปิด dangling intent เก่าโดยอาศัยเพียง actionId

- Location:
  - `core/src/executor/executor.ts:1112-1125`
- Dimension: Recovery correctness / audit integrity / `REQ-3.7`, `REQ-3.8`
- Failure scenario:
  1. APPLY_PATCH เขียน `wrong` เป็น `correct`
  2. Inject crash หลัง side effect แต่ก่อน `ACTION_APPLIED` จึงเหลือ
     `ACTION_INTENT` ที่ dangling
  3. ก่อนเรียก recovery ส่ง actionId เดิมอีกครั้ง; preflight พบ patch conflict และ append
     `ACTION_REJECTED`
  4. `recoverWorktree` ถือว่า rejection นี้เป็น terminal ของ intent เก่า เพราะ match
     แค่ `runId`, `seq > intent.seq` และ `actionId`
  5. Recovery คืน `action=none`, ไม่ restore snapshot และไม่ replay
- Evidence: หลัง probe content เป็น `correct`, event log มีเพียง
  `ACTION_INTENT,ACTION_REJECTED`, ไม่มี `ACTION_APPLIED`, แต่ recovery รายงาน
  `log and worktree consistent`
- Impact: worktree และ audit log ไม่สอดคล้องกัน; dangling mutation ถูกซ่อนโดย rejection
  ที่ไม่ใช่ terminal ของ intent นั้น ทำให้ deterministic restore-and-replay และ
  exactly-once audit semantics ใช้ไม่ได้
- Required fix:
  - เพิ่ม immutable intent generation เช่น `intentSeq` หรือ `attemptId`
  - ให้ `ACTION_APPLIED`/terminal recovery event อ้าง generation เดียวกัน
  - ปิด dangling intent ได้เฉพาะ terminal event ของ intent นั้น ห้ามใช้ actionId อย่างเดียว
  - เพิ่ม regression: crash-after-apply, resubmit แล้ว preflight reject, จากนั้น recover
    ต้อง restore snapshot, replay หนึ่งครั้ง และลง terminal applied event ที่ผูกกับ intent

### Medium 1 — APPLY_PATCH preflight ไม่อยู่ใต้ public deadline/cancellation control

- Location:
  - `core/src/executor/executor.ts:668-700`
  - `core/src/executor/executor.ts:833-846`
  - `core/src/executor/executor.ts:903-913`
  - `core/src/executor/patch.ts:45`
  - `core/src/executor/patch.ts:81-102`
- Dimension: Availability / P0-02 operation-control integration
- Failure scenario: ส่ง valid APPLY_PATCH พร้อม `commandSignal` ที่ abort อยู่ก่อนเรียก
  executor; executor ยัง dereference, inspect syntax, freeze/materialize repository และ
  `git apply --check` จนจบ เพราะ operation control ถูกสร้างหลัง preflight
- Evidence: probe จริงคืน `reason=cancelled` ในเวลาประมาณ 974 ms และมี
  `ACTION_REJECTED` แต่ cancellation เกิดหลัง preflight ทั้งหมด; Git call ที่ไม่มี
  operation ใช้ fixed timeout 120 วินาทีต่อ call
- Impact: cancellation/deadline ที่ public boundary ไม่ครอบคลุมงานหนักของ patch;
  repository ขนาดใหญ่หรือ hostile input สามารถยึด executor ผ่านหลาย fixed timeout
  ก่อน cancellation มีผล
- Required fix:
  - สร้าง operation control ก่อน APPLY_PATCH dereference/preflight
  - ส่ง control เดียวกันผ่าน evidence read, syntax inspection, freeze/materialization,
    path check, actual-worktree check, snapshot, apply, final hash และ rollback
  - เพิ่ม regression สำหรับ pre-aborted signal และ injected slow prep โดยยืนยันว่าไม่มี
    child/filter/preflight side effect และเวลา bounded ตาม deadline

## Verified Controls

ส่วนต่อไปนี้ผ่านการตรวจและไม่มี finding เพิ่มในขอบเขตนี้:

- `diffRef` ถูก dereference และตรวจ hash ก่อน parse patch ที่
  `core/src/executor/executor.ts:674-689`
- effective Git path parsing ใช้ NUL-delimited raw output; quoted/newline path และ
  Git-generated Unicode path ใช้งานได้
- valid text add/update/delete/rename ผ่าน และ malformed, binary, symlink, copy,
  conflict, empty/no-op-only patch ถูก reject แบบ structured ตาม tests ที่มี
- normal mutating path เป็น snapshot, `ACTION_INTENT`, side effect,
  `ACTION_APPLIED` ตามลำดับ
- duplicate actionId ปกติไม่ทำ side effect ซ้ำ
- `READ_FILE` ใช้ descriptor traversal แบบไม่ follow symlink, ไม่สร้าง snapshot/INTENT
  และเก็บ content ref ใน `ACTION_APPLIED`
- final artifact identity ใช้ P0-02 frozen-tree/persistent-root behavior ที่แก้แล้ว
- external P0-02 real macOS blocker ถึง 2026-08-02 11:46 Asia/Bangkok ยังไม่เปลี่ยน;
  review นี้ไม่ได้ retry และไม่ได้อ้างว่าผ่าน

## Verification

Focused acceptance tests:

```text
pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts
```

ผล: 32 tests, 32 passed, 0 failed

Static gates:

```text
pnpm --filter core typecheck
git diff --check
shasum -a 256 loop-engineering-implementation-spec.md
```

ผล:

- typecheck ผ่าน
- tracked diff check ผ่าน
- authority SHA-256 ตรงกับ
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`

Safe probes ใช้ temporary Git repositories ใต้ระบบ temp และล้าง fixture หลังจบ:

- mixed golden no-op plus allowed add: ยืนยัน High 2
- crash-after-apply plus later same-action rejection: ยืนยัน High 3
- repository clean/smudge filter writing outside marker: ยืนยัน High 1
- pre-aborted APPLY_PATCH: ยืนยัน Medium 1
- Git-generated non-ASCII Unicode filename: positive control ผ่าน

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-21-p0-03-review.md`

ไม่มีการแก้ production code, tests, requirements, design หรือ tasks

## Constraints and Next Steps

1. คง Task 3 เป็น open จนแก้ High 1–3 และ Medium 1 พร้อม regression tests
2. ให้ implementation agent แก้ finding โดยไม่ย้อน P0-02 security/cancellation controls
3. รัน focused REQ-3 tests, full core tests, typecheck, secret scan และ fresh re-review
4. อย่า mark P0-02 complete จน external blocker เปิดและ real macOS acceptance ผ่าน
5. อย่าเริ่ม P0-04, commit, push หรือแก้ task checkbox จาก handoff นี้

ไฟล์ `RTK.md` และ `karpathy.md` ที่ root instructions อ้างถึงไม่พบใน repository หรือ
ตำแหน่ง parent ที่ตรวจแบบจำกัด ซึ่งสอดคล้องกับ Task 02/10; จึงใช้ shared authority และ
Codex adapter ที่มีอยู่เป็นฐาน review
