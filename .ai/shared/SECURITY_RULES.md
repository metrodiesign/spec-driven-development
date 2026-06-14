# Security Rules

> Vendor-neutral, PROJECT-SCOPED. Distilled from the global operating rules.
> These rules apply to EVERY agent (Claude, Codex, OpenCode, Pi) and to humans.

## Enforcement model: a cross-agent floor + a per-harness layer

Enforcement is layered. The bottom layer is the same for everyone; the top layer exists
only for harnesses that support pre-tool hooks.

| Tier | Mechanism | Covers | Notes |
|---|---|---|---|
| 1. Git + CI (the floor) | `.githooks/` (enabled via `core.hooksPath`) + `.github/workflows/ci.yml`, both calling `.ai/bin/check-*.sh` | **ALL agents + humans** | Cannot be bypassed by choosing a different agent. This is the real, cross-agent enforcement. |
| 2. Harness pre-tool hook | Claude: `.claude/hooks/*` -> `.ai/bin/`; Codex: `.codex/hooks.json` -> `.ai/bin/`; OpenCode: `.opencode/plugins/ai-guard.js` -> `.ai/bin/` | Claude, Codex, OpenCode | Pre-execution interception. Pi has no core pre-tool hook, so it falls back to Tier 1 + Tier 3. |
| 3. Procedural | root `AGENTS.md` + `.ai/roles/` + `.ai/workflows/` instruct the agent to run `.ai/bin/check-*` before risky commands | ALL agents (the only AI-side layer Pi has) | Advisory; relies on the agent following instructions. The git+CI floor backstops it. |

**Hooks are Claude/Codex/OpenCode-only. The git + CI floor is the enforcement that
spans every agent.** When in doubt about whether a harness layer caught something,
trust Tier 1: a clean commit and a green CI run are the proof.

All three tiers call the SAME single-source check logic in `.ai/bin/`
(`check-destructive.sh`, `check-bypass.sh`, `check-secrets.sh`, `gate-task.sh`). Do not
fork or weaken these checks per harness.

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
  secret-scan job, for ALL agents and humans (Tier 1). Claude/Codex/OpenCode also get
  pre-execution interception via their harness hook (Tier 2).

### Destructive operations

- No `DROP` / `DELETE` / `TRUNCATE` on production data without a `WHERE` clause and an
  explicit human confirmation.
- No `rm -rf`, `git reset --hard`, or `git clean -fd` without confirming the target
  first.
- DB migrations require a rollback plan and a backup before running on production.
- Any destructive command on production must be confirmed by a human.
- **Enforced by:** `.ai/bin/check-destructive.sh` (exit 2 = block), invoked by the
  harness pre-tool hook for Claude/Codex/OpenCode (Tier 2). Pi and humans rely on the
  procedural instruction in `AGENTS.md` (Tier 3) plus the git + CI floor (Tier 1).

### Bypass prevention

- Do not attempt to disable, skip, or route around the guards (no
  `--no-verify`, no overriding `core.hooksPath`, no `HUSKY=0`-style escapes, no editing
  the guards to weaken them).
- **Enforced by:** `.ai/bin/check-bypass.sh` (exit 2 = block) via the harness pre-tool
  hook (Tier 2); the git + CI floor (Tier 1) re-checks on the server side regardless.

### CI gate

- A PR may merge only when CI passes (tests + lint) as a required check.
- Never merge past a failing check.
- Never leave `.only` / `.skip` in committed tests.
- Coverage must not drop below the project threshold.
- **Enforced by:** `.github/workflows/ci.yml` as a required check for ALL contributors
  (Tier 1). Server-side branch protection is the gate that cannot be skipped locally.

### Deploy / release

- A production deploy must always go through staging first.
- Every release must have a rollback plan.
- Do not deploy to production on a Friday evening or before a long holiday, except for
  an emergency hotfix.
- Every release is tagged with a version + a changelog entry.
- **Enforced by:** procedural discipline (Tier 3) + release-pipeline checks where they
  exist. (This project ships a static frontend with no real backend; treat these as the
  standard to follow if a deploy pipeline is added.)

### Dependencies

- Do not add a new dependency without reviewing its license and maintenance status, and
  getting approval first (this project says: prefer the existing stack; new libraries
  need a stated reason and approval).
- Lock files (`package-lock.json`, etc.) must always be committed.
- Do not pin floating versions (`*` / `latest`) on a production dependency.
- Vulnerability audit (`npm audit` or equivalent) is part of CI. When auditing, separate
  a dev-only chain from prod-core before acting — never `npm audit fix --force` a core
  dependency into a breaking downgrade.
- **Enforced by:** CI (audit + lockfile presence) (Tier 1) + review approval for new
  dependencies (Tier 3, see [REVIEW_PROTOCOL.md](REVIEW_PROTOCOL.md)).

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
