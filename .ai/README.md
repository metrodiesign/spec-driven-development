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

## Per-agent entry points

| Agent | Auto-loads | Then read |
|---|---|---|
| Claude | `.claude/` (`CLAUDE.md`, `rules/`) | `.ai/agents/claude/AGENT.md` |
| Codex | `AGENTS.md` (root) | `.ai/agents/codex/AGENT.md` |
| OpenCode | `AGENTS.md` (root) | `.ai/agents/opencode/AGENT.md` |
| Pi | `AGENTS.md` + `SYSTEM.md` | `.ai/agents/pi/AGENT.md` |

All agents read `.ai/shared/*` in the order listed in the root `AGENTS.md` before acting.

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

## Related top-level docs (not moved)

- `../PROMPT.md` — the originating prompt / brief for this project.
- `../claude-code-spec-driven-workflow.md` — the long-form spec-driven workflow guide.
