# Tasks: Bugfix lg-button height

- [x] 1. Fix + regression test
  - เพิ่ม `spacing: { "13": "3.25rem" }` ใน `tailwind.config.ts` -> `theme.extend` (B1.1, B1.2)
  - export `SIZES` จาก `Button.tsx` เพื่อ testability (ไม่เปลี่ยน behavior)
  - regression test `app/lib/...`? -> ทดสอบ token + SIZES map:
    - assert `tailwind.config.ts` `theme.extend.spacing["13"] === "3.25rem"` (B1.1/B1.2; guard token deletion)
    - assert `SIZES.lg` มี `h-13` (bug-fixed: token + class จับคู่กัน)
    - assert SHALL CONTINUE: `SIZES.sm` = `h-9 px-3 text-caption`, `SIZES.md` = `h-11 px-5 text-body` (B2.1, B2.2); `SIZES.lg` คง `px-7 text-body` (B2.3)
    - assert config colors `primary.DEFAULT === "#13266B"`, `accent.DEFAULT === "#FDB913"` ไม่เปลี่ยน (B2.6)
  - Verify: `npm test` เขียว + browser prod build — Hero CTA + Calculator submit สูง 52px
