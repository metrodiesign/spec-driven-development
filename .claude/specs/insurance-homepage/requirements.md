# Requirements: Insurance Homepage

## Overview

หน้าแรกพอร์ทัลบริษัทประกันภัย (อ้างอิงแบรนด์วิริยะ กรมท่า+เหลืองทอง) — เว็บองค์กรเนื้อหาแน่น
12+ section รันได้ทันทีด้วย `npm install && npm run dev`. ผูกกับ product.md: ทดสอบคุณภาพ
**ดีไซน์ + ตรรกะคำนวณเบี้ย** ในงานชิ้นเดียวพร้อมนำเสนอ. ทุก requirement ต้องตรวจได้ด้วยตา/DevTools
ที่ viewport 375 / 768 / 1440px. ดู `clarifications.md` สำหรับ decision ที่ตกลงแล้ว.

---

## REQ-1: ความครบของ section (Page Composition)

**User Story:** As ผู้ประเมิน, I want เห็นครบทุก section ตามลำดับ IA พอร์ทัล, so that งานดูเป็นเว็บองค์กรที่สมบูรณ์.
**Acceptance Criteria (EARS):**

- 1.1 WHEN หน้า homepage โหลดเสร็จ THE SYSTEM SHALL แสดง section ตามลำดับบนลงล่าง: utility bar, sticky header, hero, ประเภทประกัน, บริการ, โปรโมชั่น, เครื่องคำนวณเบี้ย, แถบสถิติ, บทความ, testimonials, ดาวน์โหลดแอป, footer.
- 1.2 THE SYSTEM SHALL จัดเนื้อหาทุก section ภายใน container กึ่งกลาง max-width 1200–1280px + padding ซ้าย/ขวาเท่ากัน.
- 1.3 THE SYSTEM SHALL ไม่ทำให้ element ใดล้นจอแนวนอน (horizontal overflow) ที่ทุก viewport ยกเว้น slider ที่ตั้งใจให้เลื่อน.
- 1.4 THE SYSTEM SHALL ใช้ spacing scale สม่ำเสมอ (4/8/12/16/24/32/48/64) ทั้งหน้า และไม่มี dead space ขนาดใหญ่ที่ไม่ได้ตั้งใจ.

## REQ-2: Utility Bar

**User Story:** As ลูกค้าเดิม, I want แถบเครื่องมือด้านบน, so that เข้าถึงบัญชี/ภาษา/ค้นหาได้เร็ว.
**Acceptance Criteria (EARS):**

- 2.1 THE SYSTEM SHALL แสดงแถบ utility บนสุด (พื้นกรมท่า มีเส้น accent) ที่มี: ตัวเลือกช่องทาง, "กรมธรรม์ของฉัน/บัตรลูกค้า", สลับภาษา TH/EN, สกุลเงิน, ช่องค้นหา, เข้าสู่ระบบ/สมัครสมาชิก, ไอคอนตะกร้า/โปรไฟล์.
- 2.2 WHEN viewport ≤ 768px THE SYSTEM SHALL ยุบ/จัดเรียง utility bar ใหม่อย่างเรียบร้อยโดยไม่ overflow.
- 2.3 WHEN ผู้ใช้คลิกสลับภาษา TH/EN THE SYSTEM SHALL toggle สถานะปุ่ม (UI เท่านั้น ไม่ต้องแปลทั้งหน้า — ดู product.md non-goals).

## REQ-3: Sticky Header + Navigation

**User Story:** As ผู้เยี่ยมชม, I want เมนูหลักติดบนเสมอ, so that นำทางได้ทุกตำแหน่งที่เลื่อน.
**Acceptance Criteria (EARS):**

- 3.1 THE SYSTEM SHALL แสดง header แบบ sticky ที่มีโลโก้, เมนูหลัก (ผลิตภัณฑ์/คำนวณเบี้ย/แจ้งเคลม/เกี่ยวกับเรา/บทความ), สายด่วนโทร.
- 3.2 WHILE ผู้ใช้ hover/focus เมนูที่มีรายการย่อย THE SYSTEM SHALL แสดง dropdown ที่ใช้งานได้.
- 3.3 WHEN viewport ≤ 768px THE SYSTEM SHALL ยุบเมนูหลักเป็นปุ่ม hamburger.
- 3.4 WHEN ผู้ใช้กดปุ่ม hamburger THE SYSTEM SHALL เปิด/ปิดเมนูมือถือได้ (toggle).
- 3.5 WHEN เมนู dropdown หรือเมนูมือถือเปิดอยู่ และผู้ใช้กด ESC THE SYSTEM SHALL ปิดเมนูและคืน focus ไปยังปุ่มที่เปิด. _(แก้ L)_

## REQ-4: Hero (Split Left-Right)

**User Story:** As ผู้เยี่ยมชม, I want hero ที่มีทางลัดและแคมเปญเด่น, so that เริ่มทำงานสำคัญหรือเห็นโปรได้ทันที.
**Acceptance Criteria (EARS):**

- 4.1 THE SYSTEM SHALL แสดงการ์ดแผงทางลัดด้านซ้าย: ลิงก์เข้าสู่ระบบ/สมัครสมาชิก + ไอคอนทางลัด 4 อัน (ซื้อประกัน/เช็กกรมธรรม์/แจ้งเคลม/ติดต่อเรา) + ลิงก์ "ไปยังแผนยอดนิยม".
- 4.2 WHEN ผู้ใช้คลิกการ์ดทางลัดใด THE SYSTEM SHALL ตอบสนองได้ (คลิกได้/เป็นลิงก์ — ปลายทางเป็น placeholder ได้).
- 4.3 THE SYSTEM SHALL แสดงแบนเนอร์แคมเปญด้านขวา พื้นกรมท่าตัดเหลือง/ทอง พร้อมภาพประกอบ/กราฟิก inline SVG จริง + ปุ่ม CTA สีเหลืองทอง.
- 4.4 WHEN viewport ≤ 768px THE SYSTEM SHALL จัด hero เป็นแนวตั้ง (ซ้อนบนล่าง) โดยไม่ overflow.

## REQ-5: ประเภทประกัน (Insurance Types Grid + Filter)

**User Story:** As ผู้หาซื้อประกัน, I want เห็นและกรองประเภทประกัน, so that หาแผนที่สนใจได้.
**Acceptance Criteria (EARS):**

- 5.1 THE SYSTEM SHALL แสดงกริดการ์ดประเภทประกันอย่างน้อย 6 ใบ (ชีวิต/สุขภาพ/รถยนต์/เดินทาง/อุบัติเหตุ/บ้าน/มะเร็ง/สะสมทรัพย์) โดยแต่ละใบมีรูปจริง + ชื่อ + ป้ายกำกับ + ลิงก์ดูแผน.
- 5.2 THE SYSTEM SHALL แสดงแถบค้นหา + ตัวกรองเหนือกริด (ตัวกรองนี้เป็น state อิสระของ section ประเภทประกัน ไม่ใช้ร่วมกับ section อื่น).
- 5.3 WHEN ผู้ใช้เลือกตัวกรองประเภท THE SYSTEM SHALL แสดงเฉพาะการ์ดที่ตรงตัวกรอง.
- 5.4 WHEN ผู้ใช้พิมพ์ข้อความในช่องค้นหา THE SYSTEM SHALL กรองการ์ดแบบ live ตามชื่อ/ป้ายกำกับ (case-insensitive). _(แก้ D)_
- 5.5 IF ตัวกรอง/ค้นหาไม่เหลือผลลัพธ์ THEN THE SYSTEM SHALL แสดงข้อความสถานะว่าง (เช่น "ไม่พบประเภทประกันที่ตรงเงื่อนไข") แทนกริดว่าง. _(แก้ I)_
- 5.6 THE SYSTEM SHALL ปรับคอลัมน์กริดตามจอ: ~4 (desktop) → 2 (tablet) → 1 (mobile) โดยการ์ดในแถวเดียวกันสูงเท่ากัน.

## REQ-6: บริการของเรา (Services)

**User Story:** As ลูกค้า, I want เห็นบริการหลักทั้งหมด, so that ไปยังงานที่ต้องการได้.
**Acceptance Criteria (EARS):**

- 6.1 THE SYSTEM SHALL แสดงแถวบริการอย่างน้อย 12 รายการ แต่ละรายการมี inline SVG icon + ป้ายชื่อ (เช่น ซื้อออนไลน์, แจ้งเคลม, ต่ออายุ, เปลี่ยนแผน, ปรึกษาตัวแทน, ดาวน์โหลดกรมธรรม์, ตรวจสถานะเคลม, ชำระเบี้ย, โรงพยาบาลคู่สัญญา, สะสมแต้ม).
- 6.2 THE SYSTEM SHALL แสดงลิงก์ "ดูทั้งหมด".
- 6.3 THE SYSTEM SHALL จัด layout บริการให้ปรับตามจอโดยไม่ overflow และไม่มี dead space.

## REQ-7: แพ็กเกจและโปรโมชั่น (Promotions Grid)

**User Story:** As ผู้หาซื้อ, I want เห็นโปรโมชั่นพร้อมราคา, so that เปรียบเทียบและเลือกซื้อได้.
**Acceptance Criteria (EARS):**

- 7.1 THE SYSTEM SHALL แสดงกริดการ์ดโปรโมชั่นอย่างน้อย 8 ใบ แต่ละใบมี: รูปจริง, ชื่อแผน, ป้ายหมวด, เบี้ย/ราคาปัจจุบัน, ราคาเดิมแบบขีดฆ่า, วันหมดเขต, ปุ่ม "รายละเอียด" + "ซื้อเลย".
- 7.2 THE SYSTEM SHALL แสดงตัวเลือกช่องทาง/สกุลเงินเหนือกริด (selector สกุลเงินเป็น UI เท่านั้น — ไม่แปลงตัวเลขราคาจริง สอดคล้อง non-goal). _(แก้ F)_
- 7.3 WHEN ผู้ใช้เลือกตัวกรองประเภทประกันของ section โปรโมชั่น THE SYSTEM SHALL กรองการ์ดโปรโมชั่นให้เหลือเฉพาะที่ตรง (state อิสระจากตัวกรองใน REQ-5). _(แก้ A)_
- 7.4 IF ตัวกรองไม่เหลือผลลัพธ์ THEN THE SYSTEM SHALL แสดงข้อความสถานะว่างแทนกริดว่าง. _(แก้ I)_
- 7.5 THE SYSTEM SHALL ปรับคอลัมน์ ~4→2→1 ตามจอ การ์ดสูงเท่ากันในแถวเดียว.

## REQ-8: เครื่องคำนวณเบี้ยประกัน (Premium Calculator)

**User Story:** As ผู้สนใจซื้อ, I want คำนวณเบี้ยโดยประมาณเอง, so that ประเมินค่าใช้จ่ายก่อนตัดสินใจ.
**Acceptance Criteria (EARS):**

- 8.1 THE SYSTEM SHALL ให้ผู้ใช้เลือกประเภทประกัน และกรอกอายุกับทุนประกันผ่าน `<input type="number">`. _(แก้ E)_
- 8.2 WHEN ผู้ใช้กดปุ่ม "คำนวณ" (หรือ blur ออกจากฟิลด์สุดท้าย) และ input ผ่าน validation ครบ THE SYSTEM SHALL คำนวณและแสดงเบี้ยโดยประมาณ. การคำนวณ trigger ที่จังหวะนี้เท่านั้น ไม่ใช่ทุก keystroke (กัน error กระพริบระหว่างพิมพ์). _(แก้ B)_
- 8.3 THE SYSTEM SHALL คำนวณเบี้ยด้วยสูตรเฉพาะของแต่ละประเภทประกัน (per-type rate factor) แบบ deterministic — input ชุดเดียวกันให้ผลเดิมเสมอ.
- 8.4 THE SYSTEM SHALL แสดงเบี้ยเป็น **เบี้ยรายปี หน่วยบาท ปัดเป็นจำนวนเต็ม** (ปัดลง/`Math.round` — ระบุชัดใน design) เพื่อให้ค่าคาดหวังของ acceptance test แน่นอน. _(แก้ C)_
- 8.5 IF อายุ < 18 หรือ > 70 THEN THE SYSTEM SHALL แสดง error และไม่คำนวณ (ค่าขอบ 18 และ 70 ถือว่า valid).
- 8.6 IF ทุนประกัน < 100,000 หรือ > 10,000,000 THEN THE SYSTEM SHALL แสดง error และไม่คำนวณ (ค่าขอบ 100,000 และ 10,000,000 ถือว่า valid).
- 8.7 IF อายุหรือทุนประกันเว้นว่าง/NaN/ติดลบ หรือยังไม่เลือกประเภท THEN THE SYSTEM SHALL แสดง error ที่ชัดเจนและไม่คำนวณ.
- 8.8 THE SYSTEM SHALL แยก logic คำนวณ+validate ไว้ใน `app/lib/premium.ts` (ไม่ฝังสูตรใน JSX) เพื่อให้ทดสอบได้.

## REQ-9: แถบสถิติความน่าเชื่อถือ (Stats)

**Acceptance Criteria (EARS):**

- 9.1 THE SYSTEM SHALL แสดงแถบตัวเลขความน่าเชื่อถืออย่างน้อย 4 รายการ (จำนวนลูกค้า, อัตราจ่ายเคลม %, ปีที่ก่อตั้ง, สินทรัพย์) บนพื้น section เด่น.

## REQ-10: บทความ/ความรู้ (Articles Grid)

**Acceptance Criteria (EARS):**

- 10.1 THE SYSTEM SHALL แสดงกริดการ์ดบทความอย่างน้อย 8 ใบ แต่ละใบมี: รูปจริง, หัวข้อ, ป้ายหมวด, ผู้เขียน (avatar) + วันที่.
- 10.2 THE SYSTEM SHALL ปรับคอลัมน์ ~4→2→1 ตามจอ การ์ดสูงเท่ากันในแถวเดียว.

## REQ-11: เสียงจากลูกค้า (Testimonials Slider)

**Acceptance Criteria (EARS):**

- 11.1 THE SYSTEM SHALL แสดงรีวิวลูกค้าอย่างน้อย 3 รายการในรูปแบบสไลด์ พร้อมปุ่ม/จุดบอกตำแหน่ง.
- 11.2 WHEN ผู้ใช้กดเลื่อนสไลด์ THE SYSTEM SHALL แสดงรายการถัดไป/ก่อนหน้าได้.

## REQ-12: ดาวน์โหลดแอป (App Download + Phone Mockup)

**Acceptance Criteria (EARS):**

- 12.1 THE SYSTEM SHALL แสดง phone mockup ที่มี UI จำลองข้างใน (status bar, การ์ดกรมธรรม์, ปุ่ม, ข้อความจำลอง) — ห้ามเป็นกล่องว่าง.
- 12.2 THE SYSTEM SHALL แสดงปุ่ม App Store และ Google Play.

## REQ-13: Footer ไดเรกทอรีหลายคอลัมน์

**Acceptance Criteria (EARS):**

- 13.1 THE SYSTEM SHALL แสดง footer พื้นกรมท่าหลายคอลัมน์: ผลิตภัณฑ์แยกหมวด, ศูนย์บริการ/สาขาแยกภาค, เกี่ยวกับเรา, ปุ่มแอป, โซเชียล, ใบอนุญาตประกอบธุรกิจประกัน, ลิขสิทธิ์.
- 13.2 WHEN viewport ≤ 768px THE SYSTEM SHALL ยุบ/จัดเรียงคอลัมน์ footer ใหม่อย่างเรียบร้อยโดยไม่ overflow.

## REQ-14: ความสมบูรณ์ด้านภาพ (Visual Completeness)

**User Story:** As ผู้ประเมิน, I want งานดูเสร็จพร้อมใช้จริง, so that ไม่เห็นกล่องว่าง/ฟอนต์ระบบ/พื้นที่ผิดปกติ.
**Acceptance Criteria (EARS):**

- 14.1 THE SYSTEM SHALL โหลดเว็บฟอนต์ไทยจริงผ่าน Google Fonts และใช้เป็นฟอนต์หลักทั้งเอกสาร — ห้ามตกไปใช้ฟอนต์ระบบ.
- 14.2 THE SYSTEM SHALL กำหนด typographic scale ชัดเจน (h1/h2/h3/body/caption) โดย body line-height ≥ 1.5 และสระไทยบน-ล่างไม่ตัดกัน.
- 14.3 THE SYSTEM SHALL ไม่ใช้สี่เหลี่ยมสีเดียว/กล่อง gradient ว่างเป็น placeholder — ทุกพื้นที่ภาพต้องมีเนื้อหา (รูปจริง / inline SVG มีรายละเอียด / gradient+ลวดลายที่จัดองค์ประกอบ).
- 14.4 THE SYSTEM SHALL ให้ทุก `<img>` มี `alt` และโหลดได้จริง (ไม่ broken).
- 14.5 THE SYSTEM SHALL แสดงไอคอนทุกตัวเป็น inline SVG ที่มีรูปทรงจริง.
- 14.6 IF รูปจาก picsum.photos โหลดไม่สำเร็จ (เช่น ออฟไลน์) THEN THE SYSTEM SHALL แสดง inline SVG placeholder ที่มีรายละเอียด (ไม่ใช่กล่องเทาว่าง) แทน เพื่อไม่ละเมิด REQ-14.3/14.4. _(แก้ G)_
- 14.7 THE SYSTEM SHALL กำหนดขนาด/aspect-ratio คงที่ให้ทุกรูป (width/height หรือ aspect-ratio + ตำแหน่งสำรอง) เพื่อกัน layout shift (CLS) ตอนรูป remote โหลด. _(แก้ H)_

## REQ-15: Design Tokens, Brand Palette & States

**Acceptance Criteria (EARS):**

- 15.1 THE SYSTEM SHALL นิยาม design tokens (สี primary/primary-dark/accent/bg/surface/text/muted/border, รัศมี, เงา, spacing, ฟอนต์) ที่เดียวใน `tailwind.config.ts` → `theme.extend` และเรียกผ่าน semantic utility class — ห้าม hardcode สีดิบซ้ำๆ.
- 15.2 THE SYSTEM SHALL ใช้พาเลตวิริยะ: primary กรมท่า ~#13266B, primary-dark ~#0E1C50, accent เหลืองทอง ~#FDB913, bg ~#F5F7FB, surface ขาว, text ~#1A2238 — กรมท่าเป็นพื้น section เด่น, เหลืองทองเป็นปุ่มหลัก/ราคา/แบนเนอร์.
- 15.3 THE SYSTEM SHALL ให้ปุ่ม/การ์ด/อินพุต มี state ครบ: default, hover, focus (มี focus ring), active, disabled (ถ้ามี) พร้อม transition 150–250ms.
- 15.4 THE SYSTEM SHALL ให้เงาและรัศมีมุมสอดคล้องกันทั้งหน้า.

## REQ-16: Responsive & Accessibility

**Acceptance Criteria (EARS):**

- 16.1 THE SYSTEM SHALL แสดงผลถูกต้องไม่พังที่ 375px / 768px / 1440px.
- 16.2 THE SYSTEM SHALL ใช้ semantic HTML และมี `alt`/`aria-label` ตามจำเป็น.
- 16.3 THE SYSTEM SHALL ให้ผู้ใช้นำทางด้วยคีย์บอร์ดได้ทุก interactive element และมี focus ring มองเห็นได้.
- 16.4 THE SYSTEM SHALL ให้ contrast ของข้อความผ่านเกณฑ์อ่านได้ (โดยเฉพาะตัวอักษรบนพื้นกรมท่า/เหลือง).
- 16.5 WHERE ผู้ใช้ตั้ง `prefers-reduced-motion: reduce` THE SYSTEM SHALL ลด/ปิด animation และ auto-advance ของ slider. _(แก้ J)_

## REQ-17: รันและโครงสร้างโค้ด

**Acceptance Criteria (EARS):**

- 17.1 THE SYSTEM SHALL รันได้ด้วย `npm install && npm run dev` บน Node 20.9+ เปิดที่ http://localhost:3000.
- 17.2 THE SYSTEM SHALL ใช้ Next.js 16 App Router (Server Components ค่าเริ่มต้น, `"use client"` เฉพาะ interactive) + TypeScript `strict` (เลี่ยง `any`).
- 17.3 THE SYSTEM SHALL ดึงรูป picsum.photos ผ่าน `next/image` พร้อมตั้ง `images.remotePatterns` ใน `next.config.ts`.

---

## Resolved Decisions (จาก /spec-analyze)

- **picsum ออฟไลน์** → แก้ด้วย REQ-14.6 (onError → inline SVG placeholder).
- **ปัดเศษเบี้ย** → แก้ด้วย REQ-8.4 (เบี้ยรายปี บาท จำนวนเต็ม; วิธีปัดระบุชัดใน design).
- **ค่าขอบ valid** → แก้ด้วย REQ-8.5/8.6 (18/70/100000/10000000 = valid).
- **ตัวกรองซ้อน 5 vs 7** → แก้ด้วย REQ-5.2/7.3 (state อิสระต่อ section).
- **สลับสกุลเงิน** → แก้ด้วย REQ-7.2 (UI เท่านั้น ไม่แปลงราคา).
- **trigger คำนวณ** → แก้ด้วย REQ-8.2 (on submit/blur ไม่ใช่ทุก keystroke).
- **empty filter** → แก้ด้วย REQ-5.5/7.4 (ข้อความสถานะว่าง).
- **layout shift / a11y** → แก้ด้วย REQ-14.7, 16.5, 3.5.

## Out of Scope (ยืนยันตัดออก)

- **Cookie consent bar** (brief #13, optional) — ตัดออกจาก scope รอบนี้เพื่อโฟกัส section หลัก+ rubric. เพิ่มภายหลังได้ ไม่กระทบ acceptance checklist 1–11. _(แก้ K)_
