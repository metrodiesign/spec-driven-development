# Tasks — SDD framework distribution

Status: draft

รายการนี้ผูก implementation กับ requirements และ verification ที่รันได้ใน repository

- [ ] 1. Canonical artifacts
  Satisfies: REQ-1, REQ-2, REQ-3, REQ-4, REQ-5, REQ-6, REQ-7, REQ-8, REQ-9, REQ-10, REQ-11, REQ-12, REQ-13, REQ-14
  Verify: canonical requirements, design, tasks และ handoff มี `Status: draft`

- [ ] 2. Explicit manifest
  Satisfies: REQ-2, REQ-9, REQ-10, REQ-12, REQ-14
  Verify: `node scripts/sdd-framework.mjs validate --source . --ref HEAD`

- [ ] 3. Snapshot และ offline inspection
  Satisfies: REQ-1, REQ-2, REQ-7, REQ-8, REQ-9, REQ-11, REQ-14
  Verify: `node --test scripts/sdd-framework.test.mjs`

- [ ] 4. Install และ adopt
  Satisfies: REQ-3, REQ-4, REQ-10, REQ-13
  Verify: `node --test scripts/sdd-framework.test.mjs`

- [ ] 5. Update transaction และ rollback
  Satisfies: REQ-5, REQ-6, REQ-10, REQ-13
  Verify: `node --test scripts/sdd-framework.test.mjs`

- [ ] 6. Consumer runtime และ CI wrapper
  Satisfies: REQ-7, REQ-8, REQ-10
  Verify: `bash .claude/hooks/tests/sdd-framework-distribution.test.sh`
