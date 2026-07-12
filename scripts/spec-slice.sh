#!/usr/bin/env bash
# spec-slice.sh — deterministic per-task slice of a spec's artifacts (REQ-3). Zero model
# judgment: the task block -> its Satisfies: REQ blocks -> design sections mapped via the
# design's own "## Requirement Traceability" table. An unresolved reference prints a
# MISSING: marker (never silently omitted) so /spec-implement can fall back to a full read
# (REQ-3.4, REQ-4.2) instead of guessing.
#
# usage: spec-slice.sh <feature> <task-id>
# exit: 0 (even with MISSING: markers present — the marker drives the fallback, not the
#          exit code) · 1 unknown task id (message lists available ids) or missing tasks.md
set -euo pipefail

FEATURE="${1:?usage: spec-slice.sh <feature> <task-id>}"
TASK_ID="${2:?usage: spec-slice.sh <feature> <task-id>}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
FDIR="$REPO_ROOT/.ai/specs/$FEATURE"
REQ_FILE="$FDIR/requirements.md"
DESIGN_FILE="$FDIR/design.md"
TASKS_FILE="$FDIR/tasks.md"

[ -d "$FDIR" ] || { echo "spec-slice: no such feature dir: $FDIR" >&2; exit 1; }
[ -f "$TASKS_FILE" ] || { echo "spec-slice: $FEATURE has no tasks.md" >&2; exit 1; }

status_line() { # $1=file -> first "> Status:" line, or a placeholder
  [ -f "$1" ] && grep -m1 '^> Status:' "$1" 2>/dev/null || echo "(no Status header)"
}

# from the line matching checkbox+id (inclusive) to the next checkbox line (exclusive) or EOF.
task_block() { # $1=file $2=task_id
  awk -v id="$2" '
    !started && $0 ~ ("^- \\[[ xX]\\][[:space:]]*" id "\\.") { started=1; print; next }
    started && /^- \[[ xX]\]/ { exit }
    started { print }
  ' "$1"
}

# from a "## REQ-<n>:" heading (inclusive) to the next "## " heading (exclusive) or EOF.
req_block() { # $1=file $2=req_number
  awk -v n="$2" '
    !started && $0 ~ ("^## REQ-" n ":") { started=1; print; next }
    started && /^## / { exit }
    started { print }
  ' "$1"
}

# from an EXACT heading line (inclusive, string equality — no regex escaping needed) to
# the next "## " heading (exclusive) or EOF.
section_from_heading() { # $1=file $2=exact_heading_line
  awk -v h="$2" '
    !started && $0 == h { started=1; print; next }
    started && /^## / { exit }
    started { print }
  ' "$1"
}

TASK_BLOCK=$(task_block "$TASKS_FILE" "$TASK_ID")
if [ -z "$TASK_BLOCK" ]; then
  AVAILABLE=$(grep -oE '^- \[[ xX]\][[:space:]]*[0-9]+\.' "$TASKS_FILE" 2>/dev/null \
    | grep -oE '[0-9]+' | tr '\n' ' ')
  echo "spec-slice: task id '$TASK_ID' not found in $TASKS_FILE" >&2
  echo "available: ${AVAILABLE:-none}" >&2
  exit 1
fi

# Satisfies: REQ ids on the task block -> parent REQ-N, deduped (criterion ids like
# REQ-1.2 resolve to their parent ## REQ-1 block, per REQ-3.1).
SATISFIES_NUMS=$(printf '%s\n' "$TASK_BLOCK" | grep -i 'Satisfies:' \
  | grep -oE 'REQ-[0-9]+' | sed -E 's/REQ-//' | sort -un)

echo "== STATUS =="
echo "requirements.md: $(status_line "$REQ_FILE")"
echo "design.md:       $(status_line "$DESIGN_FILE")"
echo "tasks.md:        $(status_line "$TASKS_FILE")"
echo "== TASK $TASK_ID (tasks.md, verbatim) =="
printf '%s\n' "$TASK_BLOCK"

MISSING=()
DESIGN_ELEMENTS_SEEN=()
DESIGN_REQS_MATCHED=()

for n in $SATISFIES_NUMS; do
  echo "== REQ-$n (requirements.md) =="
  REQ_BLK=""
  [ -f "$REQ_FILE" ] && REQ_BLK=$(req_block "$REQ_FILE" "$n")
  if [ -z "$REQ_BLK" ]; then
    MISSING+=("MISSING: REQ-$n (not found in requirements.md)")
  else
    printf '%s\n' "$REQ_BLK"
  fi
done

# Design sections: rows of design.md's own Requirement Traceability table whose REQ column
# mentions any selected id, either "REQ-N" prefixed or a bare "N.M" dotted id (REQ-3.6); the
# row's design-element cell is matched against "## " headings by literal substring (REQ-3.1).
# A cell matching no heading -> MISSING (REQ-3.4). A REQ with zero matching rows at all ->
# MISSING too (REQ-3.7) — a table written in one id style must never drop a whole design
# section silently.
if [ -f "$DESIGN_FILE" ]; then
  TRACE_BLOCK=$(awk '
    !started && /^## Requirement Traceability/ { started=1; next }
    started && /^## / { exit }
    started { print }
  ' "$DESIGN_FILE")

  while IFS= read -r row; do
    case "$row" in '|'*) ;; *) continue ;; esac
    case "$row" in *'---'*|*'Design element'*) continue ;; esac
    cell1=$(printf '%s' "$row" | awk -F'|' '{print $2}' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    cell2=$(printf '%s' "$row" | awk -F'|' '{print $3}' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    [ -z "$cell1" ] && continue

    match=0
    for n in $SATISFIES_NUMS; do
      if printf '%s' "$cell2" | grep -qE "REQ-${n}([^0-9]|\$)|(^|[^A-Za-z0-9_.])${n}\.[0-9]"; then
        match=1
        DESIGN_REQS_MATCHED+=("$n")
      fi
    done
    [ "$match" -eq 1 ] || continue

    already=0
    for seen in "${DESIGN_ELEMENTS_SEEN[@]:-}"; do
      [ "$seen" = "$cell1" ] && { already=1; break; }
    done
    [ "$already" -eq 1 ] && continue
    DESIGN_ELEMENTS_SEEN+=("$cell1")

    HEADING=$(grep '^## ' "$DESIGN_FILE" | grep -F -m1 -- "$cell1" || true)
    if [ -z "$HEADING" ]; then
      MISSING+=("MISSING: design section for \"$cell1\" (no ## heading contains it)")
      continue
    fi
    echo "== DESIGN $HEADING (design.md) =="
    section_from_heading "$DESIGN_FILE" "$HEADING"
  done <<< "$TRACE_BLOCK"

  for n in $SATISFIES_NUMS; do
    already=0
    for seen in "${DESIGN_REQS_MATCHED[@]:-}"; do
      [ "$seen" = "$n" ] && { already=1; break; }
    done
    [ "$already" -eq 1 ] || MISSING+=("MISSING: design section for REQ-$n (no traceability-table row references it)")
  done
fi

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "== MISSING =="
  printf '%s\n' "${MISSING[@]}"
fi

exit 0
