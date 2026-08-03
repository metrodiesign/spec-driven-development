# Handoff Note: Task 40 P0-04 Acceptance Review

> Schema ตาม `.ai/shared/AGENT_HANDOFF_PROTOCOL.md`

## Task Summary

ทำ fresh-context correctness และ security acceptance review หลัง Task 39 สำหรับ P0-04 Evidence Authentication โดยตรวจ REQ-4.1–4.13, findings จาก Task 36 และ fixes จาก Task 37–39 แบบ read-only ไม่แก้ production, tests, requirements, design หรือ tasks

## Current Status

- Verdict: `APPROVE_WITH_EXTERNAL_BLOCKER`
- P0-04: ผ่าน acceptance review
- Findings: Critical `0`, High `0`, Medium `0`, Low `0`
- Task 4 คง `[ ]` ตามขอบเขตของ Task 40; reviewer ไม่ได้แก้ `tasks.md`
- ยังไม่เริ่ม P0-05, ไม่ commit และไม่ push

External blocker เป็นของ P0-02 ไม่ใช่ P0-04: real-macOS suite ยังอยู่ใน recorded cooldown ถึง 2026-08-03 เวลา 20:18 Asia/Bangkok จึงยังห้ามอ้าง Phase 0 ผ่านทั้งหมด รอบนี้ไม่ได้ retry, circumvent หรืออ้าง PASS ให้ external suite ดังกล่าว

## Review Scope and Findings

อ่าน authority, approved requirements/design/tasks, handoff Task 01–39, shared project protocols, Codex adapter และใช้เกณฑ์จาก `code-reviewer` กับ `security-reviewer` ตรวจ source และ event ordering ทุกจุดที่เกี่ยวข้อง

ไม่พบ actionable finding ระดับ Critical, High, Medium หรือ Low จึงไม่มี path/scenario/fix ที่ต้องส่งกลับ

## Acceptance Evidence

### REQ-4.1–4.5: per-run key และ canonical bytes

- `core/src/evidence/auth.ts` ใช้ Node built-in Ed25519, สร้าง keypair หนึ่งชุดต่อ run, เก็บ private key ใต้ run-state นอก worktree ด้วย mode `0600`, freeze public key กับ SHA-256 SPKI fingerprint ใน immutable metadata mode `0444`
- recovery เปิด private key เดิมและตรวจ run id, metadata mode, public fingerprint และ private/public key correspondence แบบ fail closed
- signed bytes ใช้ encoding เดียว `canonical-json-v1`: recursively sorted object keys, array order คงเดิม, UTF-8 JSON และ reject unsupported/cyclic/non-finite values

### REQ-4.6–4.8: report metadata และ immutable blobs

- `core/src/gates/report-integrity.ts` ลงนาม run/task/tier/pass/config/commit/worktree/environment/scope/checks, evidence refs และ dereferenced SHA-256 content hashes
- `core/src/evidence/store.ts` freeze caller bytes, publish ด้วย `wx`, loser ตรวจ existing regular-file bytes/hash และทุก read ใช้ no-follow regular-file descriptor พร้อม address-hash verification

### REQ-4.9–4.13: trust boundaries และ fail-closed advancement

- gate reports ถูก re-dereference และ verify signature/frozen fingerprint ที่ approval, merge queue/direct merge, T2 result, audit, OOB และ completion boundaries
- `core/src/merge/artifact-binding.ts` bind signed report กับ exact task commit/tree, signed target base และ final merge OID; stale task/base, tree mismatch, wrong merge parent หรือ mutated report ถูก reject
- `core/src/merge/auto-merge.ts` direct merge สร้าง detached จาก exact signed base/artifact, verify/re-sign merge topology ก่อน CAS และใช้ `git update-ref <new> <signed-base>`; auth/CAS failure ไม่ emit `EVIDENCE_AUTHORIZED`, audit หรือ completion หลัง failure
- `core/src/merge/queue.ts` verify signed task/base ใต้ queue lease, merge exact signed artifact และ CAS main ด้วย signed base; concurrent main advance ถูกเก็บไว้และจบ structured `ESCALATED`
- `core/src/human/api.ts` ตรวจ task/deploy approval evidence ก่อน decision event/callback; missing verifier มี typed `evidence_auth_unavailable`
- `console/backend/src/loop-run.ts` recompute task diff จาก signed base/artifact และ deploy first-parent diff จาก signed merge OID พร้อม byte-equal `diffRef` verification; pending task/deploy waits ถูกปล่อยทันทีเมื่อ auth failure
- `core/src/deploy/stage.ts` บังคับ explicit verifier boundary อีกครั้งก่อน CANARY; failure จบ `DEPLOY_STATE:ESCALATED` และ `ESCALATED` โดย executor calls เป็นศูนย์
- `core/src/audit/oob.ts` derive store จาก `dirname(effectiveDbPath)/evidence`, recovery ใช้ frozen run key, verify exact merge/tree binding และ missing T1 สร้าง typed `ESCALATED` โดยไม่ mutate/revert live repo
- implementation ใช้เฉพาะ Node built-ins ไม่มี third-party crypto dependency

## Task 36–39 Regression Review

- stale signed green report A กับ current red artifact B: reject ก่อน merge และไม่ถึง `COMPLETED`
- deploy verifier: explicit endpoint boundary และ independent pre-CANARY stage recheck ผ่าน
- OOB: selected DB ใช้ run-scoped evidence path เดียว; eligible COMPLETED ที่ไม่มี T1 escalates และ CLI exit non-zero
- exact artifact binding: final/legacy tree mismatch, mutated-report re-sign และ stale signed base ถูก reject
- direct และ queue merge: first parent ต้องตรง signed base, non-first parent ต้องมี signed artifact และ ref update เป็น signed-base CAS
- concurrent direct/queue main advance: CAS แพ้โดยไม่ overwrite concurrent tip และไม่มี subsequent authorization/completion advancement
- completion auth failure: หยุดที่ structured escalation ไม่มี audited/completed transition หลัง failure

## Tests Run

- crypto/blob/report/runner focused: `33` pass, `0` fail
- Task 37 hardening cases: `10` pass, `0` fail
  - core cases `7/7`
  - composition cases `3/3`; nested sandbox รอบแรกถูกปฏิเสธด้วย `listen EPERM: operation not permitted 127.0.0.1`, rerun นอก nested sandbox ผ่านทั้งหมด
- exact Task 39 direct CAS/topology: `2` pass, `0` fail
- focused merge suites: `29` pass, `0` fail
- Human Plane/deploy/OOB: `55` pass, `0` fail, `1` explicit external-only loopback smoke skip
- auditor CLI: `9` pass, `0` fail
- full core: `527` total, `518` pass, `0` fail, `9` explicit external-only skips
- `pnpm --filter core typecheck`: pass
- `pnpm --filter console-backend typecheck`: pass

ไม่ได้รัน P0-02 external real-macOS suite เพราะ cooldown ยังไม่สิ้นสุด

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-40-p0-04-acceptance-review.md` — handoff นี้เท่านั้น

## Important Decisions

- P0-04 ได้ independent acceptance approval โดยไม่มี actionable correctness/security finding
- ใช้ `APPROVE_WITH_EXTERNAL_BLOCKER` เพื่อแยก P0-04 approval ออกจาก P0-02 cooldown ที่ยังปิด Phase 0 overall gate
- ไม่ mark Task 4, ไม่เริ่ม P0-05 และไม่แก้ shared worktree อื่น

## Known Issues

- P0-02 external real-macOS verification ยัง blocked จนถึง 2026-08-03 เวลา 20:18 Asia/Bangkok
- external-only tests ที่ถูก skip ใน full core ยังคงต้องอาศัย execution environment ตามที่ test ระบุ; รอบนี้ไม่ใช้ skip เป็นหลักฐาน PASS ของ P0-02

## Next Recommended Agent

ผู้ประสาน Phase 0 gate หลัง P0-02 cooldown สิ้นสุด โดยต้องปฏิบัติตาม retry/admission rules ของ external suite

## Next Steps

1. คง Task 4 และ P0-05 ไว้ตาม dependency gate จน parent ตัดสินการบันทึก acceptance state
2. หลัง 2026-08-03 เวลา 20:18 Asia/Bangkok ให้ดำเนิน P0-02 external verification ตาม recorded protocol โดยไม่ bypass
3. เมื่อ P0-02 มีหลักฐานจริงครบ จึง reconcile Phase 0 closure และพิจารณาเริ่ม P0-05
