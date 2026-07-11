#!/usr/bin/env bash
# lessons-coverage-check.sh — CI checker: slug sets in LESSONS.md and LESSONS-COVERAGE.md
# match both directions, and every `mechanized` row's artifact file exists AND still
# contains that row's [#slug] marker (sdd-lessons-to-guard-tests REQ-1, REQ-2.2).
# Path-exists alone would let a deleted case rot silently inside a surviving test file —
# the marker check catches that.
#
# usage: lessons-coverage-check.sh
# exit 0: slug sets identical AND every mechanized artifact resolves + carries its marker
# exit 1: lists missing/orphan slugs, dangling paths, or files missing the slug marker
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
LESSONS="$REPO_ROOT/.ai/shared/LESSONS.md"
COVERAGE="$REPO_ROOT/.ai/shared/LESSONS-COVERAGE.md"
fail=0

LESSONS_SLUGS=$(grep -oE '^- \[#[a-z0-9-]+\]' "$LESSONS" | sed -E 's/^- \[#//; s/\]$//' | sort -u)
COVERAGE_SLUGS=$(grep -oE '^\| [a-z0-9-]+ \|' "$COVERAGE" | sed -E 's/^\| //; s/ \|$//' | grep -v '^slug$' | sort -u)

MISSING_IN_COVERAGE=$(comm -23 <(printf '%s\n' "$LESSONS_SLUGS") <(printf '%s\n' "$COVERAGE_SLUGS"))
ORPHAN_IN_COVERAGE=$(comm -13 <(printf '%s\n' "$LESSONS_SLUGS") <(printf '%s\n' "$COVERAGE_SLUGS"))

if [ -n "$MISSING_IN_COVERAGE" ]; then
  fail=1
  echo "lessons-coverage-check: slugs in LESSONS.md with no coverage row:" >&2
  printf '  %s\n' $MISSING_IN_COVERAGE >&2
fi
if [ -n "$ORPHAN_IN_COVERAGE" ]; then
  fail=1
  echo "lessons-coverage-check: orphan coverage rows with no matching LESSONS.md slug:" >&2
  printf '  %s\n' $ORPHAN_IN_COVERAGE >&2
fi

# every `mechanized` row: extract slug + artifact path (the enforcement cell's leading
# token, up to "::" or the first space), verify it exists and still carries the marker.
while IFS='|' read -r _ slug cls enforcement _; do
  slug=$(printf '%s' "$slug" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  cls=$(printf '%s' "$cls" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  [ "$cls" = "mechanized" ] || continue
  enforcement=$(printf '%s' "$enforcement" | sed -E 's/^[[:space:]]+//')
  artifact_path=$(printf '%s' "$enforcement" | awk -F'::' '{print $1}' | awk '{print $1}')
  full="$REPO_ROOT/$artifact_path"
  if [ ! -f "$full" ]; then
    fail=1
    echo "lessons-coverage-check: mechanized row '$slug' names a dangling path: $artifact_path" >&2
    continue
  fi
  if ! grep -qF "[#$slug]" "$full"; then
    fail=1
    echo "lessons-coverage-check: $artifact_path no longer carries the [#$slug] marker" >&2
  fi
done < <(grep -E '^\| [a-z0-9-]+ \|' "$COVERAGE")

if [ "$fail" -eq 0 ]; then
  echo "lessons-coverage-check: OK — slugs synced, all mechanized artifacts present and marked."
fi
exit "$fail"
