# Handoff Note: รายการงานสองระดับแบบ Kiro

ส่ง implementation ของ root task 1 เข้าสู่ audit/verify/review โดย artifacts ยังเป็น `draft`.

## Task Summary

เพิ่ม root `N.` และ child `N.M` แบบ Kiro โดย root ยังเป็น execution identity เดียว.

## Current Status

Implementation และ targeted checks เสร็จ; พร้อมให้ pipeline gates ตรวจ.

## Files Changed

- `scripts/` และ `.ai/bin/` — parser, Goal, Evidence, slice, pane และ advisory consumers.
- `.ai/shared/`, `.ai/workflows/`, skills — canonical generation/execution/GitHub contracts.
- test suites — hierarchy, Evidence, projection, compatibility และ Markdown render.

## Important Decisions

- Root refs เท่ากับ union ของ root/children; root Verify เท่านั้น authoritative.
- Child เป็น checklist/Evidence record; ไม่มี Goal, batch, cost หรือ issue identity.
- Root Evidence อยู่หลัง children; completed root ต้องมี completed/evidenced children.

## Constraints

- คง artifact headers เป็น `draft` จนผู้ใช้อนุมัติ phase โดยตรง.
- ห้าม sync GitHub remote หรือสร้าง child issue.
- ห้ามเปลี่ยน raw root grammar `- [ ] N.` ระหว่าง review นี้.

## Tests Run

- `scripts/spec-trace.sh kiro-nested-tasks` -> 31 criteria ผ่าน.
- Targeted Goal/shell suites -> 27 + 38 + 42 + 11 + 42 + 10 + 14 ผ่าน.
- `pnpm typecheck` และ `pnpm lint` -> exit 0.
- `pnpm test` -> ทุก package จบโดยไม่พบ failure; backend 465/465.
- Pandoc `markdown+task_lists` -> exit 0; feature มี checkbox inputs 7 รายการ.

## Known Issues

- Unified PTY ไม่คืน final numeric rc หลัง `pnpm test` session ปิด; output ทุก packageไม่มี failure.

## Next Recommended Agent

ให้ `auditor` ตรวจ diff แล้ว `verifier` รัน gate ตาม pipeline.

## Next Steps

1. Audit correctness/security/performance และกวาด failure class.
2. Verify AC-1 ถึง AC-10 แล้วส่ง craft review.
