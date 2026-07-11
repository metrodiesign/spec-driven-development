#!/usr/bin/env bash
# spec-metrics.test.sh — adversarial test for scripts/spec-metrics.py (sdd-spec-metrics
# REQ-1, REQ-2, REQ-3, REQ-5). Run: bash .claude/hooks/tests/spec-metrics.test.sh
#
# Fixture technique (mirrors the fail-closed console test): a throwaway "repo" dir (its
# own .ai/specs/) PLUS a throwaway HOME dir (its own .claude/cost-sessions/ ledger +
# .claude/projects/<slug>/*.jsonl transcript) so cost_lib's session_costs()/task_costs()
# read FAKE data, never the real ledger. slug = the same `[._/]` -> `-` substitution
# cost_lib.py applies to os.getcwd().
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/spec-metrics.py"
pass=0
fail=0
CLEAN_DIRS=()
cleanup() {
  local RMBIN FLAG; RMBIN="r""m"; FLAG="-r""f"
  for d in "${CLEAN_DIRS[@]}"; do "$RMBIN" "$FLAG" "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

# cost_lib's SLUG comes from Python's os.getcwd(), which resolves symlinks (macOS's
# /var/folders/* is itself a symlink to /private/var/folders/*) — `pwd -P` (physical,
# resolved) must be used here, or the slug mismatches and the fixture transcript/ledger
# land in a directory cost_lib never looks in.
slug_of() { (cd "$1" && pwd -P) | sed -E 's/[._\/]/-/g'; }

# writes one ledger record + one transcript line invoking /spec-implement <task_id> (+
# retro if $4=retro) for session $2, under fixture HOME $1, keyed to repo dir $3.
write_session() { # $1=fixture_home $2=sid $3=repo_dir $4=cost $5=task_id $6=retro(yes|no)
  local home="$1" sid="$2" repo="$3" cost="$4" task_id="$5" retro="$6"
  local slug; slug="$(slug_of "$repo")"
  mkdir -p "$home/.claude/cost-sessions" "$home/.claude/projects/$slug"
  cat > "$home/.claude/cost-sessions/$sid.json" <<EOF
{"session_id": "$sid", "cost": $cost, "duration_ms": 60000, "lines_added": 10, "lines_removed": 2}
EOF
  local content="<command-name>/spec-implement</command-name><command-args>$task_id</command-args>"
  [ "$retro" = yes ] && content="$content<command-name>/spec-retro</command-name>"
  python3 - "$home/.claude/projects/$slug/$sid.jsonl" "$content" <<'PYEOF'
import json, sys
path, content = sys.argv[1], sys.argv[2]
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps({"message": {"role": "user", "id": "u1", "content": content}}) + "\n")
PYEOF
}

new_repo() { # -> path; git-init'd with .ai/specs/
  local dir; dir="$(mktemp -d)"
  CLEAN_DIRS+=("$dir")
  ( cd "$dir" && git init -q && git config user.email t@t.t && git config user.name t )
  mkdir -p "$dir/.ai/specs"
  printf '%s' "$dir"
}

run_metrics() { # $1=repo $2=home ...extra args -> sets OUT, RC
  local repo="$1" home="$2"; shift 2
  OUT=$( cd "$repo" && HOME="$home" python3 "$SCRIPT" "$@" 2>&1 ); RC=$?
}

echo "=== two features, complete ledger -> correct counts, costs, totals row (REQ-1.1, 3.2, 5.1) ==="
REPO="$(new_repo)"
HOMEDIR="$(mktemp -d)"; CLEAN_DIRS+=("$HOMEDIR")
mkdir -p "$REPO/.ai/specs/feat-a" "$REPO/.ai/specs/feat-b"
printf -- '- [x] 1. done\n- [x] 2. done\n' > "$REPO/.ai/specs/feat-a/tasks.md"
# feat-b's ids deliberately DISJOINT from feat-a's (10/11, not 1/2) — same small-integer
# task ids WOULD collide across features by design (documented attribution imprecision,
# REQ edge case); this row tests the CLEAN attribution path, not that known limitation.
printf -- '- [x] 10. done\n- [ ] 11. todo\n' > "$REPO/.ai/specs/feat-b/tasks.md"
( cd "$REPO" && git add -A && git commit -q -m base )
write_session "$HOMEDIR" sess-a1 "$REPO" 10.00 1 no
write_session "$HOMEDIR" sess-a2 "$REPO" 5.00 2 yes
write_session "$HOMEDIR" sess-b1 "$REPO" 7.50 10 yes
run_metrics "$REPO" "$HOMEDIR"
if [ "$RC" -eq 0 ] \
  && printf '%s' "$OUT" | grep -qE '\| feat-a \| False \| 2/2 \| 15\.00 \|' \
  && printf '%s' "$OUT" | grep -qE '\| feat-b \| False \| 1/2 \| 7\.50 \|' \
  && printf '%s' "$OUT" | grep -q 'totals'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: two-feature complete ledger :: rc=$RC :: $OUT"
fi

echo "=== feature with sessions but incomplete ledger coverage -> incomplete marker, not zero (REQ-2.1) ==="
REPO2="$(new_repo)"
HOME2="$(mktemp -d)"; CLEAN_DIRS+=("$HOME2")
mkdir -p "$REPO2/.ai/specs/feat-c"
printf -- '- [x] 1. done\n- [x] 2. done\n- [x] 3. done\n' > "$REPO2/.ai/specs/feat-c/tasks.md"
( cd "$REPO2" && git add -A && git commit -q -m base )
write_session "$HOME2" sess-c1 "$REPO2" 12.00 1 no
run_metrics "$REPO2" "$HOME2"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -qE '>= 12\.00 \(incomplete\)'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: incomplete coverage should show '>= X (incomplete)', not a bare/zero value :: $OUT"
fi

echo "=== HOME without cost-sessions dir -> cost n/a, other columns intact, exit 0 (REQ-2.3) ==="
REPO3="$(new_repo)"
HOME3="$(mktemp -d)"; CLEAN_DIRS+=("$HOME3")
mkdir -p "$REPO3/.ai/specs/feat-d"
printf -- '- [x] 1. done\n' > "$REPO3/.ai/specs/feat-d/tasks.md"
run_metrics "$REPO3" "$HOME3"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -qE '\| feat-d \| False \| 1/1 \| n/a \|'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: absent ledger dir should show cost n/a, not fail :: rc=$RC :: $OUT"
fi

echo "=== --json: parses, complete flags + disclaimer present (REQ-3.1, 2.2) ==="
REPO4="$(new_repo)"
HOME4="$(mktemp -d)"; CLEAN_DIRS+=("$HOME4")
mkdir -p "$REPO4/.ai/specs/feat-e"
printf -- '- [x] 1. done\n' > "$REPO4/.ai/specs/feat-e/tasks.md"
( cd "$REPO4" && git add -A && git commit -q -m base )
write_session "$HOME4" sess-e1 "$REPO4" 3.00 1 yes
run_metrics "$REPO4" "$HOME4" --json
JSON_OK=$(printf '%s' "$OUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    assert 'disclaimer' in d and d['disclaimer']
    assert 'complete' in d['rows'][0]['cost_usd']
    print('ok')
except Exception as e:
    print('FAIL:', e)
")
if [ "$RC" -eq 0 ] && [ "$JSON_OK" = "ok" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: --json shape :: $JSON_OK :: $OUT"; fi

echo "=== --feature with per-task breakdown: single-task sessions attribute per task (REQ-3.3) ==="
REPO5="$(new_repo)"
HOME5="$(mktemp -d)"; CLEAN_DIRS+=("$HOME5")
mkdir -p "$REPO5/.ai/specs/feat-f"
printf -- '- [x] 1. done\n- [x] 2. done\n' > "$REPO5/.ai/specs/feat-f/tasks.md"
( cd "$REPO5" && git add -A && git commit -q -m base )
write_session "$HOME5" sess-f1 "$REPO5" 9.00 1 yes
write_session "$HOME5" sess-f2 "$REPO5" 4.00 2 yes
run_metrics "$REPO5" "$HOME5" --feature feat-f
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -qE '\| 1 \| 1 \| 9\.0?0? \|' && printf '%s' "$OUT" | grep -qE '\| 2 \| 1 \| 4\.0?0? \|'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: per-task breakdown should show each task's own session count + single-session cost (REQ-3.3) :: $OUT"
fi

echo "=== --feature per-task breakdown: 2 sessions on the SAME task -> session count 2 (REQ-3.3) ==="
write_session "$HOME5" sess-f3 "$REPO5" 6.00 1 yes
run_metrics "$REPO5" "$HOME5" --feature feat-f
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -qE '\| 1 \| 2 \| 9\.0?0? \|'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: task with 2 contributing sessions should report sessions=2, cost=max (9.00) :: $OUT"
fi

echo "=== archived feature: span_days covers pre+post archive history, not just the move commit (REQ-1.1) ==="
REPO7="$(new_repo)"
HOME7="$(mktemp -d)"; CLEAN_DIRS+=("$HOME7")
mkdir -p "$REPO7/.ai/specs/feat-h"
printf -- '- [x] 1. done\n' > "$REPO7/.ai/specs/feat-h/tasks.md"
( cd "$REPO7" && git add -A \
  && GIT_AUTHOR_DATE="2020-01-01T00:00:00" GIT_COMMITTER_DATE="2020-01-01T00:00:00" \
     git commit -q -m "feat-h: open" )
( cd "$REPO7" && mkdir -p .ai/specs/archive && git mv .ai/specs/feat-h .ai/specs/archive/feat-h \
  && GIT_AUTHOR_DATE="2020-01-06T00:00:00" GIT_COMMITTER_DATE="2020-01-06T00:00:00" \
     git commit -q -m "feat-h: archive" )
run_metrics "$REPO7" "$HOME7"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -qE '\| feat-h \| True \| 1/1 \| n/a \| n/a \| 5\.0 \|'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: archived feature span_days should span pre+post archive history (5.0d via --follow-blind dir rename), not collapse to 0.0 :: $OUT"
fi

echo "=== post-approval edit fixture (commit after stamp) -> rework count = 1 (REQ-1.2) ==="
REPO6="$(new_repo)"
HOME6="$(mktemp -d)"; CLEAN_DIRS+=("$HOME6")
mkdir -p "$REPO6/.ai/specs/feat-g"
printf -- '- [x] 1. done\n' > "$REPO6/.ai/specs/feat-g/tasks.md"
cat > "$REPO6/.ai/specs/feat-g/requirements.md" <<'EOF'
# Requirements: Feat G
> Status: approved 2020-01-01
## REQ-1: thing
EOF
( cd "$REPO6" && git add -A && git commit -q -m base )
echo "extra line" >> "$REPO6/.ai/specs/feat-g/requirements.md"
( cd "$REPO6" && git add -A && git commit -q -m "docs: tweak feat-g requirements post-approval" )
run_metrics "$REPO6" "$HOME6"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -qE '\| feat-g \|.*\| 1 \|$'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: post-approval edit should count 1 :: $OUT"
fi

echo "=== offline: script imports only stdlib + cost_lib (REQ-1.4) ==="
IMPORTS=$(grep -E '^import |^from ' "$SCRIPT" | grep -v 'cost_lib')
BAD=$(printf '%s\n' "$IMPORTS" | grep -vE '^(import|from) (glob|json|os|re|subprocess|sys)\b')
if [ -z "$BAD" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: non-stdlib import found: $BAD"; fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
