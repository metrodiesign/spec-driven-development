# Security Rules

> Vendor-neutral, PROJECT-SCOPED. Distilled from the global operating rules.
> These rules apply to EVERY agent (Claude, Codex, OpenCode, Pi) and to humans.

## Enforcement model: a cross-agent floor + a per-harness layer

Enforcement is layered. The bottom layer is the same for everyone; the top layer exists
for harnesses that support native hooks or project extensions.

| Tier | Mechanism | Covers | Notes |
|---|---|---|---|
| 1. Git + CI (the floor) | `.githooks/` (enabled via `core.hooksPath`) + `.github/workflows/ci.yml`, both calling `.ai/bin/check-*.sh` | **ALL agents + humans** | Shared across harnesses; local blocking needs hook setup, merge blocking needs repository ruleset. |
| 2. Harness interception | Claude: `.claude/hooks/*` -> `.ai/bin/`; Codex: `.codex/config.toml` `[hooks]` -> `.codex/hooks/*` -> `.ai/bin/` (single source `config.toml`; the legacy `.codex/hooks.json` was removed — Codex 0.139 loaded both, see issue #26 — and these in-session hooks fire only after interactive `/hooks` trust); OpenCode: `.opencode/plugins/ai-guard.js` -> `.ai/bin/`; Pi: `.pi/extensions/sdd-enforcement.ts` `tool_call` -> `.ai/bin/` | Claude, Codex, OpenCode, Pi | Pre-execution interception. Pi support is project-local and requires launch from repository root. |
| 3. Procedural | root `AGENTS.md` + `.ai/roles/` + `.ai/workflows/` instruct the agent to run `.ai/bin/check-*` before risky commands | ALL agents | Advisory fallback; relies on the agent following instructions. The git+CI floor backstops it. |

**Native hooks are Claude/Codex/OpenCode-only; Pi uses a committed project extension.
The git + CI floor spans every agent when configured.** A clean commit + green CI run
เป็น evidence; repository-side merge enforcement ต้องตรวจ ruleset แยก ห้าม infer จาก
workflow green อย่างเดียว.

All three tiers call the SAME single-source check logic in `.ai/bin/`
(`check-destructive.sh`, `check-bypass.sh`, `check-secrets.sh`, `check-evidence.sh`,
`gate-task.sh`). Do not fork or weaken these checks per harness.

## The rules

### Secrets

- Never commit any secret: API key, token, password, private key, connection string,
  or credential file.
- `.env` and `.env.*` must always be in `.gitignore`. Only `.env.example` (with fake
  values) may be committed.
- Never hardcode a credential — read it from an environment variable or a secret
  manager.
- Never log sensitive data (tokens, passwords, PII).
- If a secret leaks: rotate/revoke it immediately. Deleting the commit or force-pushing
  is NOT enough — history still holds it.
- **Enforced by:** `.githooks/pre-commit` -> `.ai/bin/check-secrets.sh` and the CI
  secret-scan job, for ALL agents and humans (Tier 1). Harness layers add the command
  and task-gate interception documented above; secret detection remains a universal
  git + CI floor.
- **Detection details** (so the rule and the engine agree): the generic detector
  inspects the matched `key=VALUE` substring, not the whole line — a placeholder word
  in a trailing comment no longer whitelists a real secret; only a placeholder VALUE
  passes. It covers secret values containing `@ ! $ # %` punctuation (`.` is excluded so
  dotted member-access like `process.env.API_TOKEN` is not misread as a secret), `*_SECRET`
  names (e.g. `JWT_SECRET`), and connection strings with embedded credentials
  (`scheme://user:<password>@host`, an explicitly forbidden secret). The forbidden
  dotenv-filename rule matches real dotenv files only (basename `== .env`, starting with
  `.env.`, or ending in `.env`), not arbitrary names containing `.env.` mid-string. The
  guard's own adversarial fixtures under `.claude/hooks/tests/` are excluded from the scan.
  Pre-existing true
  blocks (AWS `AKIA`, Stripe, GitHub PAT, PEM private-key block, real `.env`,
  `.pem`/`.key`) remain intact. `SECRET_GUARD_SKIP=1` is a STAGED-path-only escape
  hatch for the in-session human; it is IGNORED in `--all`/CI mode (a non-bypassable
  hard gate).

### Destructive operations

- No `DROP` / `DELETE` / `TRUNCATE` on production data without a `WHERE` clause and an
  explicit human confirmation.
- No `rm -rf`, `git reset --hard`, or `git clean -fd` without confirming the target
  first.
- DB migrations require a rollback plan and a backup before running on production.
- Any destructive command on production must be confirmed by a human.
- **Enforced by:** `.ai/bin/check-destructive.sh` (exit 2 = block), invoked by the
  native hook for Claude/Codex/OpenCode or Pi project extension (Tier 2). Humans and
  any disabled extension rely on `AGENTS.md` (Tier 3) plus the git + CI floor (Tier 1).
- **What the engine actually blocks** (so docs and the engine agree exactly):
  - `rm` recursive+force in every spelling — `-rf`/`-fr`/`-r -f`/`--recursive --force`,
    and the same when written `\rm`, `"rm"`, `'rm'`, or wrapped in `sh -c '...'` /
    `bash -c '...'` / `eval '...'`. It inspects ALL argv, not just the first word.
  - `git reset --hard`, `git clean -f`, `find -delete`.
  - SQL Destructive-Ops: `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `dropdb`, and
    `DELETE FROM ...` with NO `WHERE` clause. A `DELETE ... WHERE ...` is allowed.
  - Branch/force-push protection (see Branch / push discipline below): force push,
    `+refspec`, `--mirror`, `--all --force`, and direct push/commit to `main`/`develop`
    including a fully-qualified `HEAD:refs/heads/main`.
  - **Intentionally NOT blocked** (high false-positive risk; the Tier 1 git hooks + CI
    are the durable floor for these): `git checkout`/`restore`, `git branch -D`,
    `find -exec`. Documented gap, not an oversight.
  - Known fail-safe trade-off: the engine treats the command as a flat string and does
    not parse shell quoting, so destructive-looking content inside a quoted string may
    over-block, by design. The `.ai/bin` engine and the Claude adapter are tested for
    identical exit codes.

### Bypass prevention

- Do not attempt to disable, skip, or route around the guards (no
  `--no-verify`, no overriding `core.hooksPath`, no `HUSKY=0`-style escapes, no editing
  the guards to weaken them).
- **Enforced by:** `.ai/bin/check-bypass.sh` (exit 2 = block) via the harness pre-tool
  hook or Pi project extension (Tier 2); the git + CI floor (Tier 1) re-checks on the
  server side regardless.
- **What the bypass engine catches** (expanded — superseding the old "only inspects
  git commands" description): a `-n`/`--no-verify` skip-verify flag written UNQUOTED at
  any position in a `git commit` — including preceded by git global options
  (`git -c k=v commit -nm …`, `git --no-pager commit -n …`), after a quoted commit
  message, and after a `\` line continuation (it strips quoted segments and flattens
  newlines before scanning) — while a commit message that merely mentions `-n` still
  passes. Because it inspects the command as a flat string, a flag deliberately WRAPPED
  in quotes (`git commit "-nm" …`) is stripped along with the quoted segment and slips
  this Tier-2 check; the Tier-1 CI secret scan (`check-secrets.sh --all`, below)
  re-scans server-side regardless and is the durable backstop for that case. A commit
  whose message text contains the literal substring `--no-verify` is over-blocked as a
  fail-safe (rephrase the message). It also independently blocks
  tamper that disables or overwrites the enforcement floor — `chmod`/`mv`/`rm`/redirect
  against `.githooks/*`, `.ai/bin/check-*.sh`, `.ai/bin/gate-task.sh`, or pointing
  git's `core.hooksPath` / `hooksPath` away — even when the command contains no
  standalone `git` token. The CI guard-regression suite (below) is the backstop for the
  "do not weaken the guards" rule.

### CI gate

- Policy requires every PR to merge only when configured required checks pass.
- Never merge past a failing check.
- Never leave `.only` / `.skip` in committed tests.
- Coverage must not drop below the project threshold.
- Repo นี้มี Node workspace tests จริงและ CI รันผ่าน `scripts/ci-test-scope.sh`; downstream
  projects ยังประกาศ runner เพิ่มได้ผ่าน `SDD_TEST_CMD`
- **Workflow floor:** `.github/workflows/ci.yml` รันทั้ง `pull_request` และ `push` ไป `main`/
  `develop`. Server-side enforcement เกิดเมื่อ repository ruleset/branch protection require
  check เท่านั้น; workflow file เองเป็นหลักฐานแต่ยังไม่ block merge.
- **Current operational state (2026-08-12):** active ruleset
  `protected-main-develop` (ID `20737973`) covers `main` and `develop`, requires linear
  history, pull requests with review-thread resolution, squash-only merge, and exact
  strict checks `platform (vendor check + typecheck + lint + tests)` and
  `guards + spec-trace`. Local git hooks still depend on clone configuration.
- **Checks CI actually runs** (ให้เอกสารตรง workflow): vendor-name check, frozen `pnpm`
  install, `pnpm audit --prod --audit-level high`, full typecheck, lint, scoped/full
  workspace tests, guard-regression suite ทุก `.claude/hooks/tests/*.test.sh`, lessons
  coverage, full-tree/diff-range secret scan และ spec-trace coverage
- Exact CI check names คือ `platform (vendor check + typecheck + lint + tests)` และ
  `guards + spec-trace`.

### Universal PR Quality Gate

- Production custom check ชื่อ `Universal PR Quality Gate`; เปิดเป็น required หลัง real canary
  สร้าง check บน exact head ได้จริงเท่านั้น.
- `pull_request` analysis ถือ PR data เป็น untrusted, ใช้ read credential, รัน deterministic
  checks และส่ง artifact; ไม่มี provider secret หรือ `checks: write`.
- Trusted `workflow_run` finalize checkout default branch เท่านั้น, verify workflow run id,
  repository, event, PR/head, source/policy hashes, manifest/report/evidence integrity ก่อนใช้
  provider หรือ reporter credential.
- ห้าม checkout/execute fork head ใน finalize, ห้ามใช้ `pull_request_target` รัน untrusted code
  และห้ามส่ง GitHub reporter token เข้า provider child. Child env มาจาก explicit allowlist.
- Self-hosted macOS runner ต้อง dedicated/ephemeral; ห้ามแชร์กับ repository/workload อื่นที่
  ไม่ได้อยู่ trust domain เดียวกัน.
- Public-repo trust split ลด exposure โดยไม่ execute head ใน privileged finalize แต่ไม่ลบ
  ความเสี่ยง public runner, malicious artifact/parser, supply chain หรือ credential misuse.
  Workflow ยังไม่มี global rate limit, contributor admission หรือ protected environment
  approval. ห้ามผูก runner + paid secrets จนเพิ่ม abuse control ผ่าน reviewed PR.
- Third-party GitHub Actions ต้อง pin full commit SHA ที่ review แล้วก่อน production; moving
  major tags เช่น `@v4`/`@v5` ไม่ใช่ immutable supply-chain boundary.
- Provider/API keys อยู่ GitHub secrets หรือ secret manager เท่านั้น. Conformance records ไม่มี
  credential และต้องผ่าน P1-P8 ทุก lineage ก่อน reviewer slot eligible.
- `systemDecision` เป็น immutable system verdict; human override สร้าง `effectiveDecision` แยก,
  ผูก exact current head, actor, reason และ idempotency key.
- Activation, auth, monitoring และ rollback: [production runbook](../../docs/08-pr-quality-gate-production.md).

### Deploy / release

- A production deploy must always go through staging first.
- Every release must have a rollback plan.
- Do not deploy to production on a Friday evening or before a long holiday, except for
  an emergency hotfix.
- Every release is tagged with a version + a changelog entry.
- **Enforced by:** procedural discipline (Tier 3) + release-pipeline checks where they
  exist. Repo มี Console frontend/backend แต่ยังไม่มี production deployment pipeline;
  ใช้มาตรฐานนี้เมื่อเพิ่ม pipeline

### Dependencies

- Do not add a new dependency without reviewing its license and maintenance status, and
  getting approval first (this project says: prefer the existing stack; new libraries
  need a stated reason and approval).
- Lock files (`package-lock.json`, etc.) must always be committed.
- Do not pin floating versions (`*` / `latest`) on a production dependency.
- A dependency vulnerability audit (the package manager's audit command or equivalent) is
  REQUIRED in CI for any project that ships a package manifest. When auditing, separate a
  dev-only chain from prod-core before acting — never force-fix a core dependency into a
  breaking downgrade.
- **Enforced by:** blocking `pnpm audit --prod --audit-level high` ใน CI platform job
  (Tier 1) สำหรับ runtime dependencies; `pnpm-lock.yaml` ต้องอยู่ใน review และ dependency
  ใหม่ยังต้องผ่าน license/maintenance approval (Tier 3, ดู
  [REVIEW_PROTOCOL.md](REVIEW_PROTOCOL.md))

### Branch / push discipline

- Never push directly to `main` or `develop`; everything goes through a PR.
- Never force-push.
- Never commit directly without review.
- **Enforced by:** `.githooks/pre-push` (blocks pushes to `main`/`develop` and
  non-fast-forward force pushes, ref-based) for ALL agents and humans (Tier 1).

## When a guard fires

A blocked command means the floor is working. Do not try to bypass it (that itself is
blocked). Read the message, fix the underlying problem, and if the rule looks wrong for
a legitimate case, stop and ask a human — do not weaken the guard.
