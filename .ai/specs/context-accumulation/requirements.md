# Requirements — context-accumulation: ให้ผลของ READ_FILE กลับถึงโมเดลในรอบถัดไป

Status: approved
Base: develop @ `effc5f6`
หลักฐาน: live run `RUN-1785819815065` (127 events) + run ก่อนหน้า 2 ตัว — วิเคราะห์เต็มใน `.pipeline/context-accumulation/design.md`

## Overview

Autonomous loop ไม่เคยไปถึง REVIEWING ตลอด 3 live run ติดกัน — `WRITE_FILE` = 0 ทุก run
ทั้งที่ implementer อ่าน `run-tests.sh` สำเร็จตั้งแต่รอบ 2 (seq 31) และเห็นเงื่อนไขผ่าน gate
คือ `grep -q correct src/impl.txt` ครบถ้วน

สาเหตุมีสองชั้นที่ต่างกันและต้องแยกให้ชัด:

- **ต้นตอ (D1)** — ผลของ `READ_FILE` ไม่เคยกลับถึงโมเดลเลยไม่ว่าทางไหน:
  `core/src/executor/executor.ts:1618-1663` อ่านไฟล์สำเร็จ เก็บเนื้อเข้า evidence แล้วคืน
  `{status:'applied', outputRef}` แต่ `core/src/orchestrator/loop.ts:344-349` ดูเฉพาะ
  `outcome.status === 'rejected'` แล้วทิ้ง `outputRef` ทั้งก้อน — ชนกับ §6.1 ของ constitution
  (`unified-platform-spec.md:205`) ที่สั่งไว้ตรง ๆ ว่า `core เติมผลรอบถัดไป + นับ context miss`
- **ผลพวง (D2)** — `buildContext` (`core/src/context/builder.ts:208`) ถูกเรียกใหม่ทุกรอบด้วย
  `deps.seedPaths` ชุดเดิมที่ผูกตอน construct (`aal/src/source.ts:39,150-160`) ทำให้
  `CONTEXT_BUILT` ทั้ง 5 รอบ (seq 8, 29, 57, 76, 107) มี manifest เหมือนกันเป๊ะ:
  `stats: {bytes: 6, pieceCount: 1}` และ recall ตันที่ 0.333

ทางแก้ที่เลือก (ตัวเลือก A ใน design): **สะสมเป็นชุด path แล้ว re-read ผ่าน `buildContext`
ทุกรอบ ไม่ cache เนื้อ** — ได้ GOVERN (secret scan) และ MARK ตามเส้นทางเดิมโดยไม่ต้องเขียน
กลไกใหม่ และไม่มีปัญหาความสดของข้อมูลโดยโครงสร้าง เพราะไม่มี cache ให้ค้าง

ขอบเขตของ spec นี้จำกัดอยู่ที่ Ring 1 (`aal/`) และ prompt vocabulary (`adapters/`) เท่านั้น —
**ไม่แตะ `core/`** ซึ่งเป็นเหตุผลหลักที่เลือกทางนี้แทนการเดินสาย `outputRef` กลับผ่าน loop

ข้อเท็จจริงที่ requirements นี้อิง (ยืนยันบน develop @ `effc5f6`):
- `readRequested` (`aal/src/source.ts:148`) สะสม path ข้ามรอบอยู่แล้ว แต่ใช้เป็น allowlist ของ
  `WRITE_FILE` เท่านั้น (`aal/src/source.ts:474-479`) ไม่เคยขยาย bundle
- allowlist ปัจจุบันคือ `bundle paths ∪ readRequested` อยู่แล้ว การสะสมจึงให้ยูเนียนชุดเดิม —
  **ไม่ขยายสิทธิ์เขียนด้วยตัวมันเอง**
- `normalizeWorktreeRelativePath` (`core/src/executor/path-policy.ts:36-44`) export ออกจาก
  package `core` แล้วที่ `core/src/index.ts:44-49` — ไม่ต้องเขียน matcher ใหม่
- `SecretInContextError` พก `.file` มาให้แล้ว (`core/src/context/builder.ts:83-92`) จึงแยก
  seed/accumulated ได้ที่ฝั่ง caller โดยไม่ต้องแก้ signature ของ builder
- conformance harness สร้าง `ContextBundle` เป็น literal ของตัวเอง
  (`aal/src/conformance/harness.ts:68-71`) ไม่มีเส้นทาง import ไปถึง `buildContext` —
  probe P1-P8 และ baseline record ไม่ได้รับผลกระทบ ไม่ต้อง re-record

Supersession ที่ประกาศใน spec นี้ (ตาม lesson `#supersede-old-guarantees-explicitly`,
`.ai/shared/LESSONS.md:48`):
- **Phase-1 REQ-7.3** (`.ai/specs/archive/platform-phase1/requirements.md:156-159` — วลี
  `THE SYSTEM SHALL fail the bundle build ... and the task SHALL be escalated with
  secret_in_context` แบบไม่มีเงื่อนไข) — superseded **บางส่วน เฉพาะ piece ที่ไม่ได้มาจาก
  `seedPaths`** แยกตามที่มาเป็นสามทาง:

  | ที่มาของ piece | พฤติกรรม | เกณฑ์ |
  |---|---|---|
  | `seedPaths` (composition กำหนด — รวมกรณีที่อยู่ในชุด accumulated ด้วย) | **เดิมทุกประการ** ล้ม bundle ทั้งก้อน + escalate `secret_in_context` | 2.2, 2.5 |
  | accumulated (โมเดลเคย `READ_FILE`) | evict path ที่ hit + `accumulated_secret_evicted` แล้ว build ใหม่ **วนจนสำเร็จหรือชนเพดานหน้าต่าง cap** (bounded drain) | 2.3 |
  | EXPAND ล้วน (ไม่อยู่ใน `input.seedPaths` — เข้ามาเพราะ import เท่านั้น) | **ข้าม piece นั้นรายชิ้นใน GOVERN** build เดินต่อ ไม่ throw ไม่จบ run | 2.6 |

  **เหตุผลร่วมของทั้งสองทางที่ถูก supersede:** path ที่ไม่ได้มาจาก composition ถูกเลือกโดย
  **โมเดล** ไม่ใช่ operator ถ้าคง abort ทั้งก้อนไว้ การที่โมเดลอ่านไฟล์ที่ scan ติดครั้งเดียว
  จะฆ่า task ทิ้ง — และ trigger ไม่จำเป็นต้องเป็น secret จริงด้วยซ้ำ: `scanForSecret`
  heuristic `high-entropy` ติด identifier ธรรมดาอย่าง `publicKeyFingerprintSha256`
  (H=4.210 > 3.5) โดยวัดบน production source จริงของรีโปนี้ได้ **3/120 ไฟล์ (~2.5%)
  ที่ไม่มี secret จริงสักตัว** และที่สำคัญกว่าอัตราคือ hit **เกาะกลุ่มตามหัวข้อ ไม่กระจาย
  อิสระ** — `core/src/evidence/auth.ts` กับ `core/src/gates/report-integrity.ts` ติดด้วย
  identifier ตัวเดียวกันและทำงานเรื่องเดียวกัน โมเดลที่แก้เรื่องนั้นมีเหตุผลจะอ่านทั้งคู่
  ในรอบเดียว (โมเดล binomial จึงใช้ประเมินไม่ได้ — นี่คือเหตุผลที่เกณฑ์ 2.3 ต้องเป็น drain) · ทาง EXPAND ร้ายแรงกว่าทาง
  accumulated เพราะ valve eviction ไม่ครอบ (ไฟล์นั้นไม่เคยถูกโมเดลขอ จึงไม่มีอะไรให้ evict)
  ปลายทางคือ `loop.ts` `move('block')` = **จบ run ทั้งรัน ไม่ใช่แค่รอบนั้น**
  · ส่วนที่ไม่เปลี่ยน: **block ไม่ใช่ redact** ตาม INV-14 — เนื้อไฟล์ไม่ปรากฏใน prompt
  ทั้งสามทาง · precedent ที่ carve-out แบบเดียวกันไปแล้วคือ **Phase-4 REQ-12.3**
  (`.ai/specs/archive/platform-phase4/requirements.md:283-285`) ซึ่ง block lesson ที่มี secret
  เป็นรายชิ้นแทนการ abort ทั้ง build — ทาง EXPAND ใช้รูปเดียวกันเป๊ะ (per-piece skip ใน
  GOVERN) และสอดคล้องกับ REQ-4.3 ที่ spec นี้ตั้งไว้เองว่า path ที่เข้า bundle ไม่ได้
  ต้องถูกข้ามโดยไม่ล้ม build
- **Phase-1 design ประโยค `context builder is a pure function of (contract, worktree)`**
  (`.ai/specs/archive/platform-phase1/design.md:414`) และ **doc comment
  `core/src/context/builder.ts:4-6`** ที่ระบุ `Pure function of (contract, worktree files,
  seedPaths, canaryToken)` — superseded เฉพาะการนับ input: ตัว `buildContext` **ยังเป็น pure
  function ทุกประการ** สิ่งที่เปลี่ยนคือ caller ส่ง seed set ที่โตขึ้นตามรอบ ทั้งสองข้อความต้อง
  ขยับพร้อมกันในคอมมิตเดียวกับโค้ด มิฉะนั้นเอกสารจะขัดกับพฤติกรรมจริง
- **Phase-1 REQ-7.6** (`.ai/specs/archive/platform-phase1/requirements.md:164-165` —
  `contextRecall`/`contextWaste`) — **ไม่ถูก supersede** เกณฑ์ยังใช้ได้ทุกตัวอักษร แต่ต้อง
  บันทึกว่า `contextWaste` เปลี่ยนความหมายเชิงตัวเลข: path ที่สะสมไว้แต่รอบนั้นไม่ได้แตะ
  นับเป็น unused ทุกตัว ค่าจึงสูงขึ้นโดยกลไก **ไม่ใช่ regression**

## REQ-1: Context accumulation ข้ามรอบ

**User Story:** As the platform operator, I want ไฟล์ที่ agent เคยขออ่านอยู่ใน context ของรอบถัดไป,
so that โมเดลไม่ต้องเสียรอบไปกับการอ่านสิ่งเดิมซ้ำและมีข้อมูลพอจะลงมือแก้จริง

**Acceptance Criteria (EARS):**
- 1.1  WHEN `propose()` ถูกเรียกในรอบที่สองเป็นต้นไปของ task เดียวกัน THE SYSTEM SHALL
       ประกอบ seed ของ context bundle จาก `seedPaths` รวมกับ path ที่เคยถูกขอผ่าน
       `READ_FILE` ในรอบก่อนหน้า และส่งทั้งชุดผ่าน `buildContext` เท่านั้น — ห้าม append
       piece เข้า bundle หลัง build (precedent Phase-4 REQ-12.2)                    (event-driven)
- 1.2  WHILE task ยังดำเนินอยู่ THE SYSTEM SHALL อ่านเนื้อไฟล์ใหม่จาก worktree ทุกรอบ
       และ SHALL NOT cache เนื้อไฟล์ข้ามรอบ — bundle ของแต่ละรอบต้องสะท้อนสถานะ
       worktree ล่าสุดเสมอ                                                              (state-driven)
- 1.3  IF path ที่ role ขอเป็น absolute path หรือหลุดออกนอก worktree ด้วย `..` THEN THE
       SYSTEM SHALL คัดออกก่อนเข้า SEED โดยใช้ `normalizeWorktreeRelativePath` —
       ห้ามส่ง path ที่โมเดลกำหนดเข้า `buildContext` โดยไม่ normalize                  (unwanted)
- 1.4  WHEN จำนวน accumulated path เกิน 20 THE SYSTEM SHALL คงไว้เฉพาะ 20 path
       ที่ถูกขอล่าสุดโดยตัดตัวที่เก่าที่สุดออก และ `seedPaths` SHALL NOT ถูกตัดออก
       ไม่ว่ากรณีใด                                                                     (event-driven)
- 1.5  THE SYSTEM SHALL คงบทบาทเดิมของ `readRequested` ในฐานะ allowlist ของ
       `WRITE_FILE` ไว้ครบ — การสะสม context SHALL NOT ขยายสิทธิ์เขียนเกินกว่าที่
       `bundle paths ∪ readRequested` ให้อยู่แล้ว (Phase-1 REQ-5.4)                    (ubiquitous)

## REQ-2: Secret governance ของ path ที่สะสม

**User Story:** As the platform operator, I want ทุก byte ที่สะสมเข้ามาถูกสแกน secret เหมือน
file piece ปกติ และไม่ให้ไฟล์มี secret ไฟล์เดียวฆ่า task ทั้งตัว, so that ความปลอดภัยไม่ถูก
แลกกับความพร้อมใช้งาน

**Acceptance Criteria (EARS):**
- 2.1  THE SYSTEM SHALL ให้ทุก byte ที่เข้ามาทาง accumulated path เดินผ่าน GOVERN
       (`scanForSecret` บนเนื้อเต็มก่อน COMPRESS) และ MARK (`<<<UNTRUSTED-DATA>>>`
       + injection canary) เส้นทางเดียวกับ file piece ปกติทุกประการ (INV-3, Phase-1
       REQ-7.4, Phase-3 REQ-22.3)                                                      (ubiquitous)
- 2.2  IF GOVERN ตรวจพบ secret ในไฟล์ที่มาจาก `seedPaths` THEN THE SYSTEM SHALL
       คงพฤติกรรมเดิมทุกประการ — ล้ม bundle build ทั้งก้อนแล้ว escalate
       `secret_in_context` (Phase-1 REQ-7.3 ส่วนที่ไม่ถูก supersede)                    (unwanted)
- 2.3  WHILE build ของรอบหนึ่งยังล้มด้วย secret ในไฟล์ที่มาจาก accumulated path
       THE SYSTEM SHALL ถอด path ที่ hit ออกจากชุดสะสม, บันทึก event
       `ERROR {reason: 'accumulated_secret_evicted', file, kind}` แล้ว build ใหม่
       **วนต่อจนกว่าจะสำเร็จหรือชนเพดาน** (bounded drain) โดยเนื้อไฟล์ที่ hit
       SHALL NOT ปรากฏใน prompt (block ไม่ใช่ redact — INV-14) · **เพดานของการวน
       SHALL เป็นจำนวน path ในหน้าต่าง cap ของรอบนั้น** (คือ `min(ชุดสะสม, 20)`
       ตามเกณฑ์ 1.4 — ไม่ใช่ขนาดชุดสะสมทั้งหมด) วัดครั้งเดียวก่อน evict ครั้งแรก ·
       แต่ละรอบของลูปถอดอย่างน้อยหนึ่ง path ออกจากชุด ลูปจึงจบเสมอ · การ build
       ที่ล้มด้วยไฟล์จาก `seedPaths` ยังออกทางเกณฑ์ 2.2 ทันที ไม่เข้าลูปนี้            (state-driven)

  **เพดานเป็นหน้าต่าง ไม่ใช่ชุดเต็ม — และนั่นยอมรับได้:** ทุกครั้งที่ evict หน้าต่าง 20 ตัว
  เลื่อนดูด path ที่เก่ากว่าเข้ามาแทน ชุดสะสมจริงจึงอาจใหญ่กว่าเพดาน (auditor รันจริง:
  21 accumulated ที่ติดหมดทุกตัว → evict 20 แล้ว BLOCKED) เคสที่ชนเพดานต้องมี false
  positive **มากกว่า 20 ไฟล์ในรอบเดียว** ขณะที่อัตราที่วัดได้คือ ~2.5% ต่อไฟล์ และ
  พฤติกรรมตอนชนเพดานเป็น **fail-safe** (escalate = block ไม่ใช่ leak) · ทางเลือกที่จะ
  คำนวณ budget ใหม่ตอนหน้าต่างเลื่อนถูกปฏิเสธโดยเจตนา: เพิ่มความซับซ้อนให้เคสที่ยังไม่มี
  หลักฐานว่าเกิด

  **ทำไมไม่ใช่ "build ใหม่หนึ่งครั้ง" (ถ้อยคำเดิมของเกณฑ์นี้):** n=1 กันได้แค่ hit เดียว
  ต่อรอบ hit ที่สองบน accumulated path ตัวอื่นจะไม่มีอะไรรับแล้ว escalate ปิด run ถาวร
  ซึ่งขัดกับ user story ของ REQ-2 เองและเหตุผลของ supersession ที่ไม่ได้ผูกกับจำนวนไฟล์
  · ที่สำคัญคือ hit **เกาะกลุ่มตามหัวข้อ ไม่กระจายอิสระ**: `core/src/evidence/auth.ts`
  กับ `core/src/gates/report-integrity.ts` ติดด้วย identifier ตัวเดียวกัน
  (`publicKeyFingerprintSha256`, H=4.210) และทำงานเรื่องเดียวกัน — โมเดลที่กำลังแก้
  เรื่องนั้นมีเหตุผลจะอ่านทั้งคู่ในรอบเดียว จึงต้องออกแบบเผื่อหลาย hit ต่อรอบ ไม่ใช่หนึ่ง
- 2.4  WHEN รอบใดมีการ build ซ้ำตามเกณฑ์ 2.3 THE SYSTEM SHALL ใช้ canary token
       ใบเดียวกันกับ **ทุก build ของรอบนั้น** ไม่ว่าลูป drain จะวนกี่ครั้ง (เรียก
       `ids.canary()` ครั้งเดียวต่อรอบ) เพื่อไม่ให้ replay เพี้ยน                        (event-driven)
- 2.5  WHEN `SecretInContextError` ไปถึง caller THE SYSTEM SHALL จัดสาขาตามลำดับ
       ความสำคัญนี้: (ก) `err.file` อยู่ใน `seedPaths` → สาขา seed ตามเกณฑ์ 2.2
       **แม้ path นั้นจะอยู่ในชุด accumulated ด้วย** (seed ชนะเสมอ — การ evict ไม่ช่วย
       เพราะ path ยังถูกส่งเข้า build รอบสองอยู่ดี จึง SHALL NOT เสีย build รอบสอง
       และ SHALL NOT บันทึก `accumulated_secret_evicted`) · (ข) อยู่ในชุด
       accumulated เท่านั้น → สาขา accumulated ตามเกณฑ์ 2.3 · (ค) ไม่อยู่ในทั้งสองชุด
       → ปฏิบัติแบบสาขา seed (fail closed)                                          (event-driven)
- 2.6  IF GOVERN ตรวจพบ secret ในไฟล์ที่ **ไม่ได้อยู่ใน `input.seedPaths` ของ build
       รอบนั้น** (คือไฟล์ที่เข้า bundle เพราะ EXPAND ตาม import เท่านั้น) THEN THE
       SYSTEM SHALL ข้าม piece นั้น **เป็นรายชิ้นภายใน GOVERN** โดยไม่ throw,
       ไม่ล้ม bundle และไม่จบ run — build เดินต่อด้วย piece ที่เหลือ และเนื้อไฟล์นั้น
       SHALL NOT ปรากฏใน prompt (block ไม่ใช่ redact — INV-14) · ตัวตัดสิน SHALL
       เป็น membership ใน `input.seedPaths` **ห้ามใช้ inclusion reason ของ piece**
       (ดู "กับดัก" ด้านล่าง) · `input.seedPaths` ที่ builder เห็นเป็นยูเนียนของ
       composition seed กับชุด accumulated ที่ caller ต่อให้แล้ว ทั้งสองจึงยัง throw
       ตามเกณฑ์ 2.2/2.3 ครบ                                                          (unwanted)

  **กับดักที่ต้องไม่พลาดซ้ำ:** ใช้ `reason === 'expand:depth-N'` เป็นตัวตัดสิน **ผิด** —
  `visit()` กันการเดินซ้ำด้วย `collected.has(relPath)` ดังนั้นถ้า literal seed A ถูก visit
  ก่อนแล้ว A มี import ชี้ไป literal seed B, B จะถูกบันทึกด้วย `reason='expand:depth-1'`
  ตั้งแต่ตอนนั้น พอลูป `for (const p of input.seedPaths)` เดินมาถึง B เองก็ถูกตัดออกที่
  `collected.has()` — **B เป็น seed จริงแต่ค้าง reason เป็น expand ถาวร** ถ้าตัดสินด้วย
  `reason` แล้ว secret ใน B จะถูก skip เงียบแทนที่จะล้ม bundle = กลับด้าน AC-4 และ
  Phase-1 REQ-7.3 โดยไม่ได้ตั้งใจ (พบตอน implement รอบ 3 — เดิม spec นี้เขียนผิดว่า
  "path ใน `seedPaths` ได้ `reason='seed'` เสมอ")

## REQ-3: Constitution Amendment v1.8

**User Story:** As the platform operator, I want `unified-platform-spec.md` บันทึกพฤติกรรมใหม่
ของ context builder และ supersession ที่ประกาศไว้, so that constitution ยังเป็น source of truth
เดียวและไม่มีข้อความที่กลายเป็นเท็จค้างอยู่

**Acceptance Criteria (EARS):**
- 3.1  THE SYSTEM SHALL แก้ §9.4 ให้ระบุว่า seed ของแต่ละรอบ = `seedPaths` ของ
       composition รวมกับ path ที่เคยขอผ่าน `READ_FILE` (normalized + capped) และ
       ระบุว่าเนื้อถูกอ่านใหม่ทุกรอบ — ปิดช่องว่างระหว่าง §9.4 กับสัญญาที่ §6.1 ให้ไว้แล้ว
       (`unified-platform-spec.md:205`)                                                (ubiquitous)
- 3.2  THE SYSTEM SHALL บันทึก supersession ของ Phase-1 REQ-7.3 (บางส่วน เฉพาะ
       accumulated path) ใน §17 changelog อย่างชัดแจ้งพร้อมเหตุผลและ precedent
       Phase-4 REQ-12.3 — ห้ามกลับด้าน guarantee เดิมแบบเงียบ                          (ubiquitous)
- 3.3  THE SYSTEM SHALL อัปเดต version banner บรรทัด 3 เป็น v1.8, เพิ่ม §17 changelog
       entry `v1.8`, และปรับบรรทัด "จุดเริ่ม" ของ §17 ให้ยังชี้ว่างานถัดไปคือ stage 5
       (Evidence backflow) ตามเดิม                                                     (ubiquitous)
- 3.4  THE SYSTEM SHALL แก้ข้อความที่กลายเป็นเท็จสองจุดในคอมมิตเดียวกับโค้ด:
       `.ai/specs/archive/platform-phase1/design.md:414` และ doc comment
       `core/src/context/builder.ts:4-6`                                               (ubiquitous)
- 3.5  THE SYSTEM SHALL บันทึกไว้ว่า `contextWaste` (Phase-1 REQ-7.6) จะสูงขึ้นโดยกลไก
       หลังการเปลี่ยนนี้ และ SHALL NOT ถูกตีความว่าเป็น regression                      (ubiquitous)

## REQ-4: Containment ที่ขอบการอ่านของ context builder

**User Story:** As the platform operator, I want ไม่มีไฟล์นอก worktree ไหลเข้า context ได้
ไม่ว่าจะผ่านทางเข้าใด, so that การที่ agent ตั้งชื่อไฟล์เองไม่กลายเป็นช่องอ่านไฟล์นอกขอบเขต

**บริบท:** ด่าน `normalizeWorktreeRelativePath` ที่ REQ-1.3 กำหนดอยู่ที่ **caller** จึงกันได้
เฉพาะ path ที่ role ขอตรง ๆ — **EXPAND ไม่ผ่านด่านนั้นเลย** `visit()` มีแค่ `excludePath`
กับ `collected.has()` และบรรทัดที่แปลง import (`core/src/context/builder.ts:237-252`) ตัด `../`
ออกแค่ชั้นเดียวก่อนส่งเข้า `readFileSync(join(worktreeDir, relPath))` ซึ่ง `join()` ยุบ `..`
ที่เหลือแล้วอ่านนอก worktree ได้ · audit พิสูจน์ด้วยการรัน `buildContext` ตัวจริง: ไฟล์ที่
โมเดลตั้งชื่อผ่าน `READ_FILE` ซึ่งมีบรรทัด `import ... from '../../outside/stolen.ts'`
ทำให้ได้ piece `path=../outside/stolen.ts reason=expand:depth-1` พร้อมเนื้อไฟล์เต็ม
ไหลเข้า prompt · ช่องนี้มีอยู่ก่อนแล้วบน develop แต่การสะสม path ขยาย trigger จาก
"seed ที่ composition กำหนด" เป็น "path ใดก็ได้ที่โมเดลตั้งชื่อ" — จึงปิดในงานนี้
(ยกเลิกการเลื่อนตาม design R2)

**Acceptance Criteria (EARS):**
- 4.1  THE SYSTEM SHALL บังคับ containment กับ **ทุก** path ที่จะถูกอ่านเข้า bundle
       ไม่ว่าจะมาจาก SEED หรือ EXPAND โดยจุดบังคับอยู่ที่ **ขอบการอ่านจริงใน
       `buildContext`** ไม่ใช่ที่ caller — caller-side guard (REQ-1.3) ยังอยู่ในฐานะ
       defense-in-depth ไม่ใช่ด่านเดียว                                                (ubiquitous)
- 4.2  THE SYSTEM SHALL อ่านเฉพาะ **regular file ที่อยู่ใต้ worktree** เข้าสู่ bundle —
       path ที่ resolve แล้วหลุดออกนอก worktree ถูกปฏิเสธ **และ path ที่เป็น symlink
       ถูกปฏิเสธทุกกรณีแม้ target จะอยู่ใน worktree เอง** (ไม่ใช่แค่ตัวที่ชี้ออกนอก) —
       ใช้ idiom เดิมของ repo คือ `realpathSync` เทียบ root + `lstatSync` ยืนยัน
       regular file + เปิดด้วย `O_NOFOLLOW` แบบ
       `core/src/gates/red-provenance.ts:167,185-193` ไม่เขียนกลไกใหม่                (ubiquitous)
- 4.3  WHEN path ใดถูกปฏิเสธตามเกณฑ์ 4.1 หรือ 4.2 THE SYSTEM SHALL ข้าม path นั้น
       โดยไม่ล้ม bundle build ทั้งก้อน (parity กับพฤติกรรมเดิมของไฟล์ที่อ่านไม่ได้ที่
       `core/src/context/builder.ts:186-190`) — build เดินต่อด้วย piece ที่เหลือ        (event-driven)

## REQ-5: Observability ของ piece ที่ถูกข้าม

**User Story:** As the platform operator, I want รู้ได้จาก event log ว่าไฟล์หนึ่งหายจาก
context เพราะอะไร, so that การไล่ปัญหา "ทำไมโมเดลไม่เห็นไฟล์นี้" ไม่ต้องเดา

**บริบท:** ตอนนี้ piece ที่ถูกข้ามหายจาก bundle **เงียบสนิท** — `CONTEXT_BUILT` มีแค่
`{manifestRef, recall, waste, requestId}` คนไล่ปัญหาจึงแยกไม่ออกระหว่าง "ไฟล์ไม่มีจริง" /
"ติด containment ตาม REQ-4" / "ติด secret scan ตามเกณฑ์ 2.6" ทั้งที่ builder มี precedent
ของการคืน signal อยู่แล้วสองตัว (`lessonsBlocked`, `planBlocked`) · งานทั้งงานนี้เกิดขึ้น
เพราะช่องว่าง context ที่มองไม่เห็นกินเวลาไป 3 live run กว่าจะจับได้ การเพิ่มทางมองเห็น
จึงเป็นส่วนหนึ่งของงาน ไม่ใช่ของแถม

**Acceptance Criteria (EARS):**
- 5.1  WHEN builder ข้าม piece ไม่ว่าเพราะ secret ตามเกณฑ์ 2.6 หรือเพราะ containment
       ตามเกณฑ์ 4.2 THE SYSTEM SHALL คืน signal ให้ caller ในรูปเดียวกับ
       `lessonsBlocked`/`planBlocked` ที่มีอยู่แล้ว (list ของ `{path, kind}`) —
       ไม่สร้างกลไกใหม่                                                               (event-driven)
- 5.2  WHEN signal ตามเกณฑ์ 5.1 ไม่ว่าง THE SYSTEM SHALL บันทึกลง event
       `CONTEXT_BUILT` โดยมีเฉพาะ path, จำนวน และเหตุผล — **SHALL NOT มีเนื้อไฟล์
       หรือส่วนของเนื้อไฟล์อยู่ใน payload** (block ไม่ใช่ redact ยังบังคับอยู่ตาม INV-14
       และ event log เป็น artifact ที่ Console แสดงได้)                               (event-driven)

## Edge Cases & Open Questions

- **ไฟล์ที่สะสมถูกลบระหว่างรอบ** — `lstatSync` ใน `readWithinWorktree`
  (`builder.ts:186-190`) คืน `blocked: 'not-found'` แล้ว path นั้นถูกข้ามไปโดยไม่ล้ม
  build ตามพฤติกรรมเดิม ไม่ต้องเขียนกรณีพิเศษ (ต่างจาก `containment` ตรงที่ `kind`
  ใน signal ของ REQ-5 แยกสองอย่างนี้ออกจากกัน)
- **path ที่โมเดลขอแต่ไม่มีจริง** (เช่น `README.md`, `src/auth` ใน run จริง) — เข้ากลไก
  เดียวกันกับข้อบน จึงไม่เคยเข้า bundle ตั้งแต่แรก
- **EXPAND ขยายจากไฟล์ที่อ่าน** — `builder.ts:237-252` วิ่ง EXPAND ที่ depth 1 บนทุก seed
  ดังนั้น import ของไฟล์ที่โมเดลอ่านจะเข้า bundle ด้วย ต้องแยกสองผลที่ต่างกัน:
  (ก) **การหลุดออกนอก worktree — ปิดแล้วใน REQ-4** เป็น trust boundary จึงไม่เลื่อน
  (ข) **การที่ path เหล่านั้นได้สิทธิ์เขียนตามไปด้วย (อยู่ใน bundle = เขียนได้ ตาม
  Phase-1 REQ-5.4) — ยังยอมรับในรอบนี้** เพราะการเขียนยังผ่าน `checkWrite` ที่จำกัด
  implementer ไว้ที่ `src/` + `test/ai-generated/` และปฏิเสธ `test/golden/` กับ frozen
  RED artifact ทุกกรณี (`core/src/executor/path-policy.ts:62-78`) — ถ้าภายหลังพบว่า
  กว้างเกิน ทางแก้คือแยก accumulated path ออกจาก EXPAND (backlog ไม่ตัดเงียบ)
- **symlink ถูกปฏิเสธเข้มกว่าที่จำเป็น** — REQ-4.2 ปฏิเสธ symlink ทุกตัวแม้ target อยู่ใน
  worktree เอง ตาม idiom `red-provenance.ts` + `O_NOFOLLOW` ผลคือไฟล์ที่ถูก symlink
  ในรีโปจะหายจาก context **ยอมรับ** เพราะรีโปนี้มี tracked symlink 0 ตัว ผลกระทบวันนี้
  เป็นศูนย์ และการผ่อนให้ตาม symlink ที่ชี้ในขอบต้องเขียน resolve loop เอง ซึ่งเป็นผิว
  โจมตีที่ไม่มีใครต้องการวันนี้ · **ไม่ได้หายเงียบ** — REQ-5 ทำให้ทุก piece ที่ถูกข้าม
  ปรากฏใน `CONTEXT_BUILT` พร้อม `kind` อยู่แล้ว ถ้าวันหนึ่งมี symlink จริงในรีโป
  signal นั้นคือจุดที่จะเห็นก่อน
- **`scanForSecret` false positive เป็นเรื่องปกติ ไม่ใช่ข้อยกเว้น** — heuristic
  `high-entropy` (`core/src/context/secret-scan.ts:36-43`) ติด identifier ธรรมดาที่ยาวเกิน
  20 ตัวและมีตัวใหญ่+เล็ก+เลข วัดจริงบน production source ของรีโปนี้ได้ 3/120 ไฟล์ (~2.5%)
  โดยไม่มี secret จริงสักตัว และ hit เกาะกลุ่มตามหัวข้อไม่กระจายอิสระ — นี่คือเหตุผลที่ทาง
  ที่โมเดลเลือกเองต้องไม่ทำให้ทั้ง run ตาย และที่ valve ต้องเป็น drain ไม่ใช่ retry ครั้งเดียว
  · ปรับ heuristic ให้แม่นขึ้นเป็นงานคนละตัว (backlog ไม่ตัดเงียบ)
- **byte cap ของ bundle** — ยังไม่ทำในรอบนี้ ของเดิมมีเพดานต่อไฟล์ 8,000 bytes
  (`builder.ts:94`) + COMPRESS อยู่แล้ว เพดานที่รู้ตัวคือ 20 path × 8,000 bytes;
  จุดตัดที่ต้องกลับมาเพิ่ม byte budget = เห็น `CONTEXT_BUILT.stats.bytes` เกิน 32 KB
  ใน live run ใด (fixture ปัจจุบันสะสมเต็มที่ 2,541 bytes จึงยังห่างมาก)
- **defect ที่พบระหว่างออกแบบแต่อยู่นอก scope** (เปิดเป็น task แยกทั้งหมด ไม่ตัดเงียบ):
  idempotency key ชนข้ามรอบ (`core/src/executor/executor.ts:1410-1422` เทียบเฉพาะ
  `actionId` ขณะที่ `adapters/src/wire.ts:27` แจก `a-${i}` ตามตำแหน่ง) ·
  `costUnits` ไม่รวม cache token · `outputTail` ว่างเปล่าใน `GATE_RESULT` ·
  `ESCALATED` ไม่ส่งต่อ hypothesis
