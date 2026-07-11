#!/usr/bin/env bash
# ci-test-scope.sh — decides and runs the right TEST scope for the CI event (REQ-3, 5.3).
# PR events run pnpm's changed-since filter (package + every dependent, "AS MERGED"
# against current base per the default pull_request merge-ref checkout — ARC-F5). Any
# changed file outside every workspace package (root manifest/lockfile/shared config),
# or any resolution/probe failure, runs the FULL suite — fail-closed to running more,
# never to skipping (REQ-3.6). typecheck/lint/vendor-check/guard-tests/spec-trace are
# NOT scoped by this script (REQ-3.4) — they stay in ci.yml, unconditional on every event.
#
# usage: ci-test-scope.sh <event_name> <base_ref>
# env:   CI_SCOPE_DRY_RUN=1  -> print the decision, run nothing (for tests)
# exit:  the underlying pnpm exit code
#
# Deliberately no `set -e`: several steps below capture a failing command's own exit
# status via `||`/`$?` and DECIDE from it, rather than aborting — an uncaught abort here
# would violate REQ-3.6 (probe/resolution failures must run the full suite, not crash).
set -uo pipefail

EVENT="${1:?usage: ci-test-scope.sh <event_name> <base_ref>}"
BASE_REF="${2:?usage: ci-test-scope.sh <event_name> <base_ref>}"

run_full() { # $1=cause
  echo "scope: event=$EVENT decision=full cause=\"$1\"" >&2
  if [ "${CI_SCOPE_DRY_RUN:-0}" = 1 ]; then
    echo "DRY_RUN: would run pnpm test"
    exit 0
  fi
  exec pnpm test
}

if [ "$EVENT" != "pull_request" ]; then
  run_full "non-PR event ($EVENT)"
fi

BASE=$(git merge-base "origin/$BASE_REF" HEAD 2>/dev/null)
[ -n "$BASE" ] || run_full "merge-base unresolvable (origin/$BASE_REF)"

CHANGED=$(git diff --name-only "$BASE"..HEAD 2>/dev/null)
[ $? -eq 0 ] || run_full "git diff failed ($BASE..HEAD)"

# Root-file guard (REQ-3.5, ARC-F4): package dirs read straight from pnpm-workspace.yaml
# so this never drifts from the real workspace shape. Any changed path not under one of
# them (root package.json, lockfile, tsconfig.base.json, eslint config, workflow/guard
# files, ...) can affect every package without being "in" one.
[ -f pnpm-workspace.yaml ] || run_full "pnpm-workspace.yaml not found"
PKG_DIRS=$(awk '
  /^packages:/ { f=1; next }
  f && /^[[:space:]]*-/ { gsub(/^[[:space:]]*-[[:space:]]*/, ""); print; next }
  f { exit }
' pnpm-workspace.yaml)
[ -n "$PKG_DIRS" ] || run_full "no package dirs parsed from pnpm-workspace.yaml"

OUTSIDE_FILE=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  in_pkg=0
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    case "$f" in "$d"/*) in_pkg=1; break ;; esac
  done <<< "$PKG_DIRS"
  if [ "$in_pkg" -eq 0 ]; then OUTSIDE_FILE="$f"; break; fi
done <<< "$CHANGED"
[ -z "$OUTSIDE_FILE" ] || run_full "root-file change ($OUTSIDE_FILE)"

# Captured-exit package probe (REQ-3.6, ARC-F3): a non-zero exit is read as FAILURE and
# runs the full suite — never misread as "0 packages -> skip" (that would be fail-OPEN).
if AFFECTED=$(pnpm ls -r --depth -1 --parseable --filter "...[${BASE}]" 2>/dev/null); then
  TOTAL_LIST=$(pnpm ls -r --depth -1 --parseable 2>/dev/null) || run_full "package probe failed (total enumeration)"
  COUNT=$(printf '%s\n' "$AFFECTED" | grep -c . || true)
  TOTAL=$(printf '%s\n' "$TOTAL_LIST" | grep -c . || true)
  SKIPPED=$((TOTAL - COUNT))
  if [ "$COUNT" -eq 0 ]; then
    echo "scope: event=$EVENT decision=skip base=$BASE affected=0 skipped=$SKIPPED total=$TOTAL" >&2
    exit 0
  fi
  echo "scope: event=$EVENT decision=filtered base=$BASE affected=$COUNT skipped=$SKIPPED total=$TOTAL" >&2
  if [ "${CI_SCOPE_DRY_RUN:-0}" = 1 ]; then
    echo "DRY_RUN: would run pnpm --filter \"...[${BASE}]\" -r test"
    exit 0
  fi
  exec pnpm --filter "...[${BASE}]" -r test
else
  run_full "package probe failed"
fi
