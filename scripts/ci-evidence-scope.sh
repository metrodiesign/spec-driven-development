#!/usr/bin/env bash
# Require strict Evidence only for completed task openings added by this CI diff.
# usage: ci-evidence-scope.sh <event_name> <base_ref> <before_sha>
# exit: 0 pass, 1 Evidence failure, 2 event/range/parser failure
set -euo pipefail

EVENT="${1:-}"
BASE_REF="${2:-}"
BEFORE_SHA="${3:-}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="$REPO_ROOT/.ai/bin/check-evidence.sh"

fail_scope() {
  echo "Evidence scope error: $1" >&2
  exit 2
}

[ -n "$EVENT" ] || fail_scope "missing event name"
[ -x "$ENGINE" ] || fail_scope "missing/non-executable parser at $ENGINE"
HEAD_SHA=$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null) || fail_scope "HEAD unresolvable"

case "$EVENT" in
  pull_request)
    [ -n "$BASE_REF" ] || fail_scope "pull_request event has empty base_ref"
    BASE_SHA=$(git merge-base "origin/$BASE_REF" "$HEAD_SHA" 2>/dev/null) || \
      fail_scope "merge-base unresolvable (origin/$BASE_REF)"
    ;;
  push)
    [ -n "$BEFORE_SHA" ] && [ -n "${BEFORE_SHA//0/}" ] || \
      fail_scope "push event has empty or zero before SHA"
    BASE_SHA=$(git rev-parse --verify "${BEFORE_SHA}^{commit}" 2>/dev/null) || \
      fail_scope "before SHA unresolvable ($BEFORE_SHA)"
    ;;
  *) fail_scope "unsupported event ($EVENT)" ;;
esac

RANGE="$BASE_SHA..$HEAD_SHA"
FILES_TMP=$(mktemp) || fail_scope "cannot allocate file list"
LINES_TMP=$(mktemp) || fail_scope "cannot allocate line selection"
CONTENT_TMP=$(mktemp) || fail_scope "cannot allocate content buffer"
trap 'rm -f -- "$FILES_TMP" "$LINES_TMP" "$CONTENT_TMP"' EXIT

git diff --name-only --diff-filter=ACMR -z "$RANGE" -- \
  ':(glob).ai/specs/**/tasks.md' ':(glob).claude/specs/**/tasks.md' \
  > "$FILES_TMP" || fail_scope "git diff failed ($RANGE)"

FAILED=0
while IFS= read -r -d '' file; do
  case "$file" in
    *$'\n'*|*$'\r'*) fail_scope "task path contains a line break" ;;
  esac

  git show "${HEAD_SHA}:${file}" > "$CONTENT_TMP" 2>/dev/null || \
    fail_scope "cannot read $file from HEAD"

  git diff --unified=0 --no-color "$RANGE" -- "$file" | awk '
    /^@@ / {
      header=$0
      sub(/^@@ -[^ ]+ \+/, "", header)
      sub(/[, ].*$/, "", header)
      if (header !~ /^[0-9]+$/) exit 2
      new_line=header + 0
      in_hunk=1
      next
    }
    in_hunk && /^\+/ {
      line=substr($0, 2)
      if (line ~ /^[[:space:]]*-[[:space:]]\[[xX]\]/) print new_line
      new_line++
      next
    }
    in_hunk && /^-/ { next }
    in_hunk && /^ / { new_line++; next }
  ' > "$LINES_TMP" || fail_scope "cannot parse diff for $file"

  [ -s "$LINES_TMP" ] || continue
  if output=$("$ENGINE" --lines-strict "$LINES_TMP" < "$CONTENT_TMP"); then
    :
  else
    rc=$?
    if [ "$rc" -ne 1 ]; then
      fail_scope "Evidence parser failed for $file (exit $rc)"
    fi
    while IFS= read -r task; do
      [ -n "$task" ] && echo "Evidence gate: $file: $task" >&2
    done <<< "$output"
    FAILED=1
  fi
done < "$FILES_TMP"

[ "$FAILED" -eq 0 ] || exit 1
