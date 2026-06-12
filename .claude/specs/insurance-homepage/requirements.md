# Requirements: Insurance Homepage

## Overview

หน้าแรก (homepage) พอร์ทัลบริษัทประกันภัยแบรนด์วิริยะ (น้ำเงินกรมท่า + เหลืองทอง) — เว็บองค์กร
เนื้อหาแน่นเป็นระบบ อ้างอิง IA แบบเว็บโรงพยาบาลใหญ่ แปลงเป็นธุรกิจประกัน. งานชิ้นเดียวสมบูรณ์
พร้อมนำเสนอ รันใน browser ทันที (`npm install && npm run dev`). เป้าหมายตาม product.md: ทดสอบ
คุณภาพ design + ตรรกะคำนวณเบี้ยประกัน. ไม่มี backend จริง — data ทั้งหมดเป็น mock ใน TypeScript.
เอกสารนี้คือ WHAT (behavior); HOW (สูตรเบี้ย, สถาปัตยกรรม) อยู่ใน design.md.

ขอบเขตจาก clarifying questions: รวม search bar ที่ทำงานจริง; ตัด cookie consent; TH/EN toggle เป็น
UI-only (ไม่แปลทั้งหน้า); รูปการ์ดใช้ picsum.photos + inline SVG fallback; สูตรเบี้ยนิยามตอน design.

---

## REQ-1: Page Structure & Section Completeness

**User Story:** As a visitor, I want หน้าแรกแสดงครบทุก section ตามลำดับพอร์ทัลองค์กร, so that ฉันเห็น
ภาพรวมผลิตภัณฑ์/บริการ/โปรโมชั่นได้ในหน้าเดียว.

**Acceptance Criteria (EARS):**

- 1.1 WHEN หน้าโหลดเสร็จ THE SYSTEM SHALL render section ตามลำดับบนลงล่าง: (1) utility bar,
  (2) sticky header, (3) hero, (4) ประเภทประกัน, (5) บริการ, (6) โปรโมชั่น, (7) เครื่องคำนวณเบี้ย,
  (8) แถบสถิติ, (9) บทความ, (10) testimonials, (11) ดาวน์โหลดแอป, (12) footer.
- 1.2 THE SYSTEM SHALL ให้ทุก section อยู่ภายใน container กึ่งกลาง max-width ~1200-1280px มี padding
  ซ้าย/ขวาเท่ากันทุก section (ยกเว้นพื้นหลังเต็มความกว้างของ section พื้นกรมท่า).
- 1.3 THE SYSTEM SHALL ให้ทุกลิงก์ใน header nav ผูกกับ anchor ของ section ที่มีจริงในหน้า ตาม mapping:
  ผลิตภัณฑ์->`#insurance-types`, คำนวณเบี้ย->`#calculator`, แจ้งเคลม->`#services`, เกี่ยวกับเรา->`#stats`,
  บทความ->`#articles` — กดแล้ว scroll ไปถึง section นั้นจริง (ไม่มี dead anchor).

## REQ-2: Utility Bar

**User Story:** As a returning customer, I want แถบทางลัด/ตั้งค่าด้านบนสุด, so that เข้าถึงกรมธรรม์
ของฉัน ภาษา สกุลเงิน และค้นหาได้เร็ว.

**Acceptance Criteria (EARS):**

- 2.1 THE SYSTEM SHALL แสดง utility bar พื้นกรมท่า มีเส้น accent เหลืองทอง ประกอบด้วย: ตัวเลือก
  ช่องทาง/บริษัท, ลิงก์ "กรมธรรม์ของฉัน / บัตรลูกค้า", toggle ภาษา TH/EN, ตัวเลือกสกุลเงิน, ช่องค้นหา,
  ลิงก์เข้าสู่ระบบ/สมัครสมาชิก, ไอคอนตะกร้า/โปรไฟล์ (inline SVG).
- 2.2 WHEN ผู้ใช้คลิก toggle ภาษา TH/EN THE SYSTEM SHALL สลับสถานะปุ่มที่แสดง (active) โดยไม่ต้อง
  แปลเนื้อหาทั้งหน้า (UI-only).
- 2.3 WHILE viewport < 768px THE SYSTEM SHALL ยุบ utility bar ให้เหลือเฉพาะองค์ประกอบสำคัญหรือจัด
  เรียงใหม่ โดยไม่เกิด horizontal overflow.
- 2.4 THE SYSTEM SHALL ให้ช่องค้นหาใน utility bar เป็น UI-only (global search ลวง) — ไม่ผูกกับตัวกรอง
  ใดในหน้า (ตัวกรองจริงอยู่ที่ REQ-5).
- 2.5 THE SYSTEM SHALL ให้ตัวเลือกสกุลเงินใน utility bar เป็น UI-only — สลับป้ายที่แสดงได้ แต่ราคาทุก
  จุดในหน้าคงเป็น THB (ไม่ recompute).

## REQ-3: Sticky Header & Navigation

**User Story:** As a visitor, I want เมนูหลักที่ติดอยู่ด้านบนตลอด, so that นำทางได้ทุกจุดของหน้า.

**Acceptance Criteria (EARS):**

- 3.1 THE SYSTEM SHALL แสดง header พร้อมโลโก้บริษัท (inline SVG), เมนูหลัก 5 รายการ (ผลิตภัณฑ์ /
  คำนวณเบี้ย / แจ้งเคลม / เกี่ยวกับเรา / บทความ) แต่ละรายการเป็น anchor ตาม mapping ใน REQ-1.3,
  และสายด่วนโทร.
- 3.2 WHILE ผู้ใช้ scroll ลง THE SYSTEM SHALL ตรึง header ไว้ด้านบน (sticky) ตลอด.
- 3.3 WHILE viewport < 768px THE SYSTEM SHALL ยุบเมนูหลักเป็นปุ่ม hamburger.
- 3.4 WHEN ผู้ใช้คลิกปุ่ม hamburger THE SYSTEM SHALL เปิด/ปิดเมนูมือถือ และตั้ง `aria-expanded`
  ให้ตรงสถานะ.
- 3.5 WHERE เมนูมีรายการที่มีเมนูย่อย (dropdown) THE SYSTEM SHALL เปิด dropdown เมื่อ hover/focus และ
  เข้าถึงได้ด้วยคีย์บอร์ด.

## REQ-4: Hero (Split Left/Right)

**User Story:** As a visitor, I want hero ที่ให้ทางลัดใช้งานบ่อย + แบนเนอร์แคมเปญ, so that เริ่มทำ
ธุรกรรมหรือดูโปรได้ทันที.

**Acceptance Criteria (EARS):**

- 4.1 THE SYSTEM SHALL แสดง hero แบ่งซ้าย-ขวา: ซ้ายเป็นการ์ดแผงทางลัด, ขวาเป็นแบนเนอร์แคมเปญ.
- 4.2 THE SYSTEM SHALL ให้การ์ดซ้ายมีลิงก์เข้าสู่ระบบ/สมัครสมาชิก + ไอคอนทางลัด 4 อัน (ซื้อประกัน /
  เช็กกรมธรรม์ / แจ้งเคลม / ติดต่อเรา) + ลิงก์ "ไปยังแผนยอดนิยม".
- 4.3 WHEN ผู้ใช้คลิกการ์ดทางลัดอันใดอันหนึ่งใน 4 อัน THE SYSTEM SHALL นำทาง (เป็น link/anchor ที่
  คลิกได้จริง ปลายทาง placeholder ได้).
- 4.4 THE SYSTEM SHALL ให้แบนเนอร์ขวาพื้นกรมท่าตัดเหลือง/ทอง มีภาพประกอบ/องค์ประกอบกราฟิกจริง
  (inline SVG รายละเอียด ไม่ใช่ไอคอนเดี่ยวลอย) + ปุ่ม CTA สีเหลืองทอง.
- 4.5 WHILE viewport < 768px THE SYSTEM SHALL เรียงซ้าย-ขวาเป็นแนวตั้ง โดยไม่เกิด overflow.

## REQ-5: Insurance Types Grid + Search + Filter

**User Story:** As a shopper, I want ดู/กรองประเภทประกัน, so that หาแบบที่ตรงความต้องการได้เร็ว.

**Acceptance Criteria (EARS):**

- 5.1 THE SYSTEM SHALL แสดงกริดการ์ดประเภทประกัน >= 6 ใบ (ครอบคลุม ชีวิต / สุขภาพ / รถยนต์ /
  เดินทาง / อุบัติเหตุ / บ้าน / มะเร็ง / สะสมทรัพย์) แต่ละใบมีรูปจริง + ชื่อ + ป้ายกำกับหมวด + ลิงก์ดูแผน.
- 5.2 THE SYSTEM SHALL แสดงแถบค้นหา + ตัวกรองหมวดเหนือกริด.
- 5.3 WHEN ผู้ใช้เลือกตัวกรองหมวด THE SYSTEM SHALL แสดงเฉพาะการ์ดที่ตรงหมวดนั้น และอัปเดตทันที.
- 5.4 WHEN ผู้ใช้พิมพ์คำค้นในแถบค้นหาประเภทประกัน THE SYSTEM SHALL กรองการ์ดตามชื่อ/หมวดแบบ
  case-insensitive และอัปเดตทันที.
- 5.5 IF ไม่มีการ์ดตรงกับคำค้น/ตัวกรอง THEN THE SYSTEM SHALL แสดง empty state ที่สื่อความหมาย
  (ไม่ใช่พื้นที่ว่างเปล่า).
- 5.6 WHEN ทั้งตัวกรองหมวดและคำค้นถูกใช้พร้อมกัน THE SYSTEM SHALL แสดงเฉพาะการ์ดที่ตรง **ทั้งสอง
  เงื่อนไข** (AND).

## REQ-6: Services Grid

**User Story:** As a customer, I want เห็นบริการที่ทำได้ออนไลน์, so that เลือกทำธุรกรรมที่ต้องการ.

**Acceptance Criteria (EARS):**

- 6.1 THE SYSTEM SHALL แสดงกริดบริการ >= 12 รายการ แต่ละรายการมีไอคอน inline SVG (รูปทรงจริง) +
  ป้ายชื่อ (เช่น ซื้อออนไลน์, แจ้งเคลม, ต่ออายุ, เปลี่ยนแผน, ปรึกษาตัวแทน, ดาวน์โหลดกรมธรรม์,
  ตรวจสถานะเคลม, ชำระเบี้ย, โรงพยาบาลคู่สัญญา, สะสมแต้ม ฯลฯ).
- 6.2 THE SYSTEM SHALL มีลิงก์ "ดูทั้งหมด".
- 6.3 WHEN ผู้ใช้ hover/focus รายการบริการ THE SYSTEM SHALL แสดง hover/focus state ที่ชัดเจน.

## REQ-7: Promotions Grid + Filter

**User Story:** As a shopper, I want เปรียบเทียบโปรโมชั่นพร้อมราคา, so that ตัดสินใจซื้อได้.

**Acceptance Criteria (EARS):**

- 7.1 THE SYSTEM SHALL แสดงกริดการ์ดโปรโมชั่น >= 8 ใบ แต่ละใบมี: รูปจริง, ชื่อแผน, ป้ายหมวด, ราคา/เบี้ย
  ปัจจุบัน, ราคาเดิมขีดฆ่า, วันหมดเขต, ปุ่ม "รายละเอียด" + ปุ่ม "ซื้อเลย".
- 7.2 THE SYSTEM SHALL แสดงตัวเลือกช่องทาง/สกุลเงินเหนือกริด เป็น UI-only — ราคาการ์ดคงเป็น THB
  (ไม่ recompute ตามสกุลเงิน, สอดคล้อง REQ-2.5).
- 7.3 WHEN ผู้ใช้เลือกตัวกรองประเภทประกัน THE SYSTEM SHALL แสดงเฉพาะการ์ดโปรโมชั่นที่ตรงประเภทนั้น
  และอัปเดตทันที.
- 7.4 THE SYSTEM SHALL ให้ราคาเดิมแสดงเป็นขีดฆ่า (strikethrough) และราคาปัจจุบันเน้นด้วยสี accent.

## REQ-8: Premium Calculator

**User Story:** As a shopper, I want กรอกข้อมูลแล้วได้เบี้ยโดยประมาณทันที, so that ประเมินค่าใช้จ่ายได้เอง.

**Acceptance Criteria (EARS):**

- 8.1 THE SYSTEM SHALL แสดงฟอร์มเลือกประเภทประกัน + ช่องกรอกอายุ + ช่องกรอกทุนประกัน + ปุ่มคำนวณ.
- 8.2 WHEN ผู้ใช้กดปุ่มคำนวณด้วยค่าที่ถูกต้องครบ (ประเภท + อายุ + ทุนประกันในช่วงที่ยอมรับ) THE SYSTEM
  SHALL คำนวณและแสดงเบี้ยโดยประมาณ. การ validate (8.4-8.7) และการคำนวณ trigger ตอนกดปุ่มคำนวณ
  (on-submit) — ไม่ใช่ live ทุก keystroke.
- 8.3 THE SYSTEM SHALL คำนวณเบี้ยแบบ deterministic จากฟังก์ชัน logic ล้วน (input เดียวกัน -> ผลเดียวกัน
  เสมอ); นิยามสูตร/ค่าคงที่/วิธีปัดเศษ/ช่วงที่ยอมรับ ใน design.md และครอบด้วย unit test.
- 8.4 IF ช่องอายุหรือทุนประกันเว้นว่าง THEN THE SYSTEM SHALL แสดง error ที่ช่องนั้นและไม่คำนวณ.
- 8.5 IF อายุ <= 0 หรือ เกินช่วงที่ยอมรับ THEN THE SYSTEM SHALL แสดง error ที่สื่อความหมายและไม่คำนวณ.
- 8.6 IF ทุนประกัน <= 0 หรือ เกินช่วงที่ยอมรับ THEN THE SYSTEM SHALL แสดง error ที่สื่อความหมายและ
  ไม่คำนวณ.
- 8.7 IF input ไม่ใช่ตัวเลข (NaN) THEN THE SYSTEM SHALL ถือว่า invalid แสดง error และไม่คำนวณ.
- 8.8 WHEN ผู้ใช้แก้ไข input ที่เคย error ให้ถูกต้อง THE SYSTEM SHALL เคลียร์ error ของช่องนั้น.
- 8.9 WHEN แสดงผลเบี้ย THE SYSTEM SHALL แสดงเป็นจำนวนเต็มบาท ปัดเศษ คั่นหลักพันด้วย `,` พร้อมหน่วยและ
  รอบชำระชัดเจน (เช่น "12,500 บาท / ปี").

## REQ-9: Stats / Trust Bar

**User Story:** As a visitor, I want เห็นตัวเลขความน่าเชื่อถือ, so that มั่นใจในบริษัท.

**Acceptance Criteria (EARS):**

- 9.1 THE SYSTEM SHALL แสดงแถบสถิติพื้นกรมท่า >= 4 ตัวเลข (จำนวนลูกค้า, อัตราการจ่ายเคลม %,
  ปีที่ก่อตั้ง, มูลค่าสินทรัพย์) พร้อมป้ายกำกับ.

## REQ-10: Articles Grid

**User Story:** As a visitor, I want อ่านบทความความรู้ประกัน/การเงิน, so that ตัดสินใจได้ดีขึ้น.

**Acceptance Criteria (EARS):**

- 10.1 THE SYSTEM SHALL แสดงกริดการ์ดบทความ >= 8 ใบ แต่ละใบมี: รูปจริง, หัวข้อ, ป้ายหมวด, ผู้เขียน
  (avatar รูปจริง) + วันที่.

## REQ-11: Testimonials Slider

**User Story:** As a visitor, I want อ่านรีวิวลูกค้าแบบเลื่อนได้, so that เห็นประสบการณ์จริง.

**Acceptance Criteria (EARS):**

- 11.1 THE SYSTEM SHALL แสดงสไลด์ testimonial >= 3 รายการ แต่ละรายการมีข้อความ + ชื่อ + avatar.
- 11.2 WHEN ผู้ใช้กดปุ่มถัดไป/ก่อนหน้า (หรือจุดบอกตำแหน่ง) THE SYSTEM SHALL เลื่อนไปยังรายการนั้นและ
  แสดงการ์ดเต็มใบ.
- 11.3 THE SYSTEM SHALL แสดงตัวบอกตำแหน่งปัจจุบัน (dots/active state) และเข้าถึงปุ่มเลื่อนด้วยคีย์บอร์ดได้.
- 11.4 WHERE รองรับ touch THE SYSTEM SHALL ให้ปัด (swipe) เลื่อน slide ได้ (optional — ปุ่ม+dots พอ
  สำหรับ acceptance #8; ไม่บังคับ swipe).

## REQ-12: App Download (Phone Mockup)

**User Story:** As a visitor, I want เห็นตัวอย่างแอปก่อนดาวน์โหลด, so that รู้ว่าแอปทำอะไรได้.

**Acceptance Criteria (EARS):**

- 12.1 THE SYSTEM SHALL แสดง phone mockup ที่มี UI จำลองข้างในจริง (status bar, การ์ดกรมธรรม์, ปุ่ม,
  ข้อความจำลอง) — ไม่ใช่กล่องว่าง.
- 12.2 THE SYSTEM SHALL แสดงปุ่ม App Store + Google Play (inline SVG badge).

## REQ-13: Footer Directory

**User Story:** As a visitor, I want footer ไดเรกทอรีครบ, so that เข้าถึงลิงก์/ข้อมูลบริษัทได้.

**Acceptance Criteria (EARS):**

- 13.1 THE SYSTEM SHALL แสดง footer หลายคอลัมน์พื้นกรมท่า: ผลิตภัณฑ์แยกหมวด + ศูนย์บริการ/สาขาแยกภาค +
  เกี่ยวกับเรา + ปุ่มแอป + ไอคอนโซเชียล (inline SVG) + ใบอนุญาตประกอบธุรกิจประกัน + ลิขสิทธิ์.
- 13.2 WHILE viewport < 768px THE SYSTEM SHALL ยุบ/จัดเรียงคอลัมน์ footer ใหม่อย่างเรียบร้อย ไม่ overflow.

## REQ-14: Responsive Layout

**User Story:** As a mobile user, I want หน้าใช้งานได้ทุกขนาดจอ, so that เปิดบนมือถือ/แท็บเล็ต/เดสก์ท็อปได้.

**Acceptance Criteria (EARS):**

- 14.1 THE SYSTEM SHALL render โดยไม่มี horizontal overflow ที่ 375px, 768px, และ 1440px (ยกเว้น
  slider ที่ตั้งใจ).
- 14.2 WHILE viewport >= 1024px THE SYSTEM SHALL แสดงกริดการ์ด (ประเภทประกัน/โปรโมชั่น/บทความ) ~4
  คอลัมน์.
- 14.3 WHILE viewport อยู่ในช่วง tablet (~768-1023px) THE SYSTEM SHALL แสดงกริดการ์ด ~2 คอลัมน์.
- 14.4 WHILE viewport < 768px THE SYSTEM SHALL แสดงกริดการ์ด 1 คอลัมน์.
- 14.5 THE SYSTEM SHALL ให้การ์ดในแถวเดียวกันสูงเท่ากันและระยะห่างสม่ำเสมอ (spacing scale คงที่).

## REQ-15: Visual Completeness

**User Story:** As an evaluator, I want งานดู "เสร็จ" พร้อมนำเสนอ, so that ไม่มีกล่องว่าง/ฟอนต์ระบบ/ภาพแตก.

**Acceptance Criteria (EARS):**

- 15.1 THE SYSTEM SHALL โหลดและใช้เว็บฟอนต์ไทยจริง (IBM Plex Sans Thai / Noto Sans Thai / Sarabun /
  Prompt / Kanit อย่างใดอย่างหนึ่ง) เป็นฟอนต์หลักทั้งเอกสาร — ห้ามตกไปใช้ฟอนต์ระบบ. กลไกโหลด
  (`next/font/google` self-host ตอน build vs `@font-face` self-host) ระบุใน design.md; runtime ต้อง
  ไม่ง้อ network.
- 15.2 THE SYSTEM SHALL ไม่มีกล่อง/สี่เหลี่ยมสีเดียวว่างเป็น placeholder — ทุกพื้นที่ภาพต้องเป็น
  inline SVG รายละเอียด / รูปจริง / gradient+ลวดลายที่จัดองค์ประกอบ.
- 15.3 IF รูปจาก remote (picsum.photos) โหลดไม่สำเร็จ THEN THE SYSTEM SHALL แสดง fallback ที่ดู
  "ตั้งใจ" (inline SVG/gradient) ไม่ใช่ภาพแตกหรือกล่องว่าง.
- 15.6 WHILE รูป remote กำลังโหลด THE SYSTEM SHALL แสดง placeholder ที่ดู "ตั้งใจ" (blur/skeleton
  SVG/gradient) ไม่ใช่กล่องว่างชั่วคราว.
- 15.4 THE SYSTEM SHALL กำหนด typographic scale ชัดเจน (h1/h2/h3/body/caption) โดย body line-height
  > = 1.5 และตัวอักษรไทยสระบน-ล่างไม่ตัดกัน.
- 15.5 THE SYSTEM SHALL ไม่มี dead space ขนาดใหญ่ที่ไม่ได้ตั้งใจในทุก section.

## REQ-16: Accessibility

**User Story:** As a keyboard/AT user, I want นำทางและเข้าใจหน้าได้, so that ใช้งานได้เท่าเทียม.

**Acceptance Criteria (EARS):**

- 16.1 THE SYSTEM SHALL ใช้ semantic HTML (header/nav/main/section/footer, heading hierarchy ถูกต้อง).
- 16.2 THE SYSTEM SHALL ให้ทุก `<img>` มี `alt` ที่สื่อความหมาย และไอคอน decorative มี `aria-hidden`
  หรือ label ตามบริบท.
- 16.3 WHEN ผู้ใช้นำทางด้วยคีย์บอร์ด THE SYSTEM SHALL ให้ทุก control แบบโต้ตอบ (ลิงก์/ปุ่ม/อินพุต/
  slider/filter) เข้าถึงได้และมี focus ring ที่มองเห็น.
- 16.4 THE SYSTEM SHALL ให้สี text/พื้นหลังผ่านเกณฑ์ contrast (WCAG AA) ในองค์ประกอบหลัก.
- 16.5 WHEN ผู้ใช้ตั้ง `prefers-reduced-motion: reduce` THE SYSTEM SHALL ลด/ปิด animation ที่ไม่จำเป็น
  (slider auto, transition ตกแต่ง) โดยยังใช้งาน control ได้ครบ.

## REQ-17: Design Tokens & Brand Palette

**User Story:** As a maintainer, I want token รวมศูนย์, so that แบรนด์สม่ำเสมอและไม่ hardcode สี.

**Acceptance Criteria (EARS):**

- 17.1 THE SYSTEM SHALL นิยาม design tokens ด้วยค่า hex เป๊ะ (primary `#13266B` / primary-dark
  `#0E1C50` / accent `#FDB913` / bg `#F5F7FB` / surface `#FFFFFF` / text `#1A2238` + muted/border ที่
  design.md lock, รัศมีมุม, เงา, spacing, ฟอนต์) ไว้ที่เดียวใน `tailwind.config.ts` -> `theme.extend`.
- 17.2 THE SYSTEM SHALL เรียกสีผ่าน semantic utility class จาก token — ไม่ hardcode ค่า hex ดิบซ้ำใน
  คอมโพเนนต์.
- 17.3 THE SYSTEM SHALL ให้ปุ่ม/การ์ด/อินพุต มี state ครบ default/hover/focus(ring)/active/disabled
  พร้อม transition 150-250ms; เงาและรัศมีมุมสอดคล้องทั้งหน้า.
- 17.4 THE SYSTEM SHALL ใช้กรมท่าเป็นพื้นของ section เด่น (utility bar/แถบสถิติ/ส่วนแอป/footer) และ
  เหลืองทองเป็นปุ่มหลัก/แบนเนอร์/ป้ายราคา.

---

## Edge Cases & Open Questions

หลัง `/spec-analyze` (รอบนี้): ปัญหา testability/conflict ถูกแก้เข้า REQ แล้ว (L1->1.3/3.1,
A1->8.2, A2->2.4, A3->2.5/7.2, C2->15.6, G2->8.9, G3->5.6, G5->16.5, A4->17.1, A5->15.1).
เหลือ design-deferred ล้วน:

- **สูตรเบี้ย + ช่วงยอมรับ (REQ-8.3/8.5/8.6) [design-blocking]** — design.md ต้อง lock: base_rate ต่อ
  ประเภท, age_factor table, ช่วงที่ยอมรับ (เสนอ อายุ 1-80, ทุน 100,000-50,000,000), วิธีปัดเศษ. จนกว่า
  lock เสร็จ acceptance #4 ("อายุ 30 ทุน 1,000,000 -> ตรงสูตร") เขียน unit test ไม่ได้ -> เป็น blocker
  ของ design phase.
- **กลไกฟอนต์ + รูป remote ตอน offline (REQ-15.1/15.3/15.6) [design-blocking]** — design ต้องเลือก:
  ฟอนต์ผ่าน `next/font/google` (fetch ตอน build ต้องมีเน็ต) หรือ `@font-face` self-host (.woff2 ใน repo);
  และกลไก placeholder/onError ของ `next/image`. ต้องกัน build/verify offline พัง (เครื่องนี้เน็ตไม่ชัวร์).
- **Cookie consent** — ตัดออกจาก scope ตามที่ตกลง.
