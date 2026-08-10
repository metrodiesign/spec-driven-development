# Handoff: Universal PR Quality Gate

> From: Codex session `/root`   To: human review   Date: 2026-08-10

## Task Summary

สร้าง `universal-pr-quality-gate` ตาม requirements, design และ tasks ที่อนุมัติ ครอบคลุม REQ-1 ถึง REQ-11: exact-head snapshot, deterministic evidence, blind reviewer panel, Evidence Judge, trusted GitHub boundary, operator API/CLI/Console, policy governance, Phase 1 acceptance corpus และ production operations documentation

## Current Status

Implementation Tasks 1–7 เสร็จแล้ว Code-review findings ระดับ block-merge ถูกแก้ Full test,
static, security, trace, audit, documentation integrity และ desktop/mobile browser smoke ผ่าน PR #138 เปิดเข้า `develop`.

เอกสารพร้อมใช้ แต่ production activation ยังถูก block อย่างตั้งใจ: repository เป็น public และยังไม่มี abuse control ก่อนผูก self-hosted runner/secrets; workflow Actions ยังไม่ pin full commit SHA; finalize workflow ยังไม่อยู่ default branch; Gemini/OpenCode ยังไม่มี live conformance records.

## Files Changed

- `.ai/specs/universal-pr-quality-gate/requirements.md` — created — approved EARS requirements 132 ข้อ
- `.ai/specs/universal-pr-quality-gate/design.md` — created — approved module/interface design
- `.ai/specs/universal-pr-quality-gate/tasks.md` — created — implementation checklist และ Evidence
- `.ai/specs/universal-pr-quality-gate/handoff.md` — created — durable handoff
- `docs/08-pr-quality-gate-production.md` — created — canonical production runbook สำหรับ GitHub Actions, CLI, Console, REST API, analysis/finalize, monitoring, rollback และ incident handling
- `AGENTS.md`, `CLAUDE.md`, per-agent `AGENT.md`, `README.md`, `docs/README.md`, `docs/01-spec-driven-flow.md` ถึง `docs/07-packages.md` และ `docs/calibration/RUNBOOK.md` — edited — enforcement claims, navigation และ operational guidance ให้ตรงกับระบบล่าสุด
- `.ai/README.md`, `.ai/bin/README.md`, `.ai/shared/*.md` และ `unified-platform-spec.md` — edited — shared architecture, review, test และ security contracts ให้ชี้ canonical production source
- `.ai/bin/install.sh` — edited — แก้ comment stale เรื่อง workspace bootstrap เท่านั้น
- `.ai/policies/pr-quality-gate.json` — created — governed Phase 1 policy
- `.ai/schemas/pr-review.schema.json` — created — reviewer output schema
- `.ai/schemas/pr-judge.schema.json` — created — Judge output schema
- `.ai/schemas/pr-quality-result.schema.json` — created — final result schema
- `.ai/governance/events.jsonl` — edited — human proposal/approval events for PR gate policy
- `.github/workflows/pr-quality-analysis.yml` — created — untrusted analysis workflow
- `.github/workflows/pr-quality-finalize.yml` — created — privileged finalize workflow
- `core/src/pr-gate/` — created — Ring 0 types, kernel, deterministic checks and tests
- `core/src/executor/default-command-executor.ts` — created — reusable command execution boundary
- `core/src/types.ts` — edited — PR gate contracts
- `core/src/index.ts` — edited — PR gate exports
- `core/src/governance/policy.ts` — edited — PR gate policy governance coverage
- `aal/src/pr-review/` — created — blind panel, Judge and tests
- `aal/src/dispatch.ts` — edited — PR review dispatch integration
- `aal/src/protocol.ts` — edited — review protocol contracts
- `aal/src/index.ts` — edited — PR review exports
- `adapters/src/control.ts` — created — child cancellation with SIGTERM/SIGKILL escalation
- `adapters/src/reasoning-cli.ts` — created — Gemini/OpenCode reasoning-only adapter
- `adapters/src/reasoning-cli-live.ts` — created — live CLI transport
- `adapters/src/reasoning-cli.test.ts` — created — transport, env, cancellation and conformance tests
- `adapters/src/anthropic.ts` และ `adapters/src/anthropic.test.ts` — edited — PR review protocol support
- `adapters/src/codex.ts`, `adapters/src/codex-live.ts` และ `adapters/src/codex.test.ts` — edited — PR review protocol and cancellation support
- `adapters/src/live.ts`, `adapters/src/wire.ts` และ `adapters/src/index.ts` — edited — shared live adapter wiring and exports
- `console/backend/src/pr-gate/` — created — manager, GitHub trust boundary, local Git pinning, policy, artifacts, checks, classification, context, composition and tests
- `console/backend/src/pr-gate-cli.ts` และ `console/backend/src/pr-gate-cli.test.ts` — created — operator CLI and tests
- `console/backend/src/app-pr-gate.test.ts` — created — guarded API tests
- `console/backend/bin/platform.ts` — edited — PR gate commands and live four-lineage conformance command
- `console/backend/src/app.ts` — edited — PR gate routes; file also contains pre-existing user bugfix changes
- `console/backend/test/fixtures/pr-gate/acceptance-corpus.json` — created — Phase 1 acceptance corpus
- `console/web/src/PrQuality.tsx` — created — accessible operator surface
- `console/web/src/logic/pr-quality.ts` และ `console/web/src/logic/pr-quality.test.ts` — created — UI state logic and tests
- `console/web/src/App.tsx` และ `console/web/src/styles.css` — edited — PR Quality navigation and styling

## Important Decisions

- Ring 0 remains vendor-free; provider/GitHub integration stays in AAL, adapters and backend
- Every run pins exact current PR head; stale SHA, missing object or provenance mismatch fail closed
- Stale direct run creates a durable replacement run for current SHA; trusted workflow path records replacement supplied by `pull_request synchronize`
- Privileged finalize workflow consumes verified artifact metadata and trusted GitHub API state; it does not checkout PR code
- Initial rollout uses a one-time analysis exemption pinned to trusted base `926cc2053115bc358979049499964260d0b77419`; any other base missing the handler fails closed
- Deterministic checks form mandatory floor; reviewer panel and Judge cannot weaken it
- Node checks copy dependency bytes only from trusted base checkout and include ignored dependency roots in frozen command input; network and install remain denied
- Four reviewer slots receive identical context and anonymous labels; Judge consumes structured findings only
- Override is explicit, durable, audited and exact-head-bound
- Policy file is governance-protected; approval event `gov-e5b83542c43caf5f` authorizes snapshot hash `8390f44d0c38e6d314674a03c2acc8ca06f3499b0bbd4fc63b0ba2c2e0c00a5e`
- Live provider conformance writes durable records keyed by exact adapter lineage; production eligibility depends on current records
- `docs/08-pr-quality-gate-production.md` เป็น canonical operator runbook; เอกสารอื่นลิงก์เข้าหาแทนการ duplicate คำสั่ง
- Public-repository trust split ลด exposure เพราะ privileged finalize ไม่ execute untrusted head แต่ไม่ลบ public-runner, artifact/parser, supply-chain, credential misuse หรือ denial-of-wallet risk; ห้ามผูก production secrets/self-hosted runner จนมี admission/abuse control ที่ตรวจได้
- `/api/system/stats` degrade แยก metric: metric ที่อ่านไม่ได้เป็น `null`, response ยัง HTTP 200 พร้อม `degraded` และ `unavailableMetrics`
- CLI exit อิง `systemDecision`; exit 0 ไม่พิสูจน์ Check Run publication ต้องตรวจ `publication == "PUBLISHED"` แยก
- Runtime ไม่มี built-in retention/prune; production ต้อง monitor/backup disk และห้าม ad-hoc purge state

## Verified Root Causes and Before/After Impact

| Incident | Root cause ที่มี reproduction | ก่อน | หลัง |
|---|---|---|---|
| Console system stats | [`bugfix-system-stats-degradation`](../bugfix-system-stats-degradation/bugfix.md): `os.uptime()` ถูก OS deny ด้วย `ERR_SYSTEM_ERROR`, route ไม่มี per-metric boundary | metric เดียวทำ endpoint 500 ทั้งก้อน | HTTP 200, unavailable metric เป็น `null` พร้อม degraded metadata |
| Loop repair test | [`bugfix-loop-run-nested-sandbox`](../bugfix-loop-run-nested-sandbox/bugfix.md): nested `/usr/bin/sandbox-exec` ล้ม `sandbox_apply: Operation not permitted`; `ECONNREFUSED` เป็น cascade | T0 ทุก check `sandbox_unavailable` แล้ว `ESCALATED` | test-only injection แยก synthetic path; production sandbox ยัง fail closed |
| Spec slice | [`bugfix-spec-slice-contract`](../bugfix-spec-slice-contract/bugfix.md): validator ตรวจ token แต่ไม่ตรวจ table schema/exact H2 | slicer `MISSING` แล้ว fallback full read | active spec schema/H2 ถูก validate ก่อนใช้; producer ตรง contract |

## Constraints

- Do not push directly to `main` or `develop`; review, commit and PR required
- Do not revert unrelated dirty-worktree changes, especially existing bugfix specs/tests and context/Kiro documentation
- Provider credentials must enter through environment allowlists only and must never reach untrusted analysis or logs
- Phase 1 ceiling remains GitHub PR gate with four configured lineages; do not add providers or policy axes without approved spec change
- Production activation ต้องผ่าน blockers และ acceptance checklist ใน `docs/08-pr-quality-gate-production.md`; ห้ามตีความเอกสารเสร็จว่า rollout เสร็จ

## Tests Run

- `scripts/spec-trace.sh universal-pr-quality-gate` -> 132/132 requirements covered; EARS lint passed
- `pnpm typecheck` -> passed across 6 workspace packages
- `pnpm lint` -> passed
- `pnpm build` -> passed; Vite emitted non-blocking chunk-size warning
- `pnpm vendor-check` -> passed
- `.ai/bin/check-secrets.sh --all` -> passed
- `git diff --check` -> passed
- `(cd core && node --test --test-reporter=dot src/pr-gate/kernel.test.ts src/pr-gate/checks.test.ts)` -> 18 passed
- `pnpm --filter core test` -> passed, 0 failed, 10 existing runtime-guarded tests skipped
- `pnpm --filter aal test` -> 192 passed, 0 failed
- `pnpm --filter adapters test` -> 50 passed, 0 failed
- `(cd console/backend && node --test --test-reporter=dot src/pr-gate/*.test.ts src/app-pr-gate.test.ts src/pr-gate-cli.test.ts)` -> 39 passed, 0 failed
- `pnpm --filter console-web test` -> 77 passed, 0 failed
- `pnpm --filter console-web typecheck && pnpm --filter console-web build` -> passed
- `ruby -e "require 'yaml'; ARGV.each { |path| YAML.load_file(path, aliases: true) }" .github/workflows/pr-quality-analysis.yml .github/workflows/pr-quality-finalize.yml` -> passed
- PR #138 bootstrap regression: workflow test, backend typecheck, lint และ pinned-base simulation -> passed
- guard regression tests 14/14, lessons coverage และ spec-trace active/archive specs 20/20 -> passed
- `pnpm test` -> exit `0`; Web 77, Core 612, AAL 192, Adapters 50 และ Backend 436 passed; Core มี 10 capability-gated skips
- custom Markdown check -> ไฟล์ Markdown ที่เปลี่ยน 29 ไฟล์มี H1 เดียว, heading hierarchy ถูกต้อง และ local links resolve ครบ
- manual high-risk token scan ของ `docs/08-pr-quality-gate-production.md` -> no matches
- `pnpm audit --prod --audit-level high` -> exit `0`; 1 low และ 4 moderate findings ต่ำกว่า blocking threshold
- `scripts/check-golden-manifests.sh` -> passed
- local browser smoke -> desktop และ `390x844` ผ่าน; PR Quality controls render, mobile ไม่มี horizontal overflow, console ไม่มี error

## Known Issues

- PR #138 ยังเปิด; current analysis job ใช้ exact bootstrap skip จึงยังไม่มี unprivileged analysis artifact จริง และ finalize workflow ยังไม่ถูก register บน default branch
- Repository เป็น public แต่ workflow ยังไม่มี repository-wide rate limit, contributor allowlist หรือ protected-environment approval; เปิด runner/secrets ตอนนี้มี denial-of-wallet risk
- GitHub API audit ณ 2026-08-10 พบ rulesets 0, `develop` ไม่มี branch protection, self-hosted runners 0 และ Actions secrets 0
- Workflow Actions ยังอ้าง moving major tags (`@v4`/`@v5`) ไม่ใช่ immutable full commit SHA
- Conformance records ปัจจุบัน: Claude 5, Codex 3, Gemini 0, OpenCode DeepSeek 0; production four-lineage quorum ยังไม่ครบ
- Conformance eligibility ยังตรวจเพียง `adapterId` + P1-P8; อายุ/`modelVersion` เป็น operator check และ current workflow จึงห้ามเปิด model override
- Runtime ไม่มี built-in retention/prune; state/evidence โตตาม run และต้องมี disk monitoring/backup ก่อน production
- `systemDecision` อาจเป็น `PASS` ขณะ publication ล้ม; operator ต้องตรวจ `publication`/Check Run ไม่ใช้ exit code อย่างเดียว
- Dependency audit reports 1 low and 4 moderate findings; current CI blocks high+ only
- Vite reports existing non-blocking chunk-size warning for Console bundle

## Next Recommended Agent

Human security/operations reviewer หลัง PR review และ matching CI checks.

## Next Steps

1. เพิ่ม abuse control และ pin ทุก GitHub Action เป็น full commit SHA ผ่าน reviewed PR; หรือใช้ private staging repository ตาม runbook.
2. Review และ merge PR #138 เมื่อ matching CI เขียว; ห้ามเปิด privileged rollout ก่อน merge.
3. Provision self-hosted runner, Actions secrets และ live conformance ทั้งสี่ lineage ตาม `docs/08-pr-quality-gate-production.md`.
4. รัน canary PR, ยืนยัน Check Run/evidence/state/alerts แล้วค่อยเปิด required ruleset บน `develop`.
