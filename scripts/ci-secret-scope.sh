#!/usr/bin/env bash
# ci-secret-scope.sh — decides and runs the right secret-scan scope for the CI event
# (REQ-2.1, 2.2, 5.3). PR events scan the diff (--range); anything else (push to
# develop/main, or any resolution failure) scans everything (--all) — the full-tree
# floor never weakens, it only ever gets a narrower FAST PATH on top of it.
#
# usage: ci-secret-scope.sh <event_name> <base_ref>
# env:   CI_SCOPE_DRY_RUN=1  -> print the decision, run nothing (for tests)
# exit:  the underlying check-secrets.sh exit code; decision failures never exit 0
#        without having run the FULL fallback (--all)
set -euo pipefail

EVENT="${1:?usage: ci-secret-scope.sh <event_name> <base_ref>}"
BASE_REF="${2:?usage: ci-secret-scope.sh <event_name> <base_ref>}"
BIN="$(cd "$(dirname "$0")/../.ai/bin" && pwd)"
ENGINE="$BIN/check-secrets.sh"

run_all() { # $1=cause
  echo "scope: event=$EVENT decision=all cause=\"$1\"" >&2
  if [ "${CI_SCOPE_DRY_RUN:-0}" = 1 ]; then
    echo "DRY_RUN: would run check-secrets.sh --all"
    exit 0
  fi
  exec "$ENGINE" --all
}

if [ "$EVENT" != "pull_request" ]; then
  run_all "non-PR event ($EVENT)"
fi

BASE=$(git merge-base "origin/$BASE_REF" HEAD 2>/dev/null || true)
[ -n "$BASE" ] || run_all "merge-base unresolvable (origin/$BASE_REF)"
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || true)
[ -n "$HEAD_SHA" ] || run_all "HEAD unresolvable"

echo "scope: event=$EVENT decision=range base=$BASE head=$HEAD_SHA" >&2
if [ "${CI_SCOPE_DRY_RUN:-0}" = 1 ]; then
  echo "DRY_RUN: would run check-secrets.sh --range $BASE..$HEAD_SHA"
  exit 0
fi
exec "$ENGINE" --range "$BASE..$HEAD_SHA"
