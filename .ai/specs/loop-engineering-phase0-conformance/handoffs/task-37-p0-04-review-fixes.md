# Handoff: Task 37 — P0-04 review fixes

- วันที่: 2026-08-02
- ผู้ดำเนินการ: Codex
- ขอบเขต: Critical 1 และ High 1–3 จาก Task 36 เท่านั้น
- สถานะ: implementation และ local verification เสร็จ; Task 4 เปิดค้างรอ fresh-context review

## Outcome

แก้ findings ทั้งสี่จาก Task 36 แล้ว:

1. signed gate report authorize เฉพาะ immutable task commit/tree และ target base ที่ core re-sign ไว้; merge ใช้ exact commit OID และ final report re-sign พร้อม merge commit
2. deploy decision และ deploy stage authenticate approval evidence ก่อน callback/CANARY
3. OOB auditor ใช้ evidence store เดียวที่ `<runDir>/evidence` ซึ่ง derive จาก effective DB path
4. eligible COMPLETED task ที่ไม่มี T1/authenticated final report คืน structured failure, append `ESCALATED` และ CLI exit non-zero

ไม่มี dependency, lockfile, policy, authority, commit หรือ push change และไม่ได้เริ่ม P0-05

## TDD evidence

Initial exact RED probes รันแยกกัน:

- C1 stale signed A แล้ว branch ขยับเป็น red B: actual `COMPLETED` แทน `ESCALATED`
- H2 deploy verifier throw: actual HTTP `200`, verifier calls `0`, deploy callback calls `1`
- H3 valid run evidence อยู่ `<runDir>/evidence` แต่ alternate store ถูกใช้: actual `no eligible targets`
- H4 COMPLETED + AUDIT_RESULT แต่ไม่มี T1: actual exit `0`, ไม่มี escalation
- รวม `0` pass, `4` fail

หลัง implementation exact probes เดิมผ่าน `4/4` และเพิ่ม deploy-stage re-verification probe ผ่าน `1/1` โดย executor calls `0` เมื่อ auth mismatch

Self-review เพิ่ม fault probes อีกสิบข้อ โดยรัน RED แยกก่อนแก้ทุกข้อ: final task-tree mismatch, legacy OOB tree mismatch, missing verifier typing, task/deploy wait release, stale base tip, queue ref race, empty deploy merge diff, mutated-report re-sign และ endpoint-boundary misclassification; แต่ละ probe ได้ `0` pass, `1` fail ก่อน implementation และรวมกลับมา GREEN `10/10` หลังแก้

## Implementation decisions

### Immutable report authorization

- `GateReport` เพิ่ม signed optional fields `artifactCommitHash`, `baseCommitHash` และ `mergedCommitHash`
- `bindGateReportToTaskArtifact` ตรวจว่า task commit tree เท่ากับ signed `worktreeHash`, freeze current base/task OIDs แล้ว re-sign ด้วย per-run Ed25519 key เดิม
- `verifyTaskArtifactBinding` re-dereference evidence, verify signature/content hashes และตรวจ current branch tip/tree กับ signed task OID ก่อน approval และ merge
- current target ref ต้องเท่ากับ signed `baseCommitHash`; base ที่ขยับหลัง authorization จึงบังคับ re-review แทนการ merge กับ artifact คนละฐาน
- direct merge และ merge queue ใช้ `artifactCommitHash` โดยตรง; queue ตรวจ binding ซ้ำภายใต้ lease ก่อน merge
- queue advance ref ด้วย atomic compare-and-swap `git update-ref <ref> <new> <signed-base>` จึงไม่ overwrite concurrent main update ระหว่าง T2
- หลัง merge core ตรวจ parent relationship แล้ว re-sign report พร้อม `mergedCommitHash`; audit/completion ตรวจ signature, parent relationship และ current main ref ซ้ำก่อน state advance
- ก่อน re-sign merge report จะ verify signature เดิมซ้ำ และ final/OOB verification ผูก `worktreeHash` กลับกับ immutable task/merge tree เพื่อไม่ให้ tampered report ถูก re-sign รับรองใหม่
- final signed authorization บันทึกเป็น append-only `EVIDENCE_AUTHORIZED`; OOB เลือก record นี้เหนือ later sampled `GATE_RESULT`
- task approval diff recompute จาก signed `baseCommitHash...artifactCommitHash`; deploy diff recompute จาก signed `mergedCommitHash`; content-addressed `diffRef` ต้อง byte-equal ก่อน approval

### Deploy boundaries

- `POST /deploy/decision` เรียก shared verifier หลัง attestation validation แต่ก่อน `DEPLOY_DECISION` และ `onDeployDecision`
- missing/failed verifier คืน `409` พร้อม `evidence_auth_unavailable|evidence_auth_mismatch`, เรียก typed `onEvidenceInvalid(..., "deploy_approval")`, ไม่เรียก deploy callback
- Human Plane ส่ง boundary ชนิด `human_approval|deploy_approval` เข้า verifier โดยตรง ไม่ infer จาก approval/task id; evidence failure ปลด pending wait ทันทีโดยไม่รอ timeout และไม่สร้าง decision event
- deploy package แสดง first-parent diff ของ signed merge commit; verifier recompute bytes จาก OID/parent เดิมก่อนอนุมัติ จึงไม่ส่ง empty combined merge diff ให้ผู้ review
- `runDeployStage` ต้องมี `verifyApprovalEvidence()` และเรียกก่อน CANARY; failure บันทึก `DEPLOY_STATE{state:"ESCALATED",trigger:"evidence_invalid"}` กับ `ESCALATED{boundary:"deploy_stage"}` โดยไม่เรียก executor

### OOB failure channel

- ลบ `evidenceDir` จาก OOB/CLI production inputs และ hard-coded `~/.platform/oob-evidence`
- store เดียวคือ `join(dirname(effectiveDbPath), "evidence")` หลัง `--db` override
- `runOobAudit` คืน verdict array พร้อม non-enumerable typed `failures` เพื่อคง array compatibility และให้ CLI แยก no-target จาก authentication failure
- missing T1 ใช้ code `gate_report_missing`; auth/artifact failuresเก็บ reason/code/detail; CLI exit `2` และ auditorคง detection-only

### Recovery signal

พบ regression ระหว่าง full backend: DB ที่มี foreign/concurrent lease เพียงอย่างเดียวถูกตีเป็น recovery เพราะใช้ `exists(events.db)` จึงหา frozen key ที่ยังไม่ควรมีแล้วจบก่อน graph. เปลี่ยน recovery signal เป็น `exists(run-metadata.json)` ซึ่งเป็น trust-root state จริง; หาก metadata มีแต่ key หาย authenticator เดิมยัง fail closed. Existing lease tests RED `2/2` แล้ว GREEN `2/2`.

สอง integration polling tests เดิมใช้ deadline `5s`/`15s` แต่ observed gate/deploy path ปัจจุบันใช้ประมาณ `20–35s`; ขยายเฉพาะ test harness เป็น `30s`/`45s`. ไม่มี production timeout หรือ behavior change.

## Tests run

- exact Task 36 probes: `4` pass, `0` fail
- deploy decision + stage boundary probes: `2` pass, `0` fail
- OOB core: `9/9`
- merge queue: `8/8`
- self-review hardening probes: `10/10`
- direct/queue auto-merge รวม valid sampled/unsampled, stale A→B rejection และ genuine non-repro revert: pass
- full core รอบล่าสุด: `525` total, `516` pass, `0` fail, `9` explicit external-only skips
- full console backend นอก managed socket sandbox: `387` pass, `0` fail
- full AAL: `143` pass, `0` fail
- adapters: `39` pass, `0` fail
- console web: `74` pass, `0` fail
- `pnpm typecheck`: `6` workspace projects pass
- `pnpm lint`: `ESLint: No issues found`
- `pnpm build`: pass; Vite แสดง existing chunk-size warning เท่านั้น
- `scripts/check-core-vendor-free.sh`: pass
- `scripts/lessons-coverage-check.sh`: pass
- guard regression scriptsใต้ `.claude/hooks/tests`: `14/14` scripts pass
- strict Evidence validation, full-tree secret scan, spec trace `144/144` พร้อม EARS lint, authority SHA และ `git diff --check`: pass

## Self-review verdict

ทบทวน current Task 37 diff ตาม correctness, compatibility, concurrency, approval/API trust boundaries, artifact identity, signature flow, OOB path และ deploy path แล้วแก้ actionable findings ที่พบด้วย RED-first regressionsข้างต้นครบ ปัจจุบันไม่พบ actionable Critical, High, Medium หรือ security finding คงค้าง; verdict พร้อมส่งให้ fresh-context reviewer แต่ Task 4 ยังต้องคงเปิดจนกว่าจะได้ independent review

## Files changed in Task 37 scope

- `core/src/types.ts`
- `core/src/gates/report-integrity.ts`
- `core/src/merge/artifact-binding.ts`
- `core/src/merge/artifact-binding.test.ts`
- `core/src/merge/auto-merge.ts`
- `core/src/merge/auto-merge.test.ts`
- `core/src/merge/queue.ts`
- `core/src/merge/queue.test.ts`
- `core/src/human/api.ts`
- `core/src/human/api.test.ts`
- `core/src/deploy/stage.ts`
- `core/src/deploy/stage.test.ts`
- `core/src/audit/oob.ts`
- `core/src/audit/oob.test.ts`
- `core/src/index.ts`
- `console/backend/src/loop-run.ts`
- `console/backend/src/loop-run.test.ts`
- `console/backend/src/loop-run-graph.test.ts`
- `console/backend/src/auditor-cli.ts`
- `console/backend/src/auditor-cli.test.ts`
- `console/backend/bin/platform.ts`
- `.ai/specs/loop-engineering-phase0-conformance/tasks.md`
- handoff นี้

ไฟล์เหล่านี้บางส่วนมี shared uncommitted P0-02/P0-03/P0-04 work จาก tasks ก่อนหน้า; ไม่มีการ revert หรือ claim ownership ของ unrelated hunks

## External blocker

P0-02 real-macOS suite ไม่ได้ retry, circumvent หรืออ้าง PASS. Recorded cooldown ยังมีผลถึง 2026-08-03 เวลา 20:18 Asia/Bangkok; Task 2 ต้องคง `[ ]`.

## Next recommended agent

fresh-context correctness/security reviewer

## Next steps

1. review Task 37 diff กับ Critical/High scenarios ทั้งสี่ โดยเน้น approval TOCTOU, exact OID merge, queue lease, final report selection และ deploy stage boundary
2. หากไม่มี actionable finding ให้ปิด Task 4 พร้อม review evidence ใหม่
3. ห้ามเริ่ม P0-05 ก่อน Task 4 ได้ fresh approval และ dependency gate ผ่าน
