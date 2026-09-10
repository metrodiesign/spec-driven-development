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
#        check-evidence.sh --lines-strict FILE < content
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
# --lines-strict FILE lists positive, unique physical line numbers. Only completed-task
#               regions opening on those lines are checked with --strict semantics.
#               Invalid numbers or lines that are not completed-task openings exit 2.
#
# stdout: opening line of each failing task (only on exit 1)
# exit:   0 pass · 1 evidence-fail · 2 usage/engine error
set -u

MODE="${1:-}"
SELECT_FILE=""
case "$MODE" in
  --strict) ;;
  --added-only|--lines-strict)
    SELECT_FILE="${2:-}"
    [ -n "$SELECT_FILE" ] || { echo "usage: check-evidence.sh $MODE FILE" >&2; exit 2; }
    [ -r "$SELECT_FILE" ] || exit 2
    ;;
  *) echo "usage: check-evidence.sh --strict|--added-only FILE|--lines-strict FILE" >&2; exit 2 ;;
esac

if [ "$MODE" != "--strict" ] && [ ! -s "$SELECT_FILE" ]; then
  exit 0
fi

CONTENT="$(cat)"

EV_FAIL=$(printf '%s\n' "$CONTENT" | awk -v mode="$MODE" -v select_file="$SELECT_FILE" '
  BEGIN {
    if (mode == "--added-only") {
      while ((getline value < select_file) > 0) selected[value] = 1
      close(select_file)
    } else if (mode == "--lines-strict") {
      while ((getline value < select_file) > 0) {
        if (value !~ /^[1-9][0-9]*$/ || (value in selected)) {
          print "invalid or duplicate selected line: " value > "/dev/stderr"
          selection_error=1
        } else {
          selected[value]=1
        }
      }
      close(select_file)
      if (selection_error) exit 2
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
  function indent_of(v,   n) {
    n=0
    while (substr(v, n + 1, 1) == " " || substr(v, n + 1, 1) == "\t") n++
    return n
  }
  function fence_run(v,   c,n,lead) {
    lead=0
    while (substr(v, lead + 1, 1) == " " || substr(v, lead + 1, 1) == "\t") lead++
    v=substr(v, lead + 1)
    c=substr(v, 1, 1)
    if (c != "`" && c != "~") return 0
    n=0
    while (substr(v, n + 1, 1) == c) n++
    return n >= 3 ? n : 0
  }
  function hierarchy_error(message) {
    print message > "/dev/stderr"
    parse_error=1
  }
  function selected_node(line_no, text) {
    return (mode == "--strict") || (mode == "--added-only" && (text in selected)) || \
           (mode == "--lines-strict" && (line_no in selected))
  }
  function record_evidence(owner, value) {
    if (mode == "--added-only") have_ev[owner]=1
    else if (nontrivial(value)) have_ev[owner]=1
    else if (trim(value) == "") collect_evidence=1
  }
  {
    line=$0
    indent=indent_of(line)
    stripped=substr(line, indent + 1)

    if (evidence_region) {
      evidence_bullet=(indent == evidence_indent && stripped ~ /^-[[:space:]]/ && stripped !~ /^- \[[ xX]\]/)
      if (stripped == "" || indent > evidence_indent || evidence_bullet) {
        if (collect_evidence && stripped ~ /^-[[:space:]]/) {
          val=stripped
          sub(/^-[[:space:]]*/, "", val)
          sub(/^[^[:space:]:]+:[[:space:]]*/, "", val)
          if (nontrivial(val)) have_ev[evidence_owner]=1
        }
        next
      }
      evidence_region=0; collect_evidence=0
    }

    run=fence_run(line)
    if (run) {
      char=substr(stripped, 1, 1)
      if (!in_fence) { in_fence=1; fence_char=char; fence_len=run }
      else if (char == fence_char && run >= fence_len) { in_fence=0 }
      next
    }
    if (in_fence) next

    if (stripped ~ /^- \[[ xX]\]/) {
      tail=stripped
      sub(/^- \[[ xX]\][[:space:]]*/, "", tail)
      split(tail, words, /[[:space:]]+/)
      id=words[1]
      checked=(stripped ~ /^- \[[xX]\]/)
      if (indent == 0 && id ~ /^[0-9]+\.$/) {
        sub(/\.$/, "", id)
        if (id ~ /^0[0-9]/) hierarchy_error("line " NR ": root task ID " id " has a leading zero")
        else if (id in root_seen) hierarchy_error("line " NR ": duplicate root task ID " id)
        root_seen[id]=NR; current_root=NR; current_root_id=id; current_child=0
        root_has_children[NR]=0
      } else if (indent == 2 && id ~ /^[0-9]+\.[0-9]+$/) {
        split(id, parts, ".")
        if (!current_root) hierarchy_error("line " NR ": orphan child task ID " id)
        else if (parts[1] != current_root_id) hierarchy_error("line " NR ": child task ID " id " does not belong to root " current_root_id)
        else if (id in child_seen) hierarchy_error("line " NR ": duplicate child task ID " id)
        else if (root_evidence[current_root]) hierarchy_error("line " NR ": child task ID " id " appears after root Evidence")
        if (parts[1] ~ /^0[0-9]/ || parts[2] ~ /^0[0-9]/) hierarchy_error("line " NR ": child task ID " id " has a leading zero")
        child_seen[id]=NR; current_child=NR; parent[NR]=current_root
        root_has_children[current_root]=1
        if (!checked) root_pending[current_root]=1
      } else {
        hierarchy_error("line " NR ": invalid task ID or nesting: " id)
      }
      node[NR]=1; task_text[NR]=line; is_checked[NR]=checked
      if (mode == "--lines-strict" && checked && (NR in selected)) seen[NR]=1
      next
    }

    lower=tolower(stripped)
    evidence_text=lower
    if (evidence_text ~ /^-[[:space:]]+evidence:/) sub(/^-[[:space:]]+/, "", evidence_text)
    if (evidence_text ~ /^evidence:/ && current_root) {
      owner=0
      if (root_has_children[current_root]) {
        if (indent == 2) owner=current_root
        else if (indent == 4 && current_child) owner=current_child
      } else if (indent > 0) owner=current_root
      if (owner) {
        original=stripped
        if (original ~ /^-[[:space:]]+/) sub(/^-[[:space:]]+/, "", original)
        sub(/^[Ee][Vv][Ii][Dd][Ee][Nn][Cc][Ee]:[[:space:]]*/, "", original)
        if (owner == current_root) root_evidence[current_root]=1
        record_evidence(owner, original)
        evidence_region=1; evidence_owner=owner; evidence_indent=indent
        next
      }
    }
  }
  END {
    if (in_fence) hierarchy_error("line EOF: unclosed fenced block in tasks.md")
    if (selection_error || parse_error) exit 2
    if (mode == "--lines-strict") {
      for (line_no in selected) {
        if (!(line_no in seen)) {
          print "selected line is not a completed-task opening: " line_no > "/dev/stderr"
          selection_error=1
        }
      }
    }
    if (selection_error) exit 2
    for (line_no in node) {
      if (!is_checked[line_no] || !selected_node(line_no, task_text[line_no])) continue
      if (!have_ev[line_no] || (root_has_children[line_no] && root_pending[line_no])) {
        failed_line[line_no]=1
      }
    }
    for (line_no=1; line_no<=NR; line_no++) {
      if (failed_line[line_no]) { print task_text[line_no]; failed=1 }
    }
    exit (selection_error ? 2 : (failed ? 1 : 0))
  }
')
RC=$?
case "$RC" in
  0) exit 0 ;;
  1) printf '%s\n' "$EV_FAIL"; exit 1 ;;
  *) exit 2 ;;
esac
