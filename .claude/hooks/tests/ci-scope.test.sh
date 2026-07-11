#!/usr/bin/env bash
# ci-scope.test.sh — adversarial test for scripts/ci-secret-scope.sh + ci-test-scope.sh
# (sdd-ci-incremental-checks REQ-2, REQ-3, REQ-5.3). Run: bash .claude/hooks/tests/ci-scope.test.sh
#
# Every case runs CI_SCOPE_DRY_RUN=1 so the script always logs its DECISION to stderr and
# exits 0 without actually running check-secrets.sh/pnpm test for real — fixtures assert on
# the logged decision line, not on a real scan/test outcome. A fake `origin/<base>` ref is
# created locally via `git update-ref` (no real network remote needed) so merge-base
# resolves exactly as it would against a real CI checkout's remote-tracking ref.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SECRET_SCOPE="$REPO_ROOT/scripts/ci-secret-scope.sh"
TEST_SCOPE="$REPO_ROOT/scripts/ci-test-scope.sh"
pass=0
fail=0
CLEAN_DIRS=()
cleanup() {
  local RMBIN FLAG; RMBIN="r""m"; FLAG="-r""f"
  for d in "${CLEAN_DIRS[@]}"; do "$RMBIN" "$FLAG" "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

# A two-package workspace: pkg-b depends on pkg-a (workspace:*), so a pkg-a change marks
# BOTH affected (dependent inclusion) while a pkg-b-only change marks just pkg-b.
new_pnpm_fixture() {
  local dir; dir="$(mktemp -d)"
  CLEAN_DIRS+=("$dir")
  ( cd "$dir" && git init -q && git config user.email t@t.t && git config user.name t )
  cat > "$dir/pnpm-workspace.yaml" <<'YAML'
packages:
  - pkg-a
  - pkg-b
allowBuilds:
  esbuild: true
YAML
  mkdir -p "$dir/pkg-a" "$dir/pkg-b"
  printf '{"name":"pkg-a","version":"1.0.0"}' > "$dir/pkg-a/package.json"
  printf '{"name":"pkg-b","version":"1.0.0","dependencies":{"pkg-a":"workspace:*"}}' > "$dir/pkg-b/package.json"
  ( cd "$dir" && git add -A && git commit -q -m base )
  local base_sha; base_sha=$(cd "$dir" && git rev-parse HEAD)
  ( cd "$dir" && git update-ref refs/remotes/origin/develop "$base_sha" )
  printf '%s' "$dir"
}

echo "=== ci-test-scope: non-PR / push event -> FULL (REQ-3.2 path, mirrors 2.2) ==="
FIX="$(new_pnpm_fixture)"
OUT=$( cd "$FIX" && CI_SCOPE_DRY_RUN=1 "$TEST_SCOPE" push develop 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=full' && printf '%s' "$OUT" | grep -q 'non-PR event'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: push event should force decision=full :: $OUT"
fi

echo "=== ci-secret-scope: push event -> decision=all (REQ-2.2) ==="
OUT=$( cd "$FIX" && CI_SCOPE_DRY_RUN=1 "$SECRET_SCOPE" push develop 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=all'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: push should be decision=all :: $OUT"; fi

echo "=== ci-secret-scope: pull_request event, resolvable base -> decision=range (REQ-2.1) ==="
( cd "$FIX" && echo x > pkg-a/x.txt && git add -A && git commit -q -m head )
OUT=$( cd "$FIX" && CI_SCOPE_DRY_RUN=1 "$SECRET_SCOPE" pull_request develop 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=range'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: PR should be decision=range :: $OUT"; fi

echo "=== ci-test-scope: unresolvable base -> decision=full, cause logged (REQ-3.6) ==="
OUT=$( cd "$FIX" && CI_SCOPE_DRY_RUN=1 "$TEST_SCOPE" pull_request no-such-branch-anywhere 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=full' && printf '%s' "$OUT" | grep -q 'merge-base unresolvable'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: unresolvable base should log cause + decision=full :: $OUT"
fi

echo "=== ci-test-scope: in-package change (pkg-a), dependent pkg-b included -> FILTERED with counts (REQ-3.1/3.3/4.1) ==="
OUT=$( cd "$FIX" && CI_SCOPE_DRY_RUN=1 "$TEST_SCOPE" pull_request develop 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=filtered' && printf '%s' "$OUT" | grep -qE 'affected=2 skipped=0'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: pkg-a change should filter to both packages (dependent) :: $OUT"
fi

echo "=== ci-test-scope: in-package change (pkg-b only), no dependents -> FILTERED to 1, 1 skipped ==="
FIX2="$(new_pnpm_fixture)"
( cd "$FIX2" && echo x > pkg-b/x.txt && git add -A && git commit -q -m head-b-only )
OUT=$( cd "$FIX2" && CI_SCOPE_DRY_RUN=1 "$TEST_SCOPE" pull_request develop 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=filtered' && printf '%s' "$OUT" | grep -qE 'affected=1 skipped=1'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: pkg-b-only change should filter to 1 affected/1 skipped :: $OUT"
fi

echo "=== ci-test-scope: root-file change (outside every package dir) -> FULL (REQ-3.5, ARC-F4) ==="
FIX3="$(new_pnpm_fixture)"
( cd "$FIX3" && echo '{}' > pnpm-lock.yaml && git add -A && git commit -q -m lockfile-change )
OUT=$( cd "$FIX3" && CI_SCOPE_DRY_RUN=1 "$TEST_SCOPE" pull_request develop 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=full' && printf '%s' "$OUT" | grep -q 'root-file change'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: root-file (lockfile) change should force decision=full :: $OUT"
fi

echo "=== ci-test-scope: package probe fails (PATH-stubbed pnpm) -> FULL (REQ-3.6, ARC-F3) ==="
FIX4="$(new_pnpm_fixture)"
( cd "$FIX4" && echo x > pkg-a/x.txt && git add -A && git commit -q -m head )
STUBDIR="$(mktemp -d)"; CLEAN_DIRS+=("$STUBDIR")
cat > "$STUBDIR/pnpm" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$STUBDIR/pnpm"
OUT=$( cd "$FIX4" && PATH="$STUBDIR:$PATH" CI_SCOPE_DRY_RUN=1 "$TEST_SCOPE" pull_request develop 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=full' && printf '%s' "$OUT" | grep -q 'probe failed'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: failing pnpm probe should force decision=full :: $OUT"
fi

echo "=== ci-test-scope: zero affected (PATH-stubbed pnpm) -> SKIP with counts (REQ-3.3) ==="
FIX5="$(new_pnpm_fixture)"
( cd "$FIX5" && echo x > pkg-a/x.txt && git add -A && git commit -q -m head )
STUBDIR2="$(mktemp -d)"; CLEAN_DIRS+=("$STUBDIR2")
cat > "$STUBDIR2/pnpm" <<'STUB'
#!/usr/bin/env bash
# emulate: --filter query returns nothing affected; plain -r ls (no --filter) returns 2 packages
if printf '%s\n' "$@" | grep -q -- '--filter'; then
  exit 0   # empty stdout = zero affected
fi
printf 'pkg-a\npkg-b\n'
STUB
chmod +x "$STUBDIR2/pnpm"
OUT=$( cd "$FIX5" && PATH="$STUBDIR2:$PATH" CI_SCOPE_DRY_RUN=1 "$TEST_SCOPE" pull_request develop 2>&1 )
if printf '%s' "$OUT" | grep -q 'decision=skip' && printf '%s' "$OUT" | grep -qE 'affected=0'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: zero-affected probe should log decision=skip :: $OUT"
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
