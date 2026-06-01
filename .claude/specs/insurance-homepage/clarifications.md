# Clarifications — insurance-homepage

Workflow: **Requirements-First** (Requirements → Design → Tasks, มี gate ทุก artifact)
Source brief: prompt "Insurance Homepage" (Next.js 16 portal) — เก็บใน conversation วันที่ 2026-06-01

## Decisions (จากคำถาม clarify)

1. **สูตรคำนวณเบี้ย: แยกสูตรต่อประเภท**
   - แต่ละประเภท (ชีวิต/สุขภาพ/รถ/เดินทาง/อุบัติเหตุ/บ้าน/มะเร็ง/สะสมทรัพย์) มี rate factor + สูตรของตัวเอง
   - input: อายุ + ทุนประกัน → เบี้ยโดยประมาณ. สูตรอยู่ใน `app/lib/premium.ts` มีคอมเมนต์
   - acceptance #4: ผลต้องตรงสูตร deterministic → testable

2. **รูปการ์ด: picsum.photos**
   - ประเภท/โปรโมชั่น/บทความ ใช้ next/image + `images.remotePatterns` ชี้ picsum.photos
   - ⚠️ ความเสี่ยง: ต้องมีเน็ตตอน demo; ถ้าออฟไลน์รูป broken (ขัด checklist #11)
   - hero / phone mockup / ไอคอน = inline SVG เสมอ (ไม่พึ่งเน็ต)

3. **ช่วง validation เครื่องคำนวณ: อายุ 18–70, ทุนประกัน 100,000–10,000,000**
   - นอกช่วง / ติดลบ / ว่าง → error ชัดเจน, ไม่คำนวณ (acceptance #5)

4. **ขอบเขต implement: ทำรวดเดียวทั้งหมด** (`/spec-implement all`)
   - แต่ requirements/design/tasks ยังผ่าน gate review ตามปกติ
