#!/usr/bin/env bash
# lesson-tripwires.test.sh — structural (grep-based) tripwires for LESSONS.md patterns
# that live outside bash-guard reach (workflow JS, skill prose, cross-file conventions).
# TRIPWIRES ARE WEAKER THAN BEHAVIOR TESTS: each case asserts a required construct is
# PRESENT, not that the whole system behaves correctly end to end — a structural proxy,
# never claimed as a full behavior proof (sdd-lessons-to-guard-tests REQ-2.1/2.2/2.3).
# Run: bash .claude/hooks/tests/lesson-tripwires.test.sh
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
pass=0
fail=0

echo "=== [#verdict-null-not-rejected] review-fanout.js: unverified partitioned from refuted (REQ-4.1) ==="
RF="$REPO_ROOT/.claude/workflows/review-fanout.js"
if grep -qE 'const unverified = .*filter\(\(c\) => !c\.verdict\)' "$RF" \
  && grep -qE "const refuted = .*filter\\(\\(c\\) => c\\.verdict === 'REFUTED'\\)" "$RF"; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: review-fanout.js missing the unverified-vs-refuted partition shape"
fi

echo "--- node -e replica: the ACTUAL partition expressions classify an undefined-verdict item as unverified, never refuted/surviving ---"
NODE_OUT=$(node -e '
const verified = [
  { file: "a", verdict: "CONFIRMED" },
  { file: "b", verdict: "REFUTED" },
  { file: "c", verdict: undefined },
]
const surviving = verified.filter((c) => c.verdict === "CONFIRMED" || c.verdict === "PLAUSIBLE")
const refuted = verified.filter((c) => c.verdict === "REFUTED")
const unverified = verified.filter((c) => !c.verdict)
console.log(JSON.stringify({ s: surviving.length, r: refuted.length, u: unverified.length, uFile: unverified[0]?.file }))
' 2>&1)
if printf '%s' "$NODE_OUT" | grep -q '"s":1,"r":1,"u":1,"uFile":"c"'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: node -e replica did not classify as expected :: $NODE_OUT"
fi

echo "=== [#cost-from-ledger-only] cost scripts import cost_lib (single source), no independent transcript parsing ==="
for f in scripts/cost-summary.py scripts/inject-cost.py; do
  full="$REPO_ROOT/$f"
  if grep -qE '^from cost_lib import|^import cost_lib' "$full"; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); echo "FAIL: $f does not import cost_lib"
  fi
done

echo "=== [#hook-block-kills-compound-command] guard/floor scripts are tracked executable (git mode 100755) ==="
BAD_MODE=$(cd "$REPO_ROOT" && git ls-files -s .ai/bin/*.sh .githooks/* .claude/hooks/*.sh scripts/*.sh 2>/dev/null | awk '$1 != "100755" {print $4}')
if [ -z "$BAD_MODE" ]; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: non-executable guard/floor scripts in the git index: $BAD_MODE"
fi

echo "=== [#guard-needs-adversarial-test] every .ai/bin check-*.sh (+ gate-task.sh) is referenced by some *.test.sh ==="
missing=""
for f in "$REPO_ROOT"/.ai/bin/check-*.sh "$REPO_ROOT"/.ai/bin/gate-task.sh; do
  base="$(basename "$f")"
  grep -q "$base" "$REPO_ROOT"/.claude/hooks/tests/*.test.sh 2>/dev/null || missing="$missing $base"
done
if [ -z "$missing" ]; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: engines with no referencing test file:$missing"
fi

echo "=== [#replay-cache-never-committed] gate-task.sh's cache path is derived from git-dir (never a plain tracked path) ==="
GT="$REPO_ROOT/.ai/bin/gate-task.sh"
if grep -qE 'CACHE="\$\(git rev-parse --git-dir' "$GT"; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: gate-task.sh cache path no longer derived from git-dir"
fi

echo "=== [#branch-delete-ancestry-squash-issue] sync-branch skill verifies MERGED state before any -D fallback ==="
SB="$REPO_ROOT/.claude/skills/sync-branch/SKILL.md"
if grep -qE 'gh pr view.*--json.*state' "$SB" && grep -q 'MERGED' "$SB" && grep -qE 'branch -d.*\|\|.*branch -D' "$SB"; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: sync-branch SKILL.md missing the MERGED-check-before-force-delete shape"
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
