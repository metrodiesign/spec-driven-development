#!/usr/bin/env bash
# guard.sh — Codex PreToolUse(Bash) adapter (Tier 2 harness hook).
#
# Thin adapter ONLY: it extracts the bash command Codex is about to run and delegates
# the actual decision to the single-source check engine in .ai/bin/. It must contain no
# guard logic of its own — keep all regex/policy in .ai/bin/check-*.sh so Claude, Codex,
# OpenCode and CI all enforce byte-for-byte the same rules.
#
# !!! Codex hook input format is not fully documented; confirm against
# !!! https://developers.openai.com/codex/hooks and adjust the CMD extraction line below.
# !!! The git+CI floor (Tier 1: .githooks/ + .github/workflows/ci.yml) still applies if
# !!! this needs tuning — i.e. even if CMD extraction is imperfect, destructive ops are
# !!! still caught at commit/push/PR. Treat that as the hard guarantee; this hook is the
# !!! fast in-loop convenience layer.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BIN="$REPO_ROOT/.ai/bin"

# --- CMD extraction (CONFIRM AGAINST CODEX DOCS) -----------------------------------------
# Codex is expected to provide the tool invocation as JSON on stdin. The exact key path for
# a Bash tool's command string is not yet pinned in the public docs, so we read stdin once
# and try the most likely shapes, then fall back to argv. Adjust the jq path here once the
# real schema is confirmed at https://developers.openai.com/codex/hooks .
INPUT="$(cat 2>/dev/null || true)"
CMD=""
if [ -n "$INPUT" ] && command -v jq >/dev/null 2>&1; then
  CMD=$(printf '%s' "$INPUT" | jq -r '
    .tool_input.command // .input.command // .arguments.command // .command // empty
  ' 2>/dev/null || true)
fi
# Fallback: command passed as first argv.
[ -z "$CMD" ] && CMD="${1:-}"

# Nothing to inspect -> allow.
[ -z "$CMD" ] && exit 0

# --- Delegate to the single-source engine ------------------------------------------------
# .ai/bin/check-*.sh: exit 2 = block, 0 = ok. Propagate a block by exiting non-zero.
for c in check-destructive check-bypass; do
  if ! "$BIN/$c.sh" "$CMD"; then
    # check-*.sh already printed the reason on stderr; propagate the block.
    exit 2
  fi
done

exit 0
