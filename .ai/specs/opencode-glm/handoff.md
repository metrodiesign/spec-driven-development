# Handoff Note: opencode-glm

> Schema ตาม AGENT_HANDOFF_PROTOCOL.md (.ai/shared/AGENT_HANDOFF_PROTOCOL.md)

## Task Summary

Lineage ที่ห้าของแพลตฟอร์ม: GLM-5.3 ผ่าน **OpenCode Go gateway**
(`opencode-go/glm-5.3`) บน credential ที่มีอยู่บนเครื่องแล้ว — สเปก
`.ai/specs/opencode-glm/` (requirements/design/tasks approved 2026-08-16,
spec-trace 26/26) เกิดจากการที่ LIVE ของ `glm-5-3-adapter` (PR #142)
ติดที่ Z.ai API balance (error 1113) แต่ operator ต้องการทดสอบ GLM-5.3
จริง — ทางนี้ไม่ต้องเติมเงิน

## Current Status

**COMPLETED** — tasks 1–4 done (LIVE record green 2026-08-16:
`.ai/calibration/conformance-opencode-glm-2026-08-16T10-29-19-877Z.json`,
P1–P8 all pass, p7 = 0). Post-completion transport fixes from the live
diagnosis are documented in task 1's amendment (stdout error-event
surfacing + model-catalog seeding).

## Files Changed

- `adapters/src/reasoning-cli-live.ts` — `createLiveOpenCodeGlmAdapter` + `resolveOpenCodeAuthStore` + `buildOpenCodeGlmEnv` + `OPENCODE_GLM_DEFAULT_MODEL` (edited)
- `adapters/src/opencode-glm.test.ts` — 9 unit tests (stub child ไม่ใช่ opencode จริง) (new)
- `adapters/src/opencode-glm-conformance.test.ts` — P1–P8/sabotage/stale (new)
- `adapters/src/index.ts` — export ใหม่ (edited)
- `console/backend/bin/platform.ts` — allowlist + branch + `PR_GATE_OPENCODE_GLM_MODEL` (edited)
- `.ai/policies/routing.json` — `tokenBuckets["opencode-glm"]` (governance) (edited)
- `.ai/policies/provider-data-policy.json` — per-adapter entry (processor consent: OpenCode Go gateway) + `_comment` (edited)
- `.ai/specs/opencode-glm/{clarifications,requirements,design,tasks,handoff}.md` (new)

## Important Decisions

- **Lineage `'zai'` แชร์กับ adapter `glm` (direct API) โดยเจตนา** — ตระกูลโมเดลเดียวกัน fusion ต้องไม่นับ decorrelated + susceptibility routing จัดกลุ่มเดียวกัน
- **Auth ผ่าน sandbox ด้วย copy หนึ่งไฟล์**: `auth.json` → temp sandbox (0600 ด้วย `chmodSync` — `copyFileSync` arg สามเป็น copy mask 0–7 ไม่ใช่ mode), ลบใน `finally`, deny-all config คงเดิม, ไม่แหลม HOME จริง
- **ผ่าน gateway ของ OpenCode = data processor เพิ่ม** → มี entry ชัดใน `provider-data-policy.json` (paths เท่า default เป๊ะ — consent ที่รีวิวได้ ไม่คลายของเดิม)
- ตาม D1: โควตาเป็นของบัญชี OpenCode Go ไม่ใช่ Z.ai Coding Plan (คำถาม Z.ai terms จบโดยปริยาย)

## Constraints

- ห้ามแตะ `core/`, `aal/`, `reasoning-cli.ts` (adapter core ใช้ร่วม — แก้ที่นี่กระทบทุก lineage)
- ทั้งสอง policy files เป็น POLICY_FILES — live run แรกหลังแก้จะเจอ `policy_unapproved` ให้ approve ผ่าน `platform governance approve <GOV_ID>` (เหมือนรอบก่อน — ครั้งนี้จะเป็น proposal เดียวจาก hash ใหม่)

## Tests Run

- `pnpm -C adapters test` -> 62 passed / 0 failed (9 unit + 3 conformance ใหม่)
- `pnpm -C adapters typecheck` / `pnpm -C console/backend typecheck` -> clean
- `pnpm -C aal test` -> 192 passed / 0 failed (policy guards เขียวกับทั้งสองไฟล์ที่แก้)
- `pnpm vendor-check` -> OK (INV-7) · `scripts/spec-trace.sh opencode-glm` -> 26/26
- typecheck/test เต็ม: ดู tasks.md Evidence ราย task (workspace run อยู่ใน PR CI)

## Known Issues

- บั๊กที่เจอระหว่างทำและแก้แล้ว (บันทึกใน tasks.md deviations): `copyFileSync` mode arg เป็น mask 0–7 (ต้อง `chmodSync` แยก) · macOS `ls -l` มี xattr marker `@` ต่อท้าย mode column
- REQ-5 CLI wiring review-verified (ไม่มี harness สำหรับ platform.ts — ceiling ตั้งแต่ v1.7) — LIVE run คือการพิสูจน์จริง

## Next Recommended Agent

operator เอง สำหรับ LIVE run (TTY + RUN-LIVE ห้าม delegate) — จากนั้น human review ที่ PR

## Next Steps

1. **LIVE**: `node console/backend/bin/platform.ts conformance --live --lineage opencode-glm --force-quota-override` — run แรกจะเจอ governance `policy_unapprove` จาก hash ใหม่ของ 2 policy files → `platform governance approve <GOV_ID>` แล้วรันซ้ำ
2. ได้ record `.ai/calibration/conformance-opencode-glm-<stamp>.json` → mark task 4 + Evidence + commit + push
3. Review/merge PR ของ branch `feat/opencode-glm` (แยกจาก PR #142)
4. Follow-up (นอก scope): PR-gate reviewer slot, loop composition, §7.4 default flip หลังมี record จริง
