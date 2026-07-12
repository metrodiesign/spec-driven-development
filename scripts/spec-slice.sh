#!/usr/bin/env bash
# spec-slice.sh — deterministic per-task slice of a spec's artifacts (REQ-3). Zero model
# judgment: the task block -> its Satisfies: REQ blocks -> design sections mapped via the
# design's own "## Requirement Traceability" table, matched by an explicit Section column
# (exact heading text, located by header name, not position — REQ-3.8/3.12) and fence-aware
# so a heading-shaped line quoted inside a ``` block is never a false boundary (REQ-3.11).
# An unresolved reference prints a MISSING: marker (never silently omitted) so
# /spec-implement can fall back to a full read (REQ-3.4, REQ-4.2) instead of guessing.
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
# Fence-aware (REQ-3.11): a "## "-looking line inside a ``` fenced block is never a
# boundary — it toggles `fence` and is otherwise treated as inert content.
req_block() { # $1=file $2=req_number
  awk -v n="$2" '
    /^```/ { fence = !fence }
    !started && !fence && $0 ~ ("^## REQ-" n ":") { started=1; print; next }
    started && !fence && /^## / { exit }
    started { print }
  ' "$1"
}

# from an EXACT heading line (inclusive, string equality — no regex escaping needed) to
# the next "## " heading (exclusive) or EOF. Fence-aware (REQ-3.11), same as req_block().
# $2 must be a real line from the file — see find_heading_line().
section_from_heading() { # $1=file $2=exact_heading_line
  awk -v h="$2" '
    /^```/ { fence = !fence }
    !started && !fence && $0 == h { started=1; print; next }
    started && !fence && /^## / { exit }
    started { print }
  ' "$1"
}

# the real "## " heading line whose text (after "## ", trimmed both sides) exactly equals
# $2 — fence-aware (REQ-3.11) so a heading-shaped line inside a ``` block never matches.
# Prints the exact verbatim line (for section_from_heading to key off), or nothing.
find_heading_line() { # $1=file $2=heading_text (no "## " prefix, already trimmed)
  awk -v want="$2" '
    /^```/ { fence = !fence }
    !fence && /^## / {
      text = $0
      sub(/^## /, "", text)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", text)
      if (text == want) { print; exit }
    }
  ' "$1"
}

# 1-based index (among a table's real cells) of the column whose header text exactly
# equals $2; 0 if absent. REQ-3.12: locate a column by its header name, never a fixed
# position, so Section/REQ/Design-element may sit in any order.
header_col() { # $1=header_row $2=column_name
  awk -F'|' -v want="$2" '
    {
      for (i = 2; i < NF; i++) {
        v = $i
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
        if (v == want) { print i - 1; found = 1; exit }
      }
    }
    END { if (!found) print 0 }
  ' <<< "$1"
}

# trimmed text of the N-th real cell (1-based) of a "| a | b | c |" row.
cell_at() { # $1=row $2=column_index (1-based)
  awk -F'|' -v i="$2" '{ v = $(i + 1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); print v }' <<< "$1"
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
# mentions any selected id, either "REQ-N" prefixed or a bare "N.M" dotted id (REQ-3.6). The
# row's `Section` column — located by its header name via header_col(), never a fixed
# position (REQ-3.12) — is matched against real "## " headings by case-sensitive exact
# equality after trimming both sides (REQ-3.8), never literal substring against the
# free-text design-element cell (the original REQ-3.1 mechanism, retired: a real spec's
# design-element cell never literally equals its own heading). A Section value that is
# absent (no such column, or a blank cell) or matches no heading resolves to MISSING
# (REQ-3.9). Multiple rows sharing one non-empty Section value print that section's content
# once (REQ-3.10, dedup by Section) — an absent Section is never deduped, so every such row
# still surfaces its own MISSING rather than collapsing into one. A REQ with zero matching
# rows at all -> MISSING too (REQ-3.7).
if [ -f "$DESIGN_FILE" ]; then
  TRACE_BLOCK=$(awk '
    /^```/ { fence = !fence }
    !started && !fence && /^## Requirement Traceability/ { started=1; next }
    started && !fence && /^## / { exit }
    started { print }
  ' "$DESIGN_FILE")

  HEADER_ROW=""
  while IFS= read -r row; do
    case "$row" in '|'*) HEADER_ROW="$row"; break ;; esac
  done <<< "$TRACE_BLOCK"

  REQ_COL=$(header_col "$HEADER_ROW" "REQ")
  [ "$REQ_COL" -eq 0 ] && REQ_COL=$(header_col "$HEADER_ROW" "Satisfies")
  SECTION_COL=$(header_col "$HEADER_ROW" "Section")

  HEADER_SEEN=0
  while IFS= read -r row; do
    case "$row" in '|'*) ;; *) continue ;; esac
    case "$row" in *'---'*) continue ;; esac
    if [ "$HEADER_SEEN" -eq 0 ]; then HEADER_SEEN=1; continue; fi

    cell2=""
    [ "$REQ_COL" -gt 0 ] && cell2=$(cell_at "$row" "$REQ_COL")
    [ -z "$cell2" ] && continue

    match=0
    for n in $SATISFIES_NUMS; do
      if printf '%s' "$cell2" | grep -qE "REQ-${n}([^0-9]|\$)|(^|[^A-Za-z0-9_.])${n}\.[0-9]"; then
        match=1
        DESIGN_REQS_MATCHED+=("$n")
      fi
    done
    [ "$match" -eq 1 ] || continue

    SECTION_VAL=""
    [ "$SECTION_COL" -gt 0 ] && SECTION_VAL=$(cell_at "$row" "$SECTION_COL")

    if [ -z "$SECTION_VAL" ]; then
      MISSING+=("MISSING: design section for REQ column \"$cell2\" (Section value empty or column absent)")
      continue
    fi

    already=0
    for seen in "${DESIGN_ELEMENTS_SEEN[@]:-}"; do
      [ "$seen" = "$SECTION_VAL" ] && { already=1; break; }
    done
    [ "$already" -eq 1 ] && continue
    DESIGN_ELEMENTS_SEEN+=("$SECTION_VAL")

    HEADING_LINE=$(find_heading_line "$DESIGN_FILE" "$SECTION_VAL")
    if [ -z "$HEADING_LINE" ]; then
      MISSING+=("MISSING: design section for \"$SECTION_VAL\" (no ## heading matches it exactly)")
      continue
    fi
    echo "== DESIGN $HEADING_LINE (design.md) =="
    section_from_heading "$DESIGN_FILE" "$HEADING_LINE"
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
