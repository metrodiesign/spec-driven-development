# Design — SDD framework distribution

> Status: draft

สถานะ `draft` หมายถึงยังไม่ได้บันทึก phase approval ของเอกสาร design เท่านั้น ไม่ใช่สถานะของ implementation ซึ่งทำเสร็จและผ่าน verification แล้ว

เครื่องมือใช้ source Git object database เป็น immutable snapshot และยืนยัน consumer lock กับ source snapshot ที่เชื่อถือได้ก่อนใช้ lock เป็นหลักฐาน ownership ของ managed paths การที่ offline `status` ผ่านพิสูจน์ได้เพียง self-consistency และ local drift ไม่ได้พิสูจน์ source provenance

## Components

| Component | Responsibility |
|---|---|
| `scripts/sdd-framework.mjs` | Parse commands, validate snapshot, plan operations และ commit transaction |
| `.ai/distribution/framework-manifest.json` | ระบุ source-to-target allowlist, mode และ reference boundaries |
| `.ai/sdd-framework.lock.json` | เก็บ exact revision, version, identity และ per-file hash/mode |
| Consumer Git root | เก็บ managed payload และ project-owned files ร่วมกันโดยแยก ownership |

## Snapshot flow

1. Resolve `--source` เป็น exact Git root และ `--ref` เป็น full commit OID
2. อ่าน manifest ด้วย `git show <oid>:<path>`
3. Validate schema, source/target paths, duplicates, modes และ required references
4. อ่าน blobs และ modes จาก commit OID เดิม
5. คำนวณ per-file hash และ aggregate identity แบบ deterministic

## Mutation flow

1. Validate target เป็น exact Git root และตรวจ lock/path types
2. Preflight old managed hashes, collisions และ symlink ทั้งชุด
3. Stage desired bytes และ backup affected files ใน transaction directory
4. Recheck observed target state ก่อน operation แต่ละรายการ
5. Commit operations ตาม target path order และ rename lock เป็นขั้นสุดท้าย
6. เมื่อ write failure ถูกจับ ให้ rollback journal ย้อนลำดับ

## Identity

Aggregate SHA-256 ครอบ manifest bytes และ record ที่เรียงตาม target ดังนี้

```text
sdd-framework-content-v1\0
<manifest-sha256>\n
<target>\0<mode>\0<file-sha256>\n
```

Revision แยกอยู่ใน lock เพื่อให้ revision ต่างที่ payload เดียวกันมี identity เดียวกัน แต่ `check` ยังตรวจ exact revision

## Exit codes

| Code | Meaning |
|---|---|
| `0` | สำเร็จหรือ state ตรง |
| `1` | `status` หรือ `check` พบ not-installed, drift หรือ desired mismatch |
| `2` | Usage, source, revision หรือ manifest ไม่ถูกต้อง |
| `3` | Target conflict ก่อน mutation |
| `4` | Mutation ล้มเหลวและ rollback ครบ |
| `5` | Rollback ไม่ครบและเก็บ recovery transaction |

## Payload boundary

Manifest ระบุทุกไฟล์ด้วย exact source และ target ไม่รวม project specs, project context, coding standards, lessons, package metadata, CI, root front door หรือ harness activation config

## Requirement Traceability

| REQ | Section |
|---|---|
| REQ-1 | Snapshot flow |
| REQ-2 | Identity |
| REQ-3 | Mutation flow |
| REQ-4 | Mutation flow |
| REQ-5 | Mutation flow |
| REQ-6 | Mutation flow |
| REQ-7 | Components |
| REQ-8 | Components |
| REQ-9 | Snapshot flow |
| REQ-10 | Payload boundary |
| REQ-11 | Snapshot flow |
| REQ-12 | Snapshot flow |
| REQ-13 | Mutation flow |
| REQ-14 | Snapshot flow |
