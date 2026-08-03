# Handoff: Task 27 — P0-03 final acceptance re-review

วันที่: 2026-07-27  
ผู้ตรวจ: Codex fresh-context reviewer  
ขอบเขต: P0-03 executor และ recovery หลัง Task 26  
สถานะ: ตรวจแบบ read-only; ไม่แก้ source/test/spec checklist

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 1
- Medium: 0
- Low: 0

Task 26 ปิด causal-hardening ที่ร้องขอได้ภายใน artifact identity domain ปัจจุบัน แต่ Task 25 High ยังไม่ปิดครบ เพราะ identity, snapshot และ rollback ไม่ครอบคลุมไฟล์ Git-ignored ที่ role มีสิทธิ์เขียนและอยู่นอก `persistentOutputRoots`

P0-02 external macOS sandbox verification ยังถูกบล็อกถึง 2026-08-02 11:46 Asia/Bangkok ตามข้อจำกัดเดิม จึงไม่ได้ retry, circumvent หรืออ้าง PASS ประเด็นนี้ไม่ใช่สาเหตุของ `REQUEST_CHANGES` รอบนี้

## Finding

### [High] Artifact identity ไม่ผูกไฟล์ ignored ที่ role เขียนได้ ทำให้ admission และ `ACTION_APPLIED.resultHash` รับรอง state ที่ไม่ครบ

- ตำแหน่งหลัก: `core/src/executor/executor.ts:327-339`, `core/src/executor/executor.ts:374-399`
- ตำแหน่งสนับสนุน: `core/src/executor/executor.ts:531-539`, `core/src/executor/executor.ts:873-895`, `core/src/executor/executor.ts:1099-1128`, `core/src/executor/executor.ts:1181-1185`
- policy ที่ทำให้เข้าถึง scenario ได้: `core/src/executor/path-policy.ts:22-26`, `core/src/executor/path-policy.ts:46-58`
- ช่องว่างใน regression test: `core/src/executor/executor.test.ts:1821-1945`
- มิติ: correctness, durability, recovery integrity
- Security category: OWASP A08 Software and Data Integrity Failures

`persistentRoots()` ส่งเฉพาะ `offlineDependencyPolicy.persistentOutputRoots` เข้า `freezeWorkingTree(... includeIgnoredRoots)`. ดังนั้น Git-ignored regular file ใต้ allowlisted roots เช่น `src/ignored.txt` แต่ไม่ได้ประกาศเป็น persistent output จะไม่อยู่ใน artifact identity และ persistent snapshot ขณะที่ `git clean -fd` ก็ไม่ลบ ignored file ดังกล่าว

Scenario ที่ reproduce ได้ด้วย temp harness:

1. เพิ่ม `src/ignored.txt` ลง `.gitignore`
2. ทำ action A ให้ `ACTION_APPLIED`
3. เพิ่ม/แก้ ignored file จากภายนอก แล้วส่ง action B คนละ `actionId` ผ่าน `WRITE_FILE`, `APPLY_PATCH` หรือ `RUN_COMMAND`
4. admission เรียก recovery ตามลำดับที่ถูกต้อง แต่ current hash เท่ากับ hash ที่ log ไว้เพราะไม่เห็น ignored file
5. action B ถูก apply, ignored bytes คงอยู่ และ restart recovery คืน `{ action: "none", coherent: true }`

นอกจากนี้ `WRITE_FILE` และ `APPLY_PATCH` ที่เขียน `src/ignored.txt` โดยตรงถูก apply ได้ แต่ `ACTION_APPLIED.resultHash` เท่ากับ hash ก่อน action ทั้งที่ durable worktree เปลี่ยนแล้ว จึงทำให้ duplicate/recovery อ้าง consistency ที่ไม่จริงได้

ผลกระทบ: mutating admission สามารถ seal external tamper/add/delete ที่ไม่อยู่ใน identity; source/config ignored ที่มีผลต่อ command หรือ gate อาจคงอยู่โดยไม่มี hash หรือ snapshot ผูกกับ accepted history

แนวทางแก้:

1. กำหนด authoritative artifact identity ให้ครอบคลุม durable regular files ทั้งหมดภายใน role-writable artifact roots รวม Git-ignored paths ด้วย bounded descriptor/no-follow audit เดียวกัน หรือ fail closed เมื่อพบ ignored path ที่ไม่อยู่ใน ownership model
2. ให้ snapshot/rollback เก็บและคืน exact ignored-path manifest ใน domain เดียวกัน โดยไม่ใช้ broad destructive clean
3. ให้ admission, post-apply `resultHash`, duplicate check และ recovery ใช้ identity domain เดียวกันทุกจุด
4. เพิ่ม public regressions สำหรับ ignored regular file ใต้ `src/`: external mutate/delete/add ก่อน distinct `WRITE_FILE`/`APPLY_PATCH`/`RUN_COMMAND` และ direct ignored `WRITE_FILE`/`APPLY_PATCH`; ต้องยืนยันว่า tamper ไม่ถูก seal, hash เปลี่ยนหรือ action ถูก reject, ไม่มี new intent ก่อน reconciliation coherent และ recovery รอบสองเป็น no-op

test ปัจจุบันชื่อ “ignored-output mutation, deletion, and addition before every mutator type” แต่ครอบคลุมเฉพาะ `node_modules` ที่ประกาศใน `persistentOutputPolicy` และจับคู่ tamper/nextType เพียงสามคู่ จึงไม่จับ scenario นี้

## Closure review

- Task 21: ปิดแล้ว — fixed Git path, isolated filters/config, NUL path parsing, policy ครบทุก path, causal `intentSeq` และ patch preflight cancellation ไม่พบ regression
- Task 23: ปิดแล้ว — ordered history ไม่ปล่อย buried dangling intent หลุดจาก recovery
- Task 25: ยังไม่ปิด — unconditional admission reconciliation อยู่ก่อน duplicate/preflight/snapshot/INTENT และใช้ operation เดียวกันแล้ว แต่ “complete artifact identity including ignored roots” ยังไม่จริงตาม Finding
- Task 26: ปิดแล้วภายใน captured domain — recovery หา preceding active `ACTION_APPLIED` ด้วย causal `intentSeq`, rewind ก่อน dangling snapshot, replay accepted suffix ตามลำดับ, ตรวจ `resultHash` ราย generation และ final identity ก่อนเขียน recovered terminal
- clean fast path, duplicate idempotency และ `READ_FILE` แบบไม่มี snapshot/INTENT ยังทำงานตามเดิม

REQ-3 acceptance:

- REQ-3.1–3.5: ผ่าน source review และ focused tests
- REQ-3.6–3.8: ยังรับไม่ได้ เนื่องจาก High นี้ทำให้ post-effect hash, restore/replay และ duplicate consistency ไม่ครอบคลุม accepted ignored mutations
- REQ-3.9–3.11: ผ่าน source review และ focused tests

## Verification

- Authority SHA-256: `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts` — 60 pass, 0 fail
- `pnpm --filter core test` — 451 pass, 0 fail, 9 explicit external-only skips
- `pnpm --filter core typecheck` — PASS
- `pnpm lint` — PASS
- `scripts/check-core-vendor-free.sh` — PASS
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` — PASS, 144 criteria referenced และ EARS lint ผ่าน
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md` — PASS
- `.ai/bin/check-secrets.sh --all` — PASS
- `git diff --check` — PASS
- safe temp probes: external ignored addition ก่อน distinct `WRITE_FILE`, `APPLY_PATCH`, actual `RUN_COMMAND`; direct ignored `WRITE_FILE` และ `APPLY_PATCH` — reproduce Finding ทุกกรณี
- external macOS sandbox probe — ไม่รันตาม cooldown ถึง 2026-08-02 11:46 Asia/Bangkok

## Handoff

- ไฟล์ที่เพิ่มจากการตรวจรอบนี้มีเพียง handoff นี้
- ห้าม mark Task 3, commit/push หรือเริ่ม P0-04
- Builder ต้องแก้ High และส่ง fresh-context re-review ใหม่
