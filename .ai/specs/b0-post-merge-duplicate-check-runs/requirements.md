# Requirements: B0 Post-Merge Duplicate Check Runs

> Status: approved 2026-08-21

## Overview

ข้อกำหนดนี้เสริม B0 single-operator authority ใน `kiro-system-upgrade` เมื่อ GitHub เก็บ
check run ชื่อเดียวกันหลายรายการบน exact head เดียวจากการ close/reopen PR หรือ rerun workflow.
ระบบต้องเลือก attempt ล่าสุดแบบ deterministic โดยยังคง exact-head binding, GitHub App และ
workflow provenance, merge-time boundary และ fail-closed behavior เดิมครบถ้วน.

ข้อกำหนดนี้ขยาย REQ-12.60, REQ-12.73 และ REQ-12.74 ของ `kiro-system-upgrade` โดยไม่แทนที่
ข้อกำหนดเดิม และไม่เปลี่ยน ruleset, operator identity, approval policy หรือ exact-six B0 scope.

## REQ-1: เลือก post-merge check run แบบ deterministic

**User Story:** ในฐานะผู้ดูแล repo ฉันต้องการให้ post-merge verifier เลือก check run ล่าสุด
ที่มี authority ถูกต้อง เพื่อให้ workflow ซ้ำบน exact head เดียวไม่ทำให้ B0 ถูก block โดยผิดพลาด.

**Acceptance Criteria (EARS):**

- 1.1 WHEN post-merge verifier พบ check run มากกว่าหนึ่งรายการสำหรับ required context เดียวกันบน exact head เดียว THE SYSTEM SHALL จัดลำดับเฉพาะ authority-valid candidates ตาม `completed_at` จากใหม่ไปเก่า
- 1.2 IF authority-valid candidates มากกว่าหนึ่งรายการมี `completed_at` เท่ากัน THEN THE SYSTEM SHALL ปฏิเสธ verification แบบ fail closed
- 1.3 WHEN authority-valid candidate มีเพียงหนึ่งรายการ THE SYSTEM SHALL เลือกรายการนั้น
- 1.4 WHEN check run เสร็จหลัง `merged_at` THE SYSTEM SHALL ตัดรายการนั้นออกจาก candidate set
- 1.5 WHEN ruleset กำหนด required contexts มากกว่าหนึ่ง context THE SYSTEM SHALL resolve แต่ละ context แยกจากกัน
- 1.6 WHEN ทุก required context ถูก resolve สำเร็จ THE SYSTEM SHALL คืน selected check run หนึ่งรายการต่อหนึ่ง context
- 1.7 WHEN selected check runs ถูกคืนเป็น authority evidence THE SYSTEM SHALL เรียงรายการตามลำดับ context ใน ruleset
- 1.8 IF required context ใดไม่มี authority-valid candidate ที่เสร็จไม่เกิน `merged_at` THEN THE SYSTEM SHALL ปฏิเสธ post-merge verification แบบ fail closed
- 1.9 WHEN post-merge verifier รวบรวม check runs สำหรับ required context THE SYSTEM SHALL request candidate history ด้วย `filter=all`
- 1.10 WHEN candidate history มีหลายหน้า THE SYSTEM SHALL อ่านทุกหน้าภายใน bounded pagination limit เดิมของ authenticated API

## REQ-2: รักษา authority และห้ามย้อนเลือกผลผ่านเก่า

**User Story:** ในฐานะเจ้าของ governance policy ฉันต้องการให้ duplicate handling รักษา
trust boundary เดิม เพื่อไม่ให้ประวัติ check run ที่ผ่านแล้วใช้กลบผลล่าสุดที่ล้มเหลว.

**Acceptance Criteria (EARS):**

- 2.1 WHEN post-merge verifier ประเมิน candidate THE SYSTEM SHALL require check name ให้ตรง required context แบบ exact match
- 2.2 WHEN post-merge verifier ประเมิน candidate THE SYSTEM SHALL require `head_sha` ให้ตรง reviewed exact head
- 2.3 WHEN post-merge verifier ประเมิน candidate THE SYSTEM SHALL require status เป็น `completed`
- 2.4 WHEN post-merge verifier ประเมิน candidate THE SYSTEM SHALL require GitHub App integration ID ให้ตรง ruleset binding
- 2.5 WHEN post-merge verifier ประเมิน candidate THE SYSTEM SHALL require GitHub App slug เป็น `github-actions`
- 2.6 WHEN post-merge verifier ประเมิน candidate THE SYSTEM SHALL require `details_url` ให้ชี้ไปยัง Actions job ใน repository เดียวกัน
- 2.7 WHEN post-merge verifier ประเมิน linked workflow run THE SYSTEM SHALL require workflow path เป็น `.github/workflows/ci.yml`
- 2.8 WHEN post-merge verifier ประเมิน linked workflow run THE SYSTEM SHALL require workflow name เป็น `CI`
- 2.9 WHEN post-merge verifier ประเมิน linked workflow run THE SYSTEM SHALL require event เป็น `pull_request`
- 2.10 WHEN post-merge verifier ประเมิน linked workflow run THE SYSTEM SHALL require workflow `head_sha` ให้ตรง reviewed exact head
- 2.11 WHEN post-merge verifier ประเมิน linked workflow run THE SYSTEM SHALL require `run_attempt` เป็น positive integer
- 2.12 IF selected authority-valid candidate ล่าสุดมี conclusion ไม่ใช่ `success` THEN THE SYSTEM SHALL ปฏิเสธ verification โดยไม่ย้อนเลือก candidate เก่าที่ผ่าน
- 2.13 IF GitHub API response ไม่ครบ THEN THE SYSTEM SHALL ปฏิเสธ verification แบบ fail closed
- 2.14 IF verifier พิสูจน์ candidate ล่าสุดไม่ได้ THEN THE SYSTEM SHALL ปฏิเสธ verification แบบ fail closed
- 2.15 IF required GitHub API lookup ล้มเหลว THEN THE SYSTEM SHALL ปฏิเสธ verification แบบ fail closed
- 2.16 WHEN post-merge verifier ประเมิน linked workflow run THE SYSTEM SHALL bind job ID จาก `details_url` กับ unique run attempt ผ่าน attempt-specific jobs endpoint ตั้งแต่ attempt 1 ถึง current `run_attempt`
- 2.17 IF job ID จาก `details_url` ไม่พบใน run attempt ใด THEN THE SYSTEM SHALL ปฏิเสธ verification แบบ fail closed
- 2.18 IF job ID จาก `details_url` พบใน run attempt มากกว่าหนึ่งรายการ THEN THE SYSTEM SHALL ปฏิเสธ verification แบบ fail closed
- 2.19 IF bounded pagination ถึง limit ก่อนพิสูจน์ completeness THEN THE SYSTEM SHALL ปฏิเสธ verification แบบ fail closed
- 2.20 WHEN attempt-specific job history มีหลายหน้า THE SYSTEM SHALL อ่านทุกหน้าภายใน bounded pagination limit เดิมของ authenticated API

## REQ-3: ผูก pr-head source job กับ current rerun attempt

**User Story:** ในฐานะผู้ดูแล CI ฉันต้องการให้ pr-head verifier แยก job ของแต่ละ rerun attempt
เพื่อไม่ให้ job เก่าชื่อเดียวกันทำให้ current attempt ถูกมองว่า ambiguous.

**Acceptance Criteria (EARS):**

- 3.1 WHEN pr-head verifier รวบรวม current source jobs THE SYSTEM SHALL อ่าน jobs จาก `/actions/runs/{run_id}/attempts/{run_attempt}/jobs`
- 3.2 WHEN pr-head verifier สร้าง current source set THE SYSTEM SHALL ไม่รวม jobs จาก generic `filter=all` response
- 3.3 WHEN current source set มี source job exact-name หนึ่งรายการ THE SYSTEM SHALL ใช้ job นั้นเป็น current source check
- 3.4 IF current source set ไม่มี source job exact-name THEN THE SYSTEM SHALL ปฏิเสธ pr-head verification แบบ fail closed
- 3.5 IF current source set มี source job exact-name มากกว่าหนึ่งรายการ THEN THE SYSTEM SHALL ปฏิเสธ pr-head verification แบบ ambiguous
- 3.6 WHEN current source check ถูกเลือก THE SYSTEM SHALL require `head_sha` ให้ตรง reviewed exact head
- 3.7 WHEN current source check ถูกเลือก THE SYSTEM SHALL require status เป็น `queued` หรือ `in_progress`
- 3.8 WHEN current source check ถูกเลือก THE SYSTEM SHALL require GitHub App integration ID ให้ตรง ruleset binding
- 3.9 WHEN current source check ถูกเลือก THE SYSTEM SHALL require GitHub App slug เป็น `github-actions`
- 3.10 WHEN current attempt job list มีหลายหน้า THE SYSTEM SHALL อ่านทุกหน้าภายใน bounded pagination limit เดิมของ authenticated API

## REQ-4: Evidence และ regression proof

**User Story:** ในฐานะผู้ตรวจ governance evidence ฉันต้องการให้ผลลัพธ์ระบุ attempt ที่ถูกเลือก
และมี regression tests ครบ เพื่อพิสูจน์ว่าการรองรับ duplicate ไม่ลดความเข้มงวดของ B0.

**Acceptance Criteria (EARS):**

- 4.1 WHEN post-merge verification สำเร็จ THE SYSTEM SHALL บันทึก selected check run ID ของแต่ละ required context ใน authority evidence
- 4.2 WHEN post-merge verification สำเร็จ THE SYSTEM SHALL บันทึก linked workflow run ID ของแต่ละ required context ใน authority evidence
- 4.3 WHEN post-merge verification สำเร็จ THE SYSTEM SHALL บันทึก selected run attempt ของแต่ละ required context ใน authority evidence
- 4.4 WHEN post-merge verification สำเร็จ THE SYSTEM SHALL บันทึก selected `completed_at` ของแต่ละ required context ใน authority evidence
- 4.5 WHEN exact head มี authority-valid check run เพียงหนึ่งรายการ THE SYSTEM SHALL ให้ pass/block decision ตรง single-run contract เดิม
- 4.6 THE SYSTEM SHALL มี deterministic fixture จาก response shape ของ PR #146 ที่พิสูจน์ว่า close/reopen มี check runs ซ้ำแล้ว verifier เลือกรายการล่าสุดก่อน merge
- 4.7 THE SYSTEM SHALL มี regression test ที่พิสูจน์ว่าผลล้มเหลวล่าสุด block แม้มีผลผ่านเก่า
- 4.8 THE SYSTEM SHALL มี regression test ที่พิสูจน์ว่า check run ซึ่งเสร็จหลัง merge ไม่ถูกเลือก
- 4.9 THE SYSTEM SHALL มี regression test ที่พิสูจน์ว่า candidate จาก GitHub App ผิดไม่ถูกเลือก
- 4.10 THE SYSTEM SHALL มี regression test ที่พิสูจน์ว่า candidate จาก workflow source ผิดไม่ถูกเลือก
- 4.11 THE SYSTEM SHALL มี regression test ที่พิสูจน์ว่า single-run input ยังผ่าน contract เดิม
- 4.12 THE SYSTEM SHALL มี synthetic regression fixture ที่พิสูจน์ว่า pr-head rerun เลือก source job ของ current run attempt
- 4.13 THE SYSTEM SHALL รัน regression suite โดยไม่เรียก GitHub API ที่เขียนข้อมูล

## Edge Cases & Open Questions

| กรณี | ผลที่อนุมัติ |
|---|---|
| close/reopen สร้างหลาย workflow runs บน SHA เดียว | เลือก authority-valid candidate ล่าสุดที่เสร็จไม่เกิน merge |
| candidate ล่าสุดล้มเหลว แต่ candidate เก่าผ่าน | block และห้าม fallback ไปผลผ่านเก่า |
| candidate เสร็จหลัง merge | ไม่นับเป็น authority ของการ merge |
| candidates มีเวลาเสร็จเท่ากัน | fail closed เพราะ check run ID ไม่ใช่ temporal authority |
| rerun workflow มี source jobs จากหลาย attempts | ใช้ attempt-specific jobs endpoint สำหรับ current attempt |
| API response ไม่ครบหรือ newest candidate พิสูจน์ไม่ได้ | fail closed |
| review-record gate ของ PR ใหญ่ | อยู่นอก scope และติดตามแยก |

ไม่มีคำถามเปิดที่ block design phase. ห้ามเพิ่ม dependency ใหม่ และห้ามเปลี่ยน ruleset,
single-operator policy, exact-head boundary หรือ B0 authority model ใน spec นี้.

### Findings log (spec-analyze, anchor: 6e43a7f — requirements.md uncommitted at analysis time)

- **B0A-1 — Gap, REQ-1.1 และ REQ-2.13–2.15:** เลือก `filter=all` กับ bounded pagination เดิม; page limit หรือ response ไม่ครบต้อง fail closed
- **B0A-2 — Unstated assumption, REQ-1.2:** ยกเลิก check run ID tie-break เพราะ API รับรอง uniqueness แต่ไม่รับรอง temporal ordering; เวลาเสร็จเท่ากันให้ fail closed
- **B0A-3 — Ambiguity, REQ-3.1–3.5:** ใช้ attempt-specific jobs endpoint โดยตรง; ไม่พึ่ง generic `filter=all` หรือ undocumented job field
- **B0A-4 — Gap, REQ-2.11 และ REQ-4.3:** bind job ID จาก `details_url` กับ unique run attempt ตั้งแต่ 1 ถึง current `run_attempt`; zero, duplicate หรือ incomplete match ต้อง fail closed
- **B0A-5 — Unstated assumption, REQ-4.6–4.12:** ใช้ deterministic fixture จาก PR #146 และ synthetic negative cases; ห้าม mutate GitHub เพื่อทดสอบ
