# Handoff: Task 63 — P0-09 fresh-context review

> From: Codex fresh-context correctness/security reviewer  To: parent / acceptance owner  Date: 2026-08-02

## Task Summary

ตรวจ Task 62 implementation ของ P0-09 เทียบกับ REQ-9.1–REQ-9.10, TD-7 และ
mutation surfaces ทั้ง `WRITE_FILE`, `APPLY_PATCH` และ `RUN_COMMAND` โดยตรวจ
versioned convention policy/parser, policy-hash binding, core-observed RED
provenance/re-RED flow, production composition wiring และ paired regression tests.
Task 9 ยังคง `[ ]` และยังไม่เพิ่ม Evidence.

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 2
- Medium: 3
- Low: 0

### High

1. `console/backend/src/loop-run.ts:1125-1155` และ `core/src/gates/runner.ts:95-116`
   — correctness/security (REQ-9.2, REQ-9.4): production loop ไม่ส่ง
   `conventionPolicyPath` ให้ `createGateRunner`; fixture มีเพียง
   `gate-ladder.json` และไม่มี `.ai/policies/convention.json` copy/path binding.
   เมื่อ option นี้หาย `GateRunner` ใช้ `DEFAULT_CONVENTION_POLICY` ซึ่งมีแค่
   `focused-or-skipped-test` (`.only`/`.skip`) และไม่ตรวจ typecheck/lint/coverage/
   unexplained-ignore rules. ดังนั้น T1 production path ยังผ่าน bypass syntax ที่
   policy ใหม่ควร block และ `gateConfigHash` ไม่เปลี่ยนเมื่อ versioned convention
   policy เปลี่ยน. `core/src/audit/oob.ts` และ `console/backend/src/fusion.ts`
   ก็สร้าง runner โดยไม่ส่ง path เช่นกัน. ต้องทำ policy path เป็น production-owned
   required input (หรือ fail closed เมื่อไม่มี), ให้ทุก GateRunner caller ใช้ bytes
   เดียวกัน และเพิ่ม wired regression ที่ assert REQ-9.4 กับ hash จาก production path;
   compatibility default ควรจำกัดไว้เฉพาะ test fixture ที่ประกาศชัดเจน.

2. `console/backend/src/loop-run.ts:1125-1138` — correctness/security (REQ-9.6–9.9):
   production composition ไม่สร้าง `createRedArtifactStore` และไม่ส่ง `redArtifacts`
   หรือ `frozenRedArtifacts` เข้า `createExecutor`/`createDefaultPathPolicy` เลย
   (ทั้ง repository พบ store wiring เฉพาะ unit tests). ทำให้ frozen RED ของ test
   designer ไม่ถูกนำไป enforce ใน loop จริง แม้ primitive API และ direct executor
   test จะผ่าน. ยิ่งกว่านั้น `RedObservation.observedByCore: true` เป็นเพียง boolean
   ที่ caller ส่งได้ และ `expectedFailureFingerprint` เป็น string ที่ caller ตั้งเอง;
   ไม่มีการผูกกับผล gate ที่ core รันหรือ evidence ของ observed failure. ต้อง wire
   store/index ที่ rehydrate จาก core event log เข้ากับทุก mutator และให้ freeze/
   `replaceAfterObservedRed` รับเฉพาะผล RED ที่ core รันและ authenticate แล้ว; test
   designer correction ต้องผ่าน core-run re-RED ก่อนแทนการเรียก public method ด้วย
   metadata ที่ agent สร้าง.

### Medium

1. `core/src/executor/executor.ts:1165-1175` — security (REQ-9.7/9.9): เมื่อ
   `redArtifacts` ถูกส่งผ่าน `createExecutor`, wrapper เรียก
   `opts.redArtifacts?.get(path.replaceAll('\\\\', '/'))` โดยไม่ normalize path
   แบบเดียวกับ `PathPolicy.checkWrite`. แต่ `checkMutationPaths` จะ normalize
   `test/ai-generated/dir/../frozen.test.ts` ก่อน commit (`mutation-path.ts`),
   จึงมี alias path ที่ผ่าน WRITE_FILE/APPLY_PATCH preflight แล้วแก้หรือลบ frozen
   RED ได้. ให้ normalize/canonicalize ก่อน lookup หรือให้ policy wrapper ใช้
   normalized decision เดียวกับ `createDefaultPathPolicy`; เพิ่ม regression สำหรับ
   `..` alias ในทุก mutator surface.

2. `core/src/gates/convention.ts:173-180` และ `.ai/policies/convention.json:32-36`
   — correctness/security (REQ-9.3/9.4): `allowedControls` ถูกใช้เป็น global
   `controls.some(...)` สำหรับทุก rule และ policy pattern กว้างถึง `reason:`,
   `convention: allow`, `allow ... because` และ `-- allowed`. บรรทัดเดียวที่มี
   marker เหล่านี้จึงยกเว้น focused/skip หรือ configured typecheck/lint/coverage
   bypass ได้ แม้ marker ไม่ได้ผูกกับ rule นั้นและไม่จำเป็นต้องเป็น comment/documented
   control. นี่ทำให้เงื่อนไข “syntax ที่ policy prohibited ต้อง fail” มีช่อง bypass.
   ให้ allowed control ระบุ rule id แบบ per-rule, จำกัด marker เป็นรูปแบบ documented
   comment ที่ชัด และเพิ่ม cross-rule near-miss paired tests (เช่น `.only` +
   `reason:` ต้องยัง fail).

3. `core/src/gates/red-provenance.ts:145-189` — integrity (REQ-9.6/9.8):
   rehydration ตรวจเพียง shape/hex ของ `contentHash` และ non-empty `contentRef`;
   ไม่ dereference `contentRef`, ไม่ตรวจว่า bytes hash ตรง `contentHash`, และไม่
   เก็บ evidence reference ของผล RED ที่ core observe (มีเพียง caller-supplied
   fingerprint). Event/evidence tamper หรือ stale provenance จึง rehydrate เป็น
   frozen record ได้โดยไม่มีการตรวจ source/hash/observed artifact. ให้ verify blob
   ผ่าน `EvidenceStore.get()` + hash และ bind record กับ authenticated core RED
   report/fingerprint ก่อนใส่ index; เมื่อ current artifact ไม่ตรง frozen hash ให้
   fail closed และคง provenance เดิม.

## Verified Controls

- `core/src/gates/convention.ts` ใช้ text/line syntax matching และไม่มี AST หรือ
  semantic assertion classifier; policy comment ระบุข้อจำกัดนี้ถูกต้อง.
- `parseConventionPolicy` ตรวจ version, roots, duplicate rule ids และ malformed
  regex; malformed policy ทำให้ gate check fail closed.
- `core/src/gates/runner-convention-policy.test.ts` ยืนยัน policy bytes เปลี่ยนแล้ว
  `gateConfigHash` เปลี่ยน (1 pass).
- `core/src/gates/red-provenance.test.ts` ยืนยัน observed RED gate, hash freeze,
  unchanged correction rejection, new observed re-RED replacement และ event-log
  rehydration (3 pass).
- `core/src/executor/red-artifact-fault.test.ts` ยืนยัน implementer edit/delete
  denial ผ่าน WRITE_FILE/APPLY_PATCH/RUN_COMMAND (1 pass); test ไม่ได้พิสูจน์
  production composition wiring หรือ alias paths.

## Tests Run

- `pnpm --filter core exec node --test --test-reporter spec src/gates/convention.test.ts` -> 2 pass, 0 fail.
- `pnpm --filter core exec node --test --test-reporter spec src/gates/red-provenance.test.ts` -> 3 pass, 0 fail.
- `pnpm --filter core exec node --test --test-reporter spec src/executor/red-artifact-fault.test.ts` -> 1 pass, 0 fail.
- `pnpm --filter core exec node --test --test-reporter spec src/gates/runner.test.ts` -> 21 pass, 0 fail.
- `pnpm --filter core exec node --test --test-reporter spec src/gates/runner-convention-policy.test.ts` -> 1 pass, 0 fail.
- `pnpm --filter core exec node --test --test-reporter spec src/executor/path-policy.test.ts src/security/amended-command-contract.test.ts` -> 62 total, 61 pass, 0 fail, 1 explicit external-only skip.
- `pnpm typecheck` -> all 6 workspace projects passed.
- `pnpm lint` -> `ESLint: No issues found`.
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` -> exit 0.
- `git diff --check` -> exit 0.
- `pnpm --filter core test` -> 571 total, 562 pass, 0 fail, 9 explicit external-only skips.

## Constraints

- คง Task 9 เป็น `- [ ]`; ห้ามเพิ่ม Evidence/flip task จาก review นี้.
- ห้าม retry/circumvent external P0-02 macOS blocker หรือ fabricate P0-08 operator
  golden fixture; ไม่แก้ requirements/design/authority และไม่ commit/push.

## Next Steps

1. แก้ production convention-policy wiring และ RED provenance composition ก่อน
   acceptance; เพิ่ม wired policy-hash, bypass, RED rehydrate และ alias regression.
2. ตรวจ re-RED flow ผ่าน core-run authenticated result/evidence แล้วรัน focused,
   full core และ production composition suites ใหม่.
3. ให้ acceptance reviewer fresh-context ตรวจซ้ำ; จึงค่อยตัดสินใจ Evidence/checkbox
   ของ Task 9.
