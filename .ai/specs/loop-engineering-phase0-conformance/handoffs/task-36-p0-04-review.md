# Handoff: Task 36 — P0-04 fresh-context correctness/security review

- วันที่: 2026-08-02
- ผู้ตรวจ: Codex fresh-context correctness/security reviewer
- ขอบเขต: Task 35 implementation, REQ-4.1–REQ-4.13, signed evidence lifecycle,
  state/approval/merge/audit/completion trust boundaries และ recovery
- สถานะการแก้: read-only ต่อ production/tests/requirements/design/tasks และเพิ่มเฉพาะ
  handoff นี้

## Verdict

`REQUEST_CHANGES`

- Critical: 1
- High: 3
- Medium: 0
- Low: 0

P0-04 ยังปิดไม่ได้ แม้ cryptographic primitives และ focused suite เดิมผ่าน เพราะ
signed report ยัง replay ข้าม artifact mutation ได้, deploy approval ไม่เข้า evidence
verifier, OOB CLI อ่านคนละ evidence store กับ run และ OOB auditor ข้าม COMPLETED task
ที่ไม่มี T1 แบบเงียบ ๆ

P0-02 external real-macOS verification ยังถูกบล็อกตาม recorded cooldown ถึง
2026-08-03 เวลา 20:18 Asia/Bangkok รอบนี้ไม่ได้ retry, circumvent หรืออ้าง PASS
ข้อจำกัดภายนอกนี้ไม่ใช่เหตุผลของ verdict; local Critical/High findings เป็น blocker
อยู่แล้ว

## Findings

### Critical 1 — signed T1 replay อนุญาตให้ merge artifact ที่ถูกเปลี่ยนภายหลังจน COMPLETED

- Location:
  - `core/src/gates/report-integrity.ts:48-57,150-205`
  - `core/src/merge/auto-merge.ts:193-203,359-430`
  - `core/src/merge/queue.ts:127-149`
  - `console/backend/src/loop-run.ts:963-988,1053-1068`
- Dimension: artifact authenticity / merge authorization / approval TOCTOU /
  REQ-4.6, REQ-4.9–REQ-4.12
- Failure scenario:
  1. Core สร้าง T1 report ที่ผ่านและลงลายเซ็นบน commit/tree A
  2. หลัง report ถูกสร้างหรือระหว่างรอ human approval ผู้เขียนรายอื่นขยับ
     `taskBranch` ไป commit/tree B ซึ่งไม่ผ่าน gate
  3. `verifyGateReport` ตรวจเพียง `runId`, `taskId`, fingerprint, evidence hashes และ
     signature ของ report A; `GateReportIdentity` ไม่มี expected commit/tree/artifact
  4. direct merge และ queue merge เรียก verifier แล้ว merge ชื่อ branch ที่ mutable
     โดยไม่เปรียบเทียบ tip/tree ปัจจุบันกับ `commitHash`/`worktreeHash` ใน report และ
     ไม่ merge immutable commit OID ที่ถูก authorize
  5. unsampled path ตรวจ report A ซ้ำแล้วเปลี่ยนสถานะเป็น `COMPLETED`; sampled path
     ตรวจภายหลัง merge และ `reproduces` เปรียบเทียบเฉพาะ ordered check refs ไม่ผูก
     report กับ merged commit/tree
- Evidence: safe temporary-repository probe ใช้ `GateRunner` และ `runAutoMerge` จริง:
  report A เป็น green/signed, จากนั้น commit B เปลี่ยน `src/impl.txt` เป็น
  `wrong-after-signed-report`, แล้วรัน `auditSampleRate: 0`; ผลคือ
  `finalState="COMPLETED"`, main มี bytes ของ B และ `ESCALATED=0`
- Impact: agent หรือ process ที่เขียน branch ได้สามารถใช้ green signature เก่าเป็น
  merge authorization ให้ arbitrary untested bytes และได้ durable `COMPLETED` ทำลาย
  trust boundary หลักของ P0-04; audit sampling ไม่ใช่ prevention และ unsampled task
  ไม่มีโอกาสตรวจ drift
- Existing-test gap: tests ครอบ unsigned/forged/tampered blob แต่ไม่ครอบ valid signed
  T1 ตามด้วย branch mutation ก่อน approval/merge; บาง audit tests ยังจงใจป้อน signed
  stale/fabricated report แล้วคาดให้ตรวจพบหลัง merge เท่านั้น
- Required fix:
  - เพิ่ม expected artifact identity ใน merge authorization และ verifier ไม่ใช่เพียง
    `(runId, taskId)`; สำหรับ report ที่สร้างบน dirty worktree ต้องยืนยันว่า final
    immutable commit มี tree เท่ากับ signed `worktreeHash` และ parent/base สอดคล้องกับ
    signed `commitHash` หรือสร้าง core-owned signed promotion envelope ที่บันทึก final
    commit OID โดยตรง
  - หลัง gate ให้ freeze/promote artifact เป็น immutable commit OID แล้วส่ง OID นั้น
    ผ่าน approval/queue; ห้าม merge ด้วย mutable branch name เพียงอย่างเดียว
  - ตรวจ identity ซ้ำภายใต้ merge-queue lease ทันทีก่อน `git merge` และ merge exact
    OID ที่ตรวจแล้ว; mismatch ต้อง append structured `ESCALATED` และห้าม state advance
  - ให้ approval package ผูก diff, gate report, worktree hash และ immutable target OID
    เข้าด้วยกัน และ revalidate ชุดเดียวกันตอน human decision
  - เพิ่ม regressions ทั้ง direct auto-merge, human approval wait และ queue:
    `signed A -> mutate branch to B -> approve/merge` ต้องไม่ merge B และต้อง
    `ESCALATED`; เพิ่ม valid control ที่ report ผ่าน commit promotion แล้วยัง merge ได้

### High 1 — deploy approval ข้าม evidence verifier และเริ่ม deploy callback ได้ด้วย package ที่ tamper

- Location:
  - `core/src/human/api.ts:142-162,196-225`
  - `console/backend/src/loop-run.ts:793-815,1092-1102,1130-1140`
  - `core/src/deploy/stage.ts:66-74,138-146`
- Dimension: approval/deploy trust boundary / REQ-4.9–REQ-4.12
- Failure scenario: task approval route เรียก `verifyApprovalEvidence` และ fail closed
  แต่ `/deploy/decision` ตรวจเฉพาะ attestations แล้ว append `DEPLOY_DECISION` และเรียก
  `onDeployDecision`; ไม่มีการ dereference report/diff หรือ verify signature ก่อน
  `runDeployStage` เริ่ม CANARY นอกจากนี้ deploy package ใช้ raw Git OID เป็น
  `diffRef` จึงไม่ใช่ evidence ref ที่ shared verifier ปัจจุบันรับได้
- Evidence: pure handler probe ส่ง deploy approval พร้อม verifier ที่จงใจ throw
  `tampered evidence`; ผลคือ HTTP `200`, verifier ถูกเรียก `0` ครั้ง และ deploy
  callback ถูกเรียก `1` ครั้ง
- Impact: tampered/missing deploy package evidence ไม่หยุด approval หรือ deploy state
  advancement ขัดข้อกำหนดทุก approval boundary แม้ Phase 0 stage ปัจจุบันเป็น
  network-none simulation
- Required fix:
  - ใช้ shared approval evidence verifier ใน `/deploy/decision` ก่อนบันทึก decision และ
    ก่อน callback; authentication failure ต้อง structured `ESCALATED` ด้วย boundary
    เช่น `deploy_approval` และต้องไม่เรียก callback
  - สร้าง deploy package ด้วย content-addressed diff/report refs ที่ verify ได้ และผูก
    report/worktree/merged target identity ตาม Critical 1
  - ให้ composition หรือ `runDeployStage` reverify authenticated deploy authorization
    ทันทีก่อน CANARY เพื่อไม่ให้เกิด gap ระหว่าง HTTP decision กับ stage start
  - เพิ่ม approve/reject/missing verifier/forged/missing/tampered deploy regressions และ
    valid control

### High 2 — production OOB CLI ชี้ evidence store คนละที่กับ run ทำให้ valid audit ถูกปฏิเสธแต่ exit 0

- Location:
  - `console/backend/src/loop-run.ts:486-493`
  - `console/backend/bin/platform.ts:148-175`
  - `console/backend/src/auditor-cli.ts:47-58`
  - `core/src/audit/oob.ts:143-191`
- Dimension: OOB audit availability/integrity / run-state composition / REQ-4.9–REQ-4.12
- Failure scenario: live run เก็บ blobs ที่ `<runDir>/evidence` ข้าง `events.db` แต่
  `platform auditor run --db <runDir>/events.db` hard-code `evidenceDir` เป็น
  `~/.platform/oob-evidence`; auditor จึงเปิด frozen key ถูก run แต่ dereference report
  refs จาก store ผิด, append `evidence_blob_missing` แล้วคืน verdict ว่าง ซึ่ง CLI
  แปลเป็น success ว่าไม่มี eligible targets
- Evidence: composition-equivalent probe สร้าง genuine signed T1 ใน
  `<runDir>/evidence` แล้วเรียก auditor ด้วย separate OOB dir; event log ได้
  `ESCALATED{why:"evidence_auth_unavailable",boundary:"oob_audit",
  code:"evidence_blob_missing"}` แต่ CLI คืน code `0` และข้อความ
  `oob auditor: no eligible targets this cycle`
- Impact: real OOB command ใช้ตรวจหลักฐานของ persistent run ไม่ได้ และ automation
  เห็น false success แทน authentication failure
- Required fix:
  - derive evidence directory จาก resolved DB run directory เป็น
    `join(dirname(dbPath), "evidence")` หลัง apply `--db` override; อย่าใช้ global
    home store แยกจาก run
  - validate ว่า DB, run metadata, private key และ evidence root เป็น run-state ชุดเดียว
    ก่อน audit
  - propagate authentication/escalation outcome ให้ CLI exit non-zero แทนข้อความ
    no-target และเพิ่ม end-to-end binary regression ด้วย layout จริงของ
    `runSupervisedLoop`

### High 3 — COMPLETED task ที่ไม่มี T1 report ถูก OOB auditor ข้ามเงียบ ๆ

- Location:
  - `core/src/audit/oob.ts:91-101,143-160`
  - `console/backend/src/auditor-cli.ts:56-58`
- Dimension: fail-closed audit/completion integrity / REQ-4.9–REQ-4.12
- Failure scenario: event log มี `AUDIT_RESULT` พร้อม merge commit และ
  `TASK_STATE{COMPLETED}` แต่ไม่มี T1 `GATE_RESULT`; target ถูกเลือกแล้ว
  `originalByTask.get(...)` คืน `undefined` จากนั้นบรรทัด 159 `continue` โดยไม่สร้าง
  structured failure
- Evidence: safe probe สร้าง exact event sequence ข้างต้นที่ rate 100; ผลคือ CLI
  exit `0`, ข้อความ `no eligible targets`, `ESCALATED=0` และ `OOB_AUDIT_RESULT=0`
- Impact: event loss/corruption หรือ invalid completion สามารถหายจาก OOB audit โดยไม่มี
  signal ทำให้ audit trail ที่ขาดหลักฐานดูเหมือนไม่มีงานต้องตรวจ
- Required fix:
  - เมื่อ eligible COMPLETED target ไม่มี T1 ให้ append structured
    `ESCALATED{why:"evidence_auth_unavailable", boundary:"oob_audit",
    code:"gate_report_missing", ...}` และคืน typed failure ให้ CLI exit non-zero
  - ห้าม mark target ว่า reproduced/audited และต้องคง detection-only contract โดยไม่
    แก้ task state ย้อนหลัง
  - เพิ่ม regression สำหรับ missing T1, missing merge info, cross-run task IDs และ
    valid signed T1 control เพื่อแยก corrupted target จาก genuinely ineligible target

## Verified controls

- `core/src/evidence/auth.ts:80-83,186-321` ใช้ Node built-in Ed25519, fingerprint
  จาก DER SPKI, exclusive-create key/metadata, mode `0600`/`0444`, ตรวจ key pair และ
  fingerprint เดิมตอน recovery และ reject symlink/missing/mismatch แบบ fail closed
- `core/src/evidence/auth.ts:117-159` ใช้ versioned `canonical-json-v1`, sort object
  keys recursively, retain array order และ reject non-finite/unsupported values
- `core/src/evidence/store.ts:80-141` freeze caller bytes, publish ด้วย `wx`, verify
  exact existing bytes/hash และ no-follow regular-file read ก่อน trust
- `core/src/gates/report-integrity.ts:132-205` dereference check refs, compare signed
  content-hash list, frozen fingerprint และ Ed25519 signature; forged, missing,
  tampered และ wrong-fingerprint focused tests ผ่าน
- normal task approval path ที่ `core/src/human/api.ts:142-162` re-verifies refs และ
  composition ที่ `console/backend/src/loop-run.ts:793-815` escalates structured failure
- ไม่พบ dependency หรือ lockfile change ใน `package.json`, workspace package files
  หรือ `pnpm-lock.yaml`; REQ-4.13 ใช้ `node:crypto` เท่านั้น

Controls เหล่านี้พิสูจน์ authenticity ของ report bytes และ referenced blobs แต่ยัง
ไม่พิสูจน์ว่า report เดิม authorize artifact ที่ boundary กำลังจะ merge/deploy จริง
จึงไม่หักล้าง findings ข้างต้น

## Tests and probes run

- focused P0-04/core boundaries:
  `pnpm --filter core exec node --test --test-reporter spec src/evidence/store.test.ts src/evidence/auth.test.ts src/gates/report-integrity.test.ts src/human/api.test.ts src/merge/queue.test.ts src/merge/auto-merge.test.ts src/audit/oob.test.ts`
  — 79 tests, 78 pass, 0 fail, 1 explicit external-only skip
- auditor CLI:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/auditor-cli.test.ts`
  — 7 pass, 0 fail
- `pnpm typecheck` — workspace projects ทั้ง 6 ผ่าน
- safe stale-merge probe — reproduced Critical 1:
  signed green A, commit red B, unsampled auto-merge คืน `COMPLETED`, main เป็น B,
  ไม่มี escalation
- safe deploy-handler probe — reproduced High 1:
  verifier ที่ throw ถูกเรียก 0 ครั้ง, response 200, deploy callback ถูกเรียก 1 ครั้ง
- safe OOB wrong-store probe — reproduced High 2:
  internal `evidence_blob_missing` แต่ CLI exit 0/no eligible
- safe OOB missing-T1 probe — reproduced High 3:
  CLI exit 0/no eligible โดยไม่มี ESCALATED หรือ OOB result

focused suites ที่ผ่านแสดงว่า regression coverage ปัจจุบันไม่ discriminate failure
scenarios ทั้งสี่ จึงต้องเพิ่ม RED tests ก่อนแก้

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-36-p0-04-review.md`
  — review verdict, findings และ verification evidence (new)

ไม่มีการแก้ production code, tests, requirements, design หรือ tasks; ไม่มี commit,
push, revert shared dirty work และไม่ได้เริ่ม P0-05

## Important decisions and next steps

1. คง Task 4 เป็น unresolved acceptance แม้ `tasks.md` ปัจจุบันทำเครื่องหมาย `[x]`;
   ต้องแก้ Critical 1 และ High 1–3 แล้ว fresh-context re-review ใหม่
2. เริ่มด้วย RED regressions ทั้งสี่ โดยให้ stale-artifact tests ใช้ valid signed report
   จริง ไม่ใช่ unsigned/forged report
3. ออกแบบ immutable merge authorization ให้รองรับ report ที่ gate บน dirty worktree
   อย่างถูกต้อง; ห้ามแก้เพียงเทียบ `report.commitHash === branchTip` เพราะ production
   gate เกิดก่อน composition commit และ signed `worktreeHash` คือ tested tree
4. รวม deploy approval เข้ากับ shared verifier และทำ OOB path เป็น run-state-relative
   พร้อม non-zero failure signal
5. รัน focused/full core, console backend, typecheck และ dependency/static gates แล้ว
   ส่ง independent fresh-context correctness/security re-review
6. ห้ามเริ่ม P0-05, commit/push หรือ retry P0-02 real-macOS ก่อน cooldown ภายใต้
   scope ของ handoff นี้

ไฟล์ `RTK.md` และ `karpathy.md` ที่ root instructions อ้างถึงไม่พบใน repository หรือ
parent locations ที่ตรวจแบบจำกัด ซึ่งสอดคล้องกับ handoffs ก่อนหน้า จึงใช้ shared
authority และ Codex adapter ที่มีอยู่เป็นฐาน review
