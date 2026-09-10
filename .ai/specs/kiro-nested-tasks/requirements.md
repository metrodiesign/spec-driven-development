# ข้อกำหนด: รายการงานสองระดับแบบ Kiro
> Status: draft

## ภาพรวม

ปรับ `tasks.md` ให้แสดง task หลักและขั้นตอนย่อยแบบ checkbox สองระดับ โดยคง task หลักเป็นหน่วย execution เดิม และทำให้ตัวอ่านทุกตัวรักษา ownership ของ metadata กับ Evidence ตรงกัน

## REQ-1: รูปแบบรายการงานสองระดับ

**ความต้องการของผู้ใช้:** ในฐานะผู้ใช้ SDD ฉันต้องการเห็น task หลักและขั้นตอนย่อยแบบ Kiro เพื่ออ่านลำดับงานและสถานะได้ง่าย

**เกณฑ์การยอมรับ:**

- 1.1 ระบบต้องรับ root task รูป `- [ ] N.` หรือ `- [x] N.` ที่ column 0
- 1.2 ระบบต้องรับ child task รูป `  - [ ] N.M` หรือ `  - [x] N.M` ที่เยื้องสองช่องและมีเลขหลักตรงกับ root ปัจจุบัน
- 1.3 ระบบต้องรับรายละเอียดของ root ที่เยื้องสองช่องและรายละเอียดของ child ที่เยื้องสี่ช่อง
- 1.4 ระบบต้องคง block เดิมเมื่อมีบรรทัดว่างระหว่าง headline, metadata, child และ Evidence
- 1.5 ระบบต้องแสดงไฟล์ที่ถูกต้องผ่าน standard Markdown preview โดย checkbox สองระดับยังอยู่ใต้ parent ที่ถูกต้อง

## REQ-2: Grammar และ validation

**ความต้องการของผู้ใช้:** ในฐานะผู้ดูแล framework ฉันต้องการ grammar ที่ deterministic เพื่อให้ consumer ทุกตัวตีความ hierarchy เหมือนกัน

**เกณฑ์การยอมรับ:**

- 2.1 หากพบ root ordinal ซ้ำ ระบบต้องปฏิเสธเอกสารพร้อมระบุ ordinal และบรรทัดที่ผิด
- 2.2 หากพบ child ordinal ซ้ำ ระบบต้องปฏิเสธเอกสารพร้อมระบุ ordinal และบรรทัดที่ผิด
- 2.3 หากพบ child ที่ไม่มี root หรือเลขหลักไม่ตรงกับ root ปัจจุบัน ระบบต้องปฏิเสธเอกสาร
- 2.4 หากพบ task ลึกกว่า `N.M` ระบบต้องปฏิเสธเอกสาร
- 2.5 ระบบต้องรับ flat legacy task ที่มีเฉพาะ root โดยไม่เปลี่ยนความหมายเดิม

## REQ-3: Metadata และ traceability

**ความต้องการของผู้ใช้:** ในฐานะผู้สร้าง Goal ฉันต้องการให้ metadata ของ parent และ child มี ownership ชัดเจน เพื่อไม่สร้าง execution contract ปลอม

**เกณฑ์การยอมรับ:**

- 3.1 ระบบต้องรวม `Satisfies:` ของ root และ children เป็น REQ coverage ของ root execution unit
- 3.2 ระบบต้องใช้ `Verify:` ของ root เท่านั้นเป็น authoritative integration command ของ Goal
- 3.3 ระบบต้องเก็บ `Verify:` ของ child เป็น documentation โดยไม่ concatenate เข้า Goal
- 3.4 ระบบต้องไม่นับข้อความ `Satisfies:` หรือ `Verify:` ภายใน fenced block หรือ Evidence transcript เป็น metadata
- 3.5 ระบบต้องสร้าง Goal task หนึ่งรายการต่อ root โดยใช้ ID `T-N`

## REQ-4: Evidence และสถานะเสร็จ

**ความต้องการของผู้ใช้:** ในฐานะผู้ตรวจงาน ฉันต้องการหลักฐานแยกตาม checkbox เพื่อเชื่อถือสถานะของแต่ละขั้นและ task หลัก

**เกณฑ์การยอมรับ:**

- 4.1 เมื่อ child ถูก mark `[x]` ระบบต้องกำหนดให้ child นั้นมี Evidence ของตนเอง
- 4.2 เมื่อ root ถูก mark `[x]` ระบบต้องกำหนดให้ children ทุกตัวถูก mark `[x]`
- 4.3 เมื่อ root ถูก mark `[x]` ระบบต้องกำหนดให้ root มี Evidence ของตนเอง
- 4.4 ระบบต้องกำหนด Evidence หลัง children ทั้งหมดให้เป็นของ root
- 4.5 ระบบต้องไม่ให้ Evidence ของ root หรือ sibling ใช้แทน Evidence ของ child

## REQ-5: Execution และ projection

**ความต้องการของผู้ใช้:** ในฐานะผู้รันงาน ฉันต้องการให้ hierarchy เป็นรายละเอียดภายใน task หลัก เพื่อไม่เปลี่ยน scheduling และต้นทุนเดิม

**เกณฑ์การยอมรับ:**

- 5.1 ระบบต้องให้ CLI, dependency graph, `Batch:` และ pane scheduling เลือกได้เฉพาะ root ordinal
- 5.2 เมื่อ slice root ระบบต้องคืน root พร้อม children และรายละเอียดทั้งหมดแบบ verbatim
- 5.3 หากเลือก child ordinal โดยตรง ระบบต้องปฏิเสธว่าไม่ใช่ executable task ID
- 5.4 ระบบต้องนับ task metrics และ cost ledger จาก root เท่านั้น
- 5.5 ระบบต้องถือว่า root ยังไม่เสร็จขณะที่มี child ค้าง

## REQ-6: GitHub และ compatibility

**ความต้องการของผู้ใช้:** ในฐานะทีมพัฒนา ฉันต้องการ projection ไป GitHub และเครื่องมือเดิมที่ไม่เพิ่มจำนวน execution unit เพื่อรักษา workflow ปัจจุบัน

**เกณฑ์การยอมรับ:**

- 6.1 เมื่อ sync GitHub ระบบต้องสร้าง task issue หนึ่งรายการต่อ root เท่านั้น
- 6.2 เมื่อ sync GitHub ระบบต้องแสดง children เป็น checklist ภายใน body ของ root issue
- 6.3 ระบบต้องไม่สร้าง manifest key หรือ GitHub issue แยกสำหรับ child
- 6.4 ระบบต้องปฏิเสธ archive ขณะที่ root หรือ child ใดยังไม่เสร็จ
- 6.5 ระบบต้องรองรับรูปแบบใหม่โดยไม่เพิ่ม production dependency
- 6.6 ระบบต้องไม่กำหนดให้ migrate active หรือ archived flat specs ย้อนหลัง

## กรณีพิเศษและคำถามที่ยังไม่ยุติ

ไม่มีคำถาม design ค้างอยู่ การเปลี่ยนแปลงใช้กับ spec ที่สร้างหรือแก้เป็นรูปแบบใหม่ ส่วนไฟล์แบบแบนเดิมทำงานต่อได้
