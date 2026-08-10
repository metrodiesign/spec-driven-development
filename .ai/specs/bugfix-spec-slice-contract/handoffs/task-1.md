# Handoff Note: Spec traceability slice contract

## Task Summary

Bugfix task 1 ปิด contract drift ระหว่าง traceability producer, `spec-trace` validator และ
`spec-slice` consumer โดยไม่เพิ่ม slicer หรือ metadata format ใหม่.

## Current Status

Implementation, targeted validation, guard suite และ required full test เสร็จครบ Task ถูกติ๊กแล้ว
หลัง sibling bugfix specs ปิด `F-Sys` และ nested-sandbox root causes.

## Files Changed

- `scripts/spec_trace.py` — validate named columns, column-bound REQ coverage, empty/unresolved
  `Section` และ exact H2 match สำหรับ spec ที่ยังมี unchecked task.
- `.claude/hooks/tests/spec-slice.test.sh` — controlled CLI regression fixtures และ valid controls.
- `.claude/skills/spec-quick/SKILL.md` — producer contract แบบ sliceable.
- `.claude/skills/spec-requirements/SKILL.md` — Design-First backfill contract แบบ sliceable.
- `.ai/workflows/feature-development.md` — neutral producer contract แบบ sliceable.
- `.ai/specs/context-accumulation/design.md` — retrofit table และ H2 สำหรับ REQ-3.
- `docs/kiro-current-gap-analysis.md` — decision-grade research กับ implementation status.
- `.ai/specs/bugfix-spec-slice-contract/` — approved bugfix spec, tasks และ handoff.

## Important Decisions

- Enforce sliceability เฉพาะ spec ที่มี unchecked task; closed/archived spec คง coverage gate เดิม.
- `REQ` หรือ `Satisfies` และ `Section` resolve ตามชื่อ column ไม่ผูกตำแหน่ง.
- Coverage ของ active sliceable table ต้องมาจาก named `REQ/Satisfies` cell ไม่ใช่ token ที่หลง
  อยู่ใน prose หรือ column อื่น.
- `Section` ใช้ case-sensitive exact match กับ real `##` heading ตาม consumer เดิม.

## Constraints

- ห้ามแก้ `scripts/spec-slice.sh`, runtime packages หรือ `.ai/specs/archive/` ใน bugfix นี้.
- ห้าม push/commit ตรง; ต้อง review และผ่าน PR workflow.
- Task ติ๊กเสร็จได้เมื่อ required full test gate เขียว; สถานะล่าสุดผ่านแล้ว.

## Tests Run

- `bash .claude/hooks/tests/spec-slice.test.sh` -> `pass=33 fail=0`.
- active + archive `scripts/spec-trace.sh` sweep -> exit `0` ทุก spec.
- `scripts/spec-trace.sh context-accumulation` -> 21 criteria ผ่าน.
- `scripts/spec-slice.sh context-accumulation 1..4` -> ทุก task `missing=0 design=2`.
- `.claude/hooks/tests/*.test.sh` full suite -> exit `0`.
- typecheck: `pnpm typecheck` -> exit `0`.
- lint: `pnpm lint` -> `ESLint: No issues found`.
- test: `pnpm test` -> exit `0`; web 77, core 612, aal 192, adapters 50 และ
  `console/backend` 436 tests ผ่านทั้งหมด; core มี 10 capability-gated skips.

## Known Issues

- ไม่มี known issue ค้างใน scope นี้; root causes เดิมถูกปิดใน sibling bugfix specs.

## Next Recommended Agent

PR reviewer และ CI.

## Next Steps

1. Review diff และ ship ผ่าน PR เข้า `develop`.
2. Merge ได้เมื่อ required CI เขียว.
