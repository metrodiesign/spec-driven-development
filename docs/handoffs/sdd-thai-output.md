# Handoff Note: ผลลัพธ์ SDD ภาษาไทย

## Task Summary

ปรับคำสั่งกลางให้ทุกขั้นตอน SDD สร้างเนื้อหาภาษาไทย และอัปเดต dependency patch ที่พบว่าขวาง audit ระหว่างเตรียม PR เข้า develop

## Current Status

แก้นโยบายและ dependency patch ครบ ผ่าน review และการตรวจก่อน commit/push บน branch docs/sdd-thai-output

## Files Changed

- `.ai/shared/TASK_PROTOCOL.md` — กำหนดภาษาของผลลัพธ์และข้อยกเว้นสำหรับ machine contract
- `.ai/shared/OUTPUT_FORMATS.md` — เชื่อมแม่แบบเข้ากับนโยบายภาษา
- `docs/handoffs/sdd-thai-output.md` — บันทึกขอบเขตและผลตรวจของงานนี้
- `pnpm-workspace.yaml` — pin fast-uri เป็น 4.1.3 เพื่อแก้ช่องโหว่ระดับ high
- `pnpm-lock.yaml` — ปรับ resolution และ references เฉพาะ fast-uri

## Important Decisions

- ใช้คำสั่งกลางที่ทุก harness อ่านอยู่แล้ว เพื่อให้แก้กฎภาษาได้ที่เดียว
- เนื้อหาและชื่อที่เติมลงแม่แบบใช้ไทย ส่วนหัวข้อบังคับ, EARS keywords และ parser markers คงเดิม
- ปรับเนื้อหาใหม่หรือส่วนที่อยู่ในขอบเขตงาน ไม่แปล spec เก่าย้อนหลังทั้ง repository
- audit พบ fast-uri 4.1.2 มี 4 high advisories จึงอัปเดต patch เป็น 4.1.3 ไม่มี dependency ใหม่
- ตรวจ metadata ของ fast-uri 4.1.3: BSD-3-Clause, upstream fastify/fast-uri และ integrity ตรงกับ registry

## Constraints

คง identifier, command, path, raw log และ schema เดิม ไม่แก้ approval gate หรือเครื่องมือตรวจ

## Tests Run

- `git diff --check` → exit 0
- `bash .claude/hooks/tests/check-evidence.test.sh` → pass=31 fail=0
- `bash .claude/hooks/tests/spec-slice.test.sh` → pass=33 fail=0
- `python3 -B scripts/spec_trace.py thai-fixture /private/tmp/sdd-thai-verifier-fixture/.ai/specs` → ผ่าน 1 criterion
- `bash scripts/spec-trace.sh thai-fixture /private/tmp/sdd-thai-verifier-fixture/.ai/specs` → ผ่าน EARS และ traceability

fixture ชั่วคราวใช้เนื้อหาไทยและ heading ไทย โดยค่า Section ตรงกับ heading จริง
ตรวจ pointer จาก AGENTS และ adapter ของ Claude, Codex, OpenCode, Pi มายัง TASK_PROTOCOL ครบ

ผลตรวจระหว่างเตรียม PR:

- `pnpm build`, `pnpm typecheck`, `pnpm lint` → exit 0 ก่อนอัปเดต dependency
- `scripts/check-core-vendor-free.sh`, `scripts/check-golden-manifests.sh` → exit 0
- `scripts/lessons-coverage-check.sh` → exit 0
- รันทุก `.claude/hooks/tests/*.test.sh` → exit 0
- รัน `scripts/spec-trace.sh` ครบ 19 active และ 6 archived specs → exit 0
- `NPM_CONFIG_USERCONFIG=/dev/null pnpm audit --prod --audit-level high` → exit 0 หลังแก้ lockfile

audit เหลือ 9 advisories: 1 low และ 8 moderate ไม่มี high
log ของ full gate รอบแรกอยู่ `/private/tmp/sdd-ship-verify.fngaOT/`

- `pnpm test` → exit 0, ผ่าน 1,495 เคส ข้าม 10 เคสตาม environment ของ core ไม่มี failure
- หลังติดตั้ง patch จาก store เฉพาะงาน: `pnpm build`, `pnpm typecheck`, `pnpm lint` → exit 0 ทั้งหมด
- `pnpm --filter adapters test` → ผ่าน 92 เคส ไม่มี failure หรือ skipped

ทดสอบ backend หลัง patch เฉพาะเส้นทาง HTTP/auth, schema และ SDK ที่ใช้ dependency นี้:

```sh
export NPM_CONFIG_USERCONFIG=/dev/null
export PNPM_CONFIG_STORE_DIR=/private/tmp/sdd-thai-ship.XTpDOU/pnpm-store
pnpm --filter console-backend exec node --test --test-reporter spec \
  'src/app*.test.ts' 'src/auth/*.test.ts' src/goal-schema.test.ts \
  src/task-graph-schema.test.ts src/pr-gate/schema.test.ts src/chat-runtime.test.ts
```

ผล: ผ่าน 175 เคส ไม่มี failure หรือ skipped คำสั่ง pnpm หลัง patch ใช้ environment ข้างต้น
core/aal ไม่มี dependency fast-uri จึงใช้ผล full suite เดิม ไม่รันซ้ำ
log หลัง patch อยู่ `/private/tmp/sdd-thai-ship.XTpDOU/` เป็นไฟล์ชั่วคราว ไม่รวมใน commit

## Known Issues

ไม่ได้ทดลองให้โมเดลสร้างผลลัพธ์จริงในทุก harness การตรวจ parser พิสูจน์ความเข้ากันได้ของรูปแบบเอกสาร
ไม่รับประกันว่าโมเดลทุกตัวจะทำตามคำสั่งภาษาทุกครั้ง

## Next Recommended Agent

agent ที่ทำงาน SDD รอบถัดไป ใช้นโยบายจาก TASK_PROTOCOL

## Next Steps

1. อ่าน `.ai/shared/TASK_PROTOCOL.md` ก่อนสร้างหรือแก้ artifact รอบถัดไป
2. เปิด PR เข้า develop ด้วยผลตรวจข้างต้น และให้ CI ตรวจ head ที่ push ก่อนตัดสิน merge
