# .ai/ — the vendor-neutral operating layer

This directory is the single source of truth for how every agent works on this repo.
It is harness-agnostic: Claude Code, Codex, OpenCode and Pi all read the same knowledge,
adopt the same roles, and are gated by the same checks. The per-harness `.claude/`,
`.codex/`, `.opencode/` artifacts are thin adapters that point back here.

## System map

```text
.ai/
  README.md            # this file — system map, entry points, golden rules, SETUP
  shared/              # SINGLE SOURCE OF TRUTH: knowledge + protocols (read in order)
  workflows/           # runnable procedures (neutral), reference scripts/ + shared/
  roles/               # vendor-neutral personas (subagent bodies, no frontmatter)
  bin/                 # harness-agnostic check engine (single source for all guards)
  agents/              # per-agent adapters (claude/ codex/ opencode/ pi/)
  templates/           # task-brief / plan / review / handoff / changelog templates
```

| Dir | One line |
|---|---|
| `shared/` | Project context, architecture, coding standards, task/review/testing/security protocols, EARS, lessons |
| `workflows/` | feature-development, bug-fix, code-review, test-generation, frontend-task — each cites `scripts/` |
| `roles/` | spec-architect, bug-investigator, pbt-runner — personas any harness can adopt |
| `bin/` | `check-destructive.sh`, `check-bypass.sh`, `check-secrets.sh`, `gate-task.sh` (exit 2 = block) + `install.sh` |
| `agents/` | One `AGENT.md` per harness explaining its read order and live hook/role wiring |
| `templates/` | Fill-in-the-blank artifacts for briefs, plans, reviews, handoffs, changelog |

**Skills standard** — the spec workflow ships once as Agent Skills under
`/.agents/skills/spec-*/SKILL.md` (frontmatter `name` + `description`, markdown body).
This one set is auto-read by **Codex**, **OpenCode** (which also reads `.claude/skills/`)
and **Pi**; the bodies route to the single source (`workflows/*` + `.claude/skills/spec-*`)
and are never duplicated per harness. Claude reads the same procedure via `.claude/skills/`.
`spec-retro` and `spec-sync-github` are intentionally NOT in `.agents/skills/` — they are
Claude-only (Claude cost ledger / GitHub MCP) and are not runnable by Codex/OpenCode/Pi.

## Per-agent entry points

| Agent | Auto-loads | spec-* skills | Then read |
|---|---|---|---|
| Claude | `.claude/` (`CLAUDE.md`, `rules/`) | `.claude/skills/spec-*` | `.ai/agents/claude/AGENT.md` |
| Codex | `AGENTS.md` (root) | `.agents/skills/spec-*` | `.ai/agents/codex/AGENT.md` |
| OpenCode | `AGENTS.md` (root) | `.agents/skills/` + `.claude/skills/` | `.ai/agents/opencode/AGENT.md` |
| Pi | `AGENTS.md` (+ `SYSTEM.md` if present) | `.agents/skills/spec-*` | `.ai/agents/pi/AGENT.md` |

All agents read `.ai/shared/*` in the order listed in the root `AGENTS.md` before acting.

## Parity matrix

How each spec-driven capability lands per harness. **native** = the harness provides
it as a first-class mechanism wired to the single source; **floor-only** = no native
mechanism, enforced by the Tier 1 git + CI floor (and self-discipline); **n/a** = not
applicable in this setup. Wiring detail is in each `agents/<harness>/AGENT.md`.

| Capability | Claude | Codex | OpenCode | Pi |
|---|---|---|---|---|
| spec-* workflow as skills | native (`.claude/skills/spec-*`) | native (`.agents/skills/spec-*`) | native (`.agents/skills/` + `.claude/skills/`) | native (`.agents/skills/spec-*`) |
| Slash commands | native (`.claude/commands/`) | via skills (prompts deprecated) | native (`.opencode/commands/spec-*`) | via skills |
| Subagents (fresh-context personas) | native (Task tool -> `.ai/roles/*`) | native (`.codex/agents/*.toml` + `[agents]`) | native (`.opencode/agents/*`) | floor-only (persona via skill / `APPEND_SYSTEM.md`) |
| Pre-tool guard (destructive/bypass) | native (`.claude/` hook -> `.ai/bin/check-*`) | native (`.codex/hooks.json` PreToolUse -> `guard.sh`) | native (`.opencode/plugins/ai-guard.js`) | floor-only (run `.ai/bin/check-*` by hand) |
| Task-gate (`[x]` flip = green + Evidence) | native (`.claude/` hook -> `gate-task.sh`) | native (`.codex/hooks.json` PostToolUse -> `task-gate.sh`) | native-ish (`.opencode/plugins/task-gate.js` on `file.edited`, no hard-block) | floor-only (git pre-commit + CI) |
| MCP browser-verify (chrome-devtools) | native (MCP) | native (`.codex/config.toml` `[mcp_servers]`) | native (`opencode.json` `mcp`) | n/a (no MCP host) |

All native task-gate, guard, subagent and skill wiring routes to the same single
source — `.ai/bin/{check-*,gate-task}.sh`, `.ai/roles/*`, `.ai/workflows/*` +
`.claude/skills/*` — so every harness enforces byte-for-byte identical rules.

## Golden rules

- **Spec first** — requirements -> design -> tasks, with approval gates. No code first.
- **Minimal change** — touch only what the task needs; match existing conventions.
- **Tests are part of the task** — green before done, with an `Evidence:` block.
- **Hand off cleanly** — durable state in the spec files; fill the handoff note.

## SETUP (one time per clone)

The git hooks are committed but not active until you point git at them:

```sh
git config core.hooksPath .githooks
```

This enables `pre-commit` (secret scan + Evidence check) and `pre-push` (blocks direct
pushes to `main`/`develop` and force pushes). Claude cannot run this itself (the bypass
guard blocks `core.hooksPath` edits), so a human runs it once. CI
(`.github/workflows/ci.yml`) is the server-side floor that applies regardless.

**Codex MCP (Codex users only)** — the browser-verify server is wired in
`.codex/config.toml` under `[mcp_servers.chrome-devtools]` (confirm package/version).
OpenCode reads its MCP straight from `opencode.json`; Pi has no MCP host.

## Related top-level docs (not moved)

- `../PROMPT.md` — the originating prompt / brief for this project.
- `../claude-code-spec-driven-workflow.md` — the long-form spec-driven workflow guide.
