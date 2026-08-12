# Universal PR Quality Gate: Production Runbook

คู่มือ canonical สำหรับเปิดใช้และปฏิบัติการ Universal PR Quality Gate ใน production ครอบคลุม GitHub Actions, CLI, Console, REST API, workflow plumbing และ live conformance. เอกสารอื่นควรลิงก์มาที่นี่แทนการคัดลอกคำสั่งหรือ contract ซ้ำ.

## ขอบเขตและสถานะปัจจุบัน

ระบบตรวจ PR จาก exact current head ด้วย deterministic checks, blind reviewer panel สี่ lineage, Evidence Judge และ Check Run ที่แยก `systemDecision` ออกจาก `effectiveDecision`. Source of truth ของ runtime คือ `.ai/policies/pr-quality-gate.json`, `.github/workflows/pr-quality-*.yml` และ `console/backend/src/pr-gate/`.

สถานะตรวจจริงวันที่ 2026-08-10:

| รายการ | หลักฐานปัจจุบัน | ผลต่อ production |
|---|---|---|
| Implementation | PR [#138](https://github.com/metrodiesign/spec-driven-development/pull/138) ยัง `OPEN` ณ เวลาตรวจ | โค้ดยังไม่อยู่บน default branch `develop` |
| Analysis workflow | check เขียวเพราะ one-time bootstrap; install, analysis และ artifact steps ถูก skip | ยังไม่ใช่ end-to-end gate pass |
| Finalize workflow | ยังไม่อยู่บน default branch จึงยังไม่ถูก GitHub register | custom check `Universal PR Quality Gate` ยังไม่เกิด |
| Self-hosted runner | repository runners = `0` | finalize job รันไม่ได้หลัง workflow ถูก merge |
| Repository secrets | repository secrets = `0` | reviewer สี่ lineage ใช้งานไม่ได้ |
| Server-side enforcement | branch protection ตอบ `404 Branch not protected`; rulesets = `[]` | CI/gate เป็น advisory; GitHub ยังไม่ block merge |
| Conformance | Claude และ Codex มี record ล่าสุดที่ผ่าน; Gemini CLI และ OpenCode DeepSeek ไม่มี record | reviewer coverage ยังไม่ครบ production eligibility |
| Repository exposure | repository เป็น `PUBLIC` | ต้องปิด abuse path ก่อนผูก runner และ paid credentials |
| Actions supply chain | workflow ปัจจุบันอ้าง `actions/*@v4`, `actions/setup-python@v5` และ `pnpm/action-setup@v4` | moving tags ไม่ immutable; ต้อง pin full commit SHA ผ่าน reviewed PR ก่อน production |

สรุป: implementation ผ่าน test แต่ production activation ยังไม่เสร็จ. ห้ามตั้ง `Universal PR Quality Gate` เป็น required check ก่อนมี canary end-to-end ที่สร้าง check นี้จริง.

### Production blocker สำหรับ public repository

Trust split ปัจจุบันลดโอกาสเปิดเผย secret โดยไม่ checkout/execute fork head ใน privileged finalize แต่ไม่ได้ลบความเสี่ยงจาก public self-hosted runner, malicious artifact/parser, dependency supply chain หรือ credential misuse. Workflow ยังเริ่ม finalize อัตโนมัติหลัง analysis สำเร็จทุก PR. Policy จำกัด `maxCostUnits` ต่อ run แต่ไม่มี repository-wide rate limit, contributor allowlist หรือ environment approval จึงยังกัน denial-of-wallet จาก PR จำนวนมากไม่ได้.

สำหรับ public repository นี้ ห้ามลงทะเบียน self-hosted runner พร้อม provider secrets จนมี PR แยกที่เพิ่ม abuse control ใน trusted workflow เช่น protected GitHub Environment พร้อม required reviewer หรือ trusted-contributor admission policy. ทางเลือกชั่วคราวที่ปลอดภัยกว่าคือทดลองใน private staging repository ที่จำกัดผู้เปิด PR.

## Root cause ที่ยืนยันแล้วและผลก่อน-หลัง

ตารางนี้อ้าง reproduction, stack/error และ fix contract ใน bugfix specs; ไม่อนุมานจากอาการ:

| Incident | หลักฐานและ root cause | ก่อนแก้ | หลังแก้ล่าสุด |
|---|---|---|---|
| Console system stats 500 | [`bugfix-system-stats-degradation`](../.ai/specs/bugfix-system-stats-degradation/bugfix.md): managed macOS ทำ `os.uptime()` throw `ERR_SYSTEM_ERROR: uv_uptime returned EPERM`; route ประกอบ metrics ใน expression เดียวโดยไม่มี per-metric boundary | metric เดียวล้มทำ `/api/system/stats` ทั้ง route เป็น Fastify 500 และทิ้ง metric ที่อ่านได้ | capture แยกราย metric; ตอบ HTTP 200, ค่าที่อ่านไม่ได้เป็น `null`, พร้อม `degraded`/`unavailableMetrics`; UI แสดง `unavailable` |
| Loop repair escalated ใน test | [`bugfix-loop-run-nested-sandbox`](../.ai/specs/bugfix-loop-run-nested-sandbox/bugfix.md): synthetic test เรียก production `denyNetworkSandbox` ภายใน sandbox อีกชั้น; `/usr/bin/sandbox-exec` ล้ม `sandbox_apply: Operation not permitted`; `ECONNREFUSED` เป็น downstream cascade ไม่ใช่ต้นเหตุ | ทุก T0 check เป็น `sandbox_unavailable`, repair หมด hypothesis แล้ว `ESCALATED` แม้ planning gate ถูกต้อง | synthetic tests inject sandbox เฉพาะภายใต้ test guard; production ยังใช้ real fail-closed sandbox; real SBPL tests แยกยืนยัน boundary |
| Spec slice fallback เป็น full read | [`bugfix-spec-slice-contract`](../.ai/specs/bugfix-spec-slice-contract/bugfix.md): validator เดิมตรวจแค่ token `REQ-*`, ไม่ตรวจ table schema และ exact H2 ของ `Section`; producer จึงสร้าง schema เก่าแล้ว slicer คืน `MISSING` | context loader fallback อ่าน requirements เต็ม ทำ token/context โตและซ่อน producer drift | validator บังคับ schema + exact H2 บน active spec; producer docs ตรง contract; invalid slice fail ชัดก่อน fallback |

ผลรวม: Console ทนต่อ OS metric degradation, test ไม่สับสน nested-sandbox limitation กับ product defect และ context slice ตรวจ contract ต้นทางก่อนใช้. Production sandbox, fail-closed behavior และ EARS trace ไม่ถูกลดความเข้ม.

## สถาปัตยกรรม production

| ระยะ | Runner | Credential | งานที่ทำ | Trust boundary |
|---|---|---|---|---|
| `PR Quality Analysis` | GitHub-hosted `macos-latest` | `contents: read`, `pull-requests: read` | checkout trusted base, pin PR, materialize snapshot, รัน deterministic checks, upload artifact 1 วัน | ไม่มี provider secret หรือ `checks: write`; PR data เป็น untrusted |
| `PR Quality Finalize` | dedicated `[self-hosted, macOS]` | provider secrets และ `checks: write` | checkout default branch, download artifact ตาม workflow run id, verify provenance/source/policy/integrity, รัน reviewers/Judge, publish Check Run | ห้าม checkout หรือ execute PR head; child provider ไม่ได้รับ `GITHUB_TOKEN` |
| Operator plane | dedicated trusted host | operator session และ GitHub Checks credential เมื่อ publish | list/detail/cancel/override ผ่าน manager เดียวกับ CLI/API | override ผูก exact head, durable, audited และ idempotent |

`pull_request_target` ไม่ถูกใช้. Artifact signature ที่ artifact สร้างเองไม่ใช่ trust anchor; finalize re-fetch Git objects และตรวจ workflow run id, repository, event, PR, head SHA, policy hash, manifest hash และ deterministic report ก่อนเปิด credential boundary.

## ช่องทางเรียกใช้

| ประเภท | เหมาะกับ | พฤติกรรมสำคัญ | คำแนะนำ production |
|---|---|---|---|
| GitHub Actions split workflow | gate อัตโนมัติทุก PR | unprivileged analysis แล้ว trusted finalize | ช่องทางหลักหลัง activation checklist ผ่าน |
| Direct CLI `pr-gate run` | operator run แบบ synchronous | host เดียว pin snapshot, รัน checks, providers และ report | ใช้เฉพาะ trusted/admission-controlled PR บน dedicated host; มี quota spend ทันที |
| Console UI | operator run แบบ asynchronous | start/list/detail/cancel/override ผ่าน manager durable | ใช้เฉพาะ trusted/admission-controlled PR; loopback หรือ TLS proxy + auth |
| REST API | automation รอบ Console | contract เดียวกับ UI; actor มาจาก server session | ไม่มี service-account auth; remote automation ต้องถือ operator session |
| `analyze` / `finalize` | GitHub workflow plumbing และ incident recovery | ต้องส่ง provenance arguments ครบ | ไม่ใช่ public operator API; ห้ามประกอบ artifact ข้าม run |
| `conformance --live` | ตรวจ adapter ก่อนให้ reviewer slot eligible | P1-P8, ราว 10 real requests ต่อ lineage | รันจาก TTY หลังตรวจ quota; ไม่ใช่ PR decision |

PR decision channels (`finalize`, Direct CLI, Console และ REST) ใช้ governed policy และ durable runtime เดียวกัน. `analyze` สร้าง unprivileged artifact; `conformance --live` เป็น eligibility test แยก ไม่สร้าง PR decision. Direct CLI, Console และ REST ไม่ได้ใช้ GitHub trust split: deterministic PR commands รันบน host เดียวกับ provider/GitHub credentials. ห้ามใช้กับ untrusted public PR จนมี admission control; production ปกติให้ใช้ split GitHub Actions.

## Prerequisites

### Software และ host

| รายการ | Requirement |
|---|---|
| macOS | runner label ต้อง match `self-hosted` และ `macOS`; deterministic sandbox พึ่ง `sandbox-exec` |
| Node | `>=26`; repository pin ผ่าน `.nvmrc` |
| pnpm | `11.9.0`; repository pin ผ่าน `packageManager` |
| Git | ต้อง fetch exact PR refs และ pinned objects ได้ |
| Provider runtime | Claude ใช้ installed SDK; Codex ต้องมี `codex`; Gemini ต้องมี `gemini`; OpenCode DeepSeek ต้องมี `opencode` |
| Network | runner ติดต่อ GitHub/Actions, package registry และ provider endpoints ผ่าน outbound HTTPS; deterministic PR commands ยังถูก network-deny |
| Storage | service account ต้องเขียน `~/.platform/pr-gate` และ repository `.ai/calibration` ได้ |

ตรวจ host ก่อนเปิดใช้:

```bash
node --version
pnpm --version
git --version
codex --version
gemini --version
opencode --version
```

Runner ต้องเป็น dedicated service account. ไม่แชร์กับ build จาก repository อื่น และไม่ใช้เครื่องส่วนตัวที่มี credential กว้างเกินงาน. GitHub เตือนว่า self-hosted runner บน public repository อาจถูกโจมตีผ่าน workflow; ใช้ ephemeral/JIT runner เมื่อทำได้.

Workflow dependency ทุกตัวต้อง pin ด้วย full commit SHA ที่ review แล้วก่อน production. Major tag เช่น `@v4` หรือ `@v5` เปลี่ยน target ได้ภายหลัง จึงไม่ใช่ immutable supply-chain boundary.

### Credential

| ชื่อ | ผู้ใช้ | ขอบเขตขั้นต่ำ |
|---|---|---|
| `GITHUB_TOKEN` | analysis read, finalize report, direct/Console read+report | GitHub Actions token ใน workflow; direct/Console ใช้ fine-grained token หรือ GitHub App token ที่มี Contents/Pull requests read และ Checks write |
| `ANTHROPIC_API_KEY` | Claude reviewer และ Judge | provider account ที่จำกัด quota ตาม production budget |
| `OPENAI_API_KEY` | Codex reviewer | provider account ที่จำกัด quota |
| `GEMINI_API_KEY` | Gemini CLI reviewer | provider account ที่จำกัด quota |
| `DEEPSEEK_API_KEY` | OpenCode DeepSeek reviewer | provider account ที่จำกัด quota |

ห้ามใส่ token ใน command argument, workflow file, `.env`, log หรือ repository. `gh secret list` แสดงเฉพาะชื่อและเวลา ไม่แสดงค่า จึงใช้ตรวจ presence ได้.

Model override ที่ PR gate runtime รองรับคือ `PR_GATE_CLAUDE_MODEL`, `PR_GATE_CODEX_MODEL`, `PR_GATE_GEMINI_MODEL` และ `PR_GATE_DEEPSEEK_MODEL`. Workflow ปัจจุบันไม่ส่งตัวแปรเหล่านี้ จึงใช้ provider defaults.

ข้อจำกัดปัจจุบัน: eligibility ตรวจ `adapterId` และผล P1-P8 แต่ยังไม่ enforce อายุหรือ `modelVersion` ของ record. `conformance --live` รับ model override เดียวกับ gate เฉพาะ Gemini/OpenCode; Claude ใช้ automation policy model และ Codex ใช้ CLI default. Production จึงต้องปล่อย override ทั้งสี่ว่างตาม workflow ปัจจุบัน. การเปิด override ต้องผ่าน reviewed code/workflow change, สร้าง conformance record จาก model เดียวกัน และเพิ่ม operator check อายุ/`modelVersion`; ห้ามเปิด Claude/Codex override จน conformance path เลือก model เดียวกับ gate ได้.

### Policy ปัจจุบัน

| ค่า | Production contract |
|---|---|
| Reviewer count | 4 |
| Blocking severity | `HIGH` |
| Provider timeout | 600,000 ms ต่อ call |
| Run deadline | 1,800,000 ms |
| Cost cap | 40 units ต่อ run |
| Risk floor | `LOW`; OpenAPI profile ยกเป็น `HIGH` |
| Human approval | false โดย default |
| Node checks | `pnpm typecheck`, `pnpm lint`, `pnpm test`; required, 300,000 ms, network none, install false |
| Docs/config checks | ไม่มี command check; ยังผ่าน structured review |
| OpenAPI check | `builtin:openapi-contract-diff`; required |

Repository policy เพิ่มความเข้มได้ แต่ลด organization floor ไม่ได้. Policy เปลี่ยนแล้ว direct/finalize จะ fail closed จนมนุษย์ตรวจและ approve proposal.

### ประเภท PR และ check ที่ถูกเรียก

Classification อ่าน path จาก pinned change set เท่านั้น. PR ที่ตรงหลายประเภท activate ทุก profile,
รวม checks แบบ deduplicate และใช้ risk สูงสุด:

| ประเภท change | ตัวอย่างที่ตรวจจับ | Profile/risk | Deterministic checks | ผลที่ต้องระวัง |
|---|---|---|---|---|
| Node.js/TypeScript | `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, test files, `package.json`, lockfiles | `node-typescript`; runtime ปกติ `MEDIUM`, public API `HIGH`, dependency `MEDIUM` | `pnpm typecheck`, `pnpm lint`, `pnpm test` | ทุก check required; fail/timeout block |
| Documentation | `.md`, `.mdx`, `.rst`, `.txt` | `docs-config`, `LOW` | ไม่มี command check ใน policy ปัจจุบัน | ยังต้องผ่าน four-lineage structured review; ไม่ใช่ auto-pass |
| Configuration | `.json`, `.yaml`, `.yml`, `.toml`, `Dockerfile`, `Makefile` | `docs-config`, `MEDIUM` | ไม่มี command check เว้นแต่ activate profile อื่นร่วม | secret/security/consistency review ยังทำงาน |
| OpenAPI/Swagger | `openapi.yaml`, `openapi.v1.json`, `swagger.yml` ตาม classifier | `openapi`, floor `HIGH` | `builtin:openapi-contract-diff` | public contract diff required; risk อย่างน้อย `HIGH` |
| Mixed | หลายชนิดใน PR เดียว | union ทุก profile, risk สูงสุด | union checks | profile หนึ่งล้มทำ decision ตาม required floor |
| Unsupported/เกินเพดาน | extension อื่น หรือหลัง 500 changed files | coverage `LIMITED` พร้อม omitted paths/reasons | checks ของ profile ที่รู้จักยังรัน | decision ceiling เป็น `HUMAN_REVIEW_REQUIRED`; ห้ามตีความ partial checks ว่าครบ |

Rename ตรวจทั้ง previous path และ current path. Classification ไม่ลด risk floor จาก organization/repository policy และ docs-only PR ยังใช้ reviewer/Judge/cost/deadline contract เดียวกับ code PR.

## เปิดใช้ครั้งแรก

ทำตามลำดับ. Public repository ต้องแก้ production blocker ด้าน abuse control ก่อนข้อ 2.

1. Merge implementation PR เข้า default branch ผ่าน CI และ review ปกติ. One-time bootstrap SHA ใช้ได้เฉพาะ PR แรก; ห้ามแก้หรือ reuse exemption. จากนั้นเปิด reviewed PR แยกเพื่อ pin ทุก `uses:` เป็น full commit SHA และเพิ่ม public-repo abuse control ก่อนผูก runner/secrets.

2. เปิด GitHub `Settings > Actions > Runners > New self-hosted runner`, เลือก macOS แล้วรันคำสั่ง registration ที่ GitHub สร้างให้บน dedicated host. Token registration มีอายุสั้นและห้ามบันทึกลงเอกสารหรือ log. ติดตั้ง runner เป็น service เพื่อให้กลับมาหลัง reboot.

3. ยืนยัน runner เป็น `online`, ไม่ busy และมี labels `self-hosted`, `macOS`:

```bash
gh api repos/OWNER/REPO/actions/runners \
  --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
```

หาก label ไม่ match job จะค้าง queued; GitHub ระบุว่า job ที่หา runner ไม่พบจะ fail หลัง 24 ชั่วโมง.

4. เพิ่ม provider secrets แบบ interactive. ไม่ใช้ `--body` เพราะค่าจะเข้า shell history:

```bash
gh secret set ANTHROPIC_API_KEY --repo OWNER/REPO
gh secret set OPENAI_API_KEY --repo OWNER/REPO
gh secret set GEMINI_API_KEY --repo OWNER/REPO
gh secret set DEEPSEEK_API_KEY --repo OWNER/REPO
gh secret list --repo OWNER/REPO
```

5. จาก trusted checkout ของ default branch ติดตั้ง dependency โดยไม่รัน lifecycle script และยืนยัน governance:

```bash
pnpm install --frozen-lockfile --ignore-scripts
node console/backend/bin/platform.ts governance list
```

ถ้า output มี proposal ให้ตรวจ diff ของ `.ai/policies/`, hash ก่อน/หลัง และ rationale ก่อน approve:

```bash
node console/backend/bin/platform.ts governance approve GOV_ID
```

ห้าม auto-approve governance ใน startup script.

6. ตรวจ quota/provider usage จาก account จริง แล้วรัน conformance จาก interactive TTY ทีละ lineage. ระบบจะขอพิมพ์ `RUN-LIVE` ทุกครั้งและใช้ราว 10 real requests ต่อ lineage:

```bash
node console/backend/bin/platform.ts conformance --live --lineage claude --force-quota-override
node console/backend/bin/platform.ts conformance --live --lineage codex --force-quota-override
node console/backend/bin/platform.ts conformance --live --lineage gemini-cli --force-quota-override
node console/backend/bin/platform.ts conformance --live --lineage opencode-deepseek --force-quota-override
```

ใช้ `--force-quota-override` เฉพาะหลังมนุษย์ตรวจ headroom; มัน bypass แค่ estimator ที่ไม่มี percentage ไม่ bypass hard budget. ต้องเห็น P1-P8 `PASS` ทุก lineage และ commit record/evidence ผ่าน PR หลัง secret scan. รันใหม่หลัง model, adapter, auth หรือ provider behavior เปลี่ยน.

7. เปิด canary PR ขนาดเล็กใน staging. ยืนยัน flow ครบ: analysis สร้าง artifact, finalize เริ่มบน dedicated runner, reviewer สี่ตัว success, custom check `Universal PR Quality Gate` ผูก exact head และไม่มี secret ใน log.

8. หลัง canary เท่านั้น เปิด ruleset สำหรับ `develop`: require pull request, block force push และ require exact status checks ต่อไปนี้:

```text
platform (vendor check + typecheck + lint + tests)
guards + spec-trace
Universal PR Quality Gate
```

GitHub ให้เลือก required check ที่เคย report ล่าสุดก่อน จึงต้องรัน canary ก่อนตั้ง rule. ตรวจผล:

```bash
gh api repos/OWNER/REPO/rulesets
gh api repos/OWNER/REPO/branches/develop/protection
```

9. ทดสอบ negative canary: deterministic failure ต้อง `FAIL`; provider ขาดหนึ่งตัวต้องอย่างมาก `PASS_WITH_WARNINGS`; stale head ต้องห้าม publish PASS; override ต้อง reject เมื่อ head เปลี่ยน.

10. Promote จาก staging สู่ production ตาม change window. บันทึก runner identity, conformance record paths, policy hash, canary PR, ruleset id และ rollback owner ใน release note.

## GitHub Actions operation

เมื่อ PR เปิดหรือ update:

1. `PR Quality Analysis` checkout base SHA ที่ trusted, `persist-credentials: false`, install ด้วย `--ignore-scripts`, fetch exact PR object และรัน deterministic checks บน detached snapshot.
2. Artifact ชื่อ `pr-quality-analysis-<workflow-run-id>` ถูกเก็บ 1 วัน. Analysis process ลบ `GITHUB_TOKEN` ออกจาก environment ก่อนสร้าง executor/provider boundary.
3. `PR Quality Finalize` ตื่นผ่าน `workflow_run` เฉพาะเมื่อ analysis conclusion เป็น success, checkout default branch ไม่ใช่ PR head และดาวน์โหลด artifact ด้วย exact run id.
4. Finalize re-fetch source/policy, verify provenance/integrity แล้วจึงรัน reviewers/Judge และ publish `Universal PR Quality Gate`.

Decision mapping:

| System decision | GitHub conclusion | CLI exit | Operator action |
|---|---|---|---|
| `PASS` | success | 0 | merge ได้เมื่อ required checks อื่นผ่าน |
| `PASS_WITH_WARNINGS` | success | 0 | อ่าน warning ก่อน merge |
| `HUMAN_REVIEW_REQUIRED` | action required | 2 | ตรวจ evidence แล้ว override เฉพาะ exact current head |
| `FAIL` | failure | 3 | แก้ PR; ห้าม override เพื่อข้าม deterministic blocker โดยไม่มี incident authority |
| `INFRASTRUCTURE_FAILURE` | failure | 4 | แก้ runner/provider/provenance แล้ว rerun |

Argument error หรือ runtime exception ก่อน decision ใช้ exit 1. Policy ที่ยังไม่ approve ใช้ exit 5.

CLI exit อิง `systemDecision` เท่านั้น. Exit 0 ไม่พิสูจน์ว่า Check Run ถูก publish: ต้องเห็น `publication == "PUBLISHED"` และตรวจ `Universal PR Quality Gate` บน exact head แยก. `publication == "FAILED"`/state `REPORTING_FAILED` ต้องถือเป็น operational failure แม้ `systemDecision` เป็น `PASS`.

## Direct CLI

Direct CLI เหมาะกับ manual incident/canary บน dedicated host. มัน synchronous, อาจใช้เวลาถึง deadline 30 นาที และเริ่ม provider spend โดยไม่มี typed confirmation.

1. Checkout repository ที่ตรงกับ `--repo`, ยืนยัน `origin` ชี้ target เดียวกัน และอยู่บน trusted default branch:

```bash
git remote get-url origin
git branch --show-current
git status --short
```

2. Inject GitHub/provider credentials จาก secret manager เข้าสู่ process environment โดยตรง. หากต้องกรอกมือ ใช้ hidden prompt; ห้ามส่งค่าเป็น command argument:

```zsh
read -r -s "GITHUB_TOKEN?GitHub token: "
printf '\n'
export GITHUB_TOKEN
read -r -s "ANTHROPIC_API_KEY?Anthropic key: "
printf '\n'
read -r -s "OPENAI_API_KEY?OpenAI key: "
printf '\n'
read -r -s "GEMINI_API_KEY?Gemini key: "
printf '\n'
read -r -s "DEEPSEEK_API_KEY?DeepSeek key: "
printf '\n'
export ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY
```

3. ตรวจ governance และ conformance ก่อนรัน:

```bash
node console/backend/bin/platform.ts governance list
ls .ai/calibration/conformance-*.json
```

4. รัน exact PR:

```bash
node console/backend/bin/platform.ts pr-gate run \
  --repo OWNER/REPO \
  --pr 123
```

stdout เป็น JSON projection. เก็บ `runId`, `headSha`, `systemDecision`, `effectiveDecision`, `reportRef`, `publication` และ exit code ใน incident evidence. ล้าง shell variable หลังจบ:

```bash
unset GITHUB_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY
```

ถ้าไม่มี GitHub token ระบบอาจอ่าน public repository ได้แต่ไม่สร้าง Check Run. Direct CLI รัน deterministic commands จาก PR snapshot บน host เดียว จึงห้ามใช้บน shared workstation หรือ public fork ที่ไม่ได้ผ่าน admission control.

## Console UI

### Loopback operator

Build frontend และเปิด Console บน loopback. Auth เป็น optional เฉพาะเมื่อไม่มี `~/.platform/console-auth.json`; หากไฟล์มีอยู่ ระบบโหลดและบังคับ provider เดิมแม้ bind loopback:

```bash
pnpm --filter console-web build
node console/backend/bin/platform.ts console --no-open
```

เปิด `http://127.0.0.1:9119`, เลือก `PR Quality`, กรอก `owner/repo` และ PR number แล้วเลือก `Start review`. รายการ refresh ทุก 4 วินาที; detail แยก deterministic failures, AI findings, coverage, cost, publication และ override history.

Cancel ใช้ได้เฉพาะ active state. Override ควรใช้เมื่อ state เป็น `AWAITING_HUMAN`; ใส่ reason ที่ตรวจสอบย้อนหลังได้และ finding ids ที่ตัดสิน. UI จะผูก current head และสร้าง idempotency key ใหม่ให้เอง.

Console startup สร้าง durable state ที่ `~/.platform/pr-gate`. ถ้า process restart ระหว่าง active run ระบบ recover เป็น `FAILED_INFRASTRUCTURE` พร้อม reason `process_restart`; ไม่ resume model call กลางทาง.

### Remote Console ด้วย Basic auth

สร้าง config `~/.platform/console-auth.json` แบบไม่เก็บ plaintext password. คำสั่งนี้ถาม password แบบ hidden, ส่งผ่าน child environment ชั่วคราว และสร้างไฟล์ mode `0600`:

```zsh
read -r -s "CONSOLE_PASSWORD?Console password: "
printf '\n'
export CONSOLE_PASSWORD
node --input-type=module <<'NODE'
import { randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const password = process.env.CONSOLE_PASSWORD;
if (!password) throw new Error('empty console password');
const salt = randomBytes(16).toString('hex');
const config = {
  provider: 'basic',
  scryptHash: scryptSync(password, salt, 64).toString('hex'),
  salt,
  signingSecret: randomBytes(32).toString('hex'),
};
const dir = join(homedir(), '.platform');
const path = join(dir, 'console-auth.json');
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
chmodSync(path, 0o600);
process.stdout.write(`wrote ${path}\n`);
NODE
unset CONSOLE_PASSWORD
```

`flag: 'wx'` ทำให้คำสั่ง fail ถ้า config มีอยู่แล้ว ป้องกัน overwrite signing secret/session โดยไม่ตั้งใจ. การ rotate ต้อง backup, เขียนไฟล์ใหม่แบบ atomic และยอมรับว่า session เดิมทั้งหมดจะใช้ไม่ได้.

วาง TLS reverse proxy หน้า loopback แล้ว start ด้วย public HTTPS origin:

```bash
node console/backend/bin/platform.ts console \
  --host 127.0.0.1 \
  --behind-proxy https://console.example.com \
  --no-open
```

Proxy ต้อง terminate TLS, forward ไป `127.0.0.1:9119`, preserve public `Host`, รองรับ WebSocket
upgrade สำหรับ F-Chat และห้าม expose backend port โดยตรง.

`--behind-proxy` บังคับ auth, allowlist public host, ใช้ Secure cookie และถือทุก request เป็น remote. F-Term/terminal WS tickets และ MCP Authenticate ถูกปิดโดย design; PR Quality, F-Chat และ view ที่ผ่าน session auth ยังใช้ได้. Session อายุ 12 ชั่วโมง; Basic login lock 5 นาทีหลัง fail 5 ครั้งต่อ source IP.

ห้ามใช้ `--insecure` บน untrusted network. เมื่อใช้ `--behind-proxy`, flag นี้ถูก ignore และ auth ยัง fail closed.

### Remote Console ด้วย Google OIDC

สร้าง Google OAuth web client ที่ callback ตรงกับ public origin แล้ววางไฟล์ mode `0600` นอก repository:

```json
{
  "provider": "oidc",
  "clientId": "<google-client-id>",
  "clientSecret": "<secret-manager-value>",
  "redirectUri": "https://console.example.com/auth/oidc/callback",
  "allowedSub": "<single-operator-google-sub>",
  "signingSecret": "<random-64-hex>"
}
```

```bash
chmod 600 ~/.platform/console-auth.json
node console/backend/bin/platform.ts console \
  --host 127.0.0.1 \
  --behind-proxy https://console.example.com \
  --no-open
```

Issuer ถูก pin เป็น `https://accounts.google.com`; callback ตรวจ PKCE, state, nonce, issuer, audience และ exact `allowedSub`. `--behind-proxy` override `redirectUri` ในไฟล์เป็น `<public-origin>/auth/oidc/callback`, จึงต้องให้ Google client allow URI เดียวกัน. Logout ล้าง local session แต่ไม่ revoke Google session.

## REST API

API มีเฉพาะเมื่อ Console process ทำงาน. ตัวอย่าง loopback ใช้ base URL ต่อไปนี้:

```bash
export PLATFORM_URL='http://127.0.0.1:9119'
```

### Start และอ่าน run

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$PLATFORM_URL/api/pr-quality/runs" \
  -H 'Content-Type: application/json' \
  --data '{"repository":"OWNER/REPO","pullRequest":123}' | jq

curl --fail-with-body --silent --show-error \
  "$PLATFORM_URL/api/pr-quality/runs?limit=50" | jq

curl --fail-with-body --silent --show-error \
  "$PLATFORM_URL/api/pr-quality/runs/RUN_ID" | jq
```

Start ตอบ HTTP 202 พร้อม `runId`. `limit` ต้องเป็น positive integer และถูก cap ที่ 100. Detail ตอบ 404 เมื่อไม่พบ run และ 503 เมื่ออ่าน current PR head ไม่ได้.

### Cancel

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$PLATFORM_URL/api/pr-quality/runs/RUN_ID/cancel" | jq
```

Cancel เป็น request แบบ cooperative. SDK transport รับ abort signal; CLI transports ส่ง
`SIGTERM` แล้ว `SIGKILL` หลัง grace period ถ้ายังไม่จบ.

### Override

อ่าน `headStatus.currentHeadSha` จาก detail ทุกครั้ง. ห้าม reuse SHA จาก PR page หรือ run เก่า:

```bash
export OVERRIDE_KEY="$(uuidgen)"
curl --fail-with-body --silent --show-error \
  -X POST "$PLATFORM_URL/api/pr-quality/runs/RUN_ID/override" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $OVERRIDE_KEY" \
  --data '{
    "headSha":"CURRENT_HEAD_SHA_FROM_DETAIL",
    "action":"APPROVE",
    "reason":"Reviewed unresolved findings against exact head",
    "findingIds":["FINDING_ID"]
  }' | jq
unset OVERRIDE_KEY
```

`action` รับ `APPROVE` หรือ `REJECT`. Header `Idempotency-Key`, `headSha`, non-empty `reason` และ array `findingIds` บังคับทั้งหมด. Same key + same payload replay ได้; same key + payload เปลี่ยนถูก reject. Head เปลี่ยนหรือ decision state conflict ตอบ 409. `systemDecision` ไม่ถูกแก้; `effectiveDecision` จึงแสดงผล override แยก.

### Remote API session

Remote API ไม่มี bearer/service-account token โดย design; ใช้ operator session cookie เดียวกับ Console. Basic auth automation ตัวอย่าง:

```zsh
COOKIE_JAR="$(mktemp)"
chmod 600 "$COOKIE_JAR"
read -r -s "CONSOLE_PASSWORD?Console password: "
printf '\n'
jq -nc --arg password "$CONSOLE_PASSWORD" '{password:$password}' | \
  curl --fail-with-body --silent --show-error \
    -X POST 'https://console.example.com/auth/login' \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    -c "$COOKIE_JAR"
unset CONSOLE_PASSWORD

curl --fail-with-body --silent --show-error \
  -b "$COOKIE_JAR" \
  'https://console.example.com/api/pr-quality/runs?limit=50' | jq
```

ลบ cookie jar เมื่อจบ session ตาม policy ของ host:

```bash
test -n "$COOKIE_JAR" && test -f "$COOKIE_JAR" && rm -f -- "$COOKIE_JAR"
unset COOKIE_JAR
```

OIDC ต้อง login ผ่าน browser; ระบบไม่มี OAuth client credential flow สำหรับ automation.

## Low-level workflow commands

ใช้สองคำสั่งนี้เฉพาะ workflow implementation หรือ incident recovery. GitHub Actions files คือ caller production ปกติ.

### Unprivileged analyze

รันจาก trusted base checkout. Output path ต้องยังไม่มี; writer ใช้ exclusive create และ mode `0600`:

```bash
node console/backend/bin/platform.ts pr-gate analyze \
  --repo OWNER/REPO \
  --pr 123 \
  --workflow-run-id 123456789 \
  --out /secure/path/pr-quality-analysis.json
```

Token ที่ให้ analyze ต้อง read-only. คำสั่งเก็บ token ไว้เฉพาะ GitHub read port แล้วลบ `GITHUB_TOKEN` จาก process environment ก่อนสร้าง untrusted executor.

### Trusted finalize

รันจาก trusted default-branch checkout และใช้ artifact จาก workflow run เดียวกันเท่านั้น:

```bash
node console/backend/bin/platform.ts pr-gate finalize \
  --artifact /secure/path/pr-quality-analysis.json \
  --repo OWNER/REPO \
  --workflow-run-id 123456789 \
  --source-head TRUSTED_WORKFLOW_HEAD_SHA
```

Artifact file เกิน 90 MiB ถูก reject. ภายในรับ evidence ไม่เกิน 256 entries และ 64 MiB รวม. Provenance หรือ integrity mismatch ต้องจบก่อน provider/reporter credential ถูกใช้. ห้ามแก้ JSON, copy ระหว่าง run หรือใช้ artifact จาก head อื่น.

Finalize ใช้ exit mapping เดียวกับ Direct CLI. หลัง exit 0 ยังต้องตรวจ projection ว่า `publication == "PUBLISHED"`; decision durable แต่ reporter ล้มสามารถจบที่ `REPORTING_FAILED` โดยไม่เปลี่ยน `systemDecision`.

## Decision, coverage และ override

| Reviewer success | Coverage | Decision ceiling เมื่อไม่มี blocker |
|---|---|---|
| 4 | `FULL` | `PASS` |
| 3 | `DEGRADED` | `PASS_WITH_WARNINGS` |
| 2 | `INSUFFICIENT` | `HUMAN_REVIEW_REQUIRED` |
| 0–1 | `INFRASTRUCTURE_FAILURE` | `INFRASTRUCTURE_FAILURE` |

Required deterministic check ที่ `FAILED` หรือ `TIMED_OUT` และ Judge-verified `HIGH`/`CRITICAL` ทำให้ `FAIL`. Infrastructure failure ของ required check ทำให้ `INFRASTRUCTURE_FAILURE`. Judge หาย, critical risk, limited analysis, policy-required human หรือ unresolved blocking finding ทำให้ `HUMAN_REVIEW_REQUIRED`.

Human override ต้องมี durable decision, exact current head, server-derived actor, reason และ idempotency key. ใช้ override เป็น exception record ไม่ใช่ retry mechanism. ถ้า run มาจาก GitHub finalize แล้วต้อง publish override กลับ Check Run, Console process ต้องรันเป็น service account เดียวที่เห็น `~/.platform/pr-gate` และมี fine-grained/GitHub App token ที่ `Checks: write`; classic PAT ไม่ควรถูกสมมติว่าเขียน Checks API ได้.

## State, monitoring และ retention

| Path | เนื้อหา |
|---|---|
| `~/.platform/pr-gate/events.db` | append-only lifecycle, decision, reporting และ override events |
| `~/.platform/pr-gate/runs/` | typed run artifacts |
| `~/.platform/pr-gate/evidence/` | content-addressed evidence |
| `~/.platform/pr-gate/snapshots/` | detached exact-head snapshots |
| `~/.platform/pr-gate/replay/` | provider replay ภายใน run |
| `~/.platform/pr-gate/agent-sessions/` | isolated provider working directories |
| `~/.platform/pr-gate-analysis/<workflowRunId>/` | temporary unprivileged analysis state |
| `.ai/calibration/` | committed conformance records/evidence |

Runtime ปัจจุบันไม่มี built-in retention/prune command สำหรับ `~/.platform/pr-gate`. ข้อมูลจึงโตตามจำนวน run. Production ต้อง monitor disk, backup durable state ตาม retention policy ขององค์กร และห้ามลบไฟล์ราย path ระหว่างมี active run. หากต้อง purge ให้สร้าง reviewed feature/PR ที่กำหนด eligibility, referential integrity, audit record และ rollback; ห้ามใช้ ad-hoc recursive delete.

Monitor อย่างน้อย:

1. GitHub workflow queue time, conclusion และ `Universal PR Quality Gate` publication.
2. Runner `online`/`busy`, disk, service restart และ runner version.
3. Run states `FAILED_INFRASTRUCTURE`, `REPORTING_FAILED`, `FAILED_INTERNAL`, `CANCELLED_STALE`.
4. Reviewer status ต่อ lineage, coverage, deadline และ cost units.
5. Conformance record age/modelVersion หลัง provider/model change.
6. Provider quota/rate-limit แยกจาก policy cost units; cost units ไม่ใช่เงินจริง.

Console host stats endpoint degrade ราย metric และยังตอบ HTTP 200:

```bash
curl --fail-with-body --silent --show-error \
  "$PLATFORM_URL/api/system/stats" | jq '{degraded,unavailableMetrics,uptimeS,freeMem}'
```

Alert ต้องดู `degraded == true` และ `unavailableMetrics`; ห้ามใช้ HTTP status อย่างเดียว. Metric ที่ capture ไม่ได้เป็น `null`, UI แสดง `unavailable`.

## Troubleshooting

| อาการ | Root cause ที่ contract รองรับ | ตรวจและแก้ |
|---|---|---|
| Analysis เขียวแต่ steps ถูก skip | exact pinned bootstrap base SHA | ใช้ได้ครั้งเดียว; merge control plane แล้วทดสอบ PR ใหม่ |
| Analysis fail `Trusted base missing pr-gate analyze` | base ไม่ใช่ bootstrap และไม่มี handler | restore trusted control-plane code ผ่าน PR; ห้ามขยาย exemption |
| Finalize queued | ไม่มี runner online หรือ labels ไม่ match | ตรวจ runner API, service และ labels `self-hosted`,`macOS` |
| Finalize workflow ไม่ปรากฏ | file ยังไม่อยู่ default branch | merge workflow ผ่าน PR ก่อน; `workflow_run` ต้องมี workflow file บน default branch |
| `policy_unapproved` / exit 5 | policy bytes ไม่ตรง approved governance snapshot | `governance list`, ตรวจ diff/hash/rationale แล้ว approve id ที่ถูกต้อง |
| Reviewer unavailable | binary/key/auth/conformance record ขาด หรือ provider timeout | ตรวจ executable, secret presence, provider log ที่ redact แล้วรัน conformance ใหม่ |
| 3 reviewers success | lineage หนึ่ง fail | ผลสูงสุด `PASS_WITH_WARNINGS`; แก้ provider ก่อนพึ่ง gate ระยะยาว |
| 2 reviewers success | coverage insufficient | `HUMAN_REVIEW_REQUIRED`; ตรวจ evidence หรือ rerun หลังแก้ provider |
| 0–1 reviewers success | panel infrastructure failure | `INFRASTRUCTURE_FAILURE`; ห้าม override เป็น PASS โดยไม่มี incident authority |
| `CANCELLED_STALE` หรือ override 409 | PR head เปลี่ยนหลัง pin | เริ่ม run ใหม่บน current head |
| `REPORTING_FAILED` | Checks token/permission/network ล้มหลัง decision durable | รักษา state, แก้ `Checks: write`, retry publication แบบ idempotent |
| `sandbox_unavailable` | host ไม่อนุญาต `sandbox-exec` หรือกำลังรัน nested sandbox | ย้ายไปรันบน unnested macOS runner; ห้ามปิด network sandbox |
| `/api/system/stats` มี `null` | OS metric call เช่น uptime ถูก deny | ดู `unavailableMetrics`; endpoint degrade ไม่ crash |
| Check ไม่ block merge | branch ไม่มี ruleset/protection | ตั้ง server-side required checks หลัง canary |

## Security invariants

- ห้าม checkout, source, import หรือ execute PR head ใน finalize job.
- ห้ามส่ง `GITHUB_TOKEN`/`GH_TOKEN` เข้า provider child; adapter environment ใช้ explicit allowlist.
- ห้ามใช้ `pull_request_target` รัน untrusted code.
- ห้ามแชร์ self-hosted runner ของ public repository กับ secrets/งานอื่น.
- ห้ามใส่ credential ใน artifact, evidence, replay, command argument หรือ log.
- ห้ามเปลี่ยน policy จาก PR head ให้มีผลต่อ PR เดียวกัน; policy ใช้ trusted pinned base.
- ห้ามเปิด network/install ให้ deterministic repository commands.
- ห้ามตีความ model text เป็น authority; Judge รับ structured findings และ Ring 0 ตัดสิน.
- ห้าม publish PASS บน stale head.
- ห้ามตั้ง required check จน check source จริงเคย report และ canary ผ่าน.
- ทุก third-party Action ต้อง pin full commit SHA ที่ review แล้ว; major tag ไม่ใช่ immutable ref.

## Rollout และ rollback

### Rollout

1. Private/dedicated staging repository หรือ trusted-contributor gate.
2. One PR canary ที่ expected `PASS`.
3. Negative canary สำหรับ deterministic fail, provider degradation, stale SHA และ reporting failure.
4. เปิด required checks บน staging.
5. Observe อย่างน้อยหนึ่ง change window แล้วค่อยเปิด production ruleset.

### Rollback

1. หยุดรับ run ใหม่โดย disable finalize workflow หรือหยุด dedicated runner service ตาม incident procedure; อย่าลบ state/evidence.
2. ถ้า required custom check ทำให้ทุก PR deadlock และ service กู้ไม่ทัน ให้ repository admin ถอดเฉพาะ `Universal PR Quality Gate` จาก required checks ชั่วคราวหลัง explicit incident approval. บันทึกผู้อนุมัติ เวลา เหตุผล และ restoration deadline; CI สอง check เดิมยังต้อง required.
3. Revert workflow/policy/code ผ่าน PR; ห้าม push ตรงหรือ force push.
4. ถ้า credential อาจรั่ว ให้ revoke/rotate provider secrets และ GitHub credential ทันที. การลบ log/commit ไม่พอ.
5. Re-run four-lineage conformance และ canary ก่อน restore required check.

## Production acceptance checklist

| Gate | ต้องเห็นก่อนประกาศ production |
|---|---|
| Code | implementation อยู่ default branch; bootstrap exemption ไม่ถูกใช้กับ PR ใหม่ |
| Abuse control | public PR ไม่สามารถปลุก paid finalize ซ้ำได้โดยไม่มี trusted admission |
| Supply chain | ทุก workflow `uses:` pin full commit SHA และ dependency review ผ่าน |
| Runner | dedicated/ephemeral macOS runner online, labels match, service recovery test ผ่าน |
| Secrets | provider secrets ครบ; ไม่มีค่าใน repo/log/artifact |
| Conformance | latest P1-P8 ผ่านทั้ง `claude`, `codex`, `gemini-cli`, `opencode-deepseek` |
| Governance | no pending policy proposal; approved hash ตรง bytes ปัจจุบัน |
| Canary | real analysis artifact + verified finalize + exact-head custom check ครบ |
| Negative cases | fail, degraded, insufficient, stale, cancel, reporting failure ทดสอบแล้ว |
| Enforcement | ruleset/protection require PR, block force push และ require checks exact names |
| Monitoring | alert runner, workflow, state, coverage, cost, quota และ degraded metrics |
| Recovery | rollback owner, token rotation, state backup และ required-check recovery ซ้อมแล้ว |
| Retention | disk alert/backup พร้อม; purge ใช้ reviewed mechanism ที่รักษา audit integrity |

## References

- Local contracts: `.ai/specs/universal-pr-quality-gate/`, `.ai/policies/pr-quality-gate.json`, `.github/workflows/pr-quality-analysis.yml`, `.github/workflows/pr-quality-finalize.yml`, `console/backend/src/pr-gate/`, `console/backend/src/app.ts`
- GitHub: [เพิ่ม self-hosted runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners?learn=hosting_your_own_runners), [runner labels](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels), [self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- Security: [secure use of GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use), [`workflow_run` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- Enforcement: [ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)
- Credentials: [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets?tool=webui), [`gh secret set`](https://cli.github.com/manual/gh_secret_set), [Checks API](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28)
