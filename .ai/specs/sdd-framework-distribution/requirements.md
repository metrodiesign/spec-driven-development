# Requirements — SDD framework distribution

> Status: draft

เอกสารนี้กำหนดพฤติกรรมของเครื่องมือกระจาย SDD framework จาก Git revision ไปยัง consumer repository แบบ local และ reproducible

สถานะ `draft` หมายถึงยังไม่ได้บันทึก phase approval ของเอกสาร requirements เท่านั้น ไม่ใช่สถานะของ implementation ซึ่งทำเสร็จและผ่าน verification แล้ว

## REQ-1: Source snapshot

- 1.1 WHEN CLI โหลด source snapshot, THE SYSTEM SHALL resolve revision เป็น full commit OID และอ่าน manifest กับ blobs จาก commit นั้นเท่านั้น

## REQ-2: Content identity

- 2.1 WHEN snapshot ผ่าน validation, THE SYSTEM SHALL สร้าง SHA-256 ต่อไฟล์และ aggregate identity จาก manifest bytes, target, mode และ file hash

## REQ-3: Install

- 3.1 WHEN `install` พบ target Git root ที่ยังไม่มี lock และไม่มี collision, THE SYSTEM SHALL ติดตั้ง payload พร้อม mode และ lock
- 3.2 WHEN desired snapshot เดิมติดตั้งแล้วและ local state สะอาด, THE SYSTEM SHALL สำเร็จแบบ no-op

## REQ-4: Adopt

- 4.1 WHEN `adopt` พบ existing payload ที่ bytes และ mode ตรง snapshot ทุกไฟล์, THE SYSTEM SHALL เขียน lock เท่านั้น
- 4.2 IF existing payload ไม่ตรงหรือขาดไฟล์, THEN THE SYSTEM SHALL ไม่แก้ consumer

## REQ-5: Update

- 5.1 WHEN `update` ทำงาน, THE SYSTEM SHALL ตรวจ old managed state ทั้งหมดก่อน mutation และเพิ่ม เปลี่ยน หรือลบเฉพาะ managed paths

## REQ-6: Rollback

- 6.1 IF mutation ที่ CLI จับได้ล้มเหลว, THEN THE SYSTEM SHALL rollback payload และ lock กลับสภาพเดิมครบ หรือเก็บ recovery transaction เมื่อ rollback ไม่ครบ

## REQ-7: Offline status

- 7.1 WHEN `status` ทำงานโดยไม่มี source checkout, THE SYSTEM SHALL ตรวจ lock self-consistency และ local bytes กับ mode พร้อมรายงาน revision, identity และ drift

## REQ-8: Desired check

- 8.1 WHEN `check` ทำงานกับ source และ revision, THE SYSTEM SHALL exit 0 เฉพาะเมื่อ local state สะอาดและ lock ตรง desired revision กับ identity

## REQ-9: Manifest validation

- 9.1 WHEN `validate` ทำงาน, THE SYSTEM SHALL ปฏิเสธ schema, path, target, mode, Git object หรือ required reference ที่ไม่ถูกต้อง

## REQ-10: Payload boundary

- 10.1 WHILE CLI ทำงาน, THE SYSTEM SHALL ไม่ใช้ไฟล์นอก explicit manifest เป็น drift verdict หรือ mutation target

## REQ-11: Exact Git roots

- 11.1 IF source หรือ target ไม่ใช่ exact Git root, THEN THE SYSTEM SHALL ปฏิเสธก่อน mutation

## REQ-12: Path safety

- 12.1 IF managed path เป็น absolute, traversal, malformed, duplicate, case duplicate, parent-child overlap หรือ consumer-owned reserved path, THEN THE SYSTEM SHALL ปฏิเสธ manifest หรือ lock

## REQ-13: Target ownership

- 13.1 IF target parent หรือ leaf เป็น symlink หรือชนกับ local content ที่พิสูจน์ ownership ไม่ได้, THEN THE SYSTEM SHALL ปฏิเสธก่อน mutation

## REQ-14: Git object type

- 14.1 WHEN snapshot ถูกอ่าน, THE SYSTEM SHALL รับเฉพาะ regular Git blob mode `100644` หรือ `100755`

## ข้อจำกัด

- ไม่มี network fetch, registry, signature, config merge หรือ fleet manager
- ไม่ activate hooks, MCP, CI หรือ per-machine trust อัตโนมัติ
- ไม่รวม optional retro, GitHub sync, cost accounting หรือ pane loop
