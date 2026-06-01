# Implementation Tasks: Insurance Homepage

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

Decisions ที่ล็อก: ฟอนต์ **IBM Plex Sans Thai** (next/font/google), test runner **vitest**
(อนุมัติแล้ว), รูป **picsum seed คงที่** + SVG fallback. ดู `design.md` / `clarifications.md`.

---

- [ ] 1. **Scaffold + design system foundation** — สร้างโปรเจกต์ Next.js 16 (App Router, TS strict),
     ตั้ง `tailwind.config.ts` design tokens (พาเลตวิริยะ + spacing/radius/shadow), โหลด
     IBM Plex Sans Thai ผ่าน next/font ใน `layout.tsx` (typographic scale), `next.config.ts`
     remotePatterns→picsum, และ ui primitives: `Container`, `Button`(variants+states),
     `Card`, `Badge`, `Icon`(registry inline SVG), `SmartImage`(next/image + onError fallback +
     fixed size). `page.tsx` เป็น skeleton ว่างที่ render `<Container>`.
     Satisfies: REQ-1.2, REQ-14.1, REQ-14.2, REQ-14.5, REQ-14.6, REQ-14.7, REQ-15.1–15.4, REQ-17.1–17.3.
     Verify: `npm run dev` เปิด localhost:3000 ได้, ฟอนต์ไทยโหลด, token class ใช้ได้, `npm run build` ผ่าน.

- [ ] 2. **Mock data + types** — `data/types.ts` (ทุก interface ใน design) + ไฟล์ mock:
     insuranceTypes (≥8), services (≥12), promotions (≥8 มี price/originalPrice/expiresOn/category),
     articles (≥8), testimonials (≥3), stats (≥4). ทุกชิ้น type ชัด ไม่ `any`, imageId/avatarId
     เป็น seed คงที่.
     Satisfies: REQ-17.2 (data shape). Verify: `tsc --noEmit` ผ่าน, จำนวนรายการครบเกณฑ์.

- [ ] 3. **Premium engine + tests** — `lib/premium.ts`: `calculatePremium(input): PremiumResult`
     ใช้สูตร per-type (baseRate table + ageFactor bracket) + validate ตามลำดับใน design,
     คืนเบี้ยรายปีบาทจำนวนเต็ม (`Math.round`). `lib/premium.test.ts` (vitest): happy table
     (รวม life/30/1M=12,000), boundary (18/70/17/71, 1แสน/10ล้าน/นอกช่วง), invalid (null/NaN/ติดลบ/type ว่าง).
     Satisfies: REQ-8.3, REQ-8.4, REQ-8.5, REQ-8.6, REQ-8.7, REQ-8.8. Depends on: 2.
     Verify: `npm run test` เขียว ครบ acceptance #4/#5.

- [ ] 4. **Utility bar + sticky header + nav** — `UtilityBar` (ภาษา/สกุลเงิน toggle UI, ค้นหา, บัญชี),
     `Header` sticky + เมนูหลัก + dropdown (hover/focus) + hamburger (≤768px) + ESC ปิด/คืน focus +
     click-outside. ต่อเข้า `page.tsx` บนสุด.
     Satisfies: REQ-2.1–2.3, REQ-3.1–3.5. Depends on: 1. Verify: 1440px เห็น nav เต็ม+dropdown;
     375px เห็น hamburger toggle ได้; ESC ปิดเมนู; ไม่ overflow.

- [ ] 5. **Hero + static trust/app/footer sections** — `Hero` (ซ้าย: การ์ดทางลัด 4 + login/register,
     ขวา: แบนเนอร์แคมเปญ inline SVG + CTA เหลือง), `Stats` (≥4 ตัวเลขบนพื้นกรมท่า),
     `AppDownload` (phone mockup มี UI จำลอง: status bar/การ์ดกรมธรรม์/ปุ่ม + App Store/Google Play),
     `Footer` (directory หลายคอลัมน์ + ใบอนุญาต + responsive). ต่อเข้า `page.tsx`.
     Satisfies: REQ-4.1–4.4, REQ-9.1, REQ-12.1–12.2, REQ-13.1–13.2. Depends on: 1.
     Verify: hero split→stack ที่ mobile, phone mockup ไม่ใช่กล่องว่าง, footer ยุบเรียบร้อย, ทางลัด 4 คลิกได้.

- [ ] 6. **Interactive card grids: ประเภทประกัน + โปรโมชั่น** — `InsuranceTypes` (กริด≥6 รูปจริง +
     search live + filter อิสระ + empty state + grid 4→2→1) และ `Promotions` (กริด≥8: ราคา+ราคาเดิมขีดฆ่า+
     วันหมดเขต+ปุ่มซื้อเลย/รายละเอียด + filter อิสระ + currency selector UI + empty state). ต่อเข้า `page.tsx`.
     Satisfies: REQ-5.1–5.6, REQ-7.1–7.5. Depends on: 1, 2. Verify: filter/search กรองได้,
     empty state แสดงเมื่อไม่เหลือผล, การ์ดสูงเท่ากัน, รูป fallback ทำงานเมื่อออฟไลน์.

- [ ] 7. **Services + Articles + Testimonials slider** — `Services` (≥12 inline SVG icon + ดูทั้งหมด),
     `Articles` (กริด≥8: รูป/หัวข้อ/หมวด/ผู้เขียน+วันที่, grid 4→2→1), `Testimonials` (slider ≥3 +
     ปุ่ม/จุดบอกตำแหน่ง + เลื่อนได้ + เคารพ reduced-motion). ต่อเข้า `page.tsx`.
     Satisfies: REQ-6.1–6.3, REQ-10.1–10.2, REQ-11.1–11.2, REQ-16.5. Depends on: 1, 2.
     Verify: slider เลื่อนถัดไป/ก่อนหน้าได้, กริดปรับคอลัมน์, ไอคอนเป็นรูปทรงจริง.

- [ ] 8. **Premium calculator UI** — `PremiumCalculator` (เลือกประเภท + input อายุ/ทุน type=number,
     ปุ่มคำนวณ, แสดงเบี้ยรายปี, error ใต้ฟิลด์เมื่อ invalid) wiring เข้า `lib/premium.ts` จาก task 3.
     trigger คำนวณตอน submit/blur ไม่ใช่ทุก keystroke. ต่อเข้า `page.tsx`.
     Satisfies: REQ-8.1, REQ-8.2. Depends on: 1, 3. Verify: กรอก life/30/1,000,000→12,000;
     อายุ/ทุนนอกช่วง/ว่าง→error ไม่คำนวณ (acceptance #3/#4/#5 ผ่านบน UI จริง).

- [ ] 9. **Responsive, a11y & visual-completeness pass** — ไล่ทั้งหน้าใน DevTools ที่ 375/768/1440:
     ไม่มี horizontal overflow, ไม่มีกล่องว่าง/รูป broken, ฟอนต์ไทยใช้จริง, ไม่มี dead space,
     semantic HTML + aria-label + keyboard nav ทุก interactive + focus ring + contrast ผ่าน,
     spacing/shadow/radius สม่ำเสมอ. แก้จุดที่หลุดเกณฑ์.
     Satisfies: REQ-1.1, REQ-1.3, REQ-1.4, REQ-14.3, REQ-14.4, REQ-16.1–16.4. Depends on: 4–8.
     Verify: acceptance checklist #1,#2,#10,#11 ผ่านด้วยตา/DevTools ทั้ง 3 viewport.

---

## Execution notes

- ขอบเขตที่ตกลง: implement **รวดเดียวทั้งหมด** (`/spec-implement all`) ตามลำดับ dependency 1→9.
- ลำดับ dependency: 1 ก่อนทุกอย่าง; 2 ก่อน 3/6/7; 3 ก่อน 8; 4–8 ก่อน 9.
- มาร์ก `- [x]` + ระบุ REQ ที่ปิดเมื่อจบแต่ละ task; pause ที่ task boundary.
- คำสั่งตรวจ: `npm run dev`, `npm run build`, `npm run test`, `tsc --noEmit`.
