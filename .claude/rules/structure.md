# Project Structure

## Folder Layout

```
app/
  layout.tsx          # root layout — โหลดฟอนต์ไทย, metadata, <html lang="th">
  page.tsx            # homepage — ประกอบ section ตามลำดับ 1–13
  globals.css         # @tailwind directives + keyframes เท่านั้น (ที่จำเป็น)
  components/         # คอมโพเนนต์ UI แยกตาม section
    UtilityBar.tsx
    Header.tsx
    Hero.tsx
    InsuranceTypes.tsx
    Services.tsx
    Promotions.tsx
    PremiumCalculator.tsx   # "use client"
    Stats.tsx
    Articles.tsx
    Testimonials.tsx         # "use client"
    AppDownload.tsx
    Footer.tsx
    ui/                # primitive ใช้ซ้ำ: Card, Button, Badge, Icon, Container
  data/               # mock data + types: insuranceTypes.ts, promotions.ts, articles.ts ...
  lib/                # logic ล้วน: premium.ts (สูตรคำนวณเบี้ย), validation
tailwind.config.ts    # design tokens ใน theme.extend
next.config.ts        # images.remotePatterns
```

## Naming Conventions

- คอมโพเนนต์: PascalCase ทั้งชื่อไฟล์และฟังก์ชัน (`PremiumCalculator.tsx`)
- ไฟล์ data/lib: camelCase (`insuranceTypes.ts`, `premium.ts`)
- type/interface: PascalCase (`InsuranceType`, `PromotionCard`)
- ค่าคงที่ mock: UPPER หรือ camelCase array export ที่มี type ชัด

## Import Ordering

1. external (react, next, ...)
2. internal absolute (`@/app/components/...`, `@/app/lib/...`)
3. relative (`./...`)

## Architectural Patterns

- Server Component เป็นค่าเริ่มต้น; `"use client"` เฉพาะ interactive (calculator, slider, filter, menu)
- Logic คำนวณ/validate แยกไว้ใน `app/lib/` — คอมโพเนนต์เรียกใช้ ไม่ฝังสูตรใน JSX
- Mock data แยกใน `app/data/` — คอมโพเนนต์รับผ่าน props หรือ import โดยตรง ไม่ inline ยาวๆ
- design tokens อยู่ที่เดียว (tailwind.config.ts) — เรียกผ่าน semantic utility class
- ปุ่ม/การ์ด/อินพุต มี state ครบ: default/hover/focus(ring)/active/disabled + transition 150–250ms
- ใช้ `<Container>` ครอบเนื้อหาทุก section ให้ max-width ~1200–1280px + padding เท่ากัน

## Anti-Patterns

- ห้าม hardcode สี hex ดิบซ้ำในคอมโพเนนต์ (ใช้ token)
- ห้ามกล่อง/สี่เหลี่ยมสีเดียวเป็น placeholder รูป
- ห้ามฝังสูตรคำนวณเบี้ยตรงใน JSX ของ component
- ห้าม `"use client"` ทั้งหน้า/ที่ root โดยไม่จำเป็น
- ห้าม inline mock data ก้อนใหญ่ในไฟล์คอมโพเนนต์
- ห้าม element ล้นจอแนวนอน (ยกเว้น slider ที่ตั้งใจ)
