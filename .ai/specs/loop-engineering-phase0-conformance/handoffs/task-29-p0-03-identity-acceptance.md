# Handoff: Task 29 — P0-03 artifact identity acceptance re-review

- วันที่: 2026-07-28
- ผู้ตรวจ: Codex fresh-context correctness/security reviewer
- ขอบเขต: P0-03 executor, authoritative artifact identity, snapshot/rollback,
  admission และ multi-intent recovery หลัง Task 28
- สถานะ: ตรวจและทำ safe temp probes แบบ read-only ต่อ production/spec/test/task
  โดยเพิ่มเฉพาะ handoff นี้

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 1
- Medium: 0
- Low: 0

Task 28 ทำให้ tracked, untracked, ignored, denied, quoted, executable-mode และ safe
symlink artifacts นอก core metadata อยู่ใน bounded authoritative identity เดียวกันแล้ว
แต่ Task 27 High ยังปิดไม่ครบ เพราะ pre-existing safe symlink ใต้ role-allowed root
สามารถ alias เข้า denied root, `.ai/runs` หรือ `.git` ได้ การ mutate สอง root หลัง
ถูกตัดออกจากทั้ง snapshot และ `resultHash` จึงเกิด accepted mutation ที่ hash ไม่เปลี่ยน
และ recovery รายงาน false coherence ได้

P0-02 external real-macOS verification ยังถูกบล็อกถึง 2026-08-02 11:46
Asia/Bangkok ตามข้อจำกัดเดิม จึงไม่ได้ retry, circumvent หรืออ้าง PASS ประเด็นภายนอกนี้
ไม่ใช่สาเหตุของ `REQUEST_CHANGES` รอบนี้

## Finding

### [High] ผูก path authorization กับ lexical path เท่านั้น ทำให้ safe symlink ข้าม role root และเจาะ excluded identity roots ได้

- ตำแหน่งหลัก:
  - `core/src/executor/path-policy.ts:46-58`
  - `core/src/executor/executor.ts:965-986`
  - `core/src/executor/executor.ts:1281-1294`
  - `core/src/executor/executor.ts:1476-1481`
- ตำแหน่งที่ทำให้ mutation หายจาก identity:
  - `core/src/executor/executor.ts:205-208`
  - `core/src/executor/executor.ts:491-526`
  - `core/src/gates/frozen-tree.ts:257-258`
- ตำแหน่งสนับสนุน:
  - patch ใช้ authorization แบบเดียวกันที่
    `core/src/executor/executor.ts:1028-1047`
  - authoritative snapshot ยอมรับ in-worktree symlink target ที่
    `core/src/gates/frozen-tree.ts:761-773` และ
    `core/src/executor/executor.ts:671-691`
  - rollback สร้าง symlink กลับที่
    `core/src/executor/executor.ts:843-854`
  - Task 28 tests ครอบคลุม same-root safe symlink และ external unsafe symlink แต่ไม่มี
    denied/excluded-root alias ที่
    `core/src/executor/executor.test.ts:1896-2002` และ
    `core/src/executor/executor.test.ts:2110-2197`
- มิติ: authorization, integrity, durability, crash recovery
- Security category:
  - OWASP A01 Broken Access Control
  - OWASP A08 Software and Data Integrity Failures

`checkWrite()` อนุญาตจาก normalized lexical prefix เช่น `src/` ส่วน
`resolveContained()` ตรวจเพียงว่า nearest existing ancestor resolve แล้วยังอยู่ที่ใดก็ได้
ภายใน worktree ไม่ได้บังคับให้อยู่ใต้ resolved role write root และไม่ได้ห้าม
`.git`/`.ai/runs` หลัง symlink resolution จากนั้น `writeFileSync()` ตาม symlink
ตามปกติ

Safe temp probes ยืนยันสามเส้นทาง:

1. สร้าง `src/docs-link -> ../docs`
2. default policy ปฏิเสธ `docs/denied.txt` ด้วย `path_outside_allowlist`
3. `WRITE_FILE src/docs-link/denied.txt` กลับได้ `status: applied` และเขียน bytes
   ลง denied `docs/denied.txt`
4. สร้าง `src/run-link -> ../.ai/runs` แล้วทำ `WRITE_FILE` สองครั้งให้
   `.ai/runs/forged.json` เปลี่ยนจาก `one` เป็น `two`
5. ทั้งสอง action ได้ `status: applied` และ `resultHash` เดียวกัน
   `0dab7197de437cb1fb4109a6596a6baa87a145e80c66605394a7c74b9718734c`
6. สร้าง `src/git-link -> ../.git` แล้วเขียน harmless `.git/action-marker`;
   action ได้ `status: applied` และ hash เดิมอีกครั้ง
7. `recoverWorktree()` หลัง mutation คืน
   `{ action: "none", detail: "log and worktree consistent", coherent: true, source: "consistent" }`

Probe ใช้เฉพาะ temporary Git repositories และล้างทิ้งหลังจบ ไม่แตะ `.git` หรือ
`.ai/runs` ของ repository จริง

ผลกระทบคือ pre-existing repository symlink สามารถขยายสิทธิ์ของ implementer จาก
`src/**` ไปยัง denied project files และ core-owned metadata/log roots ได้ สำหรับ
`.git`/`.ai/runs` accepted effect ไม่อยู่ใน snapshot หรือ result identity จึงไม่สามารถ
รับรอง exact add/delete/mutate restore, duplicate consistency หรือ crash recovery
coherence ได้ ผู้โจมตีที่ควบคุม action path และพบ symlink ดังกล่าวสามารถ overwrite
core metadata หรือ run artifacts โดย event ยังคงดู coherent

แนวทางแก้ขั้นต่ำ:

1. บังคับ mutation path ด้วย resolved role-root authorization ไม่ใช่เพียง lexical
   prefix และห้าม resolved target/ancestor เข้า `.git` หรือ `.ai/runs` ทุกกรณี
2. ใช้ descriptor-relative/no-follow mutation หรือ reject symlink traversal ทั้ง
   ancestor และ final component เพื่อไม่ให้เกิด check/use swap; safe symlink ยังเป็น
   artifact ที่ capture/restore ได้ แต่ต้องไม่มอบ write authority เพิ่ม
3. ใช้กฎเดียวกันกับ `WRITE_FILE`, `APPLY_PATCH` และ durable `RUN_COMMAND`
   promotion boundary
4. เพิ่ม public regressions สำหรับ safe aliases จาก allowed root ไป `docs/`,
   `.git` และ `.ai/runs`; ต้อง reject ก่อน snapshot/`ACTION_INTENT`/effect,
   bytes ปลายทางไม่เปลี่ยน, ไม่มี unchanged accepted `resultHash` และ recovery
   ไม่รายงาน false coherence

## Closure review

- Task 21: ปิดแล้ว — fixed Git executable/config isolation, NUL path parsing,
  all-path patch policy, causal intent metadata และ descriptor read ไม่พบ regression
- Task 23: ปิดแล้ว — buried/multiple dangling generations ถูกจัดการตาม causal order
- Task 25: admission reconciliation อยู่ก่อน duplicate, preflight, snapshot และ
  `ACTION_INTENT` สำหรับ mutator ทุกชนิดแล้ว แต่ end-to-end guarantee ยังถูก Finding
  ทำลายเมื่อ mutation เข้า excluded root
- Task 26: ปิด causal/multi-intent logic ภายใน identity domain ที่แสดงแทนได้ —
  exact `intentSeq`, preceding accepted boundary, ordered replay, per-generation hash,
  final hash และ delayed terminal append ถูกต้อง ไม่พบ causal finding ใหม่
- Task 27: ยังไม่ปิด — Task 28 เพิ่ม full authoritative identity ได้ครบสำหรับทุก path
  ยกเว้น core metadata ตาม design แต่ exclusion จะปลอดภัยก็ต่อเมื่อ action path
  เข้า root เหล่านั้นไม่ได้ ซึ่งปัจจุบัน bypass ผ่าน safe symlink ได้
- clean fast path, duplicate handling และ `READ_FILE` แบบไม่มี snapshot/intent
  ไม่พบ regression อื่น

REQ-3 acceptance:

- REQ-3.1–3.5: ผ่าน source review และ focused tests
- REQ-3.6–3.8: ยังรับไม่ได้ เพราะ accepted `WRITE_FILE` สามารถ mutate excluded
  durable state โดย snapshot/result hash ไม่เห็น ทำให้ restore/replay และ duplicate
  consistency ไม่ครบ
- REQ-3.9–3.11: ผ่าน source review และ focused tests

## Verification

- authority external/root `cmp` — exit `0`
- authority SHA-256:
  `ecb0eebf9465b2b68f579b444086eaa755b47514001d31fa5eaee1d3634aecb3`
- focused Task 28:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'Task 28' src/executor/executor.test.ts`
  — 16 pass, 0 fail
- focused REQ-3:
  `pnpm --filter core exec node --test --test-reporter spec --test-name-pattern 'REQ-3' src/executor/executor.test.ts test/fault-injection.test.ts`
  — 77 pass, 0 fail
- full core: `pnpm --filter core test` — 468 pass, 0 fail,
  9 explicit external-only skips
- `pnpm --filter core typecheck` — PASS
- `pnpm typecheck` — all 6 workspace projects PASS
- `pnpm lint` — `ESLint: No issues found`
- `scripts/check-core-vendor-free.sh` — PASS
- `scripts/spec-trace.sh loop-engineering-phase0-conformance` — PASS,
  144 criteria referenced และ EARS lint ผ่าน
- `.ai/bin/check-evidence.sh --strict < .ai/specs/loop-engineering-phase0-conformance/tasks.md`
  — PASS
- `.ai/bin/check-secrets.sh --all` — PASS
- `git diff --check` — PASS
- safe temp probes: denied-root alias, `.ai/runs` unchanged-hash alias,
  `.git` unchanged-hash alias และ false-coherent restart — reproduce Finding
- external macOS sandbox probe — ไม่รันตาม cooldown ถึง
  2026-08-02 11:46 Asia/Bangkok

## Handoff

- ไฟล์ที่เพิ่มจากการตรวจรอบนี้มีเพียง handoff นี้
- Task 3 ยังคง `[ ]`
- ห้าม mark Task 3 complete, commit/push หรือเริ่ม P0-04
- Builder ต้องแก้ High และส่ง fresh-context acceptance re-review ใหม่
