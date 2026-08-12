#!/usr/bin/env bash
# repo-policy-alignment.test.sh — repository-owned lint/dependency/CI contract.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
pass=0
fail=0

check() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL $desc"
  fi
}

check_absent() {
  local desc="$1"
  local pattern="$2"
  local file="$3"
  if grep -qF "$pattern" "$file"; then
    fail=$((fail + 1))
    echo "FAIL $desc"
  else
    pass=$((pass + 1))
  fi
}

check "ESLint excludes nested harness worktrees" \
  grep -qF "'**/.claude/worktrees/**'" "$ROOT/eslint.config.mjs"

check "CI runs blocking production audit at high threshold" \
  grep -qF 'pnpm audit --prod --audit-level high' "$ROOT/.github/workflows/ci.yml"

for floor in \
  'scripts/check-core-vendor-free.sh' \
  'pnpm install --frozen-lockfile' \
  'pnpm typecheck' \
  'pnpm lint' \
  'scripts/ci-test-scope.sh' \
  'scripts/ci-evidence-scope.sh' \
  '.claude/hooks/tests/*.test.sh' \
  'scripts/lessons-coverage-check.sh' \
  'scripts/ci-secret-scope.sh' \
  'scripts/spec-trace.sh'
do
  check "CI keeps floor command: $floor" grep -qF "$floor" "$ROOT/.github/workflows/ci.yml"
done

check_absent "CI header no longer claims no package manifest" \
  'this repo ships no application code or package' "$ROOT/.github/workflows/ci.yml"
check_absent "security rules no longer claim no runtime deps" \
  'this framework repo ships no runtime deps' "$ROOT/.ai/shared/SECURITY_RULES.md"
check_absent "security rules no longer claim no lint script" \
  '**no lint script** in this project' "$ROOT/.ai/shared/SECURITY_RULES.md"
check_absent "security rules no longer claim no app tests" \
  'this framework repo ships no app tests' "$ROOT/.ai/shared/SECURITY_RULES.md"
check_absent "security rules no longer claim no backend" \
  'static frontend with no real backend' "$ROOT/.ai/shared/SECURITY_RULES.md"
check "security rules name enforced audit command" \
  grep -qF 'pnpm audit --prod --audit-level high' "$ROOT/.ai/shared/SECURITY_RULES.md"

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
