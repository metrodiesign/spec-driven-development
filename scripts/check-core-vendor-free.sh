#!/usr/bin/env bash
# INV-7 enforcement: Ring 0 (core/) AND Ring 1 (aal/) must not name any vendor —
# keeps both testable with stubs and preserves quota-survivability
# (unified-platform-spec.md §1.2, §2, §7). Vendor names are legal ONLY in Ring 2
# (adapters/). Scans the whole tree of each ring including tests and comments;
# the discipline is deliberate.
# [#vendor-scan-includes-comments] (.ai/shared/LESSONS.md, LESSONS-COVERAGE.md)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Vendor names forbidden in Ring 0/1 (spec INV-7). Case-insensitive, whole tree.
pattern='claude|anthropic|codex|glm|openai'
status=0

for ring in core aal; do
  if [ ! -d "$ring" ]; then
    # aal/ arrives in Phase 1; core/ must always exist.
    if [ "$ring" = core ]; then
      echo "check-core-vendor-free: no core/ directory found" >&2
      exit 1
    fi
    continue
  fi
  matches=$(grep -rniE "$pattern" "$ring/" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "INV-7 violation: vendor name(s) found in $ring/ (Ring 0/1 must be vendor-neutral):" >&2
    echo "$matches" >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "OK: core/ and aal/ are vendor-name-free (INV-7)"
fi
exit "$status"
