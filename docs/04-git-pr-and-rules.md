# 4. Git / PR + Rules

ต้นทางกฎทั้งหมด: `../CLAUDE.md` + `../.claude/rules/`. ที่นี่สรุปเชิงปฏิบัติ.

## 4.1 Git / branch / PR

- **ห้าม push ตรงเข้า `main` / `develop`** — ต้องผ่าน PR เสมอ
- **ห้าม force push**, **ห้าม commit ตรงโดยไม่มี review**
- commit message ลงท้ายด้วย:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- ฟีเจอร์ทำบน feature branch (เช่น `feat/insurance-homepage`) -> เปิด PR เข้า main

## 4.2 CI gate

- PR merge ได้เมื่อ CI ผ่าน (test + lint) เป็น required check
- ห้าม merge ข้าม failing check
- ห้าม commit `.only` / `.skip` ค้างใน test
- coverage ห้ามต่ำกว่าเกณฑ์

## 4.3 Secrets

- ห้าม commit secret ทุกชนิด (API key, token, password, private key, connection string)
- `.env` / `.env.*` อยู่ใน `.gitignore` เสมอ; commit ได้แค่ `.env.example` (ค่าปลอม)
- ห้าม hardcode credential — อ่านจาก env / secret manager
- secret หลุด -> rotate/revoke ทันที (ลบ commit ไม่พอ history ยังมี)

## 4.4 Destructive ops

- ห้าม `DROP`/`DELETE`/`TRUNCATE` บน prod โดยไม่มี WHERE + ไม่ยืนยัน
- ห้าม `rm -rf`, `git reset --hard`, `git clean -fd` โดยไม่ยืนยันเป้าหมาย
- DB migration ต้องมี rollback + backup ก่อนรัน prod

## 4.5 Dependency

- ห้ามเพิ่ม dependency ใหม่โดยไม่ review license + maintenance + ขออนุมัติ
- lock file (`package-lock.json` ฯลฯ) commit เสมอ
- ห้าม pin floating (`*` / `latest`) บน prod dep
- `npm audit` เป็นส่วนหนึ่งของ CI; **ห้าม `npm audit fix --force`** (เคย downgrade core dep
  เป็น breaking)

## 4.6 Deploy / release

- prod deploy ต้องผ่าน staging ก่อน
- ทุก release มี rollback plan + tag เวอร์ชัน + changelog
- ห้าม deploy prod ศุกร์เย็น/ก่อนวันหยุดยาว (ยกเว้น hotfix ฉุกเฉิน)

## 4.7 Conventions ของโค้ด (ดู rules เต็ม)

| ด้าน            | สรุป                                                                  | ไฟล์                            |
| --------------- | --------------------------------------------------------------------- | ------------------------------- |
| โครงไฟล์/naming | `app/{components,data,lib}`, PascalCase component, camelCase data/lib | `../.claude/rules/structure.md` |
| tech stack      | Next.js 16 App Router, React 19 RSC default, TS strict, Tailwind v3.4 | `../.claude/rules/tech.md`      |
| product         | หน้าแรกพอร์ทัลประกัน, mock data, rubric                               | `../.claude/rules/product.md`   |
| บทเรียนสะสม     | กับดักจริงที่เจอแล้ว (อ่านก่อนงานคล้ายกัน)                            | `../.claude/rules/lessons.md`   |

## 4.8 Language / markdown

- คุยกับ user + output เป็นภาษาไทยเสมอ (ยกเว้น code/command/path/error/technical term)
- **ห้าม emoji ในไฟล์ `.md` ทุกชนิด**

## 4.9 Model routing (ระหว่าง execute บน Sonnet)

- เริ่มงานใหญ่/ใกล้ปิด -> เรียก `/advisor` (Opus) ก่อน
- error เดิมซ้ำ 2 ครั้ง -> หยุด เรียก `/advisor` หรือ Shift+Tab กลับ plan mode
- งานแตะหลายไฟล์/หลายโมดูล -> Shift+Tab กลับ plan mode ก่อน อย่าด้นสด
