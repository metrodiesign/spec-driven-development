# Handoff: Task 03 — Phase 0 conformance spec artifacts

> From: Codex teammate `/root/phase0_spec_author`   To: lead `/root`   Date: 2026-07-27

## Task Summary

สร้าง quick-mode approved artifacts สำหรับ
`.ai/specs/loop-engineering-phase0-conformance/` โดยยึด product behavior จาก
`/Users/king_developer/Downloads/loop-engineering-implementation-spec.md` เท่านั้น
และสังเคราะห์ Task-1 audit กับ Task-2 fresh-context architecture review ให้เป็น
requirements, design และ dependency-ordered tasks ก่อนแตะ production code

Spec มี 10 capability sections, 107 atomic EARS criteria และ 10 cohesive tasks
P0-01..P0-10 ครอบ Fault-injection DoD 1–9 รวม regression guarantees ของข้อที่
ผ่านอยู่แล้ว

## Current Status

Task 03 เสร็จแล้ว

- `requirements.md`, `design.md`, `tasks.md` มี header
  `> Status: approved 2026-07-27 (quick, no gates)` ตามอำนาจ full overnight run
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` ผ่านทั้ง coverage
  และ EARS lint: 107/107 criteria ถูกอ้างใน design และ tasks
- `scripts/spec-slice.sh` สำหรับ task 1–10 ไม่พบ `MISSING:`; ทุก traceability
  `Section` cell ตรงกับ `##` heading จริงแบบ exact text
- `tasks.md` มี 10 tasks และทุก task ยังเป็น `- [ ]`
- ไม่มี production source, tests, root authority copy, old master/blueprint,
  commit หรือ remote ถูกแก้
- Active next task คือ P0-01 pin exact authority bytes

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/requirements.md` — created —
  10 REQ sections, 107 EARS criteria, DoD mapping และ resolved quick-mode audit
- `.ai/specs/loop-engineering-phase0-conformance/design.md` — created —
  standard architecture sections, four sequence diagrams, data/interfaces,
  decisions, error strategy, tests และ exact-heading traceability table
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md` — created —
  10 unchecked cohesive tasksตาม P0-01..P0-10 dependency DAG
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-03-spec-artifacts.md`
  — created — durable state, verification results และ next task

Task-1 และ Task-2 handoffs ที่มีอยู่ก่อนถูก preserve โดยไม่แก้:

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-01-audit.md`
- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-02-architecture-review.md`

## Important Decisions

- Authority ปัจจุบันคือ external implementation spec SHA-256
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
  เพียงไฟล์เดียว P0-01 ต้อง pin repository-root copy byte-for-byte ก่อน task อื่น
- Evidence authenticity ใช้ Node built-in Ed25519 keypair ต่อ run Private key
  อยู่ใต้ run state นอก agent worktreeด้วย mode `0600`; public key/fingerprint
  อยู่ใน immutable run metadata; recovery ต้องใช้ key เดิม
- Signature ครอบ canonical gate metadata และรายการ evidence ref/content hash;
  ทุก trust boundary ต้อง dereference hash และ verify signature Missing/mismatch
  เป็น structured `ESCALATED` และห้าม state advance
- Child processes ของ executor/gates ใช้ shared async primitive Gate check แต่ละตัว
  รันบน disposable checkout จาก frozen snapshot เดียวเพื่อทิ้ง mutation ทั้งหมด
  และให้ lease heartbeat ทำงานระหว่าง process
- `READ_FILE` เป็น non-mutating exception: ไม่มี snapshot/`ACTION_INTENT` แต่มี
  `ACTION_APPLIED` พร้อม content ref; design บันทึก rationale และ test matrix
- Lease อยู่ที่ task-loop boundaryพร้อม monotonic fencing token, heartbeat,
  TTL > atomic duration, pause reacquire และ terminal release; single/graph ใช้ path เดียว
- Golden verifier และ direct CI gate เป็น system-owned แต่ truth bytes เป็น
  operator-supplied copy-only Runtime ห้าม generate/weakening หาก fixture bytes
  ยังไม่มี P0-08/P0-10 ต้องคง blocked
- Golden metrics รายงาน held-out pass rate คู่ unique-AC golden coverage เสมอ
- Convention regex จำกัด deterministic syntax Semantic prohibited changesใช้
  core-observed frozen RED hash/provenance ไม่มี classifier/mutation-gate theater
- Old master, blueprint และ archived specsไม่ถูกแตะและไม่ใช่ authority
- T0 นับหนึ่งครั้งต่อ implementer/repair proposal หลัง action batch รวม zero-action
  และทุก claim; diagnostician/probe ที่ไม่แก้ artifact ไม่ถูกนับ
- P0-05 serialize ก่อน P0-06 เพราะทั้งคู่ own `core/src/orchestrator/loop.ts`

## Constraints

- อ่าน product behavior จาก pinned exact implementation spec เท่านั้น ห้ามโหลด old
  master/blueprint/archived platform spec เป็น authority
- P0-01 ต้องผ่าน exact `cmp` และ SHA-256 ก่อน production/test edit ใด ๆ
- ห้ามแก้ old master/blueprint; แก้ stale reference เฉพาะ Phase 0 files ที่ task
  implementation แตะและมีข้อความทำให้ behavior เข้าใจผิด
- ทุก P0-02..P0-10 task ต้องเริ่มด้วย observable RED fault/test แล้ว GREEN ใน task เดียว
- ห้ามเพิ่ม dependency สำหรับ crypto, patch parsing หรือ schema validationโดยไม่ผ่าน
  approval; design ปัจจุบันไม่ต้องเพิ่ม dependency
- ห้ามสร้าง capability Phase 1+ เพื่อปิด Phase 0 gap
- ห้ามสร้าง golden truth แทน operator หรือเรียก agent-created fixture ว่า human-authored
- Real `sandbox-exec` proof ต้องรันนอก nested managed sandboxหรือบน CI `macos-latest`
- ห้าม commit/push จนผ่าน review; ห้าม pushตรง main/developและห้าม force push

## Tests Run

- `shasum -a 256 /Users/king_developer/Downloads/loop-engineering-implementation-spec.md`
  -> `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- `scripts/spec-trace.sh loop-engineering-phase0-conformance`
  -> `OK: 'loop-engineering-phase0-conformance' เกณฑ์ 107 ข้อ ถูกอ้างครบใน design.md และ tasks.md, EARS lint ผ่านทุกข้อ`
- `for n in 1 2 3 4 5 6 7 8 9 10; do scripts/spec-slice.sh loop-engineering-phase0-conformance "$n"; done | rg 'MISSING:|^== TASK|^requirements.md:|^design.md:|^tasks.md:'`
  -> task 1–10 resolve approved headers; no `MISSING:` line
- `rg -n '^## (Architecture Overview|Sequence Diagrams|Data Models & Interfaces|Technology Decisions|Error Handling Strategy|Testing Strategy|Requirement Traceability)$' .ai/specs/loop-engineering-phase0-conformance/design.md`
  -> พบ required headings ทั้ง 7
- `rg -c '^## REQ-[0-9]+:' .ai/specs/loop-engineering-phase0-conformance/requirements.md`
  -> `10`
- `rg -c '^- \[ \] [0-9]+\.' .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> `10`
- `rg -n '^- \[[xX]\]' .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  -> no output
- `rg --files | rg '(^|/)test/golden/|_MANIFEST\.sha256$'`
  -> no output; operator-supplied fixture bytesยังไม่มีใน current filesystem
- `git status --short --branch`
  -> branch `codex/loop-engineering-phase0-conformance`; spec directory untracked

ไม่ได้รัน production typecheck/tests เพราะ Task 03 ได้รับอนุญาตให้แก้เฉพาะ spec/handoff
artifacts และไม่มี production code เปลี่ยน

## Known Issues

- Current filesystem ยังไม่มี operator-supplied golden fixture หรือ
  `_MANIFEST.sha256`; P0-08 และ P0-10 ต้องไม่ถูก mark done จน operator ให้ bytes
- Root `loop-engineering-implementation-spec.md` ยังไม่มีโดยเจตนา; P0-01 เป็น task
  ถัดไปและเป็น dependency ของทุก implementation task
- Current managed sandbox ซ้อน macOS `sandbox-exec` ไม่ได้; closure ต้องบันทึกผล
  external approval run หรือ CI แยกจาก nested exit 71
- Spec directory ทั้งก้อนยัง untracked รวม Task-1/Task-2 handoffs ของ teammate;
  `git diff --stat` จะไม่แสดงไฟล์เหล่านี้ ต้องเชื่อ `git status`

## Next Recommended Agent

Builder ที่รับผิดชอบ P0-01 โดยเฉพาะก่อน จากนั้นใช้ high-effort implementation agent
ทำ P0-02 ตาม dependency order Fresh-context review ควรเกิดอีกครั้งหลัง P0-04/P0-06
เพื่อตรวจ signature boundary และ fencing semantics

## Next Steps

1. อ่าน `requirements.md`, `design.md`, `tasks.md` และรัน
   `scripts/spec-slice.sh loop-engineering-phase0-conformance 1`
2. Implement P0-01 เท่านั้น: pin external source byte-for-byteเข้า
   `loop-engineering-implementation-spec.md` โดยไม่แตะ old master/blueprint
3. รัน exact `cmp` และ SHA-256; review changed paths; mark task 1 `[x]` พร้อม
   `Evidence:` ใน edit เดียวกันเมื่อผลจริงผ่าน
4. ส่ง P0-01 ให้ reviewก่อนเริ่ม P0-02 shared command boundary
