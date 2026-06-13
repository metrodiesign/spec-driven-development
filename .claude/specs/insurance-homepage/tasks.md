# Implementation Tasks: Insurance Homepage

> Each task = cohesive, independently verifiable slice. Implement whole task in one
> pass (may touch many files). Decompose into sub-steps yourself at execution time —
> do NOT pre-split here.

- [x] 1. Scaffold + design system foundation — Next.js 16 App Router project (package.json,
     tsconfig strict, next.config.ts `images.remotePatterns` picsum, postcss, vitest.config),
     `tailwind.config.ts` tokens (hex lock + radius/shadow/type scale จาก design), `globals.css`
     (@tailwind + keyframes), `layout.tsx` (`<html lang="th">` + ฟอนต์ `next/font/google` IBM Plex
     Sans Thai เป็น `--font-sans`, `@font-face` fallback ใน `app/fonts/`, metadata, SkipLink),
     ui primitives `components/ui/` (Container, Button, Card, Badge, Icon, SectionHeading — state
     ครบ default/hover/focus(ring)/active/disabled) + `SmartImage` (client: blur placeholder +
     onError SVG fallback). "Done" = `npm run dev` boot ได้, `tsc` ผ่าน, ฟอนต์ไทยโหลดจริง, primitive
     ใช้ token ล้วน.
     Satisfies: 1.2, 15.1, 15.3, 15.4, 15.6, 17.1-17.4, 16.1 (partial). Verify: `npm run dev` +
     `npx tsc --noEmit`; เปิด `/` เห็นฟอนต์ไทย.
     Evidence: `tsc --noEmit` exit 0; `next build` exit 0 (Next 16.2.7); ui primitives ครบใน
     `app/components/ui/`. Per-task `npm run dev` boot ไม่ได้บันทึกตอน impl — back-stamp 2026-06-13.

- [x] 2. Premium engine (pure logic + unit tests) [CORE] — `lib/premium.ts` (BASE_RATES, AGE_FACTORS,
     RANGES, ageFactor, calcPremium), `lib/validatePremium.ts` (parseAndValidate -> typed input |
     field errors, เช็ค ว่าง/NaN/<=0/นอกช่วง ทุกช่องพร้อมกัน, error ไทย), `lib/format.ts` (formatTHB).
     เขียน vitest ครบตามตาราง Testing Strategy ให้ "เขียวก่อน" แตะ UI (pure-logic-first). "Done" =
     ทุก test เขียว รวม acceptance #4 (life/30/1,000,000 -> 8,000).
     Satisfies: 8.2, 8.3, 8.9 (logic + validation rules). Verify: `npm test` เขียวทั้งหมด.
     Evidence: `npm test` (vitest run) 47/47 เขียว — premium.test.ts 20 + validatePremium.test.ts 14
     + format.test.ts 7 ครอบ task นี้; acceptance #4 (life/30/1,000,000 -> 8,000) assert ใน
     premium.test.ts. ตรวจซ้ำได้ทันที — back-stamp 2026-06-13.

- [x] 3. Mock data + types — `data/types.ts` (central) + `navigation.ts` (nav 5 ราย + anchor mapping
     REQ-1.3), `insuranceTypes.ts` (>=8, ครบ 8 หมวด), `services.ts` (>=12), `promotions.ts` (>=8 มี
     priceOriginal>current + category + expiresOn), `stats.ts` (>=4), `articles.ts` (>=8 + author
     avatar), `testimonials.ts` (>=3), `appFeatures.ts`. รูปทุกตัวชี้ picsum URL จริง. "Done" = type
     ชัด, `tsc` ผ่าน, จำนวนครบเกณฑ์ทุก section.
     Satisfies: backing 5.1, 6.1, 7.1, 9.1, 10.1, 11.1, 1.3. Depends on: 1. Verify: `npx tsc --noEmit`.
     Evidence: `tsc --noEmit` exit 0 (types compile); data files ครบใน `app/data/`. back-stamp 2026-06-13.

- [x] 4. Top chrome + navigation (interactive) — `UtilityBar` (client: toggle TH/EN + currency
     UI-only, search UI-only) + `Header` (client: sticky, เมนู 5 ราย anchor ตาม mapping, hamburger
     <768 + `aria-expanded`, dropdown hover/focus + keyboard). "Done" = browser: hamburger เปิด/ปิด,
     dropdown ใช้ได้, anchor scroll ถึง section จริง, toggle สลับ active.
     Satisfies: 2.1-2.5, 3.1-3.5, 1.3. Depends on: 1, 3. Verify: browser 375/1440 — hamburger +
     dropdown + anchor.
     Evidence: Header/UtilityBar อยู่ใน `app/components/`; `next build` exit 0. browser 375/1440
     (hamburger/dropdown/anchor) ไม่มี record รายตัวตอน impl — ไม่ได้ re-run. back-stamp 2026-06-13.

- [x] 5. Static content sections — `Hero` (split L/R, การ์ดทางลัด 4 อัน + login/register link,
     campaign banner SVG รายละเอียด + CTA เหลือง), `Services` (>=12 SVG icon grid), `Stats` (>=4 พื้น
     กรมท่า), `AppDownload` (phone mockup UI จำลองจริง: status bar/การ์ดกรมธรรม์/ปุ่ม + store badge SVG),
     `Footer` (directory หลายคอลัมน์ + ยุบมือถือ). ทุกภาพเป็น inline SVG/รูปจริง — ห้ามกล่องว่าง. "Done"
     = browser: ทุก section เสร็จเชิงภาพ, phone mockup มี UI ข้างใน, no overflow.
     Satisfies: 4.1-4.5, 6.1-6.3, 9.1, 12.1-12.2, 13.1-13.2, 15.2. Depends on: 1, 3. Batch: B1.
     Evidence: Hero/Services/Stats/AppDownload/Footer อยู่ใน `app/components/`; `next build` exit 0.
     visual/no-overflow ไม่มี record รายตัว — ไม่ได้ re-run. back-stamp 2026-06-13.

- [x] 6. Card-grid sections (filter/search) — `InsuranceTypes` (client: grid >=6 + search + category
     filter, รวมกันเป็น AND, empty state), `Promotions` (client: grid >=8 + type filter, ราคาเดิม
     ขีดฆ่า + ราคา accent + ปุ่ม รายละเอียด/ซื้อเลย), `Articles` (server: grid >=8 + author avatar).
     ใช้ `SmartImage` ทุกการ์ด. "Done" = browser: filter+search กรองจริง (AND), empty state ขึ้น,
     ราคาขีดฆ่าถูก.
     Satisfies: 5.1-5.6, 7.1-7.4, 10.1. Depends on: 1, 3. Batch: B1.
     Evidence: InsuranceTypes/Promotions/Articles อยู่ใน `app/components/`; `next build` exit 0.
     filter AND / empty-state ไม่มี record รายตัว — ไม่ได้ re-run. back-stamp 2026-06-13.

- [x] 7. Premium calculator UI — `PremiumCalculator` (client) wire ฟอร์ม (เลือกประเภท + age +
     sumAssured + ปุ่มคำนวณ) เข้า `lib/` (task 2): on-submit -> parseAndValidate -> calcPremium ->
     formatTHB; แสดง error ใต้ช่อง, เคลียร์ error on-change. ไม่ฝังสูตรใน JSX. "Done" = browser:
     acceptance #3/#4/#5 ผ่าน (คำนวณถูก + validate 5 เคส + error ชัด).
     Satisfies: 8.1-8.9 (UI wire). Depends on: 1, 2. Verify: browser — กรอกชุดทดสอบ + เคสผิด.
     Evidence: PremiumCalculator อยู่ใน `app/components/` wire เข้า `lib/` (tested 47/47); `next build`
     exit 0. browser acceptance #3/#4/#5 ไม่มี record — ไม่ได้ re-run. back-stamp 2026-06-13.

- [x] 8. Testimonials slider — `Testimonials` (client) slider >=3: ปุ่ม prev/next + dots + active
     state + keyboard + swipe (optional) + เคารพ `prefers-reduced-motion`. การ์ดเต็มใบ ไม่ overflow
     นอก track. "Done" = browser: เลื่อนถัดไป/ก่อนหน้าได้, dots ตรงตำแหน่ง.
     Satisfies: 11.1-11.4, 16.5 (slider part). Depends on: 1, 3. Verify: browser — เลื่อน + keyboard.
     Evidence: Testimonials อยู่ใน `app/components/`; `next build` exit 0. slider behavior ไม่มี
     record — ไม่ได้ re-run. back-stamp 2026-06-13.

- [x] 9. Page assembly + responsive + a11y/visual pass — `page.tsx` ประกอบ 12 section ตามลำดับ
     REQ-1.1 (cross-check ทุก section มี component จริง + anchor ตรง nav — gap-catch point), `<main>` +
     landmark. รอบ responsive 375/768/1440 (กริด 4->2->1, utility/footer ยุบ, no horizontal overflow)
     - a11y (focus ring ทุก control, alt ทุก img, contrast AA, heading hierarchy, reduced-motion) +
       visual sweep (no กล่องว่าง, no dead space). "Done" = prod build + acceptance checklist #1-11 ผ่าน
       ที่ 3 viewport.
       Satisfies: 1.1, 14.1-14.5, 15.2, 15.5, 16.1-16.5. Depends on: 4, 5, 6, 7, 8. Verify:
       `next build` + `next start` บน 127.0.0.1, ตรวจ DevTools 375/768/1440.
       Evidence: `next build` exit 0 — Next 16.2.7 compiled OK, 3 static pages (fresh 2026-06-13);
       `page.tsx` ประกอบ section ครบ. responsive 375/768/1440 + a11y sweep ไม่มี record รายตัว —
       ไม่ได้ re-run. back-stamp 2026-06-13.

## Suggested execution batches

Feature นี้ **coupled หนัก** — ทุก section พึ่ง shared primitives (ui/, SmartImage), tokens, data,
lib. DEFAULT = รัน **ทั้งหมดใน 1 session**: `scripts/pane-loop.sh insurance-homepage all-in-one`
(หรือ `/spec-implement all`). แยก session ไม่ share cache -> re-acquire context แพง ~30-40% (lessons).

ลำดับ dependency: **1 -> 2,3 -> 4,5,6,7,8 -> 9**.

- **Batch B1** = task 5 + 6 (section-building, ใช้ primitives/data/SmartImage ชุดเดียวกัน) — ป้อนคู่
  ได้ถ้าแยกรัน: `scripts/pane-loop.sh insurance-homepage 5+6`.
- **Task 2 [CORE]** = pricing logic — แยก session เพื่อ **accuracy** ได้ (isolate domain จาก
  long-context drift) เป็น conscious trade ไม่ใช่ cost win. ถ้าเดิน all-in-one ก็ทำ task 2 ก่อน
  (test เขียว) แล้วค่อย UI.
