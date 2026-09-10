# Handoff — SDD framework distribution

Status: draft

เอกสารนี้เก็บผลส่งมอบและหลักฐาน verification ของ implementation รอบปัจจุบัน

## Scope

- CLI lifecycle: `install`, `adopt`, `update`, `status`, `check`, `validate`
- Explicit source-to-target manifest และ consumer lock
- Integration tests ด้วย temporary Git repositories
- Consumer runtime test โดยไม่ใช้ framework source checkout

## Evidence

- `bash .claude/hooks/tests/sdd-framework-distribution.test.sh` — ผ่าน 8/8 tests
- `scripts/spec-trace.sh sdd-framework-distribution` — ผ่าน 16 criteria
- `pnpm typecheck` — ผ่าน
- `pnpm lint` — ผ่าน
- `pnpm build` — ผ่าน โดยมี Vite chunk-size warning เดิม
- `git diff --check` — ผ่าน
- `pnpm test` — ผ่านทุก workspace package; final `console/backend` 465 pass, 0 fail และ package อื่นไม่มี failure

Mutation-check ปิด reserved-path, local-drift และ exact-revision guard ทีละจุดแล้ว test ที่เกี่ยวข้องแดง จากนั้น restore และ direct suite กลับมาเขียว

## Limitations

- เครื่องมือทำงานกับ local Git repositories เท่านั้น
- Hook activation, CI configuration และ harness settings เป็นหน้าที่ของ consumer
- Offline `status` ตรวจ self-consistency และ local drift แต่ไม่พิสูจน์ source provenance
