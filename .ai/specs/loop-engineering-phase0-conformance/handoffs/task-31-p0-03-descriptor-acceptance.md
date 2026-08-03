# Handoff: Task 31 — P0-03 descriptor transaction acceptance review

- วันที่: 2026-07-28
- ผู้ตรวจ: Codex fresh-context correctness reviewer
- ขอบเขต: Task 30 descriptor mutation boundary, batch atomicity, exact rollback และ
  REQ-3.6–REQ-3.8
- สถานะ: ตรวจแบบ read-only ต่อ production/spec/tests/tasks และเพิ่มเฉพาะ handoff นี้

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 2
- Medium: 0
- Low: 0

Task 30 ปิด symlink-alias escape และ parent-descriptor swap ที่ Task 29 พบได้ แต่
mutation transaction ยังไม่รักษา expected old state ที่ final component ระหว่าง
หลาย operation และ rollback ยังทำลาย backup ก่อนพ้น failure boundary ทั้งสองกรณี
ทำให้ batch ที่ควรเป็น atomic สามารถทิ้ง state ซึ่งไม่ใช่ pre-call หรือ intended
post-call state ได้ จึงยังรับ REQ-3.6–REQ-3.8 ไม่ได้

P0-02 external real-macOS verification ยังถูกบล็อกถึง 2026-08-02 11:46
Asia/Bangkok ตามข้อจำกัดเดิม จึงไม่ได้ retry, circumvent หรืออ้าง PASS ประเด็นภายนอก
นี้ไม่ใช่สาเหตุของ `REQUEST_CHANGES`

## Findings

### [High] Final component เปลี่ยนหลัง batch prevalidation แล้วยังถูก overwrite พร้อมรายงาน success

- ตำแหน่งหลัก:
  - `core/src/executor/mutation-path.ts:262-293`
  - `core/src/executor/mutation-path.ts:328-342`
  - `core/src/executor/mutation-path.ts:190-237`
- ตำแหน่งสนับสนุน:
  - `revalidate_parent()` ตรวจเฉพาะ parent device/inode ที่
    `core/src/executor/mutation-path.ts:163-176`
  - `APPLY_PATCH` สร้าง exact old-state operations และเรียก boundary ที่
    `core/src/executor/patch.ts:367-421` และ
    `core/src/executor/patch.ts:526-545`
  - `RUN_COMMAND` promotion ใช้ batch เดียวกันที่
    `core/src/executor/command-executor.ts:1144-1200`
  - Task 30 batch regression สลับ parent ก่อนเข้า boundary ที่
    `core/src/executor/executor.test.ts:1408-1465`; ยังไม่มีการเปลี่ยน final
    component หลัง batch prevalidation แต่ก่อน operation ลำดับท้าย
- มิติ: integrity, atomicity, concurrency, lifecycle correctness

เส้นทางที่ไม่มี planned directory ตรวจ expected state ของทุก operation ก่อนที่
operation แรกจะเริ่ม install จากนั้น revalidate เฉพาะ parent descriptors แล้วเรียก
`install_item()` ตามลำดับ เมื่อถึง final component จริง `install_item()` ทำเพียง
`lstat_at()` ที่บรรทัด 228 แต่ไม่เรียก `matches_expected()` ก่อน rename ที่บรรทัด
232 จึงใช้ precondition เก่าซึ่งอาจหมดอายุแล้ว

Safe temp filesystem repro ให้ state transition ดังนี้:

1. ก่อนเรียก: `src/a-large.bin` absent และ `src/z-later.txt = "before\n"`
2. batch prevalidate ทั้งสอง path ผ่าน
3. ระหว่างสร้าง temporary สำหรับ operation แรก เขียน
   `src/z-later.txt = "concurrent\n"` หลังเห็น `.core-mutation-*`
4. operation ท้าย rename ค่า `concurrent` ไปเป็น backup แล้วติดตั้ง
   `"transaction\n"`
5. cleanup ลบ backup, promise resolve และผลสุดท้ายเป็น
   `src/z-later.txt = "transaction\n"`

ผล probe:

```text
mutatedAfterBatchPrevalidation: true
outcome: resolved
laterFinal: "transaction\n"
largeInstalled: true
```

ผลกระทบคือ `APPLY_PATCH`, `RUN_COMMAND` promotion และ recovery batch สามารถลบ
local/concurrent state ที่ไม่ตรง snapshot โดยยังรายงาน success จากนั้น public
executor สามารถ append `ACTION_APPLIED` ที่
`core/src/executor/executor.ts:1630-1636` ได้ กรณี single-operation ก็ยังมี window
ระหว่าง prevalidation, temporary staging และ final rename เช่นกัน

แนวทางแก้ขั้นต่ำ:

1. ทำ final-component commit เป็น compare-and-swap จริง ไม่ใช่เพิ่ม `lstat` รอบสอง
   อย่างเดียว เพราะยัง race กับ `rename`
2. สำหรับ expected entry ที่มีอยู่ ให้ atomically ย้าย current entry ไป unique
   backup แล้ว inspect/verify backup ว่าตรง expected ก่อนติดตั้ง desired
3. ติดตั้ง desired ด้วย no-replace primitive เพื่อให้ entry ที่เกิดใหม่ตรง target
   ระหว่าง commit ทำให้ทั้ง batch abort แทนการ overwrite
4. หาก expected ไม่ตรงหรือ target กลับมาปรากฏ ต้องคืน unknown entry โดยไม่ทิ้ง bytes
   และ rollback operation ก่อนหน้าทั้งหมด
5. เพิ่ม deterministic boundary hook/test ที่เปลี่ยน operation ลำดับท้ายหลัง full
   batch prevalidation แล้ว assert ว่า reject, ไม่มี `ACTION_APPLIED`, concurrent
   bytes ไม่หาย และ operation ก่อนหน้าถูก rollback

### [High] Backup cleanup ลบ rollback source ต้นรายการก่อน failure ท้ายรายการ

- ตำแหน่งหลัก:
  - `core/src/executor/mutation-path.ts:353-375`
- ตำแหน่งที่ทำให้กรณีนี้เกิดใน recovery:
  - authoritative shape traversal เดินผ่าน directory แต่ inventory เก็บเฉพาะ
    regular file/symlink ที่ `core/src/gates/frozen-tree.ts:263-280`
  - obsolete directory derivation ใช้เฉพาะ parent ของ captured paths ที่
    `core/src/executor/executor.ts:781-807`
  - recovery สร้าง file/directory delete operations และส่ง batch ที่
    `core/src/executor/executor.ts:940-996`
- มิติ: data loss, rollback, recovery, durability

หลังติดตั้งครบ loop ที่บรรทัด 353–354 ลบ backup ทีละรายการโดยยังอยู่ใน `try`
เดียวกับ transaction ถ้าการลบ backup ท้ายรายการล้มเหลว control จะเข้า rollback
แต่ backup ต้นรายการที่ถูกลบสำเร็จแล้วไม่มีอยู่ให้ restore บรรทัด 369–373 กลืน
`FileNotFoundError` และคืน success ต่อรายการนั้นโดยไม่ตรวจ exact pre-call state

Safe temp repro ใช้ operation รูปเดียวกับ recovery directory pruning:

1. ก่อนเรียกมี `src/obsolete/captured.txt = "captured-before\n"` และ empty directory
   `src/obsolete/unmodeled-empty/`
2. batch ลบ captured file, `src/obsolete` และ `src` ตามลำดับ
3. cleanup ลบ backup ของ captured file สำเร็จ
4. การ `rmdir` backup ของ `src/obsolete` ล้มด้วย `ENOTEMPTY` เพราะ empty directory
   ไม่อยู่ใน artifact inventory
5. batch reject และคืน directory backups แต่ backup ของ captured file หายแล้ว

ผล probe:

```text
outcome: rejected: [Errno 66] Directory not empty
capturedExistsAfterRollback: false
capturedContentAfterRollback: null
emptyDirectoryPreserved: true
srcEntries: ["obsolete"]
```

นี่เป็น generated recovery shape ที่เกิดได้จริง ไม่ใช่เพียง malformed direct call:
authoritative inventory ไม่แทน empty directory แต่
`obsoleteArtifactDirectories()` อาจขอลบ ancestor ที่ยังมี empty directory ดังกล่าว
เมื่อ `restoreArtifactSnapshot()` ใช้ boundary นี้และ throw จะไม่มี exact rollback
เหลือให้รับรองว่า snapshot ถูก restore ก่อน replay ตาม REQ-3.7

แนวทางแก้ขั้นต่ำ:

1. ห้ามทำลาย rollback source ใดก่อนผ่าน failure-capable validation ของ backup
   ทั้งชุดและกำหนด commit point ที่ชัดเจน
2. อย่าขอลบ directory จาก file-only inventory เว้นแต่ descriptor-relative check
   ยืนยันว่าไม่มี unmodeled child; หรือเพิ่ม directory shape ที่จำเป็นเข้า snapshot
3. แยก post-commit garbage collection ออกจาก rollback path หรือย้าย backup ไป
   core-owned quarantine ที่ยัง restore ได้จน commit สมบูรณ์ โดยต้องไม่ทิ้ง residue
   ใน authoritative identity
4. เพิ่ม public recovery regression ที่มี captured file คู่กับ unmodeled empty
   subdirectory แล้วตรวจว่า failure ใดก็ตามคืน file bytes/mode/path และ directory
   state ก่อนเรียกครบถ้วน

## REQ-3 acceptance

- REQ-3.1–REQ-3.5: ไม่พบ regression ใหม่ใน scope นี้
- REQ-3.6: ยังไม่ผ่าน เพราะ accepted batch สามารถ overwrite stale final state แล้ว
  append `ACTION_APPLIED`
- REQ-3.7: ยังไม่ผ่าน เพราะ failed restore batch อาจคืน snapshot ไม่ครบ
- REQ-3.8: duplicate routing เดิมไม่พบ finding แยก แต่ idempotent guarantee ยัง
  รับไม่ได้ตราบใดที่ underlying replay/rollback transaction ไม่ atomic
- REQ-3.9–REQ-3.11: ไม่พบ regression ใหม่ใน scope นี้

## Verification

- focused Task 30:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'Task 30' src/executor/executor.test.ts src/security/amended-command-contract.test.ts`
  — 14 pass, 0 fail
- safe temp final-component race probe — reproduce accepted lost update
- safe temp generated recovery-prune probe — reproduce rejected batch ที่ทำ captured
  file หายหลัง rollback
- production/spec/tests/tasks ไม่ถูกแก้; เพิ่มเฉพาะ handoff นี้
- external real-macOS suite ไม่ได้รันตาม cooldown ถึง
  2026-08-02 11:46 Asia/Bangkok

## Handoff

- Task 3 ต้องคง `[ ]`
- ห้าม mark P0-03 complete, commit/push หรือเริ่ม P0-04
- Builder ต้องแก้ High ทั้งสองข้อ เพิ่ม regressions และส่ง fresh-context acceptance
  review ใหม่
