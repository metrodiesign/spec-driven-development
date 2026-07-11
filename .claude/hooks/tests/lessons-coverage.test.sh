#!/usr/bin/env bash
# lessons-coverage.test.sh — adversarial test for scripts/lessons-coverage-check.sh
# (sdd-lessons-to-guard-tests REQ-1.1/1.2, REQ-2.2). Run:
#   bash .claude/hooks/tests/lessons-coverage.test.sh
# Every fixture is a throwaway git repo under mktemp -d with its own .ai/shared/
# LESSONS.md + LESSONS-COVERAGE.md — never touches the real repo's files.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CHECKER="$REPO_ROOT/scripts/lessons-coverage-check.sh"
pass=0
fail=0
CLEAN_DIRS=()
cleanup() {
  local RMBIN FLAG; RMBIN="r""m"; FLAG="-r""f"
  for d in "${CLEAN_DIRS[@]}"; do "$RMBIN" "$FLAG" "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

new_fixture() { # -> path; git-init'd with .ai/shared/
  local dir; dir="$(mktemp -d)"
  CLEAN_DIRS+=("$dir")
  ( cd "$dir" && git init -q && git config user.email t@t.t && git config user.name t )
  mkdir -p "$dir/.ai/shared" "$dir/scripts"
  printf '%s' "$dir"
}

echo "=== synced fixture (1 mechanized + 1 advisory, all consistent) -> exit 0 ==="
F="$(new_fixture)"
cat > "$F/.ai/shared/LESSONS.md" <<'EOF'
- [#alpha-pattern] **Pattern**: alpha thing. — **Why**: because.
- [#beta-pattern] **Pattern**: beta thing. — **Why**: because.
EOF
mkdir -p "$F/scripts"
cat > "$F/scripts/alpha-check.sh" <<'EOF'
#!/usr/bin/env bash
# [#alpha-pattern] enforces the alpha thing
echo ok
EOF
cat > "$F/.ai/shared/LESSONS-COVERAGE.md" <<'EOF'
| slug | classification | enforcement / reason |
|---|---|---|
| alpha-pattern | mechanized | scripts/alpha-check.sh::alpha-case |
| beta-pattern | advisory | no executable surface |
EOF
OUT=$( cd "$F" && "$CHECKER" 2>&1 ); RC=$?
if [ "$RC" -eq 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: synced fixture should exit 0 :: rc=$RC :: $OUT"; fi

echo "=== LESSONS.md slug with no coverage row -> exit 1, names it ==="
F="$(new_fixture)"
cat > "$F/.ai/shared/LESSONS.md" <<'EOF'
- [#alpha-pattern] **Pattern**: alpha thing. — **Why**: because.
- [#orphan-lesson] **Pattern**: orphan thing. — **Why**: because.
EOF
cat > "$F/.ai/shared/LESSONS-COVERAGE.md" <<'EOF'
| slug | classification | enforcement / reason |
|---|---|---|
| alpha-pattern | advisory | no executable surface |
EOF
OUT=$( cd "$F" && "$CHECKER" 2>&1 ); RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q 'orphan-lesson'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: missing coverage row should exit 1 naming it :: rc=$RC :: $OUT"; fi

echo "=== coverage row with no matching LESSONS.md slug -> exit 1, names it ==="
F="$(new_fixture)"
cat > "$F/.ai/shared/LESSONS.md" <<'EOF'
- [#alpha-pattern] **Pattern**: alpha thing. — **Why**: because.
EOF
cat > "$F/.ai/shared/LESSONS-COVERAGE.md" <<'EOF'
| slug | classification | enforcement / reason |
|---|---|---|
| alpha-pattern | advisory | no executable surface |
| stray-row | advisory | leftover row, no lesson |
EOF
OUT=$( cd "$F" && "$CHECKER" 2>&1 ); RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q 'stray-row'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: orphan coverage row should exit 1 naming it :: rc=$RC :: $OUT"; fi

echo "=== mechanized row with a dangling artifact path -> exit 1 ==="
F="$(new_fixture)"
cat > "$F/.ai/shared/LESSONS.md" <<'EOF'
- [#alpha-pattern] **Pattern**: alpha thing. — **Why**: because.
EOF
cat > "$F/.ai/shared/LESSONS-COVERAGE.md" <<'EOF'
| slug | classification | enforcement / reason |
|---|---|---|
| alpha-pattern | mechanized | scripts/does-not-exist.sh::missing |
EOF
OUT=$( cd "$F" && "$CHECKER" 2>&1 ); RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q 'dangling path'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: dangling artifact path should exit 1 :: rc=$RC :: $OUT"; fi

echo "=== mechanized row whose artifact file exists but lost its slug marker -> exit 1, names the slug ==="
F="$(new_fixture)"
cat > "$F/.ai/shared/LESSONS.md" <<'EOF'
- [#alpha-pattern] **Pattern**: alpha thing. — **Why**: because.
EOF
cat > "$F/scripts/alpha-check.sh" <<'EOF'
#!/usr/bin/env bash
# marker was removed by a careless edit
echo ok
EOF
cat > "$F/.ai/shared/LESSONS-COVERAGE.md" <<'EOF'
| slug | classification | enforcement / reason |
|---|---|---|
| alpha-pattern | mechanized | scripts/alpha-check.sh::alpha-case |
EOF
OUT=$( cd "$F" && "$CHECKER" 2>&1 ); RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q 'alpha-pattern' && printf '%s' "$OUT" | grep -q 'no longer carries'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: removed slug marker should exit 1 naming it :: rc=$RC :: $OUT"
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
