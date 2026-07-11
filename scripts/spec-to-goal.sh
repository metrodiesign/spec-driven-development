#!/usr/bin/env bash
# Spec-to-Goal generator — wrapper บางๆ เรียก spec_to_goal.py
# ใช้: scripts/spec-to-goal.sh <feature> [--force] [--specs-dir <path>]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/spec_to_goal.py" "$@"
