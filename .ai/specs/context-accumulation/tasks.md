# Implementation Tasks: context-accumulation

> Status: approved 2026-08-04

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Spec amendment v1.8 — บันทึกพฤติกรรมใหม่ของ context builder ลง constitution
     ครบ 4 ชิ้นตาม precedent v1.6/v1.7: บล็อก supersession ใน Overview ของ
     `requirements.md` (ทำแล้วในไฟล์นี้เอง), §9.4 ของ `unified-platform-spec.md`
     ระบุ seed set ต่อรอบ, version banner บรรทัด 3 เป็น v1.8 พร้อมบรรทัดจุดเริ่ม §17
     ที่ยังชี้ stage 5, และ §17 changelog entry `v1.8` ที่ประกาศ supersession ของ
     Phase-1 REQ-7.3 อย่างชัดแจ้งพร้อม precedent Phase-4 REQ-12.3 · แก้ข้อความที่
     กลายเป็นเท็จที่ `.ai/specs/archive/platform-phase1/design.md:414` และระบุข้อความ
     ใหม่ของ doc comment `core/src/context/builder.ts:4-6` ไว้ใน `amendment.md`
     ให้ผู้แก้โค้ดนำไปใช้ · บันทึกว่า `contextWaste` จะสูงขึ้นโดยกลไก.
     Done = `scripts/spec-trace.sh context-accumulation` ผ่าน และไม่มีข้อความใน
     constitution ที่ขัดกับพฤติกรรมหลังแก้.
     Satisfies: REQ-3 (all criteria). Verify: scripts/spec-trace.sh context-accumulation.
     Evidence:
       - test: `scripts/spec-trace.sh context-accumulation` -> OK: เกณฑ์ 14 ข้อ
         ถูกอ้างครบใน design.md และ tasks.md, EARS lint ผ่านทุกข้อ
       - test: ลูปแบบเดียวกับ CI (ทุก dir ใต้ `.ai/specs/` + `.ai/specs/archive/`
         ที่มี requirements.md ตาม `.github/workflows/ci.yml:136-150`) -> rc=0
         ผ่านทั้งหมด รวม `archive/platform-phase1` ที่ถูกแก้ในงานนี้
       - viewports: n/a — เอกสารล้วน ไม่มี UI
       - deviations: none — doc comment `core/src/context/builder.ts` (REQ-3.4
         ส่วนที่สอง) ถูก coder เติมให้แล้วที่ `:8-12` (6 insertions เป็น `//` ล้วน
         ไม่แตะโค้ด) ตามข้อความที่ส่งต่อไว้ใน `amendment.md`
       - deviations: build/typecheck/lint/test/vendor-check/audit ยังไม่รัน — ของ
         verifier ตาม AC-9 (task นี้ไม่แตะโค้ด)

- [ ] 2. Context accumulation + secret governance ใน `aal/src/source.ts` — คำนวณ
     accumulated set จาก `readRequested` ผ่าน `normalizeWorktreeRelativePath`
     (import จาก package `core`) แล้ว cap ที่ 20 ตัวล่าสุด ส่งรวมกับ `deps.seedPaths`
     เข้า `buildContext` เป็น seed · ยก `deps.ids.canary()` มาเรียกครั้งเดียวต่อรอบ
     เก็บไว้ใช้ทั้ง build แรกและ rebuild · จับ `SecretInContextError` แล้วแยกทางด้วย
     `.file`: seed path คงพฤติกรรมเดิม (escalate `secret_in_context`), accumulated path
     ถอดออกจากชุดสะสมแล้ว build ใหม่ (bounded drain ตามเกณฑ์ 2.3 — รายละเอียด
     เพดานอยู่ใน task 4) พร้อมบันทึก event · เติม 1 บรรทัดใน
     `adapters/src/wire.ts` protocol block บอก role ว่าเนื้อไฟล์ที่ `READ_FILE` จะปรากฏ
     ใน context รอบถัดไป · test ใหม่ใน `aal/src/source.test.ts`: bundle รอบถัดไปมี piece
     ของไฟล์ที่เคยขอ, path ที่หลุด worktree ไม่เข้า bundle, secret สองสาขา, cap eviction.
     **ห้ามแตะ** `core/src/orchestrator/loop.ts`, `core/src/ports.ts`,
     `core/src/types.ts` และ **โค้ด** ใน `core/src/context/builder.ts` (doc comment
     แก้ได้ตาม REQ-3.4; การแก้โค้ดของ builder เป็นของ task 3 เท่านั้น) — พบว่าจำเป็น
     นอกเหนือจากนี้ให้หยุดแล้วรายงาน.
     Done = test ใหม่เขียวครบและ gate ทุกชุดผ่าน 0 fail 0 skipped.
     Satisfies: REQ-1 (all criteria), REQ-2.1, REQ-2.2, REQ-2.3, REQ-2.4. Depends on: 1. Verify: pnpm -C aal test.

- [ ] 3. Containment ที่ขอบการอ่านของ builder + แก้การแยกสาขา secret — ปิดช่องที่
     audit พิสูจน์ว่า EXPAND อ่านไฟล์นอก worktree ได้ · ใน
     `core/src/context/builder.ts` ใส่ containment ที่ **ขอบการอ่านจริง** (ทั้งใน
     `visit()` และรอบ GOVERN) โดยยืม idiom จาก
     `core/src/gates/red-provenance.ts:167,185-193`: `realpathSync` เทียบ root +
     เปิดไฟล์ด้วย `O_NOFOLLOW`; path ที่ resolve แล้วหลุดออกนอก worktree ให้ข้าม
     แบบเดียวกับไฟล์ที่อ่านไม่ได้ ไม่ล้ม bundle ทั้งก้อน · ใน `aal/src/source.ts`
     ทำการแยกสาขา secret ให้ครบสองชั้น · **ชั้น builder (GOVERN)**: secret hit บน
     ไฟล์ที่ **ไม่อยู่ใน `input.seedPaths`** (EXPAND ล้วน) ให้ข้าม piece นั้นรายชิ้น
     ไม่ throw ไม่ล้ม bundle (รูปเดียวกับ lesson/plan ที่ `builder.ts:191-200,210-219`)
     — **ห้ามใช้ inclusion reason เป็นตัวตัดสิน** เพราะ literal seed ที่ถูก import จาก
     seed ตัวก่อนหน้าจะค้าง `reason='expand:depth-1'` (ต้องมี regression test ปิด)
     · **ชั้น caller (`aal/src/source.ts`)**: seed ชนะเมื่อ path อยู่ทั้งใน `seedPaths`
     และชุด accumulated (escalate ทันที ไม่เสีย build รอบสอง ไม่ log
     `accumulated_secret_evicted`) และกรณีที่ไม่อยู่ในชุดใดเลยให้ปฏิบัติแบบ seed
     (fail closed) · test: ไฟล์ที่มี `import ... from '../../outside/x.ts'` ต้องไม่ทำให้
     เกิด piece นอก worktree, symlink ต้องไม่ถูกอ่านแม้ target อยู่ใน worktree,
     secret ในไฟล์ที่ EXPAND ดึงมาต้องไม่ล้ม build และ run ต้องไม่จบ, path ที่อยู่ทั้ง
     seed และ accumulated ต้อง escalate โดย build ครั้งเดียว.
     Done = test ใหม่เขียวและ suite เดิมไม่ถอย.
     Satisfies: REQ-4 (all criteria), REQ-2.5, REQ-2.6. Depends on: 2. Verify: pnpm -C aal test.

- [ ] 4. Bounded drain + signal ของ piece ที่ถูกข้าม — ปิด BLOCKING ที่ valve eviction
     ถอด accumulated path ได้รอบละตัวเดียว · ใน `aal/src/source.ts` เปลี่ยน retry
     เดี่ยวเป็น **ลูป drain**: ถอด path ที่ hit ออกจากชุดสะสม บันทึก
     `accumulated_secret_evicted` แล้ว build ใหม่วนต่อจนสำเร็จหรือชนเพดาน โดยเพดาน
     = จำนวน path ในหน้าต่าง cap ของรอบนั้น (`min(ชุดสะสม, 20)` วัดครั้งเดียวก่อน
     evict แรก — แต่ละรอบถอดอย่างน้อยหนึ่ง path ลูปจึงจบเสมอ) ใช้ canary ใบเดิม
     กับทุก build · secret ที่มาจาก `seedPaths`
     ยังออกทางเกณฑ์ 2.2 ทันที ไม่เข้าลูป · ใน `core/src/context/builder.ts` คืน
     `piecesBlocked: {path, kind}[]` ตามรูปเดียวกับ `lessonsBlocked`/`planBlocked`
     ครอบทั้ง skip จาก containment และจาก secret แล้ว caller ใส่ลง `CONTEXT_BUILT`
     — **payload ห้ามมีเนื้อไฟล์** มีได้แค่ path/จำนวน/เหตุผล · test: สอง accumulated
     path ที่ hit ทั้งคู่ในรอบเดียวต้องจบที่ WORKING ไม่ใช่ BLOCKED, ลูปต้องไม่วนเกิน
     จำนวน accumulated, `CONTEXT_BUILT` ต้องมีรายการที่ถูกข้ามและต้องไม่มีเนื้อไฟล์.
     Done = test ใหม่เขียวและ suite เดิมไม่ถอย.
     Satisfies: REQ-5 (all criteria), REQ-2.3, REQ-2.4. Depends on: 3. Verify: pnpm -C aal test.
