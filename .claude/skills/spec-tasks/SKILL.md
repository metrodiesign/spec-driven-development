---
name: spec-tasks
description: Generate the tasks.md implementation checklist from the approved design. Use after design is approved.
argument-hint: <feature folder name (optional)>
---

# Generate tasks.md

ก่อนสร้างหรือแก้ผลลัพธ์ อ่านและใช้ [นโยบายภาษาของผลลัพธ์](../../../.ai/shared/TASK_PROTOCOL.md#ภาษาของผลลัพธ์)

Resolve the target spec: use $ARGUMENTS if given; if `.ai/specs/` holds more
than one feature and none was named, list them and ask — never guess.

Read the active spec's design.md and requirements.md. If either upstream
artifact is still `> Status: draft` (design.md always; requirements.md too when
it exists — e.g. derived in design-first), warn in Thai and ask for
confirmation first — and if I confirm, flip the draft one(s) to
`> Status: approved <YYYY-MM-DD>`. Then write
`.ai/specs/<feature>/tasks.md`. Size tasks for a large-context, high-effort
model: each task is a COHESIVE, INDEPENDENTLY VERIFIABLE slice that you can
implement end-to-end in one pass, even if it spans many files.

# รายการงาน: <ชื่อฟีเจอร์>
> Status: draft

> Root task เป็น cohesive execution unit; children เป็น checked implementation steps
> ภายใน root และไม่ถูก schedule แยก

- [ ] 1. <ความสามารถที่ทำครบในงานเดียว> — <ขอบเขตและเกณฑ์เสร็จในหนึ่งบรรทัด>
  - Satisfies: REQ-1 (ทุกเกณฑ์).
  - Verify: <test หรือคำสั่งตรวจรวมของ root>.

  - [ ] 1.1 <ขั้นตอนย่อยที่มีผลลัพธ์ตรวจได้>
    - <รายละเอียด>
    - Satisfies: REQ-1.1.
    - Verify: <คำสั่งตรวจ child; ใช้เป็นเอกสารประกอบ>.

  - [ ] 1.2 <ขั้นตอนย่อยถัดไป>
    - <รายละเอียด>
    - Satisfies: REQ-1.2.

- [ ] 2. <ความสามารถที่ทำครบในงานเดียว> — <ขอบเขตและเกณฑ์เสร็จ>
  - Satisfies: REQ-2.
  - Depends on: 1.
  - Verify: <test หรือคำสั่งตรวจรวมของ root>.

ใช้ root ที่ column 0, child เยื้องสองช่อง, รายละเอียด root เยื้องสองช่อง และรายละเอียด
child เยื้องสี่ช่อง. Metadata/details เป็น nested bullet ตามตัวอย่าง. เมื่อเติมหลักฐาน
ให้เว้นบรรทัดก่อนและหลัง `Evidence:` แล้วใช้รายการย่อยตาม
`.ai/shared/TESTING_PROTOCOL.md`. ตรวจด้วย
`/opt/homebrew/bin/pandoc --from=markdown+task_lists --to=html` เมื่อมี binary.

## Suggested execution batches

> ค่าเริ่มต้นสำหรับฟีเจอร์ที่ tasks ใช้ primitives/data/lib ร่วมกัน: รันทั้งหมดใน session เดียว
> ด้วย `scripts/pane-loop.sh <feature> all-in-one` หรือ `/spec-implement all`
> session แยกไม่ใช้ cache ร่วมกัน จึงต้องจ่าย cold cache-write เพื่อโหลด context ซ้ำ
> งานที่เกี่ยวข้องกันวัดได้ว่าแพงขึ้นประมาณ 30–40%
> แยก session/pane เพื่อความแม่นยำเฉพาะงานที่เป็นอิสระจริง ไม่มี shared state
> หรือเพื่อแยก CORE domain เช่น pricing logic จาก context drift โดยยอมรับค่าใช้จ่ายเพิ่ม
> `Batch:` ยังใช้จัดกลุ่มงานเล็กชนิดเดียวกัน ส่งกลุ่มด้วย `+`
> (`scripts/pane-loop.sh <feature> 3+4`)

Rules:

- Use the fewest tasks that preserve cohesion and independent verifiability. Task
  count is an outcome, not a quota: many features land around 5-10 tasks, but there
  is no minimum or maximum at the spec level. If the count exceeds 10, review whether
  the feature is too broad or tasks are micro-steps; keep any count when every task
  remains cohesive, independently verifiable, requirement-traceable, and feasible in
  one pass. Never split cohesive behavior or merge unrelated behaviors solely to hit
  a target count. If a "task" cannot be verified on its own, fold it into the task it
  serves.
- Each root task is ONE coherent behavior / vertical slice (e.g. "user registration
  end-to-end: model → endpoint → validation → tests"), never a horizontal layer
  ("create the model", "create the repository") that does nothing alone.
- Map each root/child to a whole REQ or tightly-related group; root coverage คือ union
  ของ `Satisfies:` ทั้ง subtree. Root `Verify:` เท่านั้น authoritative; child `Verify:`
  เป็นเอกสารประกอบและห้ามใช้แทน root.
- Before STOP, run a reverse coverage check: every REQ-N in requirements.md must
  appear on the Satisfies: line of at least one task — run `scripts/spec-trace.sh
  <feature>` to verify deterministically. List any uncovered REQ loudly as a
  blocker; never skip silently. A REQ may stay uncovered only if explicitly
  declared out of scope and approved.
- Children `N.M` เป็น checklist ภายใน root; ห้ามเพิ่มระดับ `N.M.K`, `Depends on:`,
  `Batch:` หรือ execution identity ให้ child.
- Order coarsely: shared/foundational tasks first. Note a dependency only when real.
- Mark [optional] for non-essential tasks.
- Tag `Batch: <id>` ONLY on tasks that are ALL of: small, the same type (e.g. several
  data-only files, several static sections, a cluster of UI-polish fixes), touch the
  same area, and BENEFIT from shared context. Same tag = same execution session.
  Do NOT batch big/foundational/distinct-domain tasks — those want a fresh, focused
  session (more accurate). Batching is an EXECUTION hint only: it never merges tasks
  or changes their independent verifiability / REQ mapping. When unsure, leave untagged.

Sync mode: if tasks.md already exists and requirements.md or design.md changed
after it was written, do NOT regenerate — patch only the affected tasks,
preserving completed `- [x]` entries and their notes (including any appended
`Evidence:` block — never strip it). If tasks.md was already
approved, re-stamp its header: `> Status: approved <original date>, amended
<YYYY-MM-DD>`.

When done: STOP for my review. Then ask whether to implement a specific task
(`/spec-implement <n>`), a range (`/spec-implement 1-3`), or everything
(`/spec-implement all`); and note any `Batch:` groups so the orchestrator can run
them in one session (`scripts/pane-loop.sh <feature> 3+4`). When I explicitly
approve, flip the header to `> Status: approved <YYYY-MM-DD>` before
implementation starts.
