# Workflow: Frontend Task (UI / visual / a11y / responsive)

Vendor-neutral procedure for any agent (Claude / Codex / OpenCode / Pi). recipe สำหรับ
งาน UI ของ repo นี้ (Next.js App Router + React Server Components + Tailwind) ที่ต้องผ่าน
visual completeness, a11y, และ responsive ที่ 375 / 768 / 1440px.

## Purpose

สร้าง/แก้ UI ให้ "ดูเสร็จ ดูแพง" และทำงานจริง: Server Component เป็นค่าเริ่มต้น, `"use client"`
เฉพาะส่วน interactive, design tokens ที่เดียว, ทุกพื้นที่ภาพดูเสร็จ (ไม่มีกล่องว่าง), keyboard
นำทางได้, contrast ผ่าน, ไม่มี horizontal overflow — แล้วยืนยันผลด้วย production build ในเบราว์เซอร์
ที่ viewport จริง (ไม่ใช่แค่ build เขียว).

## When to use

- สร้าง/แก้ component UI, section ของ homepage, interaction (เมนู/slider/filter/calculator),
  responsive fix, a11y fix, visual polish.
- ไม่ใช้กับ: pure logic (อยู่ใน `test-generation.md` / `app/lib/`), root-cause bug ที่ไม่ใช่ UI
  (ใช้ `bug-fix.md`).

## Required context files

อ่านก่อนเริ่ม (relative จากไฟล์นี้):

- [../shared/stack/nextjs.md](../shared/stack/nextjs.md) — บทเรียน stack-specific (Next/React/Tailwind/
  vitest): patterns ที่ promote จาก retrospectives. path-scoped — เกี่ยวกับ `app/**` และ config.
- [../shared/ARCHITECTURE.md](../shared/ARCHITECTURE.md) — folder layout, naming, Server vs Client,
  `<Container>`, design tokens, state ครบ (default/hover/focus/active/disabled), anti-patterns.
- [../shared/CODING_STANDARDS.md](../shared/CODING_STANDARDS.md) — hard constraints: ห้ามกล่องว่าง,
  ห้าม raw hex ซ้ำ, ทุก `<img>` มี alt, semantic HTML, contrast, พาเลตแบรนด์ (primary navy ~#13266B,
  accent ทอง ~#FDB913).
- [../shared/PROJECT_CONTEXT.md](../shared/PROJECT_CONTEXT.md) — rubric (design 20, visual 18,
  responsive 12, interaction 8, a11y 4) + acceptance checklist.
- Browser-verify recipes: `.claude/skills/spec-implement/references/browser-verify.md` — ต้อง Read
  ก่อนทุกครั้งที่จะ verify ผ่านเบราว์เซอร์ (probe React interaction / overflow / focus-ring / viewport).

## Step-by-step process

1. **อ่าน context + ระบุ component boundary.** ดูว่า component อยู่ section ไหน, รับ props/import
   data จาก `app/data/` อย่างไร, มี anchor ใน navigation data ไหม. ตัดสิน Server vs Client:
   `"use client"` เฉพาะที่ต้องโต้ตอบจริง (menu, slider, filter, form, calculator) — ห้ามทั้งหน้า/root.
   -> verify: รู้ว่าเป็น Server หรือ Client component + แตะไฟล์ไหนบ้าง (ตรง ARCHITECTURE.md).

2. **Implement ตาม tokens + state ครบ.** ใช้ semantic utility class จาก design tokens
   (tailwind.config.ts) — ห้าม hardcode hex ดิบซ้ำ. logic คำนวณ/validate เรียกจาก `app/lib/`
   ไม่ฝังสูตรใน JSX. ปุ่ม/การ์ด/อินพุตมี state ครบ: default/hover/focus(ring)/active/disabled +
   transition 150-250ms. ครอบเนื้อหาด้วย `<Container>` (max-width ~1200-1280px). ทุกพื้นที่ภาพ
   ดูเสร็จ: inline SVG มีรายละเอียด / รูปจริงผ่าน `next/image` / gradient + ลวดลายที่จัดองค์ประกอบ —
   ห้ามกล่อง/สี่เหลี่ยมสีเดียวเป็น placeholder. ทุก `<img>`/`next/image` มี `alt`.
   -> verify: ไม่มี raw hex ซ้ำ, ไม่มีสูตรใน JSX, state ครบ, ไม่มีกล่องว่าง, ทุก image มี alt.

3. **Static check ก่อนเปิดเบราว์เซอร์.** รัน `npm run typecheck` (TS strict, ไม่มี `any`).
   ถ้ามี pure logic เกี่ยวข้องรัน `npm test`.
   -> verify: typecheck เขียว; test (ถ้ามี) เขียว.

4. **Browser verify บน production build.** โปรเจกต์นี้ `next dev` HMR พังการ hydrate -> ใช้
   production build เสมอ: `npm run build` แล้ว `PORT=<free> npx next start` ชี้ browser ไป
   `http://127.0.0.1:<port>/` (IPv4 ไม่ใช่ `localhost`). หลังแก้โค้ดทุกครั้ง **rebuild** ก่อนเทสซ้ำ.
   ก่อนเชื่อผลคลิก probe hydration (`__reactFiber$`/`__reactProps$` มีบน element) — ไม่มี = ยังไม่
   hydrate = คลิก no-op ไม่ใช่บั๊ก UI. Read browser-verify reference ก่อนเริ่ม probe.
   -> verify: build เขียว + server ขึ้น "Ready"; element hydrate แล้ว (probe ผ่าน).

5. **Responsive ที่ viewport เป๊ะ 375 / 768 / 1440.** ยืนยัน `document.documentElement.clientWidth
   === target` ทุกครั้งก่อนเชื่อผล. mobile 375 จริงต้องใช้ `emulate` viewport `375x812x2,mobile,touch`
   (chrome-devtools MCP `resize_page` มี min window ~485px บน macOS = false-pass ขอบล่าง). วัด
   overflow ด้วย `document.documentElement.scrollWidth > innerWidth` เป็น primary (ตัด SVG geometry
   + slider ที่ถูก clip ออกจาก culprit probe). culprit ที่เป็น component ของ task อื่น = รายงาน
   ไม่แก้เงียบ (task boundary).
   -> verify: clientWidth === target ที่ทั้ง 3 viewport; ไม่มี horizontal overflow (scrollWidth ไม่เกิน).

6. **a11y + interaction.** focus-ring ตรวจด้วย keyboard Tab จริง (`press_key Tab` -> อ่าน
   activeElement outline/boxShadow) ไม่ใช่ programmatic `el.focus()` (heuristic เพี้ยนใน headless).
   contrast: ไต่ ancestor อ่านทั้ง `backgroundColor` และ `backgroundImage` (พื้นเข้มหลายที่เป็น
   gradient navy -> `backgroundColor` = transparent ทำให้รายงาน contrast ปลอม). interaction:
   แยก "action (click/dispatch)" กับ "read DOM" เป็นคนละ evaluate call (React re-render async);
   keydown dispatch ได้, mouseenter dispatch ไม่ได้ (ใช้ `page.hover()` สำหรับ pointer).
   -> verify: keyboard นำทาง + focus-ring เห็นจริงทุกชนิด element; contrast ผ่านเกณฑ์ (เทียบ bg layer
   จริง); interaction (เมนู/slider/filter) ทำงานบน prod build.

7. **บันทึก Evidence.** ตาม TASK_PROTOCOL: บันทึก viewport values ที่สังเกตจริง (`375 OK | 768 OK |
   1440 OK` พร้อม clientWidth ที่วัด) + deviations. ห้าม assert pass ที่ไม่ได้เห็น; check ที่รันไม่ได้
   ระบุใน deviations.

## Expected output

- component ใต้ `app/components/` (หรือ `app/components/ui/`) ตาม ARCHITECTURE.md, Server โดยค่าเริ่มต้น
  + `"use client"` เฉพาะ interactive.
- design tokens ผ่าน semantic class; data จาก `app/data/`; logic จาก `app/lib/`.
- Evidence: typecheck เขียว, build เขียว, viewport 375/768/1440 ยืนยันค่า clientWidth จริง, a11y +
  interaction ผ่าน.

## Definition of done

- [ ] `npm run typecheck` ผ่าน; `npm test` ผ่าน (ถ้าแตะ pure logic).
- [ ] `npm run build` เขียว; verify บน `npx next start` ที่ `127.0.0.1` (rebuild หลังแก้ทุกครั้ง).
- [ ] `clientWidth === target` ยืนยันที่ 375 / 768 / 1440; ไม่มี horizontal overflow (scrollWidth check).
- [ ] focus-ring ตรวจด้วย Tab จริง; keyboard นำทางได้; contrast ผ่าน (เทียบ bg layer จริงรวม gradient).
- [ ] interaction (เมนู/slider/filter/calculator) ทำงานบน prod build (probe hydration ก่อนสรุป).
- [ ] ไม่มีกล่องว่าง/raw hex ซ้ำ/สูตรใน JSX/`"use client"` ทั้งหน้า; ทุก image มี alt.
- [ ] Evidence block บันทึกค่าที่สังเกตจริง (ไม่ใช่ค่าที่วางแผน).

## Common mistakes to avoid

- verify บน `next dev` — HMR ws พังการ hydrate ที่นี่ -> false-negative ("คลิกไม่ทำงาน"). ใช้ prod build.
- ไม่ rebuild หลังแก้โค้ด — `next start` serve `.next` เก่า -> ทดสอบโค้ดเก่า (build เขียว/200 พิสูจน์
  แค่ "มีอะไรรันอยู่" ไม่ใช่ "โค้ดล่าสุด").
- ตั้ง 375 ด้วย `resize_page` — macOS min window ~485px = false-pass ขอบล่าง. ใช้ `emulate` viewport.
- เชื่อผลคลิกก่อน probe hydration — `__reactFiber$` ไม่มี = ยังไม่ hydrate = คลิก no-op ไม่ใช่บั๊ก.
- อ่าน DOM ใน evaluate call เดียวกับ action — React re-render async อ่านค่าเก่า (race). แยก call.
- `el.focus()` programmatic ตรวจ focus-ring — heuristic `:focus-visible` เพี้ยนใน headless. ใช้ Tab จริง.
- contrast probe อ่าน `backgroundColor` อย่างเดียว — พื้น gradient navy = transparent -> รายงาน contrast
  ปลอม. อ่าน `backgroundImage` ด้วย.
- วัด overflow ด้วย `getBoundingClientRect().right` อย่างเดียว — SVG `slice` + slider ที่ถูก clip =
  false positive. ใช้ `scrollWidth > innerWidth` เป็น primary.
- hardcode hex ดิบ / กล่องสีเดียวเป็น placeholder / ฝังสูตรใน JSX / `"use client"` ที่ root — anti-pattern.
- แก้ component ของ task อื่นเงียบเมื่อเจอ overflow culprit ข้าม boundary — รายงาน ไม่แก้เงียบ.
