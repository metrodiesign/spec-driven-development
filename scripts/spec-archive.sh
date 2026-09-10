#!/usr/bin/env bash
# spec-archive.sh — move a CLOSED feature spec out of the active set (REQ-1). Validated
# `git mv` of .ai/specs/<feature>/ -> .ai/specs/archive/<feature>/. Never commits — the
# move rides the normal PR flow like any other tracked change.
#
# usage: spec-archive.sh <feature>
# exit: 0 moved (staged via git mv) · 1 refusal (message names the reason)
set -euo pipefail

FEATURE="${1:?usage: spec-archive.sh <feature>}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
TOOL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPECS_DIR="$REPO_ROOT/.ai/specs"
SRC="$SPECS_DIR/$FEATURE"
DEST="$SPECS_DIR/archive/$FEATURE"

case "$FEATURE" in
  archive/*|archive)
    echo "spec-archive: '$FEATURE' is already under archive/ — nothing to do" >&2
    exit 1
    ;;
esac

[ -d "$SRC" ] || { echo "spec-archive: no such feature dir: $SRC" >&2; exit 1; }

TASKS="$SRC/tasks.md"
[ -f "$TASKS" ] || {
  echo "spec-archive: $FEATURE has no tasks.md — nothing provably finished, refusing" >&2
  exit 1
}

UNCHECKED=$(PYTHONPATH="$TOOL_ROOT/scripts" python3 - "$TASKS" <<'PY'
import sys
from pathlib import Path
import spec_trace
rows = spec_trace.task_checkbox_lines(Path(sys.argv[1]).read_text(encoding="utf-8"), False)
print("\n".join(f"{line}:{text}" for line, text in rows))
PY
)
if [ -n "$UNCHECKED" ]; then
  echo "spec-archive: $FEATURE has unchecked tasks — refusing to archive:" >&2
  printf '%s\n' "$UNCHECKED" >&2
  exit 1
fi

[ -e "$DEST" ] && { echo "spec-archive: destination already exists: $DEST" >&2; exit 1; }

mkdir -p "$SPECS_DIR/archive"
git -C "$REPO_ROOT" mv "$SRC" "$DEST"
echo "spec-archive: moved $FEATURE -> .ai/specs/archive/$FEATURE (staged via git mv — commit via the normal PR flow)"
