# Design: เอกสาร SDD ภาษาไทย

> Status: draft

## Architecture Overview

ใช้ TASK_PROTOCOL เป็นนโยบายกลางเดิม ให้ skill ต้นทางและ template อ้างนโยบายก่อนสร้างผลลัพธ์
wrapper ใช้ต้นทางร่วมกัน แปลเฉพาะข้อความสำหรับผู้อ่านและ placeholder โดยคงหัวข้อบังคับ

## Technology Decisions

แก้เอกสารและเพิ่ม fixture ในชุดทดสอบ shell เดิม ไม่เพิ่ม dependency
ตัวตรวจยอมรับรูปประโยคไทยที่กำหนดใน EARS.md โดยยังยอมรับอังกฤษเดิม
คงเอกสารเก่าและ dirty changes ที่มีอยู่ก่อนเริ่มงาน

## Testing Strategy

REQ-1 ตรวจ diff ของต้นทางและ pointer ทุก harness ด้วยการอ่านจริง
REQ-2 ใช้ fixture ภาษาไทยใน spec-slice.test.sh ทดสอบ slice, trace และ Evidence ทั้งทางผ่านและทางปฏิเสธ
รันชุด spec-slice, check-evidence และตรวจ whitespace ก่อนส่งมอบ

## รูปแบบเอกสารที่อ่านง่าย

REQ-3 ใช้ระยะเยื้องสองช่องภายในรายการงาน เว้นบรรทัดก่อนและหลัง `Evidence:`
เพื่อให้ตัวแสดง Markdown แยกหัวข้อหลักฐานและรายการตรวจ ไม่ใส่บรรทัดว่างก่อนข้อมูลอ้างอิง
เพราะตัวอ่านงานใช้บรรทัดว่างเป็นขอบเขตข้อมูล ทดสอบการส่งต่อคำสั่งและขอบเขตหลักฐานด้วย
ตัวอ่านจริง และตรวจโครงสร้างที่แสดงผลด้วย Pandoc ที่ติดตั้งอยู่แล้ว

## Requirement Traceability

| Design element | REQ | Section |
|---|---|---|
| นโยบายกลางและต้นทางภาษาไทย | REQ-1 | Architecture Overview |
| คงรูปแบบและพิสูจน์ด้วย fixture ภาษาไทย | REQ-2 | Testing Strategy |
| หลักฐานแยกย่อหน้าและรายการย่อย | REQ-3 | รูปแบบเอกสารที่อ่านง่าย |
