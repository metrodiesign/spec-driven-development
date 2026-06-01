# Technology Stack

## Languages & Runtimes

- TypeScript 5.x — `strict: true`, เลี่ยง `any`, กำหนด type ของ props/data ชัดเจน
- Node.js 20.9+ (รันด้วย `npm install && npm run dev`)

## Frameworks & Core Libraries

- Next.js 16 (App Router) — โครงใน `app/` (`layout.tsx`, `page.tsx`)
- React 19 — Server Components เป็นค่าเริ่มต้น; ใส่ `"use client"` เฉพาะคอมโพเนนต์ที่ต้องโต้ตอบ
  (เมนู, สไลเดอร์, ตัวกรอง, ฟอร์ม, เครื่องคำนวณ)
- Tailwind CSS — ตั้งค่าผ่าน `tailwind.config.ts`; design tokens อยู่ใน `theme.extend`

## Data Layer

- ไม่มี DB / backend — ข้อมูล (ประเภทประกัน, โปรโมชั่น, บทความ, testimonials) เป็น mock
  ในไฟล์ TypeScript แยกต่างหาก พร้อม type ชัดเจน

## Tooling

- `next/image` สำหรับรูป; ตั้ง `images.remotePatterns` ใน `next.config.ts` หากดึงรูปภายนอก
  (เช่น `picsum.photos`)
- เว็บฟอนต์ไทยจริงผ่าน Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`) —
  IBM Plex Sans Thai / Noto Sans Thai / Sarabun / Prompt / Kanit; ห้ามตกไปใช้ฟอนต์ระบบ
- ไอคอน = inline SVG (ห้าม icon font / กล่องเปล่า)

## Hard Constraints

- ห้ามมีกล่องว่าง / สี่เหลี่ยมสีเดียวเป็น placeholder — ทุกพื้นที่ภาพต้องดู "เสร็จ"
  (inline SVG มีรายละเอียด / รูปจริง / gradient + ลวดลายที่จัดองค์ประกอบ)
- ห้าม horizontal overflow ที่ทุก viewport (ยกเว้น slider ที่ตั้งใจ)
- ห้าม hardcode ค่าสีดิบซ้ำๆ — เรียกผ่าน semantic utility class จาก tokens
- ทุก `<img>` มี `alt` และโหลดได้จริง; semantic HTML + นำทางด้วยคีย์บอร์ดได้; contrast ผ่านเกณฑ์
- พาเลตแบรนด์ (วิริยะ): primary กรมท่า ~#13266B, primary-dark ~#0E1C50,
  accent เหลืองทอง ~#FDB913, bg ~#F5F7FB, surface ขาว, text ~#1A2238 + muted/border

## Rule

Prefer this stack over alternatives. ห้ามเพิ่ม library ใหม่โดยไม่ระบุเหตุผลและขออนุมัติก่อน.
