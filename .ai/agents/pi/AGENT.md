# Pi Coding Agent (earendil-works) — Agent Adapter

You are the **Pi Coding Agent** working in this repo, on top of the vendor-neutral
`.ai/` operating layer. This file maps the shared workflow and standards onto Pi's
real mechanisms. Behavior, standards, and the spec-driven flow are defined once in
`.ai/shared/` and reused by every agent; this adapter only wires them to Pi.

## Role and best use cases

Pi is a coding agent that adopts an Agent-Skills standard and rich system-prompt
layering, but has **no pre-tool hook in its core** (interception is extension-only)
and deliberately no built-in subagents. Best fit here:

- Focused, single-context implementation of a cohesive task, with tests.
- Spec-driven phases driven from `../../workflows/*` exposed as Pi skills.
- Work covered by the committed project extension and the shared git + CI floor.

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
13. `../../shared/stack/` — optional stack-specific profiles; read a `<stack>.md` here
    when one is present (none bundled by default — see its README)

Also read `../../README.md` for the system map. **The repo-root `AGENTS.md` is
auto-loaded by Pi**, together with its `SYSTEM.md` / `APPEND_SYSTEM.md` system-prompt
layers. The root `AGENTS.md` is the neutral front door: read `.ai/shared/*`, adopt
`.ai/roles/*`, and enforce through git + CI + `.ai/bin/*`. Treat it as already in
context.

## Mechanism wiring

These point to the live config that the project commits (created and maintained by
the team — not by this adapter doc). Verify each is present and current before
relying on it.

- **Entry / auto-load** — Pi reads `AGENTS.md` plus `SYSTEM.md` / `APPEND_SYSTEM.md`.
  The root `AGENTS.md` is your entry point; do not duplicate its content here.
- **Pre-tool guard** — launch Pi from the repository root so it discovers
  `.pi/extensions/sdd-enforcement.ts`. The project extension registers `tool_call`,
  runs `../../bin/check-destructive.sh` and `../../bin/check-bypass.sh` for every Bash
  call, fails closed on execution errors or non-zero exits, and freezes allowed event
  input against later-handler mutation. It also blocks Bash commands containing a
  literal canonical spec `tasks.md` path; use Pi `read`, `write` or `edit` instead.
  If the extension is unavailable or disabled, report that in-session parity is
  unavailable and run both shared checks manually before risky Bash. Tier 1 git + CI
  remains the durable floor.
- **spec-* skills** — Pi auto-reads `.agents/skills/` (Agent Skills standard), so the
  same `.agents/skills/spec-*/SKILL.md` set that serves Codex and OpenCode works in Pi
  too — no Pi-specific copy. The skill bodies route to the single source
  (`../../workflows/*` + `.claude/skills/spec-*/SKILL.md`); invoke `/skills`,
  `$spec-design`, or rely on implicit triggering. Use these instead of improvising the
  phase structure.
- **Subagents / personas** — fresh-context subagents are unsupported. When work
  requires one, stop the Pi path, report `fresh-context subagent` as the missing
  capability, and hand off to Claude Code, Codex or OpenCode. Inline persona text is
  not equivalent and must not be claimed as parity.
- **Task-gate** — the project extension reconstructs final content for Pi `write` and
  exact-match `edit` calls to `.ai/specs/*/tasks.md` or
  `.claude/specs/*/tasks.md`. When a new completed-task opening appears, it runs
  `../../bin/gate-task.sh` against proposed content before disk mutation and fails
  closed. Ambiguous, overlapping or fuzzy-only edits are blocked; use `write`.
- **MCP / browser-verify** — unsupported in this setup. When work requires MCP or
  browser verification, stop the Pi path, report `MCP/browser` as the missing
  capability, and hand off to Claude Code, Codex or OpenCode. Manual verification is
  not equivalent and must not be claimed as parity.

## How you work a task

1. **Receive a task brief** shaped by `../../templates/task-brief-template.md`.
2. **Produce an implementation plan** via `../../templates/implementation-plan-template.md`
   before editing, for any non-trivial task. Confirm assumptions; do not pick
   silently among interpretations.
3. **Implement** a whole cohesive task end-to-end (it may span many files),
   including its tests. Confirm the project extension is loaded; use the shared guards
   manually only as its documented fallback. Mark
   `- [x]` in `tasks.md` and state which REQ IDs are now satisfied. Pause at task
   boundaries for review.
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
  `DROP TABLE`/`DROP DATABASE`, `TRUNCATE`, `dropdb`, or `DELETE FROM` without a
  `WHERE`). Obey the project extension. If it is not loaded, run
  `../../bin/check-destructive.sh '<cmd>'` and `../../bin/check-bypass.sh '<cmd>'`
  first. A `DELETE ... WHERE ...` passes; `git checkout`/`restore` and
  `git branch -D` remain intentionally unblocked, so inspect those yourself.
- Do not add a new dependency without reviewing license + maintenance and getting
  approval; always commit the lock file; never pin floating (`*`/`latest`) on prod.
- Do not edit `app/` outside your assigned task, do not change `scripts/` logic,
  and do not touch the `.ai/bin/` guard regex (security-critical).
- Do not commit `.only` / `.skip` left in tests; do not let coverage drop below
  threshold; do not merge across a failing CI check.

## Capabilities and limitations (honest, generic)

- **Capabilities** — code generation and editing; shell tool use; spec-* skills
  auto-read from `.agents/skills/` (Agent-Skills standard, same set as Codex/OpenCode);
  layered system prompt (`SYSTEM.md` / `APPEND_SYSTEM.md`) for personas and standing
  instructions; auto-loaded `AGENTS.md`.
- **Limitations** — no core pre-tool hook; automatic interception depends on project
  extension discovery from repository-root launch. Dynamic or obfuscated Bash paths
  can evade literal `tasks.md` path detection and remain backed by Tier 1. No built-in
  fresh-context subagents and no MCP/browser integration; route those tasks to Claude
  Code, Codex or OpenCode. Output may be buffered, so a quiet run is not necessarily
  stuck — check disk state, not terminal output. Untracked files are invisible to
  `git diff --stat`, so cross-check `git status`. No persistent memory exists beyond
  what is written to disk.
- The durable floor is Tier 1 (committed git hooks via `core.hooksPath` + CI). Hooks
  enforce configured clones; CI reports matching PRs; repository rules decide whether
  failed/missing checks block merge. For Pi, the committed extension is the in-session
  layer and manual `.ai/bin/check-*` is fallback only.

> Verify the exact version/feature-flags of this agent before relying on hook/MCP
> support.
