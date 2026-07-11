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

# Checkbox shape shared with .ai/bin/lib-guard.sh's CB_TODO (same "- [ ]" regex, kept as
# its own local copy here — this is an operator maintenance tool, not a security guard,
# so it does not source the guard fragment; REQ-1.2/1.3).
UNCHECKED=$(grep -nE '^[[:space:]]*-[[:space:]]\[[[:space:]]\]' "$TASKS" || true)
if [ -n "$UNCHECKED" ]; then
  echo "spec-archive: $FEATURE has unchecked tasks — refusing to archive:" >&2
  printf '%s\n' "$UNCHECKED" >&2
  exit 1
fi

[ -e "$DEST" ] && { echo "spec-archive: destination already exists: $DEST" >&2; exit 1; }

mkdir -p "$SPECS_DIR/archive"
git -C "$REPO_ROOT" mv "$SRC" "$DEST"
echo "spec-archive: moved $FEATURE -> .ai/specs/archive/$FEATURE (staged via git mv — commit via the normal PR flow)"
