#!/usr/bin/env bash
# Spec-Goal Drift Checker — wrapper บางๆ เรียก spec_goal_drift.py
# ใช้: scripts/spec-goal-drift.sh <feature> [--specs-dir <path>] [--strict]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/spec_goal_drift.py" "$@"
