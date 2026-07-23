#!/usr/bin/env bash
# null-byte-secret-scan.test.sh — tracked source must survive full-tree scan without
# Bash command-substitution data loss warnings.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
pass=0
fail=0

OUTPUT=$(cd "$ROOT" && scripts/ci-secret-scope.sh push develop 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL full-tree secret scan -> exit $rc"
fi

if printf '%s\n' "$OUTPUT" | grep -qF 'ignored null byte in input'; then
  fail=$((fail + 1))
  echo "FAIL full-tree secret scan emitted null-byte warning"
else
  pass=$((pass + 1))
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
