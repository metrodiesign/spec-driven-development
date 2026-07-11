#!/usr/bin/env bash
# check-evidence.sh — single Evidence-policy engine (REQ-1). One awk core lifted from
# gate-task.sh's original per-task awk (PR #24-hardened), parameterized by mode so each
# call site keeps its OWN pre-existing strictness (REQ-1.3 — parity is per-mode, this
# does not merge the levels). Emits ONLY the opening line of each failing task region on
# stdout; prints no user-facing message — callers keep their existing strings verbatim,
# so message byte-identity holds by construction (REQ-4.4).
#
# usage: check-evidence.sh --strict            < content
#        check-evidence.sh --added-only FILE   < content
#
# --strict      every `[x]` task region in stdin needs its OWN non-trivial Evidence
#               (inline value or block bullet) — gate-task.sh's semantics, verbatim.
# --added-only  FILE lists the newly-added `- [x]` lines (exact opening-line text, one
#               per line). Only regions whose opening line is IN FILE are checked, and
#               the check is PRESENCE-ONLY (any `Evidence:` line counts, even a
#               placeholder value) — pre-commit's semantics, verbatim; do NOT upgrade
#               this to the --strict non-trivial check.
#               FILE empty -> exit 0 (no newly-added tasks this diff; ARC-F7).
#               FILE missing/unreadable -> exit 2 (caller bug; fail closed).
#
# stdout: opening line of each failing task (only on exit 1)
# exit:   0 pass · 1 evidence-fail · 2 usage/engine error
set -u

MODE="${1:-}"
ADDED_FILE=""
case "$MODE" in
  --strict) ;;
  --added-only)
    ADDED_FILE="${2:-}"
    [ -n "$ADDED_FILE" ] || { echo "usage: check-evidence.sh --added-only FILE" >&2; exit 2; }
    [ -r "$ADDED_FILE" ] || exit 2
    ;;
  *) echo "usage: check-evidence.sh --strict|--added-only FILE" >&2; exit 2 ;;
esac

if [ "$MODE" = "--added-only" ] && [ -z "$(cat "$ADDED_FILE")" ]; then
  exit 0
fi

CONTENT="$(cat)"

EV_FAIL=$(printf '%s\n' "$CONTENT" | awk -v mode="$MODE" -v added_file="$ADDED_FILE" '
  BEGIN {
    if (mode == "--added-only") {
      while ((getline aline < added_file) > 0) added[aline] = 1
      close(added_file)
    }
  }
  # non-trivial = real content, not empty / a bare placeholder. Used (in --strict mode
  # only) for both the inline Evidence: value and each Evidence-block bullet. Strips
  # decorative whitespace/backticks/quotes.
  function trim(v) { gsub(/^[[:space:]`"'"'"']+|[[:space:]`"'"'"']+$/, "", v); return v }
  function nontrivial(v,   lc) {
    v=trim(v); lc=tolower(v)
    return (v != "" && lc != "todo" && lc != "tbd" && lc != "???" && \
            lc != "-" && lc != "." && lc != "none" && lc != "pending" && \
            lc != "n/a (write path)")
  }
  # A checkbox line starts a new task region. Track only [x] regions for Evidence.
  /^[[:space:]]*-[[:space:]]\[[xX]\]/ {
    if (in_x && needs_check && !have_ev) { print prev_task; failed=1 }
    in_x=1; have_ev=0; ev_open=0
    prev_task=$0
    needs_check = (mode == "--strict") || (mode == "--added-only" && ($0 in added))
    next
  }
  /^[[:space:]]*-[[:space:]]\[[[:space:]]\]/ {
    # a [ ] (unchecked) task closes any open [x] region.
    if (in_x && needs_check && !have_ev) { print prev_task; failed=1 }
    in_x=0; have_ev=0; ev_open=0
    next
  }
  {
    if (in_x && !have_ev) {
      line=$0
      if (mode == "--added-only") {
        # PRESENCE-ONLY (pre-commit semantics): any Evidence: line counts, trivial or not.
        if (line ~ /^[[:space:]]*[Ee][Vv][Ii][Dd][Ee][Nn][Cc][Ee]:/) { have_ev=1 }
      } else {
        # --strict (gate-task semantics): the documented multiline block format is an
        # Evidence: header followed by bullets, so the value can live inline on the
        # header OR on a following bullet. Either non-trivial form satisfies the gate.
        if (line ~ /^[[:space:]]*[Ee][Vv][Ii][Dd][Ee][Nn][Cc][Ee]:/) {
          val=line
          sub(/^[[:space:]]*[Ee][Vv][Ii][Dd][Ee][Nn][Cc][Ee]:[[:space:]]*/, "", val)
          # ONLY a truly empty Evidence: header opens bullet-collection mode. A
          # non-empty but placeholder header (Evidence: TODO) stays trivial and must
          # NOT open the block — else a later non-evidence bullet would rescue it.
          if (nontrivial(val)) { have_ev=1 } else if (trim(val) == "") { ev_open=1 }
        } else if (ev_open && line ~ /^[[:space:]]*-[[:space:]]/) {
          # a bullet inside an open Evidence block. Strip the dash AND an optional
          # key: label (test:/viewports:/deviations:) so a placeholder VALUE
          # (- test: TODO) is judged on the value, not the ever-non-trivial label.
          val=line
          sub(/^[[:space:]]*-[[:space:]]*/, "", val)
          sub(/^[^[:space:]:]+:[[:space:]]*/, "", val)
          if (nontrivial(val)) { have_ev=1 }
        }
      }
    }
  }
  END { if (in_x && needs_check && !have_ev) { print prev_task; failed=1 } exit (failed?1:0) }
')
RC=$?
if [ "$RC" -eq 1 ]; then
  printf '%s\n' "$EV_FAIL"
  exit 1
fi
exit 0
