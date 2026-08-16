# Handoff: Operator Control Center Web UI

> From: Codex `/root`  
> To: human review  
> Date: 2026-08-13

## Task Summary

ปรับ Web UI เป็น Operator Control Center สำหรับ Dashboard, Core, AAL, Adapters,
Console และ Governance โดยอ้างแนวทางข้อมูลหนาแน่นจาก `hermes-webui` แต่คง authority,
security boundary และสัญญาเดิมของระบบ ตาม spec
`.ai/specs/operator-control-center-webui` ครอบคลุม REQ-1 ถึง REQ-11

## Current Status

เสร็จ Tasks 1-10 ทั้งหมด พร้อม unit, integration, build, security, trace และ browser
gates. Gap `RATE_LIMIT_OBSERVED` ถูกปิดด้วย production wiring และ regression test แล้ว
Final code review ไม่พบ finding ค้าง งานอยู่ branch
`codex/operator-control-center-webui` สำหรับ PR เข้า `develop`; CI ต้องผ่านก่อน merge

## Files Changed

- `.ai/specs/operator-control-center-webui/requirements.md` — created — approved EARS requirements
- `.ai/specs/operator-control-center-webui/design.md` — created — approved design
- `.ai/specs/operator-control-center-webui/tasks.md` — created — approved tasks พร้อม Evidence ทุก task
- `.ai/specs/operator-control-center-webui/handoff.md` — created — durable handoff นี้
- `core/src/budget/budget.ts`, `core/src/budget/budget.test.ts`, `core/src/index.ts`, `core/src/types.ts` — edited — additive budget observations และ event types
- `aal/src/dispatch.ts`, `aal/src/dispatch.test.ts`, `aal/src/ratelimit.ts`, `aal/src/ratelimit.test.ts`, `aal/src/registry.ts`, `aal/src/router.ts`, `aal/src/index.ts` — edited — observation seam และ shared eligibility path
- `aal/src/eligibility.ts`, `aal/src/eligibility.test.ts` — created — pure eligibility projection/decision helper
- `adapters/src/anthropic.ts`, `adapters/src/codex.ts`, `adapters/src/reasoning-cli.ts`, `adapters/src/index.ts` — edited — reuse shared descriptors
- `adapters/src/descriptors.ts`, `adapters/src/descriptors.test.ts` — created — pure static adapter descriptors
- `console/backend/bin/platform.ts` — edited — inject read-only Control Center composition
- `console/backend/src/control-center.ts`, `console/backend/src/control-center.test.ts` — created — bounded authoritative read projections
- `console/backend/src/pagination.ts`, `console/backend/src/pagination.test.ts` — created — bounded opaque cursor pagination
- `console/backend/src/app.ts`, `console/backend/src/govern.ts`, `console/backend/src/surfaces.ts`, `console/backend/src/loop-run.ts` — edited — additive routes, redaction/provenance, governance contracts และ observations
- `console/backend/src/app-govern.test.ts`, `console/backend/src/app-issues.test.ts`, `console/backend/src/app-loop.test.ts`, `console/backend/src/app-observe.test.ts`, `console/backend/src/app-surfaces.test.ts`, `console/backend/src/app-term.test.ts`, `console/backend/src/app.test.ts`, `console/backend/src/loop-run-graph.test.ts`, `console/backend/src/loop-run.test.ts`, `console/backend/src/surfaces.test.ts` — edited — regression/contract coverage
- `console/web/index.html`, `console/web/src/main.tsx`, `console/web/src/App.tsx`, `console/web/src/styles.css` — edited — first-paint theme, application shell, responsive/a11y system
- `console/web/src/Dashboard.tsx`, `console/web/src/Core.tsx`, `console/web/src/Aal.tsx`, `console/web/src/Adapters.tsx`, `console/web/src/Console.tsx`, `console/web/src/Governance.tsx` — created — Control Center areas
- `console/web/src/DraftContext.tsx`, `console/web/src/dialog.ts`, `console/web/src/usePendingMutation.ts` — created — safe drafts, native modal lifecycle, duplicate mutation guard
- `console/web/src/Chat.tsx`, `console/web/src/Issues.tsx`, `console/web/src/Login.tsx`, `console/web/src/Loop.tsx`, `console/web/src/PrQuality.tsx`, `console/web/src/Sched.tsx`, `console/web/src/Surfaces.tsx`, `console/web/src/TerminalPanel.tsx`, `console/web/src/I18nContext.tsx`, `console/web/src/useFetch.ts` — edited — shell integration, auth-loss handling, confirmations และ localization
- `console/web/src/logic/auth.ts`, `console/web/src/logic/format.ts`, `console/web/src/logic/govern.ts`, `console/web/src/logic/i18n.ts`, `console/web/src/logic/issues.ts`, `console/web/src/logic/surfaces.ts`, `console/web/src/logic/theme.ts` พร้อมไฟล์ `*.test.ts` ที่คู่กัน — edited — pure derivation/compatibility logic
- `console/web/src/logic/console.ts`, `console/web/src/logic/controlCenter.ts`, `console/web/src/logic/dashboard.ts`, `console/web/src/logic/draftState.ts`, `console/web/src/logic/mutation.ts`, `console/web/src/logic/navigation.ts`, `console/web/src/logic/preferences.ts`, `console/web/src/logic/readState.ts` พร้อมไฟล์ `*.test.ts` ที่คู่กัน — created — routing, read model, pagination, preferences, dashboard และ mutation logic

## Important Decisions

- Control Center prefixes มีเฉพาะ `GET`; opening/refreshing Dashboard, Core, AAL หรือ Adapters ไม่ probe, spawn, execute หรือ mutate domain state
- ใช้ authoritative files/events/calibration ผ่าน injected read port; field ที่ขาดหรือเสียแสดง `unknown`, `unavailable` หรือ `invalid-record` แยก dimension ไม่เดา state
- SQLite เปิด `readOnly` พร้อม `PRAGMA query_only`; file reads ปฏิเสธ symlink และ event payload ใช้ field allowlist
- Governance mutation คง server-side validation, scope, base hash, preview token, permission และ audit authority; raw sensitive document ไม่เข้า draft persistence
- ใช้ React/CSS/native `<dialog>`/History API/`AbortController`; ไม่เพิ่ม dependency, cache หรือ background probe
- Theme default dark ก่อน first paint, รองรับ light และ Thai/English; technical identifiers คงต้นฉบับ
- Observation records เป็น additive side channel; exception ถูกกลืนและ decision folds เดิมไม่ consume records ใหม่

## Root Cause and Impact

- ก่อนแก้: `DispatcherOptions.observeRate` และ projector มีแล้ว แต่ production search
  ไม่พบ `RATE_LIMIT_OBSERVED` append site; `control-center.test.ts` พิสูจน์เฉพาะ
  synthetic event จึงทำให้ AAL rate state คง `unknown` แม้เกิด dispatcher send จริง
- Root cause มีสองส่วนที่พิสูจน์แยกกัน: dispatcher ถูกสร้างนอก fusion composition
  ขณะที่ `runFusion` เป็นเจ้าของ authoritative `EventLog`; `dispatchAll` ไม่มี
  per-call observer seam จึงไม่มี producer และ projector รับเฉพาะ numeric tokens
  ทั้งที่ producer contract กำหนด `null` สำหรับ target ที่ไม่มี bucket
- หลังแก้: `dispatchAll` รับ optional per-call observer แบบ additive และ `runFusion`
  append `RATE_LIMIT_OBSERVED` ด้วย run/task identity จริง; append failure เขียน `ERROR`
  best-effort แล้วปล่อย fusion ทำงานต่อ Projector/UI รับ `availableTokens: null` เป็น
  recorded unlimited state แต่ยังปฏิเสธ `limited: true` ที่ไม่มี token count
- ผลกระทบ: AAL projection อ่าน recorded rate state ได้จริง EventLog โตตาม observation
  ที่ dispatcher emit แต่ routing, wait, provider send count, response และ fusion decision
  ไม่เปลี่ยน Existing callers ที่ไม่ส่ง observer ยังใช้ signature เดิมได้
- หลักฐาน: RED แรกได้ records `[]`; GREEN AAL suite 17/17 ผ่าน RED รอบ review ได้
  `invalid-record`; GREEN projector 11/11 และ Web logic/i18n 15/15 ผ่าน พร้อม
  production scan ชี้ `aal/src/fusion/run.ts` เป็น producer

## Constraints

- ห้าม push ตรง `main` หรือ `develop`; ต้อง review แล้วเปิด PR ตาม workflow
- ห้าม commit ก่อน review ตาม repo rule; final review ผ่านแล้วก่อนขั้น ship
- รักษา backward compatibility ของ endpoint shape เมื่อไม่มี pagination query
- ห้ามคืนหรือ log credential/raw secret/home path; raw Governance content ต้องใช้ replace-entire flow
- ไม่มีเหตุให้เพิ่ม package, lockfile, `scripts/` หรือ `spikes/`; อย่าเพิ่มหากไม่ผ่าน dependency review
- อย่า revert unrelated user changes; reconcile `git status --short` ก่อนแตะไฟล์

## Tests Run

- `pnpm typecheck && pnpm lint` -> ผ่านทุก workspace package
- `pnpm test` -> 1,441 passed, 0 failed, 10 Core platform-only skipped
- `pnpm build` -> ผ่าน; Vite แจ้ง existing chunk-size warning เท่านั้น
- `pnpm vendor-check` -> ผ่าน Core/AAL vendor-name gate
- `.ai/bin/check-secrets.sh --all` -> ผ่าน full tracked-tree scan
- `node --test --test-reporter spec src/control-center.test.ts` ใน `console/backend` -> 11 passed, 0 failed หลังแก้ unlimited-state projection
- `node --test --test-reporter spec src/app-surfaces.test.ts src/surfaces.test.ts && pnpm typecheck` ใน `console/backend` -> 28 passed และ typecheck ผ่าน หลังปรับ secret-like test fixtures
- `scripts/spec-trace.sh operator-control-center-webui` -> 170/170 criteria traced; EARS lint ผ่าน
- `.ai/bin/check-evidence.sh --strict < .ai/specs/operator-control-center-webui/tasks.md` -> ผ่าน
- `pnpm audit --prod --audit-level high` -> exit 0; ไม่มี high/critical
- `git diff --check` -> ผ่าน
- Chromium production matrix 375, 768, 1440 px; dark/light; Thai/English -> ผ่าน ไม่มี document overflow หรือ browser error
- Chromium accessibility -> native dialog focus trap/Escape/focus return, 44 px targets, 3 px focus, landmarks/headings, long IDs, reduced motion และ contrast ขั้นต่ำ 4.61:1 ผ่าน

## Known Issues

- ไม่มี blocking issue
- Vite ยังเตือน production chunk มากกว่า 500 kB; เป็น warning เดิมและ build ผ่าน
- production dependency audit รายงาน 1 low และ 4 moderate advisories; ไม่มี high/critical
- 10 Core tests ถูก skip ตาม external macOS/loopback requirements ที่ประกาศไว้
- ไม่มี blocking issue จาก final code review

## Next Recommended Agent

PR reviewer ตรวจ root-cause evidence, UI journeys และ CI required checks; ห้าม merge
จนกว่า checks ทุกชุดจะเขียว

## Next Steps

1. อ่าน `.ai/specs/operator-control-center-webui/{requirements.md,design.md,tasks.md,handoff.md}`
2. Review PR diff และ root-cause evidence; spot-check production UI หากต้องการ
3. รอ required checks ทุกชุดผ่านก่อน merge เข้า `develop`
