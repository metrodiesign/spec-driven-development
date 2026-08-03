# Handoff: Task 38 — P0-04 Git merge consistency final review

- วันที่: 2026-08-02
- ผู้ตรวจ: Codex fresh-context reviewer
- ขอบเขต: Git merge consistency ของ Task 37 เท่านั้น โดยตรวจ `runApprovedMerge`, `bindGateReportToMerge`, direct merge, merge-queue CAS และ call completeness ของ deploy/OOB
- สถานะการแก้: read-only ต่อ production, tests, requirements, design และ tasks; เพิ่มเฉพาะ handoff นี้

## Verdict

`REQUEST_CHANGES`

- Critical: 0
- High: 1
- Medium: 0
- Low: 0

P0-04 ยังปิดไม่ได้ เพราะ direct merge path ไม่รักษา signed base แบบ atomic จนถึงการ
อัปเดต target ref และ merge topology verifier ยอมรับ merge ที่ first parent ไม่ใช่
signed base. Queue path มี CAS ที่ถูกต้อง แต่ direct path ใช้กฎคนละระดับ จึงไม่ผ่าน
merge-consistency boundary ที่ Task 38 ขอให้ตรวจ

## Finding

### High 1 — ทำ direct merge จาก signed base และ advance target ด้วย CAS เดียวกับ queue

- Location:
  - `core/src/merge/auto-merge.ts:374-425`
  - `core/src/merge/artifact-binding.ts:100-108`
  - `core/src/merge/artifact-binding.ts:134-137`
  - coverage gap: `core/src/merge/artifact-binding.test.ts:111-153`
- Dimension: correctness / concurrency / authenticated merge authorization / REQ-4.9–REQ-4.12
- Evidence:
  1. `runApprovedMerge` เรียก `verifyTaskArtifactBinding` ที่บรรทัด 374–381 แล้วไม่มี
     signed-base check หรือ CAS อีกก่อน direct `git checkout main` +
     `git merge <artifactCommitHash>` ที่บรรทัด 415–425
  2. `bindGateReportToMerge` อ่าน parent list แต่ตรวจเพียง
     `parents.includes(artifactCommitHash)`; `verifyMergedArtifactBinding` ทำแบบเดียวกัน
     จึงไม่บังคับ `parents[0] === baseCommitHash`
  3. safe temporary-repository probe ใช้ `runApprovedMerge` จริงและแทรก concurrent
     main commit เมื่อ event `merge_queued` ถูก append ซึ่งเกิดหลัง verification แต่ก่อน
     direct merge. ผลที่สังเกตได้คือ `finalState="COMPLETED"`,
     `structuredEscalations=0`, และ merge first parent เท่ากับ concurrent commit ไม่ใช่
     signed base
  4. direct `bindGateReportToMerge` probe สร้าง merge ที่ first parent เป็น concurrent
     base แต่มี signed artifact เป็น parent อีกตัว; ฟังก์ชันคืน report ที่มี
     `mergedCommitHash` สำเร็จ (`accepted=true`)
  5. test ปัจจุบัน `artifact-binding.test.ts:111-153` ครอบเฉพาะ base ที่ขยับก่อนเข้า
     verifier จึงไม่ discriminate interleaving หลัง verifier. ฝั่ง queue มี regression
     ที่ถูกต้องใน `core/src/merge/queue.test.ts:146-171`
- Impact: concurrent main advancement หลัง approval verification สามารถถูกนำมาเป็น
  first parent ของ merge แล้วได้รับลายเซ็นใหม่, `EVIDENCE_AUTHORIZED`, audit และ
  `COMPLETED` ทั้งที่ signed authorization ผูกกับ base คนละ OID. Approval diff และ
  artifact lineage จึงไม่ตรงกับ merge ที่เกิดจริง และ direct/queue paths ไม่บังคับ
  invariant เดียวกัน
- Fix:
  1. สร้าง direct merge commit จาก exact signed `baseCommitHash` นอก mutable target ref
     แล้ว advance `refs/heads/<mainBranch>` ด้วย compare-and-swap ที่ expected-old เป็น
     signed base เช่นเดียวกับ queue; CAS fail ต้องคง concurrent tip เดิม, append
     structured `ESCALATED`, และห้าม authorize/complete merge
  2. ให้ `bindGateReportToMerge` และ `verifyMergedArtifactBinding` บังคับอย่างน้อย
     `parents[0] === verified.baseCommitHash` พร้อมตรวจ signed artifact parent เดิม;
     ห้ามใช้ `parents.includes(...)` เพียงอย่างเดียว
  3. เพิ่ม real-Git regression สำหรับ direct path ที่ขยับ main หลัง entry verification
     แต่ก่อน ref update และ assert `ESCALATED`, ไม่มี `EVIDENCE_AUTHORIZED`, ไม่มี
     `COMPLETED`, concurrent main tip ไม่ถูก overwrite; คง queue race control ไว้เพื่อ
     พิสูจน์ว่าทั้งสอง path ใช้กฎเดียวกัน

## Queue-path assessment

Queue implementation ผ่าน invariant ที่ตรวจในขอบเขตนี้:

- re-verifies signed task/base ภายใต้ merge-queue lease ที่
  `core/src/merge/queue.ts:128-140`
- reset integration worktree จาก current main และเทียบกับ signed base ที่
  `core/src/merge/queue.ts:152-162`
- advance main ด้วย `git update-ref <ref> <newCommit> <signedBase>` CAS ที่
  `core/src/merge/queue.ts:214-230`
- CAS failure คืน `evidence_invalid` และ append structured `ESCALATED` โดยไม่ overwrite
  concurrent main advancement; regression `queue.test.ts:146-171` ผ่าน

จุดนี้ไม่ชดเชย direct path เพราะ `queue` เป็น optional และ production human approval
caller ที่ `console/backend/src/loop-run.ts:1129-1144` เรียก `runApprovedMerge` โดยไม่ส่ง
queue

## Deploy/OOB call completeness

ไม่พบ separate call-completeness finding:

- task/deploy HTTP approval เรียก shared verifier ก่อน decision/callback ที่
  `core/src/human/api.ts:157-171` และ `core/src/human/api.ts:226-240`
- deploy stage re-verifies ก่อน CANARY ที่ `core/src/deploy/stage.ts:141-166` และ
  composition ส่ง callback จริงที่ `console/backend/src/loop-run.ts:1236-1246`
- OOB derives evidence store จาก effective DB directory ที่
  `core/src/audit/oob.ts:159-170`, verifies the authorized report/merged artifact ที่
  `core/src/audit/oob.ts:194-232`, และ CLI propagates failures เป็น exit 2 ที่
  `console/backend/src/auditor-cli.ts:46-69`

อย่างไรก็ดี deploy/OOB เรียก `verifyMergedArtifactBinding` ตัวเดียวกับ finding ข้างบน
จึงไม่สามารถชดเชย first-parent validation ที่ขาดใน shared validator ได้

## Verification

- focused merge suites:
  `pnpm --filter core exec node --test --test-reporter spec src/merge/artifact-binding.test.ts src/merge/queue.test.ts src/merge/auto-merge.test.ts`
  -> `27` pass, `0` fail
- auto-merge suite แยกเพื่อเก็บ summary ครบ:
  `pnpm --filter core exec node --test --test-reporter spec src/merge/auto-merge.test.ts`
  -> `16` pass, `0` fail
- queue suite แยก:
  `pnpm --filter core exec node --test --test-reporter spec src/merge/queue.test.ts`
  -> `8` pass, `0` fail; expected losing-CAS Git diagnostic ปรากฏและ test ยืนยัน
  structured escalation
- deploy/OOB/Human Plane focused:
  `pnpm --filter core exec node --test --test-reporter spec src/human/api.test.ts src/deploy/stage.test.ts src/audit/oob.test.ts`
  -> `56` total, `55` pass, `0` fail, `1` explicit external-only skip
- auditor CLI:
  `pnpm --filter console-backend exec node --test --test-reporter spec src/auditor-cli.test.ts`
  -> `9` pass, `0` fail
- typecheck:
  `pnpm --filter core typecheck` -> pass
- safe bind probe -> `accepted=true` ทั้งที่ `firstParent=concurrentBase` และ
  `firstParent!=signedBase`
- safe direct interleaving probe -> `finalState="COMPLETED"`, `ESCALATED=0`,
  `firstParent=concurrentBase`, `firstParent!=signedBase`

## Files Changed

- `.ai/specs/loop-engineering-phase0-conformance/handoffs/task-38-p0-04-final-review.md`
  — review verdict, finding และ verification evidence (new)

ไม่มี production/test/spec/tasks edit, commit, push, revert shared work หรือ P0-05 work

## Constraints and next step

- Task 4 ต้องคง `[ ]` จนแก้ High 1 และได้ fresh re-review
- ห้ามเริ่ม P0-05 ก่อน Task 4 ผ่าน review
- P0-02 real-macOS cooldown เดิมยังมีผลถึง 2026-08-03 20:18 Asia/Bangkok; รอบนี้ไม่
  retry, circumvent หรืออ้าง PASS
- root includes `RTK.md` และ `karpathy.md` ไม่พบใน repo หรือ parent ที่ตรวจ; review นี้
  ใช้ `AGENTS.md`, `.ai/shared/*`, Codex adapter และ approved active spec เป็น authority
- next step: เพิ่ม RED direct-interleaving + first-parent tests ก่อนแก้ shared merge
  primitive และให้ direct/queue advance target ด้วย signed-base CAS contract เดียวกัน
