# Handoff Note: glm-5-3-adapter

> Schema ตาม AGENT_HANDOFF_PROTOCOL.md (.ai/shared/AGENT_HANDOFF_PROTOCOL.md)

## Task Summary

GLM-5.3 (Z.ai) เป็น vendor lineage ที่สามของแพลตฟอร์ม ผ่าน
`adapters/openai-compatible.ts` — สเปก `.ai/specs/glm-5-3-adapter/`
(requirements/design/tasks approved 2026-08-16, spec-trace 33/33) เป็นการ
ปฏิบัติตามเงื่อนไขที่ unified spec v1.11 บันทึกไว้ (GLM deferral ยกเลิกเพราะ
access มีจริงแล้ว) งานเฟสนี้ครอบทั้ง sync เอกสารสเปก (v1.11 + loop spec)
และ implement adapter จริงตาม INV-8

## Current Status

done ยกเว้น task 4 (LIVE conformance — ค้างตามเงื่อนไข D4: รอ operator มี
`ZAI_API_KEY` + quota แล้วรันบน TTY) — tasks 1–3 เสร็จ พร้อม Evidence ใน
tasks.md; CI readiness คือหลักฐานที่ส่งมอบรอบนี้

## Files Changed

- `unified-platform-spec.md` — v1.11: GLM-5.2→GLM-5.3, ยกเลื่อน deferral, §7.4/§7.6/§14/§17 (edited)
- `loop-engineering-implementation-spec.md` — 5 จุด sync + แก้ Phase 3 adapter claim เดิม (edited)
- `.ai/specs/glm-5-3-adapter/{clarifications,requirements,design,tasks,handoff}.md` — สเปกเต็มชุด (new)
- `adapters/src/openai-compatible.ts` + `.test.ts` — adapter core + pure helpers + 20 unit tests (new)
- `adapters/src/openai-compatible-live.ts` — fetch-only live wiring (new)
- `adapters/src/openai-compatible-conformance.test.ts` — P1–P8/sabotage/stale (new)
- `adapters/src/index.ts` — export ใหม่ (edited)
- `console/backend/bin/platform.ts` — `--lineage zai` + `createLiveGlmAdapter` branch + `PR_GATE_GLM_MODEL` (edited)
- `.ai/policies/routing.json` — `tokenBuckets["glm"]` (governance change — อนุมัติด้วย PR review โดย construction) (edited)

## Important Decisions

- D1 identity: `adapterId 'glm'` / `lineage 'zai'` / model `glm-5.3` (version-agnostic เหมือน codex; lineage 'openai' ถูก codex ใช้แล้ว)
- GLM-5.3 API: `thinking.type: 'disabled'` ถูกถอน — ทุก request บังคับ `thinking: {type:'enabled'}` + `reasoning_effort` (default 'high')
- Pure helpers (buildGlmRequestBody/parseGlmHttpBody/resolveGlmEndpointConfig) อยู่ใน core module เพื่อ CI ทดสอบได้ — live module เป็นแค่ fetch wiring ไม่ถูก import ใน CI (รูปแบบ buildCodexArgv/codex-live)
- ไม่แตะ `core/`/`aal/` เลย (INV-7/8) — `providerEnvironment` ไม่ขยับเพราะ fetch in-process ไม่มี child-process boundary
- Out of scope (D2, follow-up): PR-gate reviewer slot, loop composition threading, fusion-profiles `'zai'`, §7.4 routing-default flip (สามอย่างหลังเกิดจริงเมื่อ LIVE ผ่าน)

## Constraints

- ห้ามแตะ `core/`, `aal/`, `.ai/specs/archive/` — INV-7/INV-8 + archive เป็น evidence แช่แข็ง
- การเปลี่ยน `ZAI_BASE_URL` ไป aggregator ต้องแก้ `provider_data_policy` ก่อน (§7.6) — ตาม REQ-7.3
- routing.json เป็น POLICY_FILES — run แรกหลังแก้จะ refuse `policy_unapproved` จน operator approve (governance โดย construction)

## Tests Run

- `pnpm -C adapters test` -> 75 passed / 0 failed (20 new unit + 3 conformance)
- `pnpm -C adapters typecheck` / `pnpm -C console/backend typecheck` -> clean
- `pnpm -C aal test` -> 0 failed (routing-config guards เขียวกับ glm bucket)
- `pnpm vendor-check` -> OK (INV-7)
- `pnpm lint` -> clean
- `scripts/spec-trace.sh glm-5-3-adapter` -> 33/33 covered, EARS lint ผ่าน
- typecheck: `pnpm -r typecheck` (ผ่าน package scripts ทุก package) -> clean
- test: `pnpm test` (workspace เต็ม) -> green

## Known Issues

- Task 4 (LIVE) ค้าง: ต้องมี `ZAI_API_KEY` + quota จริง แล้วรัน `platform conformance --live --lineage zai` บน TTY (พิมพ์ RUN-LIVE) — จนกว่าจะมี record จริง routing default §7.4 ยัง Claude/Codex ตาม v1.11
- REQ-6 CLI wiring เป็น review-verified (ไม่มี test harness สำหรับ platform.ts — ceiling บันทึกตั้งแต่ v1.7)
- รายละเอียด reasoning-token ของ Z.ai (ถ้ามี field เพิ่มใน usage) ผ่านเป็น raw — ไม่ assert รูปทรงตายตัว

## Next Recommended Agent

human review → จากนั้น operator เองสำหรับ LIVE run (task 4 ต้อง TTY + key จริง ไม่ควร delegate ให้ agent)

## Next Steps

1. Review + merge PR (branch `feat/glm-5-3-adapter` → `develop`, squash)
2. เมื่อมี Z.ai API key: `ZAI_API_KEY=... platform conformance --live --lineage zai` → commit record ที่ `.ai/calibration/conformance-glm-<stamp>.json` + ปิด task 4 พร้อม Evidence
3. หลัง LIVE ผ่าน: follow-up ตาม D2 — สลับ default §7.4 (Test Designer → GLM-5.3, Reviewer ensemble + GLM-5.3) + พิจารณา PR-gate slot / loop threading / fusion `'zai'` (งานใหม่มีสเปกของตัวเอง)
