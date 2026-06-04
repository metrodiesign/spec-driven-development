# Bugfix: ปุ่ม size="lg" ยุบความสูง (dead `h-13` class)

## Bug

ปุ่มจาก `Button` primitive ที่ `size="lg"` ยุบเหลือ ~26px (ความสูง intrinsic ของ text)
แทนที่จะเป็นปุ่มเต็มความสูง ดูบางเหมือนยังไม่เสร็จ. กระทบ 2 จุดที่มองเห็น:
Hero CTA "ดูโปรโมชั่นทั้งหมด" และ PremiumCalculator submit "คำนวณเบี้ยประกัน".

## Root Cause (ยืนยันแล้ว)

`app/components/ui/Button.tsx:27` -> `lg: "h-13 px-7 text-body"`.
`h-13` ไม่มีจริง — Tailwind default spacing scale ข้าม 13 (h-12=3rem -> h-14=3.5rem)
และ `tailwind.config.ts` `theme.extend` ไม่ได้ define token `13` -> ไม่ emit `.h-13` CSS
-> ปุ่ม lg ไม่มี explicit height -> ยุบเป็นความสูง content. `sm`(h-9)/`md`(h-11) valid
จึงไม่กระทบ. `h-13` เป็น dead utility class ตัวเดียวในโค้ดเบส (สแกนทั้ง `app/` แล้ว).

## Fix

เพิ่ม token `spacing["13"] = "3.25rem"` (52px) ใน `tailwind.config.ts` ->
`theme.extend.spacing` -> `h-13` emit CSS -> ปุ่ม lg สูง 52px (ต่อ scale 36/44/52).
แก้ที่ token เดียว (single source per REQ-17.1) — ไม่แตะ `Button.tsx`, ทั้ง 2 call site
หายพร้อมกัน.

## Acceptance Criteria (EARS)

- B1.1 WHEN ปุ่ม `Button` ถูก render ด้วย `size="lg"` THE SYSTEM SHALL ให้ความสูง 3.25rem
  (52px) ผ่าน utility `h-13` ที่ backed ด้วย `theme.extend.spacing["13"]`.
- B1.2 THE SYSTEM SHALL นิยาม `spacing["13"]` ไว้ใน `tailwind.config.ts` -> `theme.extend`
  (single source of truth, REQ-17.1) — ไม่ใช่ raw value ใน component.

## Unchanged behavior (SHALL CONTINUE)

- B2.1 WHEN ปุ่มถูก render ด้วย `size="sm"` THEN THE SYSTEM SHALL CONTINUE TO ใช้
  `h-9 px-3 text-caption` (2.25rem).
- B2.2 WHEN ปุ่มถูก render ด้วย `size="md"` (รวม default) THEN THE SYSTEM SHALL CONTINUE TO
  ใช้ `h-11 px-5 text-body` (2.75rem).
- B2.3 WHEN `size="lg"` THEN THE SYSTEM SHALL CONTINUE TO คง `px-7 text-body` + BASE
  (flex/centering/focus-ring) — แก้เฉพาะ token height.
- B2.4 WHEN ปุ่ม render ด้วย `as="a"` + `href` THEN THE SYSTEM SHALL CONTINUE TO render `<a>`
  ที่มี class string ครบ (BASE + variant + size + caller className).
- B2.5 WHEN caller ส่ง `className` (เช่น `w-fit`/`w-full`) THEN THE SYSTEM SHALL CONTINUE TO
  ต่อท้ายสุด (caller override ได้).
- B2.6 THE SYSTEM SHALL CONTINUE TO คง hex literal `#13266B`/`#FDB913` และ token สีอื่น
  ใน config ไม่เปลี่ยน.
