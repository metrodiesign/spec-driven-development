# Handoff: Task 33 — P0-03 descriptor transaction acceptance

- วันที่: 2026-08-02
- ผู้ตรวจ: Codex fresh-context correctness/security reviewer
- ขอบเขต: Task 31 High fixes จาก Task 32, Task 30 alias protection, full
  authoritative identity, causal recovery และ REQ-3.1–REQ-3.11
- สถานะการแก้: read-only ต่อ production/tests/spec/tasks และเพิ่มเฉพาะ handoff นี้

## Verdict

`APPROVE_WITH_EXTERNAL_BLOCKER`

- Critical: 0
- High: 0
- Medium: 0
- Low: 0

ไม่พบ actionable correctness หรือ security finding ที่ค้างใน P0-03. Task 31 High
ทั้งสองข้อปิดแล้ว และ regression matrix ของ REQ-3 ผ่านทั้งหมดที่รันใน Task 33

external P0-02 real-macOS verification ยังถูกบล็อกตาม recorded cooldown ถึง
2026-08-03 เวลา 20:18 Asia/Bangkok จึงไม่ได้ retry, circumvent หรืออ้าง PASS
ข้อจำกัดนี้เป็นเหตุผลเดียวของ `WITH_EXTERNAL_BLOCKER` และไม่ใช่ P0-03 defect

## Findings

### Critical

ไม่มี

### High

ไม่มี

### Medium

ไม่มี

### Low

ไม่มี

## Task 31 High closure

### H1: final-component stale overwrite / lost update

ปิดแล้ว

- `core/src/executor/mutation-path.ts:123-146` ใช้ descriptor-relative atomic
  no-replace rename (`renameat2(RENAME_NOREPLACE)` หรือ
  `renameatx_np(RENAME_EXCL)`) เป็น primitive เดียวสำหรับ capture/install/restore
- `core/src/executor/mutation-path.ts:312-340` atomically ย้าย current final ไป
  sibling quarantine ก่อน inspect exact regular hash/mode, symlink target หรือ
  empty-directory shape; expected absent ถูกตรวจที่ operation linearization point
- `core/src/executor/mutation-path.ts:342-365` ติดตั้ง desired ด้วย no-replace,
  verify desired identity และ revalidate held parent descriptor ก่อน/หลัง commit
- `core/src/executor/mutation-path.ts:427-470` ทำ full-batch precheck และ rollback
  operation ก่อนหน้าหาก final ลำดับท้ายเปลี่ยน
- focused tests ที่ `core/src/executor/mutation-path.test.ts:97-202` ยืนยัน
  concurrent replacement, absent create และ commit matrix ของ regular,
  executable, create/delete, directory และ symlink
- Task 33 safe temp probe เพิ่มเติม inject concurrent final หลัง capture สำหรับ
  regular delete, symlink delete และ empty-directory delete; ทั้งสามกรณี reject,
  ไม่ overwrite concurrent final และเก็บ captured backup เป็น typed residue
- Task 30 parent-swap regressions ที่
  `core/src/executor/executor.test.ts:1166-1465` และ
  `core/src/security/amended-command-contract.test.ts:731-773` ผ่าน โดยไม่มี
  escaped bytes, partial mutation หรือ `ACTION_APPLIED`

### H2: cleanup ทำลาย rollback source ก่อนพ้น failure boundary

ปิดแล้ว

- Python transaction เก็บ backup ทุกชิ้นใน `backups` ที่
  `core/src/executor/mutation-path.ts:325-340` และไม่มี success-path delete ก่อน
  explicit commit response ที่ `core/src/executor/mutation-path.ts:472-481`
- rollback ที่ `core/src/executor/mutation-path.ts:482-547` ลบ installed/temporary
  เฉพาะ identity ที่ยังตรง, reverify captured backup และ restore ด้วย no-replace;
  concurrent final ไม่ถูก overwrite และ backup ที่คืนไม่ได้ถูกเก็บเป็น residue
- post-commit cleanup แยกออกจาก rollback ที่
  `core/src/executor/mutation-path.ts:615-634,755-773`; cleanup failure คืน
  `MutationBatchOutcome { status: 'committed', cleanup: { status: 'residue', ... } }`
  และ authoritative final ยังคง desired state
- regressions ที่ `core/src/executor/mutation-path.test.ts:204-374` ยืนยัน safe
  restore, generated recovery-prune rollback และ injected late-cleanup residue
- public recovery regression ที่ `core/src/executor/executor.test.ts:1509-1559`
  ยืนยัน failed prune ไม่มี `ACTION_APPLIED`, captured bytes/directory อยู่ครบ,
  restart replay ครั้งเดียว และรอบถัดไปเป็น no-op

## Correctness and security trace

- `APPLY_PATCH` dereference/hash/parse/policy/preflight อยู่ก่อน mutation ที่
  `core/src/executor/executor.ts:1240-1277` และ
  `core/src/executor/patch.ts:424-524`; declared old/new paths ทุก path ผ่าน policy
  และ fixed/config-isolated `/usr/bin/git` ไม่รัน target filters/hooks
- `WRITE_FILE`, `APPLY_PATCH` และ `RUN_COMMAND` route ผ่าน mutation primitive เดียว
  ที่ `core/src/executor/executor.ts:1660-1745` และ
  `core/src/executor/command-executor.ts:1144-1200`
- hard-denied roots, role roots, safe relative path, no-follow parent walk,
  symlink-artifact policy และ staged content hash ถูกตรวจที่
  `core/src/executor/mutation-path.ts:84-421,556-697`
- pre-intent snapshot, exact `intentSeq`, side effect, final authoritative identity
  และ `ACTION_APPLIED` เรียงตาม lifecycle ที่
  `core/src/executor/executor.ts:1410-1657`; rejection/timeout/cancellation หลัง intent
  reconcile snapshot ก่อน terminal rejection จึงไม่มี partial event/promotion
- authoritative identity ครอบ stable regular file/safe symlink ทั้ง
  tracked/untracked/ignored โดย exclude fixed เฉพาะ `.git` และ `.ai/runs` ที่
  `core/src/executor/executor.ts:482-600` และ
  `core/src/gates/frozen-tree.ts:1033-1237`
- recovery prevalidate causal suffix, rollback earliest snapshot, replay ตาม
  `intentSeq`, verifyทุก accepted result hash/final identity แล้วค่อย append terminal
  ที่ `core/src/executor/executor.ts:1812-2339`
- timeout/cancellation reason ใช้ shared operation control เป็น authority ที่
  `core/src/gates/frozen-tree.ts:340-390` และ
  `core/src/executor/mutation-path.ts:698-730`
- `READ_FILE` ใช้ descriptor-relative no-follow read, ไม่มี snapshot/INTENT และ
  publish content-addressed output ref ที่ `core/src/executor/executor.ts:1503-1577`

Security source-to-sink review ไม่พบ path traversal, symlink dereference,
forbidden-root write, target-controlled Git execution, stale-final overwrite,
partial promotion, replay-evidence confusion หรือ timeout-reason downgrade ที่ยัง
reproduce ได้ใน scope นี้

## REQ-3 acceptance

- REQ-3.1–REQ-3.5: ผ่าน source trace และ tests สำหรับ valid text patch,
  evidence hash, declared old/new path authorization, golden/absolute/traversal/
  outside-role rejection และ malformed/binary/symlink/empty/conflict/no-op rejection
- REQ-3.6: ผ่าน snapshot → exact INTENT → descriptor transaction → authoritative
  result identity → APPLIED รวม final/parent race และ no-partial guarantees
- REQ-3.7: ผ่าน earliest-suffix rollback/replay, multi-intent causality,
  recovery-prune exact rollback และ failure invalidation
- REQ-3.8: ผ่าน exact-generation duplicate/replay idempotency และ repeated recovery
  no-op
- REQ-3.9–REQ-3.11: ผ่าน intent-free READ_FILE, content-addressed output evidence
  และ traversal/symlink escape rejection

## Verification

- focused mutation primitive:
  `pnpm --filter core exec node --test --test-reporter spec src/executor/mutation-path.test.ts`
  — 6 pass, 0 fail
- Task 30/32 regressions:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'Task 30|Task 32' src/executor/executor.test.ts src/security/amended-command-contract.test.ts`
  — 15 pass, 0 fail
- broad REQ-3 + public fault injection:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts`
  — 91 pass, 0 fail
- Task 33 safe temp delete/symlink/directory post-capture race probe — 3 reject,
  3 concurrent finals preserved, 3 typed backup residues
- `pnpm typecheck` — all 6 workspace projects pass
- `pnpm lint` — pass
- `scripts/check-core-vendor-free.sh` — pass
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` — 144 criteria
  covered และ EARS lint pass
- `.ai/bin/check-secrets.sh --all` — pass
- authority external/root `cmp` — exit 0
- authority SHA-256 —
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- `git diff --check` — exit 0; handoff ใหม่ไม่มี trailing-whitespace error

## Residuals and handoff

- production callers ปัจจุบันถือ transaction ที่ committed แล้วเป็น success แม้
  cleanup outcome เป็น residue จึงไม่เผย quarantine path ผ่าน public action event;
  primitive ยังคงคืน typed outcome และ authoritative final ไม่เปลี่ยน ประเด็นนี้เป็น
  observability/housekeeping residual นอก approved REQ-3 ไม่ใช่ acceptance finding
- P0-02 real-macOS verification ยัง blocked ถึง 2026-08-03 20:18
  Asia/Bangkok และไม่ได้รันใน Task 33
- Task 3 ต้องคง `[ ]` ตามขอบเขตของ review นี้
- ไม่มีการแก้ production/tests/spec/tasks, ไม่มี commit/push และไม่ได้เริ่ม P0-04
