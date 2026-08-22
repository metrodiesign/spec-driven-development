# Implementation Tasks: B0 Post-Merge Duplicate Check Runs

> Status: approved 2026-08-22

> แต่ละ task เป็นงานหนึ่งก้อนที่ implement และตรวจสอบได้จบในรอบเดียว
> ให้ model แตก micro-steps ภายในตอนลงมือ ห้ามเพิ่ม sub-task ในไฟล์นี้

- [x] 1. ทำ B0 check resolution ให้ deterministic และ fail closed ครบวงจร — แก้
     `.ai/bin/check-b0-bootstrap.mjs` และ `core/src/governance/policy.test.ts` เท่านั้น:
     เพิ่ม stable keyed pagination, bounded attempt lookup, current-attempt source binding,
     post-merge authority/provenance resolution, latest-candidate selection, evidence output
     และ deterministic regression fixtures ตาม design. Done = behavior ครบทุก criterion,
     single-run contract เดิมไม่ถดถอย, ไม่มี GitHub write และไม่เพิ่ม dependency.
     Satisfies: REQ-1 (all criteria), REQ-2 (all criteria), REQ-3 (all criteria), REQ-4 (all criteria). Verify: `pnpm -C core test && pnpm -C core typecheck && pnpm lint`.
     Evidence:
     - test: `pnpm -C core test` -> 637 tests, 627 passed, 10 skipped, 0 failed
     - targeted: `node --test --test-reporter spec core/src/governance/policy.test.ts` -> 30 passed, 0 failed
     - typecheck: `pnpm -C core typecheck` -> ผ่าน
     - lint: `pnpm lint` -> ผ่าน
     - trace: `scripts/spec-trace.sh b0-post-merge-duplicate-check-runs` -> ครบ 53 criteria และ EARS ผ่าน
     - security: API inventory เป็น `GET` เท่านั้น และ diff ไม่มีข้อมูลลับ
     - viewports: ไม่เกี่ยวข้อง เนื่องจากเป็น logic-only
     - deviations: ไม่มี

## Suggested execution batches

Feature นี้ coupled: production logic, fake API และ regression matrix ใช้ contract เดียวกันใน
สองไฟล์. รัน task 1 ทั้งก้อนใน session เดียวด้วย `/spec-implement 1` หรือ
`/spec-implement all`. ไม่มี `Batch:` tag.
