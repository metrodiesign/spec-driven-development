# OpenCode (SST) — Agent Adapter

You are **OpenCode** (SST's open-source coding agent) working in this repo, on top
of the vendor-neutral `.ai/` operating layer. This file maps the shared workflow
and standards onto OpenCode's real mechanisms. Behavior, standards, and the
spec-driven flow are defined once in `.ai/shared/` and reused by every agent; this
adapter only wires them to OpenCode.

## Role and best use cases

OpenCode is an open-source coding agent with a JavaScript plugin system that gives
a real pre-tool gate, plus project-local commands and agents. Best fit here:

- End-to-end implementation of a cohesive task or task range, with tests.
- Workflows driven from `../../workflows/*` exposed as OpenCode commands.
- Edits where the `tool.execute.before` plugin enforces the shared guard before any
  shell command runs.

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
auto-loaded by OpenCode**: it is the neutral front door that tells you to read
`.ai/shared/*`, adopt `.ai/roles/*`, and enforce through git + CI + `.ai/bin/*`.
Treat it as already in context.

## Mechanism wiring

These point to the live OpenCode config that the project commits (in `.opencode/`
and `opencode.jsonc`, created and maintained by the team — not by this adapter
doc). Verify each is present and current before relying on it.

- **Entry / auto-load** — OpenCode reads `AGENTS.md` for instructions. The root
  `AGENTS.md` is your entry point; do not duplicate its content here.
- **Pre-tool guard** — `.opencode/plugins/ai-guard.js` registers a
  `tool.execute.before` hook. When the tool is `bash`, it passes the command to the
  single-source check engine (`../../bin/check-destructive.sh`,
  `../../bin/check-bypass.sh`) and **throws to block** when a check exits 2. Confirm
  the bash tool's argument key against the current OpenCode plugin schema and smoke
  test before relying on it.
- **Commands** — `.opencode/commands/` exposes the project workflows from
  `../../workflows/*` (feature-development, bug-fix, code-review, test-generation,
  frontend-task). Run these instead of improvising the phase structure.
- **Agents** — `.opencode/agents/` declares the fresh-context personas from
  `../../roles/*` (`spec-architect`, `bug-investigator`, `pbt-runner`). Use them for
  review, root-cause analysis, and property-based testing.
- **MCP** — external tool servers are configured in `opencode.jsonc`. Use the
  configured servers (e.g. GitHub for the sync workflow) rather than improvising.

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
  `DROP`/`DELETE`/`TRUNCATE` without a confirmed target). The plugin blocks these;
  do not attempt to bypass it.
- Do not add a new dependency without reviewing license + maintenance and getting
  approval; always commit the lock file; never pin floating (`*`/`latest`) on prod.
- Do not edit `app/` outside your assigned task, do not change `scripts/` logic,
  and do not touch the plugin or `.ai/bin/` guard regex (security-critical).
- Do not commit `.only` / `.skip` left in tests; do not let coverage drop below
  threshold; do not merge across a failing CI check.

## Capabilities and limitations (honest, generic)

- **Capabilities** — code generation and editing; shell tool use gated by the
  `tool.execute.before` plugin; project-local commands from `../../workflows/*`;
  project-local agents from `../../roles/*`; MCP servers via `opencode.jsonc`;
  auto-loaded `AGENTS.md` for instructions.
- **Limitations** — the plugin runs on the OpenCode JS/Bun runtime, so the exact
  hook signature and the bash tool's argument key depend on the version — smoke test
  before trusting; a guard is only as good as its adversarial test pass; output may
  be buffered, so a quiet run is not necessarily stuck — check disk state, not the
  terminal; untracked files are invisible to `git diff --stat`, so cross-check
  `git status`; no persistent memory beyond what is written to disk.
- The durable enforcement floor is Tier 1 (committed git hooks via `core.hooksPath`
  + CI), which gates every agent and human at commit and PR — the plugin is an
  in-session convenience on top of it.

> Verify the exact version/feature-flags of this agent before relying on hook/MCP
> support.
