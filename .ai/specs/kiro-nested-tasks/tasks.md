# รายการงาน: รายการงานสองระดับแบบ Kiro
> Status: draft

> Root task เป็น cohesive execution unit เดียว; children เป็น checked implementation steps ภายใน root และไม่ถูก schedule แยก

- [x] 1. รองรับรายการงานสองระดับแบบ Kiro ครบทุก consumer — parse, validate, execute, verify, project และแสดงผลโดยรักษา flat compatibility
  - Satisfies: REQ-1 (ทุกเกณฑ์), REQ-2 (ทุกเกณฑ์), REQ-3 (ทุกเกณฑ์), REQ-4 (ทุกเกณฑ์), REQ-5 (ทุกเกณฑ์), REQ-6 (ทุกเกณฑ์).
  - Verify: `scripts/spec-trace.sh kiro-nested-tasks && pnpm typecheck && pnpm lint && pnpm test` และ render nested fixture ด้วย `/opt/homebrew/bin/pandoc`.

  - [x] 1.1 ปรับ canonical task contract และ generators
    - Satisfies: REQ-1.1-1.5, REQ-6.5-6.6.
    - Verify: ตรวจ template ที่ generate แล้วด้วย Markdown preview และ protocol contract tests.
    - อัปเดต `TASK_PROTOCOL.md`, task/implement/GitHub sync skills และตัวอย่างให้ root/child ownership ตรงกัน

    - Evidence:
      - test: `/opt/homebrew/bin/pandoc --from=markdown+task_lists --to=html` -> render checkbox hierarchy สำเร็จ; protocol/sync assertions อยู่ใน `spec-slice.test.sh` 42/42
      - deviations: ไม่มี UI code ตามขอบเขต

  - [x] 1.2 สร้าง hierarchy parser และ validation
    - Satisfies: REQ-2 (ทุกเกณฑ์), REQ-3.1, REQ-3.4.
    - Verify: parser tests ครอบคลุม blank lines, flat, duplicate, orphan, wrong-parent, deeper nesting, fence และ transcript.
    - เพิ่ม structured roots/children ใน `scripts/spec_trace.py` และรักษา flat compatibility wrapper

    - Evidence:
      - test: `node --test console/backend/src/spec-to-goal.e2e.test.ts` -> 27/27 ผ่าน รวม wrapped metadata และ backtick/tilde fence ที่ indent ของ root/child
      - corpus: `parse_task_hierarchy()` รับ `.ai/specs/**/tasks.md` และ `.claude/specs/**/tasks.md` 35/35 ไฟล์
      - mutation-check: ตัด metadata continuation ในสำเนา `/tmp` แล้ว wrapped `Satisfies:` assertion แดง; source จริงกลับเขียว

  - [x] 1.3 ปรับ traceability และ Goal projection
    - Satisfies: REQ-3.1-3.5.
    - Verify: `spec-to-goal` E2E สร้างเฉพาะ `T-N`, union REQ refs และใช้เฉพาะ root `Verify:`.
    - ให้ `spec_to_goal.py` consume structured roots โดยไม่สร้าง child task หรือ concatenate child `Verify:`

    - Evidence:
      - test: wrapped fixture assert root-only `T-N`, refs `AC-1.2` + `AC-2.1`–`AC-2.3`, `depends_on: [T-1]` และ root Verify `continuation-command && continuation-command-two`
      - corpus: trace requirements specs active+archive 27/27 เขียว; `platform-phase5-stage1`, `platform-phase5-stage2`, `sdd-ci-incremental-checks` กลับมาครบ refs/depends/Verify
      - mutation-check: เปลี่ยน projection ให้ใช้ child Verify ในสำเนา `/tmp` แล้ว assertion ล้มเหลว; restore แล้วผ่าน

  - [x] 1.4 บังคับ Evidence และ completion invariant
    - Satisfies: REQ-4 (ทุกเกณฑ์), REQ-5.5.
    - Verify: `check-evidence`, `gate-task` และ CI line-scope tests ผ่าน nested ownership cases.
    - ทำ Evidence regions แบบ depth-aware; root Evidence หลัง childrenต้องไม่ตกเป็นของ child สุดท้าย

    - Evidence:
      - test: `check-evidence.test.sh` 41/41, `gate-task.test.sh` 42/42, `ci-evidence-scope.test.sh` 12/12
      - regression: fence indent 4/5 ผ่านแบบ opaque; tab-indented completed checkbox ไม่มี Evidence ถูกปฏิเสธ exit 2
      - mutation-check: เอา tab ออกจาก `indent_of()` ในสำเนา `/tmp` แล้ว fixture หลุดผ่าน exit 0; source จริง block exit 2

  - [x] 1.5 ปรับ execution, slice และ observability consumers
    - Satisfies: REQ-5 (ทุกเกณฑ์), REQ-6.4.
    - Verify: slice/pane/archive/spec-edit/metrics/cost tests ยืนยัน root-only selection/count และ subtree preservation.
    - คง root ordinal เป็น CLI/dependency/batch/cost identity และห้ามเลือก child โดยตรง

    - Evidence:
      - test: `spec-slice.test.sh` 46/46, `spec-metrics.test.sh` 11/11, `spec-edit-guard.test.sh` 15/15
      - slice: child `Satisfies:` ที่ wrap ยังคืนทั้ง `REQ-1` และ `REQ-2`
      - CLI: `scripts/pane-loop.sh kiro-nested-tasks 1.1` -> exit 1 พร้อม `ไม่ใช่ executable root ID`
      - rework review 2/5: actual `slice`, `pane all-in-one`, `metrics`, `cost`, `spec-edit`, `state`, `archive`, `trace` และ CI line-scope ข้าม checkbox ใน fence/Evidence; parser projection เป็น source เดียว

  - [x] 1.6 ปรับ GitHub projection และปิด regression gate
    - Satisfies: REQ-6.1-6.3, REQ-6.5-6.6.
    - Verify: GitHub sync dry fixture สร้าง root issue เดียวพร้อม child checklist; full repository gate ผ่าน.
    - คง manifest key ต่อ root เท่านั้นและ render child state ใน root issue body

    - Evidence:
      - test: `pnpm typecheck` และ `pnpm lint` -> exit 0; `pnpm test` -> ทุก package จบโดยไม่พบ failure (`console/web` 115/115, `console/backend` 465/465)
      - trace: requirements specs active+archive 27/27 เขียว รวม `kiro-nested-tasks` 31 เกณฑ์

  - Evidence:
    - test: targeted suitesทั้งหมด 27 + 41 + 42 + 12 + 46 + 11 + 15 cases ผ่าน; `pnpm typecheck` และ `pnpm lint` exit 0
    - rework audit 1/5: wrapped metadata, indented fences และ tab fail-closed reproduce แดงก่อนแก้ แล้ว targeted/corpus gates กลับเขียว
    - rework review 2/5: raw checkbox consumer reproduce fake root/child ก่อนแก้; หลังแก้ actual consumer entrypoints และ corpus parser 35/35, trace 27/27 กลับเขียว
    - integration: `pnpm test` จบทุก workspace packageโดยไม่พบ failure; unified PTY session ปิดหลัง `console/backend: Done`
    - render: Pandoc `markdown+task_lists` exit 0 และ feature document มี checkbox input 7 รายการตาม root+children
    - deviations: GitHub sync ตรวจ instruction contract แบบ local เท่านั้นตามข้อห้ามไม่ sync remote
