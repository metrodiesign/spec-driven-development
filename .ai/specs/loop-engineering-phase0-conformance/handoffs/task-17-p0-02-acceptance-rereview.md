# Task 17: P0-02 Acceptance Re-review

- From: P0-02 acceptance reviewer
- To: lead agent / next P0-02 implementer
- Date: 2026-07-27
- Scope: fresh-context acceptance re-review หลัง Task 16
- Verdict: `REQUEST_CHANGES`
- Findings: Critical 0, High 1, Medium 2, Low 0

## ขอบเขตและข้อจำกัด

ตรวจ full current P0-02 diff โดยเน้นข้อค้นพบจาก Task 15, ข้อค้นพบ High/Medium เดิม, REQ-2.1 ถึง REQ-2.49, production policy parser/config hash coherence และ local approved-source fixture

ไม่ได้แก้ production code, tests, requirements, design หรือ tasks และไม่ได้ mark Task 2, commit, push หรือเริ่ม P0-03

external real-macOS evidence suite ยังรันไม่ได้เนื่องจาก account limit จนถึง 2026-08-02 11:46 Asia/Bangkok จึงไม่ได้ retry/circumvent และไม่ได้อ้างว่า external suite ผ่าน

## Findings

### High 1: ACTION_APPLIED และ recovery identity ยังไม่ครอบคลุม ignored persistent dependency output

ตำแหน่ง:

- `core/src/executor/executor.ts:232-239` — `worktreeHash()` สร้าง temporary Git index แล้วใช้ `git add -A`; ไฟล์ที่ถูก `.gitignore` เช่น `node_modules/` จึงไม่อยู่ใน hash
- `core/src/executor/executor.ts:245-248` — rollback ใช้ `git clean -qfd` ซึ่งคง ignored output ไว้
- `core/src/executor/executor.ts:568-571` — บันทึก `ACTION_APPLIED.resultHash` จาก hash ที่ไม่รวม persistent dependency output
- `core/src/executor/executor.ts:669-692` — recovery เชื่อ hash ดังกล่าวและอาจสรุปว่า log กับ worktree สอดคล้องกัน

หลักฐานจาก safe local probe ผ่าน public `createExecutor`:

```json
{"firstStatus":"applied","resultHash":"333bbbe9a2e0518eaf908b1b9ef4b32123e11924","recovered":{"action":"none","detail":"log and worktree consistent"},"tamperedStillPresent":true}
```

probe ให้ command promote `node_modules/phase0-offline-dependency/index.js`, เปลี่ยน bytes หลัง `ACTION_APPLIED`, แล้วเรียก `recoverWorktree`; recovery ยังรายงาน `log and worktree consistent` และไฟล์ที่ถูกแก้ยังคงอยู่

ผลกระทบ:

- exact approved captured output ที่ตรวจใน inner executor ไม่ถูกผูกกับ durable action result identity
- การแก้ไขหรือลบ ignored persistent dependency bytes หลัง promotion ตรวจไม่พบ
- duplicate handling และ crash recovery อาจเชื่อ stale/tampered output
- ข้อค้นพบ Task 8 เรื่อง hidden state/resultHash ยังไม่ปิด และ invariant ของ authority ด้าน crash recovery/result hash ยังไม่ครบ

แนวทางแก้:

- กำหนด core artifact identity เดียวที่รวม declared persistent ignored roots โดยใช้ exact, bounded, frozen inventory ชุดเดียวกับ dependency-output verification
- ผูก `ACTION_APPLIED.resultHash` กับ identity นี้
- snapshot/rollback ต้อง restore เฉพาะ owned persistent roots อย่างแม่นยำ ห้ามแก้ด้วย broad `git clean -fdx`
- เพิ่ม regression ผ่าน public `createExecutor` สำหรับ install จริงหรือ injected install: mutate/delete persistent bytes แล้วทดสอบ recovery, duplicate และ crash หลัง promotion ให้ fail closed หรือ restore ได้ตาม contract

### Medium 1: inventory ละเว้น FIFO/socket/device ที่ Git ไม่ enumerate แทนที่จะ reject ทั้ง artifact

ตำแหน่ง:

- `core/src/gates/frozen-tree.ts:599-622` — candidate paths มาจาก `git ls-files`
- `core/src/gates/frozen-tree.ts:628-680` — unsupported-shape rejection ตรวจเฉพาะ path ที่ Git ส่งคืน
- `core/src/security/amended-command-contract.test.ts:730-762` — regression ปัจจุบันครอบคลุม golden path และ symlink แต่ไม่ครอบคลุม FIFO/socket/device

หลักฐานจาก safe local probe:

```json
{"status":"promoted","affected":["src/allowed.txt"],"allowedPromoted":true,"fifoPromoted":false,"workspaceCleaned":true}
```

command สร้างทั้ง `src/allowed.txt` และ FIFO `src/unsupported.pipe`; core promote regular file และรายงานสำเร็จ เพราะ `git ls-files --others --ignored` ไม่ส่ง FIFO กลับมา

ผลกระทบ:

- implementer command สามารถสร้าง unsupported object ร่วมกับ allowed regular change แล้วระบบละเว้น object นั้นและรับ artifact ที่เหลือ
- ไม่เป็นการ promote FIFO โดยตรง แต่ขัด fail-closed artifact validation และ REQ-2.44

แนวทางแก้:

- ใช้ core-owned filesystem traversal/inventory ที่ไม่พึ่ง Git path enumeration
- traversal ต้อง descriptor-relative/no-follow, enumerate entry ทุก shape และ reject ทั้ง attempt เมื่อพบ unsupported object
- เพิ่ม regression สำหรับ FIFO/socket/device ร่วมกับ allowed regular file โดยยืนยันว่าไม่มี promotion และ cleanup ครบ

### Medium 2: monotonic deadline และ AbortSignal ยังไม่ครอบคลุม public Executor action lifecycle ทั้งเส้น

ตำแหน่ง:

- `core/src/executor/executor.ts:150-202` — outer Git helper ใช้ fixed timeout 120 วินาทีและไม่รับ shared `AbortSignal` หรือ operation control
- `core/src/executor/executor.ts:460` — pre-INTENT snapshot ทำงานก่อน inner `CoreCommandExecutor` สร้าง operation control
- `core/src/executor/executor.ts:522-527` — signal ถูกส่งเข้า inner executor เท่านั้น
- `core/src/executor/executor.ts:568-571` — post-promotion `worktreeHash()` เริ่ม Git child เพิ่มเติมนอก shared deadline
- `core/src/executor/command-executor.ts:1329-1341` — operation control เริ่มใน inner executor
- `core/src/security/amended-command-contract.test.ts:1635-1703` — cancellation matrix เรียก direct `CoreCommandExecutor`; ไม่ครอบคลุม outer snapshot/hash path

ผลกระทบ:

- command ที่ abort แล้วหรือถูก abort ระหว่าง pre-snapshot ยังอาจ launch/wait outer Git ได้ถึง 120 วินาทีและอาจ append `INTENT`
- post-promotion hash อาจเกิน capture deadline หรือ throw untyped หลัง promotion
- Task 15 descriptor-read deadline gap ปิดแล้วภายใน inner executor แต่คำรับรอง Task 16 ว่า deadline/signal เดียวถึง Git/core children ทั้งหมด ยังไม่จริงที่ production public entry point

แนวทางแก้:

- สร้างและเป็นเจ้าของ operation control ที่ public Executor action boundary
- thread remaining monotonic deadline และ signal ผ่าน snapshot, hash, rollback และ inner executor
- map timeout/cancellation เป็น typed rejection พร้อม rollback และไม่มี child/temp leak
- เพิ่ม regression ผ่าน `createExecutor` สำหรับ pre-abort, abort ระหว่าง pre-Git และ post-Git พร้อมยืนยัน bounded completion, ไม่มี incomplete promotion และ cleanup ครบ

## Task 15 targeted recheck

- Task 15 High 1 ปิดแล้วสำหรับ captured output ปัจจุบัน: `core/src/executor/command-executor.ts:765-876` สร้าง exact expected regular-file set จาก approved source files และ metadata ที่ enumerate ชัดเจน, เปรียบเทียบทุก entry ใต้ persistent roots, validate metadata content และคืน exact path set; `core/src/executor/command-executor.ts:1638-1644` อนุญาต diff exception เฉพาะ path ใน set นี้
- Task 15 Medium 1 ปิดแล้วใน inner command lifecycle: `createCommandOperationControl` ที่ `core/src/executor/command-executor.ts:306-365` ใช้ `performance.now()`, timer และ `AbortSignal`; descriptor reads, approved-source capture, Git/core children, freeze/materialize, inventory, copy, diff, evidence และ promotion รับ control เดียวกัน
- อย่างไรก็ดี outer public Executor lifecycle ยังมี Medium 2 ข้างต้น

## Earlier High/Medium findings recheck

- Task 6: Git filter isolation, amended sandbox denial semantics, immutable builtin checks, cross-run recovery role, sanitized toolchain environment, process-residual reporting, timeout validation, SBPL escaping และ OOB failure precedence ปิดหรือถูกแทนที่ด้วย approved amendment แล้ว
- Task 8: Core Git boundary, observability, role package roots, new-session descendant handling, production dependency-policy wiring, bounded large-blob handling และ temporary cleanup ปิดแล้ว ยกเว้น hidden persistent state/resultHash ซึ่งยังเป็น High 1 ใน review นี้
- Task 11: operational source/graph, pathname symlink swap และ second-sync child primitive ปิดแล้ว
- Task 13: live installed-byte verification, approved-source resource bounds และ command scratch evidence exception cleanup ปิดแล้ว
- Task 15: exact output set และ descriptor-read shared deadline ปิดใน inner executor ตามรายละเอียดข้างต้น

## REQ-2.1 ถึง REQ-2.49

ตรวจ trace และ implementation contract ครบช่วง REQ-2.1 ถึง REQ-2.49 แล้ว ไม่พบ actionable finding ใหม่อื่นนอกเหนือจาก:

- REQ-2.44: unsupported object inventory gap ตาม Medium 1
- shared lifecycle/cancellation contract ที่ production public entry ตาม Medium 2
- durable action result identity/recovery สำหรับ persistent ignored output ตาม High 1

## Production policy/config/source coherence

- root authority SHA-256 ตรงกับ approved value:
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- `.ai/policies/security-plane.json` ถูก production parser ใน `console/backend/src/loop-cli.ts:90-224` parse แบบ fail closed สำหรับ version, roles, commands, manifest/lock/source/output metadata paths, validators, persistent roots และ network policy
- local approved source file hashes ตรง policy:
  - `package.json`: `288a67518a4206757df517fb92b5ac97cda454fe90233ae8b18ac9444b8391f6`
  - `index.js`: `95bfbc96d6e231461d2c2918a931872799760552b34968908d64245e5561f03d`
- sorted source inventory hash ตรง policy:
  `4491463319ea7693f44b010ee19354206601b211b117ef22d7cdd7137b583e2f`
- generated fixture hashes ตรง policy:
  - manifest: `0dd7803340af156b05ee20470ff07b5730682f96f91cf469658f84abae728b24`
  - lockfile: `88975c06ba94873fd4435ccf8c9ca66ee27b8351394b95c28de6eb936f3c10b1`
- local `pnpm` version `11.9.0` ตรง metadata validator

## Verification

### Task 16 focused tests

```text
pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'exact captured installed set rejects|explicitly enumerated manager metadata is content-validated|descriptor reads obey|shared deadline bounds|one cancellation signal stops' src/security/amended-command-contract.test.ts
pnpm --filter console-backend exec node --test --test-reporter spec src/loop-cli.test.ts
```

ผล:

- core: 22 passed, 0 failed
- console-backend policy: 11 passed, 0 failed

### Full focused P0-02 local suite

```text
pnpm --filter core exec node --test --test-reporter spec src/security/amended-command-contract.test.ts src/gates/frozen-tree.test.ts src/security/command-runner.test.ts src/security/sandbox.test.ts src/executor/path-policy.test.ts src/executor/executor.test.ts src/gates/runner.test.ts src/audit/oob.test.ts test/fault-injection.test.ts
```

ผล: 144 tests, 136 passed, 0 failed, 8 explicit external real-macOS skips

### Repository gates

```text
pnpm typecheck
pnpm lint
scripts/check-core-vendor-free.sh
scripts/spec-trace.sh loop-engineering-phase0-conformance
.ai/bin/check-secrets.sh --all
git diff --check
cmp -s /Users/king_developer/Downloads/loop-engineering-implementation-spec.md loop-engineering-implementation-spec.md
shasum -a 256 loop-engineering-implementation-spec.md
```

ผล:

- workspace typecheck ผ่านทั้ง 6 packages
- lint ผ่าน
- core vendor scan ผ่าน
- spec trace ผ่าน 144 criteria/EARS
- secret scan ผ่าน
- `git diff --check` ผ่าน
- authority file byte-for-byte ตรง external authority copy
- authority hash ตรง approved value

## External evidence blocker

external real-macOS suite ยัง unavailable เพราะ account limit จนถึง 2026-08-02 11:46 Asia/Bangkok ตามหลักฐาน Task 16 จึงยังไม่มี fresh external PASS และ review นี้ไม่อ้าง PASS

เนื่องจากยังมี actionable High/Medium findings จึงใช้ verdict `REQUEST_CHANGES` ไม่ใช่ `APPROVE_WITH_EXTERNAL_BLOCKER`

## Required next steps

1. แก้ High 1 และ Medium 1-2 พร้อม public-entry regressions ตามที่ระบุ
2. รัน local focused suite และ repository gates อีกครั้ง
3. ทำ fresh-context acceptance re-review
4. เมื่อ account limit เปิด ให้รัน external real-macOS suite ตาม approved workflow โดยไม่ bypass
5. คง Task 2 เป็น open จนกว่าจะไม่มี actionable finding และ external evidence ผ่าน; ห้ามเริ่ม P0-03 ก่อน acceptance
