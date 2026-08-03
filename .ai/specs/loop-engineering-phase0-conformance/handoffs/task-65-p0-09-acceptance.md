# Handoff: Task 65 — P0-09 acceptance

> From: Codex fresh-context acceptance reviewer  To: parent / Task 9 owner  Date: 2026-08-02

## Task Summary

ตรวจ acceptance ของ P0-09 (`loop-engineering-phase0-conformance`) หลัง Task 64
เทียบ REQ-9.1–REQ-9.10 และ TD-7 โดยตรวจทั้ง convention policy และ production
composition ของ frozen RED provenance ครบทุก mutation surface
(`WRITE_FILE`, `APPLY_PATCH`, `RUN_COMMAND`). Task 9 ยังคง `- [ ]`; handoff นี้
ไม่ได้เพิ่ม Evidence, flip checkbox หรือแก้ implementation

## Verdict

`APPROVE_WITH_EXTERNAL_BLOCKER`

- Critical: 0
- High: 0
- Medium: 0
- Low: 0

ไม่พบ finding ที่ต้องแก้ใน source ที่ตรวจของ P0-09. Blocker ที่ยังคงอยู่เป็น
environment-only: full `console-backend` ต้อง bind Human Plane listener แต่ managed
sandbox ปฏิเสธ `listen` ด้วย `EPERM`; full core run ถูก interrupt ก่อนมี aggregate จึง
ไม่มีการอ้าง full-suite PASS. ต้องรันสองชุดนี้ใน authorized environment/CI ก่อนปิด
Task 9 ตาม production-wiring closure gate

## Verified Production Wiring

- `console/backend/src/loop-run.ts` copy exact bytes ของ
  `.ai/policies/convention.json` ลง target fixture แล้วส่ง `conventionPolicyPath`
  ให้ `createGateRunner`; `core/src/gates/runner.ts` parse policy และผูก raw policy
  bytes เข้า `gateConfigHash` โดย policy malformed/unavailable fail closed.
- Loop task composition สร้าง `createRedArtifactStore` ด้วย `evidence`, event log,
  `reportIntegrity`, `runId`, `taskId`, `worktreeDir` แล้วส่ง index เดียวกันเข้า
  `createDefaultPathPolicy` และ `createExecutor`; command-artifact promotion ตรวจ
  `policy.checkWrite` ทุก changed path ด้วย จึงครอบคลุม WRITE_FILE/APPLY_PATCH/
  RUN_COMMAND.
- `createCoreRedObservation` รับเฉพาะ authenticated failing GateReport, capture
  artifact/report bytes ใน EvidenceStore, mint opaque frozen observation (รวม
  run/task identity); freeze/replace ปฏิเสธ caller-fabricated metadata และ re-RED
  ต้องมี hash ใหม่.
- Event-log rehydration dereference `contentRef`/`reportRef`, ตรวจ content/report/
  observed-artifact hashes, signature และ failure fingerprint รวมทั้งตรวจ current
  artifact bytes; mismatch fail closed และไม่ทับ provenance เดิม.
- Frozen RED lookup ใช้ normalized worktree-relative path เดียวกับ preflight,
  ปิด slash และ `dir/../frozen.test.ts` alias; per-rule documented controls จำกัด
  อยู่ใน comment และ control ของ rule หนึ่งไม่ waive rule อื่น.
- Candidate/fusion, OOB auditor, auto-merge และ approved-merge production call-sites
  ส่ง convention-policy relative path ต่อไปยัง GateRunner; isolated unit fixtures
  ที่ไม่มี path ยังคง compatibility default โดยเจตนา

## Tests Run

- P0-09 core focused:
  `pnpm --filter core exec node --test --test-reporter spec src/gates/convention.test.ts src/gates/runner-convention-policy.test.ts src/gates/red-provenance.test.ts src/executor/red-artifact-fault.test.ts src/executor/path-policy.test.ts`
  -> `14` tests, `14` pass, `0` fail, `0` skipped. ครอบคลุม whitespace focus/skip,
  configured bypass/unexplained-ignore, per-rule controls/legacy-global denial,
  policy hash, opaque RED freeze, test-designer re-RED, event-log rehydrate/current
  artifact tamper, frozen mutation ทั้งสาม surface และ `..` alias.
- Focused console:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/golden.fixture.test.ts src/fusion.test.ts`
  -> `15` tests, `15` pass, `0` fail.
- AAL:
  `pnpm --filter aal test` -> `148` pass, `0` fail, `0` skipped.
- Workspace gates: `pnpm typecheck` -> all `6` projects pass; `pnpm lint` ->
  `ESLint: No issues found`.
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> exit `0`; `scripts/spec-trace.sh loop-engineering-phase0-conformance` -> `144`
  criteria covered and EARS lint passed; `git diff --check` -> exit `0`.

## External / Incomplete Verification

- Full console:
  `pnpm --filter console-backend test` -> `394` total, `338` pass, `56` fail,
  `0` skipped. ทุก failure เป็น `listen EPERM: operation not permitted 127.0.0.1`
  จาก Human Plane listener ใน managed sandbox; ไม่ใช่ product PASS และไม่ถูก relabel
  เป็น skip.
- Full core: run ถูก interrupt หลัง partial execution ก่อนสรุป aggregate; ไม่มี
  full-core PASS/FAIL claim และไม่ได้ retry ใน acceptance นี้.
- Operator golden fixture blocker ของ Task 8 และ recorded real-macOS blocker ของ
  Task 2 ยังคงเดิม; acceptance นี้ไม่ fabricate fixture และไม่ retry/circumvent
  external checks.

## Constraints / Next Steps

- คง Task 9 เป็น `- [ ]`; ห้ามเพิ่ม Evidence หรือประกาศ Phase 0 closure จาก handoff
  นี้ และไม่มี commit/push.
- รัน full core และ full console ใน authorized environment/CI ที่อนุญาต local
  listener; หาก aggregate ผ่านและ blockers อื่นถูกจัดการแล้ว parent จึงพิจารณา
  เพิ่ม Evidence/flip Task 9 แยกต่างหาก.
