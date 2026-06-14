# Codex (OpenAI) — Agent Adapter

You are **Codex** (OpenAI's coding agent) working in this repo, on top of the
vendor-neutral `.ai/` operating layer. This file maps the shared workflow and
standards onto Codex's real mechanisms. Behavior, standards, and the spec-driven
flow are defined once in `.ai/shared/` and reused by every agent; this adapter only
wires them to Codex.

## Role and best use cases

Codex is a capable general coding agent with strong tool use and a project-local
trusted-config layer (`.codex/`). Best fit here:

- End-to-end implementation of a cohesive task or task range, with tests.
- Codebase-wide edits where Codex's project hooks give a real pre-tool safety gate.
- Spec-driven phases driven from the shared workflows, with subagent personas
  mapped through `.codex/config.toml`.

## What to read first

Read these before doing any work, in this order:

1. `../../shared/PROJECT_CONTEXT.md` — what the product is and why
2. `../../shared/ARCHITECTURE.md` — folder layout, naming, organization
3. `../../shared/CODING_STANDARDS.md` — the stack you MUST prefer, hard constraints
4. `../../shared/TASK_PROTOCOL.md` — how a task flows end-to-end, the prohibitions
5. `../../shared/EARS.md` — the mandatory requirement notation
6. `../../shared/REVIEW_PROTOCOL.md` — how review/audit is run
7. `../../shared/TESTING_PROTOCOL.md` — what gets tested and where
8. `../../shared/SECURITY_RULES.md` — secrets, destructive ops, branch protection
9. `../../shared/OUTPUT_FORMATS.md` — the shape of every artifact you emit
10. `../../shared/CONTEXT_MANAGEMENT.md` — when to persist state
11. `../../shared/AGENT_HANDOFF_PROTOCOL.md` — how to hand off to the next session
12. `../../shared/LESSONS.md` — promoted process lessons (read every session)
13. `../../shared/stack/nextjs.md` — stack-specific lessons (when touching matching files)

Also read `../../README.md` for the system map. **The repo-root `AGENTS.md` is
auto-loaded by Codex** (root-down concatenation of `AGENTS.md` files): it is the
neutral front door that tells you to read `.ai/shared/*`, adopt `.ai/roles/*`, and
enforce through git + CI + `.ai/bin/*`. Treat it as already in context.

## Mechanism wiring

These point to the live Codex config that the project commits (in `.codex/`,
created and maintained by the team — not by this adapter doc). Verify each is
present and current before relying on it.

- **Entry / auto-load** — Codex concatenates `AGENTS.md` from the repo root down to
  the working directory. The root `AGENTS.md` is your entry point; do not duplicate
  its content here.
- **Pre-tool guard** — `.codex/hooks.json` registers a PreToolUse hook with matcher
  `"^Bash$"` that runs `.codex/hooks/guard.sh`. That guard reads the Codex hook
  input, extracts the command, and delegates to the single-source check engine:
  `../../bin/check-destructive.sh` and `../../bin/check-bypass.sh`. A blocked
  command stops with the rule it violated. (Note: Codex's hook input format and
  exit-code/blocking semantics for a Bash matcher differ from Claude's — confirm
  against the current Codex hooks docs; the guard is written to be easy to re-point
  if the input shape changes.)
- **Subagents** — declared under `[agents]` in `.codex/config.toml`, each mapping a
  persona body from `../../roles/*` (`spec-architect`, `bug-investigator`,
  `pbt-runner`). Use them for fresh-context review, root-cause analysis, and
  property-based testing.
- **MCP** — external tool servers are configured in `.codex/config.toml` (or via
  `codex mcp`). Use the configured servers (e.g. GitHub for `spec-sync-github`)
  rather than improvising.

## How you work a task

1. **Receive a task brief** shaped by `../../templates/task-brief-template.md`.
2. **Produce an implementation plan** via `../../templates/implementation-plan-template.md`
   before editing, for any non-trivial task. Confirm assumptions; do not pick
   silently among interpretations.
3. **Implement** a whole cohesive task end-to-end (it may span many files),
   including its tests. Mark `- [x]` in `tasks.md` and state which REQ IDs are now
   satisfied. Pause at task boundaries for review.
4. **Report changes** via `../../templates/review-report-template.md` (for review)
   and record a changelog entry via `../../templates/changelog-entry-template.md`.
5. **Create a handoff note** via `../../templates/handoff-note-template.md` before
   ending the session, capturing the active task ID, decisions and rationale,
   modified files, and exact build/test/run commands.

## What NOT to do

(From `../../shared/TASK_PROTOCOL.md` and `SECURITY_RULES.md`.)

- Do not jump to implementation for a non-trivial feature — specs come first, in
  order, with approval gates after each artifact (unless `/spec-quick`).
- Do not push directly to `main` or `develop`; every change goes through a PR.
- Do not force push.
- Do not commit any secret (API key, token, password, private key, connection
  string, credential file); do not hardcode credentials; do not log sensitive data.
- Do not run destructive commands (`rm -rf`, `git reset --hard`, `git clean -fd`,
  `DROP`/`DELETE`/`TRUNCATE` without a confirmed target). The guard blocks these;
  do not attempt to bypass it.
- Do not add a new dependency without reviewing license + maintenance and getting
  approval; always commit the lock file; never pin floating (`*`/`latest`) on prod.
- Do not edit `app/` outside your assigned task, do not change `scripts/` logic,
  and do not touch `.codex/` / `.ai/bin/` guard regex (security-critical).
- Do not commit `.only` / `.skip` left in tests; do not let coverage drop below
  threshold; do not merge across a failing CI check.

## Capabilities and limitations (honest, generic)

- **Capabilities** — strong code generation and editing; shell tool use gated by
  the `.codex/` pre-tool hook; project-local subagents via `[agents]`; MCP tool
  servers; auto-loaded `AGENTS.md` chain for instructions. Good at holding a feature
  in context and implementing it end-to-end.
- **Limitations** — pre-tool hook coverage and input format depend on the Codex
  version; a guard is only as good as its adversarial test pass; output may be
  buffered, so a quiet run is not necessarily stuck — check disk state, not the
  terminal; untracked files are invisible to `git diff --stat`, so cross-check
  `git status`; no persistent memory beyond what is written to disk.
- The durable enforcement floor is Tier 1 (committed git hooks via `core.hooksPath`
  + CI), which gates every agent and human at commit and PR — the `.codex/` hook is
  an in-session convenience on top of it.

> Verify the exact version/feature-flags of this agent before relying on hook/MCP
> support.
