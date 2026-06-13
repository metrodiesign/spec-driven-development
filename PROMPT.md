# สเปกสร้างหน้าแรกเว็บไซต์ "วิริยะประกันภัย" (Insurance Homepage)

เอกสารนี้คือสเปกฉบับสมบูรณ์ของหน้าแรกพอร์ทัลบริษัทประกัน สร้างใหม่ตามสเปกนี้แล้วต้องได้ผลลัพธ์เหมือนเดิม (เนื้อหา/โครงสร้าง/ตรรกะคำนวณตรงกัน). ค่าคงที่ (ค่าสี/สูตร/ข้อความ/จำนวน entry) ถือเป็น LOCKED — ใช้ตามนี้เป๊ะ.

อ้างอิง IA แบบพอร์ทัลโรงพยาบาลใหญ่ (Bangkok Hospital) แปลงเป็นธุรกิจประกัน ดูน่าเชื่อถือ มืออาชีพ "ดูแพง" รันได้ทันทีในเบราว์เซอร์.

---

## 1. เทคโนโลยีและการรัน

- **Next.js 16.2.7 (App Router) + React 19.2.0 + TypeScript 5.7 (`strict`) + Tailwind CSS 3.4.17**
- เพิ่ม dependency: **`swiper@^12.2.0`** (ใช้ใน hero carousel), `react-dom@19.2.0`
- devDeps: `autoprefixer`, `postcss@8`, `vitest@^2.1.8`, `@types/*`
- รัน: `npm install && npm run dev` (Node 20.9+) เปิด `http://localhost:3000`
- scripts: `dev`, `build`, `start`, `lint`, `typecheck`=`tsc --noEmit`, `test`=`vitest run`
- Server Components เป็นค่าเริ่มต้น; `"use client"` เฉพาะคอมโพเนนต์ที่โต้ตอบ (UtilityBar, Header, HeroCampaignSlider, InsuranceTypes, Promotions, PremiumCalculator, Testimonials, SmartImage)
- `next/image` สำหรับรูป; `next.config.ts` ตั้ง `images.remotePatterns` (https): `picsum.photos`, `i.picsum.photos`, `images.pexels.com`
- logic คำนวณ/validate แยกใน `app/lib/` เป็น pure function + มี unit test (vitest, `environment:node`, include `app/lib/**`)

### โครงสร้างไฟล์

```
app/
  layout.tsx            # โหลดฟอนต์ไทย, metadata, <html lang="th">, skip-link
  page.tsx              # ประกอบ 12 section ตามลำดับ
  globals.css           # @tailwind + base + focus ring + reduced-motion
  components/
    UtilityBar.tsx Header.tsx Hero.tsx HeroCampaignSlider.tsx
    InsuranceTypes.tsx Services.tsx Promotions.tsx PremiumCalculator.tsx
    Stats.tsx Articles.tsx Testimonials.tsx AppDownload.tsx Footer.tsx
    ui/ Button.tsx Card.tsx Badge.tsx Container.tsx SectionHeading.tsx Icon.tsx SmartImage.tsx
  data/   insuranceTypes.ts services.ts promotions.ts articles.ts stats.ts
          testimonials.ts appFeatures.ts navigation.ts heroCampaigns.ts types.ts
  lib/    premium.ts validatePremium.ts format.ts (+ *.test.ts)
public/images/hero/   motor.png health.png life.png travel.png home.png accident.png  (1536x1024, 3:2)
tailwind.config.ts  next.config.ts
```

---

## 2. Design tokens (`tailwind.config.ts` → `theme.extend`) — LOCKED

เรียกผ่าน utility class เชิงความหมายทั้งหน้า ห้าม hardcode ค่าสีดิบซ้ำ.

**colors**

- `primary` = `#13266B` (กรมท่า), `primary.dark` = `#0E1C50`, `primary.light` = `#24398A`
- `accent` = `#FDB913` (เหลืองทอง), `accent.dark` = `#E0A500`
- `bg` = `#F5F7FB`, `surface` = `#FFFFFF`
- `text` = `#1A2238`, `text.muted` = `#5B6479`, `border` = `#E2E6EF`

**fontFamily.sans** = `["var(--font-sans)", "system-ui", "sans-serif"]`

**fontSize** (size / lineHeight / weight): `h1`=3rem/1.2/700, `h2`=2rem/1.25/700, `h3`=1.25rem/1.3/600, `body`=1rem/1.6/400, `caption`=0.875rem/1.5/400

**spacing** เพิ่ม `13`=3.25rem (รองรับ Button lg = h-13 = 52px)

**borderRadius**: sm=6px, md=10px, lg=16px, xl=24px

**boxShadow**:

- `card` = `0 1px 3px rgba(19,38,107,.08), 0 1px 2px rgba(19,38,107,.06)`
- `cardHover` = `0 10px 25px rgba(19,38,107,.12), 0 4px 10px rgba(19,38,107,.08)`
- `banner` = `0 20px 50px rgba(14,28,80,.35)`

**maxWidth.container** = 1440px; **transitionDuration.DEFAULT** = 200ms

**keyframes/animation**: `fade-in` (`opacity 0→1, translateY 8px→0`) = `fade-in 250ms ease-out both`; `shimmer` (bg-position −200%→200%) = `shimmer 1.6s linear infinite`

### ฟอนต์ (`app/layout.tsx`)

- `IBM_Plex_Sans_Thai` จาก `next/font/google` — `subsets:["thai","latin"]`, `weight:["400","500","600","700"]`, `variable:"--font-sans"`, `display:"swap"`. self-host ตอน build (ไม่ง้อ network runtime). ห้ามตกไปใช้ฟอนต์ระบบ.
- `<html lang="th" className={font.variable}>`
- metadata: title `วิริยะประกันภัย — ประกันที่ดูแลคุณทุกช่วงชีวิต`; description `พอร์ทัลประกันภัยครบวงจร: เปรียบเทียบแผนประกันชีวิต สุขภาพ รถยนต์ เดินทาง คำนวณเบี้ยประกันออนไลน์ จัดการกรมธรรม์ และแจ้งเคลมได้ในที่เดียว`; keywords `["ประกันภัย","ประกันชีวิต","ประกันสุขภาพ","ประกันรถยนต์","คำนวณเบี้ยประกัน"]`
- `<body>` มี skip-link แรกสุด → `#main` ข้อความ `ข้ามไปยังเนื้อหาหลัก` (`sr-only focus:not-sr-only ...`)

### `app/globals.css` (นอกจาก `@tailwind base/components/utilities`)

- `html`: `scroll-behavior: smooth; scroll-padding-top: 96px;`
- `body`: `@apply bg-bg text-text font-sans text-body antialiased;`
- `h1/h2/h3` → `@apply text-h1 / text-h2 / text-h3`
- focus ring (token เดียวทั้งหน้า): `:focus-visible { @apply outline-none ring-2 ring-accent ring-offset-2 ring-offset-bg; }`
- `.skeleton-shimmer` utility: `linear-gradient(100deg,#e8ecf5 20%,#f3f6fc 40%,#e8ecf5 60%)` + `background-size:200% 100%` + `animate-shimmer`
- `@media (prefers-reduced-motion: reduce)`: `html{scroll-behavior:auto}` + `*{animation-duration:.01ms!important; animation-iteration-count:1!important; transition-duration:.01ms!important}`

---

## 3. UI primitives (`app/components/ui/`)

- **Container** — `mx-auto w-full max-w-container px-4 sm:px-6 lg:px-8`. รับเฉพาะ `as`/`className`/`children` (ไม่ spread props → section ที่ต้อง `id` ให้ครอบด้วย `<section id>` ภายนอก)
- **Button** — polymorphic (`<button>` default; `as="a"`+`href`→`<a>`). variant: `primary` (`bg-primary text-surface hover:bg-primary-light active:bg-primary-dark`), `accent` (`bg-accent text-primary-dark hover:bg-accent-dark`), `outline` (`border border-border bg-surface text-text hover:border-primary hover:text-primary`), `ghost` (`text-primary hover:bg-primary/5`). size: `sm`=h-9 px-3 text-caption, `md`=h-11 px-5 text-body, `lg`=h-13 px-7 text-body. base มี `focus-visible:ring-2 ring-accent ring-offset-2` + `disabled:opacity-50`
- **Card** — `flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card`; `interactive` เพิ่ม `hover:-translate-y-1 hover:shadow-cardHover focus-within:...`
- **Badge** — tone `primary` (`bg-primary/10 text-primary`), `accent` (`bg-accent/20 text-accent-dark`), `neutral` (`bg-bg text-text-muted`); `rounded-sm px-2.5 py-1 text-caption font-medium`
- **SectionHeading** — eyebrow `<p>` (uppercase tracking-wide, `text-accent-dark`; invert→`text-accent`) + `<h2>` + description `<p>` + slot `action`; layout `sm:flex-row sm:items-end sm:justify-between`. `invert` ใช้บนพื้นเข้ม
- **Icon** — inline SVG registry 42 ชื่อ, `viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth=1.8 round`, default size 24, มี `label`→`role=img aria-label` ไม่งั้น `aria-hidden`. `IconName`=keyof PATHS. ชื่อ: `menu close search chevronDown chevronLeft chevronRight arrowRight check user cart globe location phone star life health motor travel accident home cancer savings cartPlus claim renew changePlan agent download status pay hospital points calculator shield document contact facebook line youtube instagram`
- **SmartImage** ("use client") — wrap `next/image`, `placeholder="blur"` + blurDataURL = inline SVG gradient (`#24398A`→`#0E1C50`). prop `fallbackIcon` (default `shield`). onError → fallback ที่ดูตั้งใจ: `bg-gradient-to-br from-primary-light to-primary-dark` + SVG dots (`circle r=1.5 fill=#FDB913` opacity-20) + `<Icon size=44 className=text-accent>`, `role=img aria-label={alt}`. ห้ามกล่องว่าง/ภาพแตก

---

## 4. ตรรกะคำนวณเบี้ย (`app/lib/`) — LOCKED, deterministic

### `premium.ts`

- `BASE_RATES` (เบี้ยต่อทุน 1,000 บาท/ปี): life 8.0, health 12.0, motor 18.0, travel 3.0, accident 5.0, home 2.5, cancer 6.0, savings 10.0
- `AGE_FACTORS` (≤max → factor): ≤17→0.8, ≤30→1.0, ≤40→1.2, ≤50→1.5, ≤60→2.0, ≤70→2.8, ≤80→3.5
- `RANGES`: age {min 1, max 80}, sumAssured {min 100,000, max 50,000,000}
- `ageFactor(age)` = factor ของช่วงแรกที่ `age <= max`
- **สูตร**: `calcPremium = Math.round(BASE_RATES[category] × (sumAssured / 1000) × ageFactor(age))`
- ตัวอย่างตรวจรับ: life, age 30, sum 1,000,000 → `8.0 × 1000 × 1.0` = **8,000 บาท/ปี**

### `validatePremium.ts`

- `parseAndValidate(raw: {category, age, sumAssured: string})` — validate **ทุกช่องพร้อมกัน** (ไม่หยุดที่ช่องแรก). parse ตัวเลข = ตัด `,`/ช่องว่าง → `null`(ว่าง)/`NaN`/number. ลำดับเช็คต่อช่อง: ว่าง → NaN → นอกช่วง
- ข้อความ error (ไทย): category ว่าง `กรุณาเลือกประเภทประกัน` / ไม่ถูกต้อง `ประเภทประกันไม่ถูกต้อง`; age ว่าง `กรุณากรอกอายุ` / NaN `อายุต้องเป็นตัวเลข` / นอกช่วง `อายุต้องอยู่ระหว่าง 1-80 ปี`; sumAssured ว่าง `กรุณากรอกทุนประกัน` / NaN `ทุนประกันต้องเป็นตัวเลข` / นอกช่วง `ทุนประกันต้องอยู่ระหว่าง 100,000-50,000,000 บาท`
- คืน `{ok:true, input}` หรือ `{ok:false, errors}`

### `format.ts`

- `formatTHB(amount)` = `Math.round(amount).toLocaleString("en-US")` (คั่นหลักพันด้วย `,`)
- วันที่ไทย (มีใน Promotions/Articles): `TH_MONTHS`=`[ม.ค., ก.พ., มี.ค., เม.ย., พ.ค., มิ.ย., ก.ค., ส.ค., ก.ย., ต.ค., พ.ย., ธ.ค.]`, ปี = ค.ศ.+543 (พ.ศ.)

---

## 5. ชนิดข้อมูลและ taxonomy (`app/data/types.ts`)

- `InsuranceCategory` (8 ค่า): `life, health, motor, travel, accident, home, cancer, savings`
- `CATEGORY_LABELS`: ประกันชีวิต / ประกันสุขภาพ / ประกันรถยนต์ / ประกันเดินทาง / ประกันอุบัติเหตุ / ประกันบ้าน / ประกันมะเร็ง / ประกันสะสมทรัพย์
- `CATEGORY_ICONS`: แต่ละหมวด map ไอคอนชื่อเดียวกับ key
- interfaces: `InsuranceType{id,category,name,tagline,imageUrl,planHref}`, `ServiceItem{id,label,icon,href}`, `Promotion{id,category,title,badge,priceCurrent,priceOriginal,expiresOn,imageUrl,detailsHref,buyHref}`, `Stat{id,value,label,icon}`, `Article{id,title,category(string),imageUrl,author{name,avatarUrl},date}`, `Testimonial{id,quote,name,role,avatarUrl,rating}`, `AppFeature{id,label,icon}`, `NavItem{label,anchor,children?}`, `HeroCampaign{id,headline,display,items[],ctaLabel,ctaHref,imageUrl,icon}`
- หมายเหตุ: `Article.category` เป็น free-form string (หัวข้อบทความ) คนละแกนกับ `InsuranceCategory` (taxonomy filter สินค้า)

---

## 6. ลำดับหน้า (`app/page.tsx`) — 12 section

`<UtilityBar/>`, `<Header/>`, `<main id="main">`( `Hero, InsuranceTypes, Services, Promotions, PremiumCalculator, Stats, Articles, Testimonials, AppDownload` )`</main>`, `<Footer/>`

ทุก section ใช้ `<Container>` คุมความกว้าง; padding section หลัก `py-14 lg:py-20`. section ที่เป็น scroll target ครอบด้วย `<section id="...">`.

### (1) UtilityBar ("use client")

แถบบาง `border-b-2 border-accent bg-primary text-surface` แถว `h-10`. state UI-only: `lang(TH/EN)`, `currency(THB/USD)`.

- ซ้าย: `วิริยะประกันภัย` (globe, hidden < sm) + ลิงก์ `กรมธรรม์ของฉัน`→#services (shield)
- ขวา: `<form role="search">` placeholder `ค้นหา...` (hidden < md); toggle TH/EN (`aria-pressed`, active=`bg-accent text-primary-dark`); select THB ฿/USD $ (hidden < sm); ลิงก์ `เข้าสู่ระบบ / สมัครสมาชิก` (sm: `เข้าสู่ระบบ`)→#calculator (user); ลิงก์ตะกร้า→#promotions (cart)

### (2) Header ("use client") — sticky

`<header sticky top-0 z-50 bg-surface/95 backdrop-blur>` แถว `h-16`.

- โลโก้→#main: inline SVG โล่ (fill `#13266B`, stroke `#FDB913`, ถูก stroke `#FDB913`) + `วิริยะประกันภัย` / `VIRIYAH INSURANCE`
- desktop nav `hidden lg:flex` render `MAIN_NAV`; item มี children → dropdown (เปิดด้วย hover/focus-within, chevronDown, มี hover-bridge ปิด dead zone, ปิดด้วย ESC คืน focus/click-outside)
- `hidden lg:flex`: `<a href="tel:1557">สายด่วน 1557` (phone) + Button accent sm→#calculator `คำนวณเบี้ย`
- `lg:hidden` hamburger (menu/close, `aria-expanded`, `aria-controls=mobile-menu`) → mobile panel `<nav id="mobile-menu">` (MAIN_NAV+children + hotline + ปุ่ม)
- desktop nav vs hamburger split ที่ `lg:` (≥1024) — กัน off-by-one ที่ 768

### (3) Hero — `<section bg-bg py-10 lg:py-14>`, Container `grid lg:grid-cols-[minmax(0,3fr)_minmax(0,7fr)]` items-stretch

- ซ้าย ≈30% (`order-2 lg:order-1 min-w-0` — การ์ดอยู่ล่าง slider บน responsive, desktop กลับซ้าย): `<h1 id="hero-heading" class="sr-only">วิริยะประกันภัย ประกันที่ดูแลคุณทุกช่วงชีวิต</h1>`; การ์ด header `สมัครสมาชิกวันนี้ รับ 20 V Points!` + `ลงทะเบียน / เข้าสู่ระบบ`→#calculator + badge `V Point`; กริด 2×2 มีเส้นคั่น: ซื้อประกัน(cartPlus,#insurance-types) / เช็กกรมธรรม์(document,#services) / แจ้งเคลม(claim,#services) / ติดต่อเรา(contact,#services); ลิงก์ `ไปยัง แผนประกันยอดนิยม`→#promotions
- ขวา ≈70% (`order-1 lg:order-2`): `<HeroCampaignSlider/>` (ดูข้อ 7)

### (4) InsuranceTypes ("use client") — `<section id="insurance-types" bg-bg>`

SectionHeading: eyebrow `ผลิตภัณฑ์ประกันภัย`, title `เลือกความคุ้มครองที่ใช่สำหรับคุณ`, desc `ครบทุกประเภทประกัน พร้อมแผนที่ปรับให้เหมาะกับทุกไลฟ์สไตล์`.

- ช่องค้นหา (state `query`) + filter chips (state `category`: `all`+8 หมวด, active=`bg-primary text-surface`) → กรองแบบ AND (match name/tagline/label)
- grid `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`. การ์ด: SmartImage `aspect-[3/2]` + Badge accent(label) + h3 name + tagline + ลิงก์ `ดูแผนประกัน`(arrowRight)
- empty state: search icon + `ไม่พบประเภทประกันที่ค้นหา` + ปุ่ม `ล้างตัวกรองทั้งหมด`

### (5) Services (server) — `<section id="services" bg-surface>`

SectionHeading: eyebrow `บริการออนไลน์`, title `ทำธุรกรรมประกันได้ครบ จบในที่เดียว`, desc `เลือกบริการที่ต้องการ ใช้งานได้ตลอด 24 ชั่วโมง ไม่ต้องไปสาขา`, action `ดูทั้งหมด`(arrowRight). grid `grid-cols-2 sm:grid-cols-3 lg:grid-cols-7`. การ์ด: วงกลมไอคอน (`bg-primary/8`, hover→`bg-primary text-surface`) + label, hover `-translate-y-1`

### (6) Promotions ("use client") — `<section id="promotions" bg-surface>`

SectionHeading: eyebrow `โปรโมชั่นแนะนำ`, title `ดีลประกันสุดคุ้มประจำเดือนนี้`, desc `รวมแผนประกันราคาพิเศษ พร้อมส่วนลดที่คัดมาให้แล้ว`, action = select THB/USD (UI-only). filter chips `all`+เฉพาะหมวดที่มีโปรจริง. grid `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`. การ์ด: SmartImage + Badge accent(badge) + label หมวด + h3 title + ราคา `฿{formatTHB(priceCurrent)}` (accent-dark) + `฿{priceOriginal}` line-through + `หมดเขต {วันที่ไทย}`(renew) + ปุ่ม `รายละเอียด`/`ซื้อเลย`

### (7) PremiumCalculator ("use client") — `<section id="calculator" bg-bg>`

การ์ด `lg:grid lg:grid-cols-[1.1fr_0.9fr]`.

- ฟอร์มซ้าย: eyebrow `เครื่องคำนวณเบี้ยประกัน`, h2 `ประเมินเบี้ยประกันของคุณ`. field: `<select id=calc-category>` (option แรก `-- เลือกประเภทประกัน --` + 8 หมวด); `<input id=calc-age type=text inputMode=numeric>` placeholder `เช่น 30 (รับ 1-80 ปี)`; `<input id=calc-sum>` placeholder `เช่น 1,000,000 (100,000-50,000,000)`. ปุ่ม Button primary lg full `คำนวณเบี้ยประกัน`(calculator)
- **trigger = on-submit เท่านั้น** → `parseAndValidate` → ถ้า ok → `calcPremium`. error เคลียร์เมื่อแก้ field นั้น. error: `border-red-500`, `text-red-600`, `aria-invalid`/`aria-describedby`
- panel ผลขวา `bg-primary text-surface`: eyebrow `เบี้ยประกันโดยประมาณ`; มีผล → `{formatTHB(premium)}` + `บาท / ปี` + `สำหรับ {หมวด} อายุ {age} ปี ทุนประกัน ฿{...}` + disclaimer(shield), ใช้ `animate-fade-in`; ไม่มีผล → `— —` + checklist 3 ข้อ (`คำนวณได้ทันที ไม่ต้องลงทะเบียน`, `ครบทุกประเภทประกัน`, `ผลลัพธ์เป็นค่าประเมินเบื้องต้น`)

### (8) Stats (server) — `<section id="stats" bg-primary text-surface>` พื้นเข้ม + SVG dots (`fill=#FDB913` opacity-10)

eyebrow `ความมั่นคงที่พิสูจน์ได้`, h2 `เคียงข้างคนไทยมากว่า 75 ปี`. `<dl grid grid-cols-2 lg:grid-cols-5>`: ไอคอนวงกลม + `<dd>`value + `<dt>`label

### (9) Articles (server) — `<section id="articles" bg-bg>`

SectionHeading: eyebrow `ความรู้ประกันและการเงิน`, title `บทความแนะนำสำหรับคุณ`, desc `อัปเดตความรู้เรื่องประกันและการวางแผนการเงินจากผู้เชี่ยวชาญ`, action `ดูบทความทั้งหมด`. grid `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`. การ์ด: SmartImage `aspect-[5/3]` + Badge primary(category) + h3 title + แถว author (avatar `h-9 w-9 rounded-full` fallbackIcon=user + name + วันที่ไทย)

### (10) Testimonials ("use client") — `<section id="testimonials" bg-surface aria-roledescription="carousel">`

eyebrow `เสียงจากลูกค้า`, h2 `ลูกค้ากว่า 5 ล้านคนไว้วางใจเรา`. slider `translateX(-index*100%)` (300ms), prev/next/dots wrap แบบ modulo, keyboard ArrowLeft/Right. slide: contact icon + 5 ดาว (เต็ม=text-accent ว่าง=text-border ตาม rating) + blockquote + figcaption (avatar + name + role). dots active `w-6 bg-primary`. (reduced-motion ครอบโดย globals.css)

### (11) AppDownload (server) — `<section id="app" bg-primary-dark text-surface>`, Container `grid lg:grid-cols-2`

- ซ้าย: eyebrow `แอปวิริยะ`, h2 `จัดการประกันทั้งหมดได้ในมือคุณ`, desc, list `APP_FEATURES`, ปุ่ม store 2 อัน. StoreBadge inline SVG: Apple (fill `#FFFFFF`, `Download on the`/`App Store`); Google Play (4 path สี `#34D399`/`#60A5FA`/`#F87171`/`#FBBF24`, `GET IT ON`/`Google Play`) — brand hex เป็น carve-out (ไม่ต้องแปลงเป็น token)
- ขวา: PhoneMockup UI จำลองจริง — notch + status bar `9:41`, header `สวัสดี, คุณสมหญิง รักดี`, policy card `กรมธรรม์สุขภาพ ฿5,000,000 คุ้มครองถึง 31 ธ.ค. 2569`, quick actions (เคลม/ต่ออายุ/ชำระ), cta `แจ้งเคลมใหม่` (ห้ามกล่องว่าง)

### (12) Footer (server) — `<footer bg-primary text-surface>`, Container `py-12 lg:py-16`, grid `md:grid-cols-2 lg:grid-cols-[1.4fr_repeat(3,1fr)]`

- brand col: logo SVG (fill `#FDB913`, ถูก stroke `#0E1C50`) + ชื่อ + ย่อหน้า + สายด่วน 1557 + social (facebook/line/youtube/instagram)
- คอลัมน์ไดเรกทอรี 3: `ผลิตภัณฑ์` (ประกันชีวิต/สุขภาพ/รถยนต์/เดินทาง/อุบัติเหตุ→#insurance-types); `ศูนย์บริการ` (สาขาภาคกลาง/เหนือ/อีสาน/ใต้→#services, ค้นหาสาขาใกล้คุณ); `เกี่ยวกับเรา` (ประวัติบริษัท→#stats, ข่าวสารและกิจกรรม→#articles, ร่วมงานกับเรา, นักลงทุนสัมพันธ์, ติดต่อเรา→#services)
- bottom: `ใบอนุญาตประกอบธุรกิจประกันวินาศภัย เลขที่ 1557/2490 กำกับโดย คปภ.` + `© 2569 บริษัท วิริยะประกันภัย จำกัด (มหาชน) สงวนลิขสิทธิ์`

---

## 7. Hero Carousel (`HeroCampaignSlider.tsx`, "use client") — เลียนแบบ Bangkok Hospital

ใช้ **Swiper.js** (`swiper/react`; modules `EffectFade, Autoplay, A11y, Keyboard`; css `swiper/css` + `swiper/css/effect-fade`).

- **config**: `effect="fade"`, `fadeEffect={{crossFade:false}}` (ใบเดิมคงทึบเป็นพื้น ใบใหม่ค่อยจางทับ — ไม่กระพริบ/ไม่มีพื้นโผล่), `speed=300`, `rewind`, `keyboard enabled`, `autoplay={{delay:3000, disableOnInteraction:false, pauseOnMouseEnter:false}}`
- **a11y**: gate autoplay ด้วย `prefers-reduced-motion` แบบ **imperative** (`swiper.autoplay.stop()/start()` ใน effect ที่ดู matchMedia — Swiper ไม่ stop เองเมื่อ prop เปลี่ยน) + onSwiper init; `role="region" aria-roledescription="carousel" aria-label="แคมเปญแนะนำ"`
- **กรอบภาพ**: `aspect-[3/2] overflow-hidden rounded-xl shadow-banner`; แต่ละสไลด์ = `<a href={ctaHref} aria-label={headline}>` ครอบ `<SmartImage fill object-cover fallbackIcon={icon} priority={i===0}>` (banner ภาพจริงเต็มใบ text/CTA ฝังในรูป, คลิกทั้งใบ)
- **arrows**: chevronLeft/Right; **desktop เท่านั้น** (`lg:flex`), ซ่อน default โผล่เมื่อ hover/focus hero (`lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100`); z สูงกว่าสไลด์ (`z-30/z-40`)
- **dots**: คลิกไปสไลด์ได้, active=`w-6`; **responsive** — mobile/tablet อยู่ใต้กรอบภาพ (`bg-primary` navy บนพื้นสว่าง); desktop ทับบนภาพกลางล่าง (`lg:absolute lg:bottom-4`, `lg:bg-surface` ขาว)
- **swipe**: Swiper จัดการ touch + mouse drag (built-in) — ป้องกัน native image drag ด้วย `draggable={false}` (จำเป็นเมื่อ render เอง; กับ Swiper ใช้ของ Swiper)
- **memoize slides** ด้วย `useMemo([])` (slides ไม่ขึ้น index) — onSlideChange→setIndex re-render เฉพาะ dots ไม่แตะ 6 next/image (กัน flicker จาก re-render กลาง CSS transition)
- ค่าคงที่: `AUTOPLAY_MS=3000`, `SPEED_MS=300`. รูป `public/images/hero/${name}.png` (motor/health/life/travel/home/accident, 1536×1024 = 3:2 เท่ากันทุกใบ)

---

## 8. ข้อมูล mock ทั้งหมด (`app/data/`) — LOCKED

### insuranceTypes.ts — `INSURANCE_TYPES` (10) | imageUrl `https://picsum.photos/seed/${seed}/600/420`, planHref `#insurance-types`

| id         | category | name                      | tagline                                | seed               |
| ---------- | -------- | ------------------------- | -------------------------------------- | ------------------ |
| life-1     | life     | ประกันชีวิตตลอดชีพ        | คุ้มครองยาวนาน สร้างมรดกให้คนที่รัก    | viriyah-life       |
| health-1   | health   | ประกันสุขภาพเหมาจ่าย      | ค่ารักษาเหมาจ่ายสูงสุด 5 ล้านบาท/ปี    | viriyah-health     |
| motor-1    | motor    | ประกันรถยนต์ชั้น 1        | ซ่อมห้าง ลากฟรี อุ่นใจทุกเส้นทาง       | viriyah-motor      |
| travel-1   | travel   | ประกันเดินทางต่างประเทศ   | คุ้มครองทั่วโลก เคลมง่าย ครอบคลุมโควิด | viriyah-travel     |
| accident-1 | accident | ประกันอุบัติเหตุส่วนบุคคล | ชดเชยรายวัน คุ้มครอง 24 ชม. ทั่วโลก    | viriyah-accident   |
| home-1     | home     | ประกันบ้านอยู่อาศัย       | คุ้มครองไฟไหม้ น้ำท่วม โจรกรรม         | viriyah-home       |
| cancer-1   | cancer   | ประกันมะเร็งเจอจ่ายจบ     | ตรวจพบรับเงินก้อนทันที ดูแลค่ารักษา    | viriyah-cancer     |
| savings-1  | savings  | ประกันสะสมทรัพย์ 10/5     | ออมสั้น คุ้มครองยาว การันตีผลตอบแทน    | viriyah-savings    |
| health-2   | health   | ประกันสุขภาพเด็กเล็ก      | ดูแลลูกน้อยตั้งแต่แรกเกิดถึง 15 ปี     | viriyah-health-kid |
| motor-2    | motor    | ประกันรถยนต์ชั้น 2+       | คุ้มครองคู่กรณี + รถหายไฟไหม้ คุ้มค่า  | viriyah-motor-2    |

### services.ts — `SERVICES` (14) | href ส่วนใหญ่ `#services`

buy ซื้อประกันออนไลน์ (cartPlus,#insurance-types) · claim แจ้งเคลม (claim) · renew ต่ออายุกรมธรรม์ (renew) · change เปลี่ยน/ปรับแผน (changePlan) · agent ปรึกษาตัวแทน (agent) · download ดาวน์โหลดกรมธรรม์ (download) · status ตรวจสถานะเคลม (status) · pay ชำระเบี้ยประกัน (pay) · hospital โรงพยาบาลคู่สัญญา (hospital) · points สะสมแต้ม/สิทธิพิเศษ (points) · calc คำนวณเบี้ยประกัน (calculator,#calculator) · card บัตรลูกค้าดิจิทัล (document) · contact ติดต่อศูนย์บริการ (contact) · branch ค้นหาสาขา (location)

### promotions.ts — `PROMOTIONS` (9) | imageUrl `https://picsum.photos/seed/${seed}/600/400`, detailsHref/buyHref `#promotions`

| id      | category | title                     | badge   | current | original | expiresOn  | seed             |
| ------- | -------- | ------------------------- | ------- | ------- | -------- | ---------- | ---------------- |
| promo-1 | motor    | ประกันรถชั้น 1 ลดทันที    | ขายดี   | 12900   | 16500    | 2026-07-31 | promo-motor-1    |
| promo-2 | health   | สุขภาพเหมาจ่าย 5 ล้าน     | ลด 25%  | 18500   | 24600    | 2026-06-30 | promo-health-1   |
| promo-3 | travel   | เที่ยวญี่ปุ่นอุ่นใจ       | ใหม่    | 590     | 850      | 2026-08-15 | promo-travel-1   |
| promo-4 | life     | ชีวิตคุ้มครอง 2 ล้าน      | แนะนำ   | 14200   | 17800    | 2026-09-30 | promo-life-1     |
| promo-5 | accident | PA อุบัติเหตุครอบครัว     | ลด 30%  | 2100    | 3000     | 2026-07-15 | promo-accident-1 |
| promo-6 | cancer   | มะเร็งเจอจ่ายจบ 1 ล้าน    | ฮิต     | 4800    | 6200     | 2026-10-31 | promo-cancer-1   |
| promo-7 | home     | ประกันบ้านครบวงจร         | ลด 20%  | 3200    | 4000     | 2026-08-31 | promo-home-1     |
| promo-8 | savings  | สะสมทรัพย์ผลตอบแทนสูง     | การันตี | 50000   | 55000    | 2026-12-31 | promo-savings-1  |
| promo-9 | motor    | ประกันรถชั้น 2+ ราคาพิเศษ | คุ้ม    | 6900    | 8900     | 2026-07-31 | promo-motor-2    |

### articles.ts — `ARTICLES` (9) | cover `.../seed/${seed}/600/360`, avatar `.../seed/${authorSeed}/80/80`

| id    | title                                          | category     | author                | date       |
| ----- | ---------------------------------------------- | ------------ | --------------------- | ---------- |
| art-1 | เลือกประกันสุขภาพอย่างไรให้คุ้มที่สุดในปี 2026 | สุขภาพ       | พญ. ศิริพร วงศ์ไทย    | 2026-05-20 |
| art-2 | 5 ข้อควรรู้ก่อนทำประกันรถยนต์ชั้น 1            | รถยนต์       | สมชาย ใจดี            | 2026-05-12 |
| art-3 | วางแผนเกษียณด้วยประกันสะสมทรัพย์               | การเงิน      | ดร. อนันต์ ทรัพย์มั่น | 2026-05-08 |
| art-4 | เดินทางต่างประเทศ ทำไมต้องมีประกันเดินทาง      | เดินทาง      | นภัสสร เที่ยวรอบโลก   | 2026-04-29 |
| art-5 | ประกันมะเร็ง คุ้มครองอะไรบ้าง เลือกแบบไหนดี    | สุขภาพ       | พญ. ศิริพร วงศ์ไทย    | 2026-04-22 |
| art-6 | คุ้มครองบ้านจากภัยน้ำท่วม เตรียมตัวอย่างไร     | ที่อยู่อาศัย | วิชัย มั่นคง          | 2026-04-15 |
| art-7 | ประกันชีวิตควบการลงทุน เหมาะกับใคร             | การเงิน      | ดร. อนันต์ ทรัพย์มั่น | 2026-04-03 |
| art-8 | ขั้นตอนแจ้งเคลมออนไลน์ ง่ายใน 5 นาที           | บริการ       | สมชาย ใจดี            | 2026-03-28 |
| art-9 | ประกันอุบัติเหตุสำหรับครอบครัว ต้องดูอะไร      | อุบัติเหตุ   | นภัสสร เที่ยวรอบโลก   | 2026-03-19 |

### stats.ts — `STATS` (5)

customers `5.2 ล้าน` ลูกค้าที่ไว้วางใจ (user) · claim-rate `99.3%` อัตราการจ่ายเคลม (shield) · since `พ.ศ. 2490` ปีที่ก่อตั้งบริษัท (renew) · assets `1.8 แสนล้าน` มูลค่าสินทรัพย์ (บาท) (savings) · branches `180+` สาขาทั่วประเทศ (location)

### testimonials.ts — `TESTIMONIALS` (4) | avatar `.../seed/${seed}/120/120`

- t-1 คุณกานต์ ธนวัฒน์ — ลูกค้าประกันรถยนต์ชั้น 1 — rating 5 — "แจ้งเคลมรถผ่านแอปง่ายมาก เจ้าหน้าที่มาถึงที่เกิดเหตุภายในครึ่งชั่วโมง ประทับใจบริการจริง ๆ"
- t-2 คุณพิมพ์ชนก ศรีสุข — ลูกค้าประกันสุขภาพ — rating 5 — "ทำประกันสุขภาพให้คุณแม่ เบิกค่ารักษาได้เต็มจำนวนไม่ต้องสำรองจ่าย อุ่นใจทั้งครอบครัว"
- t-3 คุณธีรภัทร อินทร์ทอง — ลูกค้าประกันเดินทาง — rating 4 — "ซื้อประกันเดินทางก่อนไปยุโรป กระเป๋าหายได้รับชดเชยรวดเร็ว ขั้นตอนไม่ยุ่งยากเลย"
- t-4 คุณวรเดช มงคล — ลูกค้าประกันสะสมทรัพย์ — rating 5 — "ตัวแทนให้คำปรึกษาดีมาก ช่วยเลือกแผนสะสมทรัพย์ที่เหมาะกับเป้าหมายเกษียณของผมพอดี"

### appFeatures.ts — `APP_FEATURES` (4)

policy ดูกรมธรรม์ทั้งหมดในที่เดียว (document) · claim แจ้งเคลมพร้อมถ่ายรูปในแอป (claim) · card บัตรลูกค้าดิจิทัลแสดงที่ รพ. (shield) · pay ชำระเบี้ย/ต่ออายุอัตโนมัติ (pay)

### navigation.ts — `MAIN_NAV` (5)

1. `ผลิตภัณฑ์`→#insurance-types, children: ประกันชีวิต/ประกันสุขภาพ/ประกันรถยนต์/ประกันเดินทาง→#insurance-types, โปรโมชั่นทั้งหมด→#promotions
2. `คำนวณเบี้ย`→#calculator · 3. `แจ้งเคลม`→#services · 4. `เกี่ยวกับเรา`→#stats · 5. `บทความ`→#articles

### heroCampaigns.ts — `HERO_CAMPAIGNS` (6) | imageUrl `/images/hero/${name}.png`

| id          | headline (= alt)                                                        | ctaLabel          | ctaHref     | name/icon |
| ----------- | ----------------------------------------------------------------------- | ----------------- | ----------- | --------- |
| hc-motor    | ประกันรถยนต์ชั้น 1 คุ้มครองครบ จบทุกอุบัติเหตุ                          | เช็คเบี้ยเลย      | #calculator | motor     |
| hc-health   | ประกันสุขภาพเหมาจ่าย ดูแลคุณทุกย่างก้าว เจ็บป่วยไม่ต้องกังวล            | ดูรายละเอียด      | #promotions | health    |
| hc-life     | ประกันชีวิต เพื่อคนที่คุณรัก วางแผนอนาคต มั่นคงเพื่อครอบครัว            | ปรึกษาเรา         | #promotions | life      |
| hc-travel   | ประกันเดินทางต่างประเทศ เที่ยวสนุก อุ่นใจทุกทริปทั่วโลก                 | ซื้อออนไลน์ลด 10% | #promotions | travel    |
| hc-home     | ประกันบ้านและที่อยู่อาศัย คุ้มครองบ้านที่คุณรัก จากอัคคีภัยและภัยพิบัติ | คำนวณเบี้ย        | #calculator | home      |
| hc-accident | ประกันอุบัติเหตุส่วนบุคคล จ่ายเบี้ยน้อย คุ้มครองหลักล้าน                | สมัครเลย          | #promotions | accident  |

(`display`/`items` เป็น metadata ภายใน ไม่ render — slider แสดงแค่รูป banner เต็มใบ)

---

## 9. Responsive และ a11y

Tailwind breakpoints: `sm`=640, `md`=768, `lg`=1024 (ทั้งหมด min-width / inclusive). ทดสอบ 375 / 768 / 1440px ต้องไม่พัง, **ไม่มี horizontal overflow** ทุก viewport (ยกเว้น slider). หลักสำคัญ: split desktop/mobile ใช้ `lg:` (1024) ไม่ใช่ `md:` — กัน off-by-one ที่ 768.

### Matrix พฤติกรรมต่อ breakpoint (LOCKED)

| ส่วน                                        | mobile (<640)                                                                                  | sm (≥640)                                                               | md (≥768)                                    | lg (≥1024, desktop)                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **UtilityBar**                              | ซ่อน brand text/currency/search; ปุ่มแสดง `เข้าสู่ระบบ`                                        | โชว์ brand text + currency select; ปุ่มเป็น `เข้าสู่ระบบ / สมัครสมาชิก` | + โชว์ช่องค้นหา (`hidden md:flex`)           | เหมือน md                                                                                           |
| **Header**                                  | hamburger + mobile panel; desktop nav ซ่อน                                                     | เหมือน mobile                                                           | เหมือน mobile (ยังเป็น hamburger จนถึง 1023) | desktop nav (`hidden lg:flex`) + hotline + ปุ่ม; hamburger ซ่อน (`lg:hidden`)                       |
| **Hero**                                    | stack: **carousel บน / การ์ดทางลัดล่าง** (CSS `order-1`/`order-2`)                             | เหมือน mobile                                                           | เหมือน mobile                                | grid 2 คอลัมน์ `[minmax(0,3fr)_minmax(0,7fr)]` — การ์ดซ้าย/carousel ขวา (`lg:order-1`/`lg:order-2`) |
| **Hero dots**                               | ใต้กรอบภาพ พื้นสว่าง (navy)                                                                    | เหมือน mobile                                                           | เหมือน mobile                                | ทับบนภาพกลางล่าง สีขาว (`lg:absolute`)                                                              |
| **Hero arrows**                             | ซ่อน (ใช้ swipe + dots)                                                                        | ซ่อน                                                                    | ซ่อน                                         | โผล่เมื่อ hover/focus (`lg:flex` + opacity)                                                         |
| **InsuranceTypes/Promotions/Articles grid** | 1 คอลัมน์                                                                                      | 2 คอลัมน์ (`sm:grid-cols-2`)                                            | 2                                            | 4 คอลัมน์ (`lg:grid-cols-4`)                                                                        |
| **Services grid**                           | 2 คอลัมน์                                                                                      | 3 (`sm:grid-cols-3`)                                                    | 3                                            | 7 (`lg:grid-cols-7`)                                                                                |
| **Stats** `<dl>`                            | 2 คอลัมน์                                                                                      | 2                                                                       | 2                                            | 5 (`lg:grid-cols-5`)                                                                                |
| **PremiumCalculator**                       | **stack**: ฟอร์มบน / panel ผลล่าง                                                              | stack                                                                   | stack                                        | grid 2 คอลัมน์ `[1.1fr_0.9fr]` (`lg:grid`) ฟอร์มซ้าย/ผลขวา                                          |
| **AppDownload**                             | **stack**: ข้อความบน / phone mockup ล่าง (phone fixed `w-[260px]`, quick-actions grid 3 คงที่) | stack                                                                   | stack                                        | grid 2 คอลัมน์ (`lg:grid-cols-2`)                                                                   |
| **Footer**                                  | 1 คอลัมน์                                                                                      | 1                                                                       | 2 (`md:grid-cols-2`)                         | `[1.4fr_repeat(3,1fr)]` brand + 3 directory                                                         |
| **Testimonials/slider**                     | ทำงานทุกขนาด (1 รีวิว/จอ, prev/next/dots/keyboard); ลูกศร `-left-2`→`sm:-left-5`               |

### a11y (ทุก viewport)

- `<h1>` ทั้งหน้ามี **1 ตัว** (hero sr-only `วิริยะประกันภัย ประกันที่ดูแลคุณทุกช่วงชีวิต`); section อื่นเป็น `<h2>`
- semantic HTML; ทุก `<img>` มี alt และโหลดได้จริง (มี SmartImage fallback); นำทางคีย์บอร์ดได้ทุก interactive
- focus ring เดียวทั้งหน้า (`ring-2 ring-accent ring-offset-2`); contrast ผ่านเกณฑ์ (ข้อความบนพื้นเข้มเป็น `text-surface`)
- เคารพ `prefers-reduced-motion`: ปิด autoplay carousel + transition/animation ~instant (globals + JS gate ของ Swiper)
- anchor scroll ใต้ sticky header คุมด้วย `scroll-padding-top:96px` (globals)
- skip-link → `#main` เป็น element แรกใน `<body>`; mobile menu มี `aria-expanded`/`aria-controls`; carousel/slider มี `role=region aria-roledescription=carousel`

---

## 10. ข้อกำหนดความสมบูรณ์ด้านภาพ (บังคับ)

ต้องดู "เสร็จพร้อมใช้จริง" — ห้ามกล่องว่าง/ฟอนต์ระบบ/พื้นที่ว่างผิดปกติ.

- ฟอนต์ไทยจริง (IBM Plex Sans Thai) โหลดและใช้จริงทั้งเอกสาร
- ทุกพื้นที่ภาพมีเนื้อหา "ตั้งใจ": รูปจริง (picsum/banner local) หรือ SmartImage fallback (gradient + dots + icon) — ห้ามสี่เหลี่ยมสีเดียวเปล่า
- Phone mockup มี UI จำลองข้างใน; Hero เป็น carousel ภาพจริง; ไอคอนเป็น inline SVG มีรูปทรงจริง
- spacing scale สม่ำเสมอ; การ์ดแถวเดียวกันสูงเท่ากัน; ปุ่ม/การ์ด/อินพุตมี state ครบ (default/hover/focus/active/disabled) + transition 150–250ms
- ห้าม hardcode สีดิบซ้ำ — เรียกผ่าน semantic utility จาก tokens

---

## 11. Acceptance Checklist (ตรวจด้วยตา/DevTools ที่ 375 / 768 / 1440)

1. เห็นครบ 12 section: utility bar, header, hero, ประเภทประกัน(10), บริการ(14 ไอคอน), โปรโมชั่น(9 การ์ด), เครื่องคำนวณ, แถบสถิติ(5), บทความ(9 การ์ด), testimonials(4), ส่วนแอป, footer
2. ที่ 375px เมนูยุบเป็น hamburger กดเปิด/ปิดได้; กริดการ์ดเหลือ 1 คอลัมน์
3. เครื่องคำนวณ: เลือกประเภท + อายุ + ทุน ที่ถูกต้อง → แสดงเบี้ยโดยประมาณ
4. เครื่องคำนวณ: life อายุ 30 ทุน 1,000,000 → **8,000 บาท/ปี** (ตรงสูตร)
5. เครื่องคำนวณ: อายุติดลบ/เกิน 80/เว้นว่าง → ขึ้น error ไม่คำนวณ
6. การ์ดทางลัด 4 อันใน hero มีและคลิกได้
7. การ์ดโปรโมชั่นมีรูปจริง + ราคา (เดิมขีดฆ่า) + ปุ่ม "ซื้อเลย"/"รายละเอียด"; filter หมวดกรองได้
8. สไลด์ testimonial เลื่อนไปรายการถัดไปได้
9. phone mockup มี UI จำลองข้างใน (ไม่ใช่กล่องว่าง)
10. ทุกรูปมี alt และนำทางคีย์บอร์ดได้
11. ฟอนต์เว็บโหลดจริง, ทุก `<img>` ไม่ broken, ไม่มี horizontal overflow
12. Hero carousel: เลื่อนอัตโนมัติ (~3 วิ), เปลี่ยนสไลด์แบบ fade ไม่กระพริบ, กดลูกศร/จุด/ลาก (เมาส์+นิ้ว) เปลี่ยนได้, เคารพ `prefers-reduced-motion`; ที่ 375/768 carousel อยู่เหนือการ์ดทางลัด, dots อยู่ใต้กรอบภาพ; desktop การ์ดซ้าย/carousel ขวา + ลูกศรโผล่เมื่อ hover

---

## 12. Rubric (เต็ม 100)

- ความครบของ section (เนื้อหาแน่นแบบพอร์ทัล) — 18
- คุณภาพ/ความสวยของดีไซน์ (พาเลตวิริยะ กรมท่า+เหลืองทอง สม่ำเสมอ) — 20
- ความสมบูรณ์ด้านภาพ (ฟอนต์, การ์ดมีรูปจริง, hero/phone mockup, ไม่มีกล่องว่าง, ไม่ overflow) — 18
- เครื่องคำนวณเบี้ยถูกต้อง + validate ครบ — 18
- responsive ทุก viewport — 12
- interaction จริง (เมนู/carousel/slide/hover/filter) — 8
- accessibility + semantic HTML — 4
- โครงสร้างโค้ด/TypeScript — 2
