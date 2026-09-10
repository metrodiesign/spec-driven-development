# Handoff Note: รายการงานสองระดับแบบ Kiro

Implementation ผ่าน audit/verify/review และเปิด PR #152 แล้ว โดย artifacts ยังเป็น `draft`.

## Task Summary

เพิ่ม root `N.` และ child `N.M` แบบ Kiro โดย root ยังเป็น execution identity เดียว.

## Current Status

แก้ CI follow-up เรื่องตัวแปร `GROUPS` ของ Bash แล้ว; local guards และ review ผ่าน รอผล CI ของ commit ที่แก้.

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

## CI follow-up: Bash task groups

- CI ล้มที่ Guard regression tests ก่อนถึง spec-trace: pane-loop อ่าน Unix group ID `1001` เป็น task ทั้งที่ไม่มีงานค้าง.
- สาเหตุคือ `GROUPS` เป็นตัวแปรพิเศษของ Bash; เส้นทาง zsh ในเครื่องซ่อนปัญหานี้ไว้.
- เปลี่ยนเป็น `TASK_GROUPS` ทุกโหมด พร้อม regression ที่บังคับ Bash สำหรับ all-in-one, default และ manual.
- RED: `PANELOOP_REEXEC=1 bash .claude/hooks/tests/spec-slice.test.sh` ได้ `pass=45 fail=1`, `groups: 20`.
- GREEN: คำสั่งเดิมและเส้นทางปกติได้ `pass=49 fail=0`; ไม่มีการเรียก GUI stub เมื่อไม่มีงานค้าง.
- Guard suites ทั้ง 16 ชุดผ่าน, active/archive spec-trace ผ่าน และ lessons coverage ผ่าน.
- Review ของ CI fix ไม่พบ finding; รอ GitHub CI ยืนยันหลัง push.

## Known Issues

- ผล `pnpm test` รอบแรกไม่มี numeric exit code; verifier รัน capture ภายหลังแล้วได้ exit 0.

## Next Recommended Agent

ติดตาม CI ของ PR #152; ไม่ merge โดยไม่มีคำสั่งจากผู้ใช้.

## Next Steps

1. Push CI fix บน feature branch เดิม.
2. ตรวจ guards + spec-trace และ checks ที่เหลือของ PR #152 จนจบ.
