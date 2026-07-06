#!/usr/bin/env bash
# INV-7 enforcement: Ring 0 (core/) must not name any vendor — keeps core testable
# with stubs and preserves quota-survivability (unified-platform-spec.md §1.2, §2).
# Scans ALL of core/ including tests and comments; the discipline is deliberate.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -d core ]; then
  echo "check-core-vendor-free: no core/ directory found" >&2
  exit 1
fi

# Vendor names forbidden in Ring 0 (spec INV-7). Case-insensitive, whole tree.
matches=$(grep -rniE 'claude|anthropic|codex|glm|openai' core/ 2>/dev/null || true)

if [ -n "$matches" ]; then
  echo "INV-7 violation: vendor name(s) found in core/ (Ring 0 must be vendor-neutral):" >&2
  echo "$matches" >&2
  exit 1
fi

echo "OK: core/ is vendor-name-free (INV-7)"
