#!/usr/bin/env python3
"""Spec-Goal Drift Checker (platform-phase5-stage3 REQ-4) — compares the
`requirements_sha256` stamped in a promoted `goal.yaml`'s `provenance:` line
against the current `requirements.md` bytes. Advisory by default (exit 0
always, warning on stdout); `--strict` exits 1 on any non-clean outcome.

Python stdlib-only (no PyYAML): the provenance line is the single-line
JSON-quoted flow mapping `spec_to_goal.py` stamps (REQ-2.1 convention), parsed
with `json.loads` directly — never the full YAML document.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

USAGE = "usage: scripts/spec-goal-drift.sh <feature> [--specs-dir DIR] [--strict]"


def warn(feature, message, strict):
    """warning ทุกโหมด: บรรทัดเดียวบน stdout — advisory ผ่านเงียบ (exit 0),
    --strict ปฏิเสธ (exit 1). ไม่มีโหมดไหน print มากกว่าหนึ่งบรรทัด (REQ-4.4/4.5)."""
    print(f"warning: {feature}: {message}")
    return 1 if strict else 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="spec-goal-drift", usage=USAGE,
        description="Compare requirements.md sha256 against the provenance stamped in goal.yaml.")
    parser.add_argument("feature")
    parser.add_argument("--specs-dir", default=None)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)

    specs_dir = Path(args.specs_dir) if args.specs_dir \
        else Path(__file__).resolve().parent.parent / ".ai" / "specs"
    feature_dir = specs_dir / args.feature
    if not feature_dir.is_dir():
        print(f"error: {feature_dir} not found — {USAGE}", file=sys.stderr)
        return 2

    # dir มีจริงแต่ยังไม่ promote — สถานะปกติ, ไม่ใช่ warning (REQ-4.8)
    goal_path = feature_dir / "goal.yaml"
    if not goal_path.is_file():
        print("not applicable (no promoted goal.yaml)")
        return 0

    # หา line แรกที่ match ^provenance: (column 0 — comment `#` ไม่มีวัน match,
    # กัน `# HUMAN: ... provenance: line below` หลอก parser; A3 regression)
    goal_text = goal_path.read_text(encoding="utf-8")
    provenance_line = next(
        (ln for ln in goal_text.splitlines() if ln.startswith("provenance:")), None)

    provenance = None
    if provenance_line is not None:
        try:
            provenance = json.loads(provenance_line[len("provenance:"):].strip())
        except Exception:
            # exception ใดๆ = โหมด no-parseable-provenance (fail-safe, ไม่ crash)
            provenance = None

    if not isinstance(provenance, dict):
        return warn(args.feature,
                    "goal.yaml has no parseable provenance — regenerate with "
                    "scripts/spec-to-goal.sh", args.strict)

    stamped_sha = provenance.get("requirements_sha256")
    if not isinstance(stamped_sha, str) or not stamped_sha:
        return warn(args.feature,
                    "provenance lacks requirements_sha256 — content drift cannot be verified",
                    args.strict)

    # spec_path ที่ stamp ไว้ไม่ถูกใช้ resolve เด็ดขาด — อ่าน requirements.md จาก
    # feature_dir เดียวกับที่อ่าน goal.yaml เท่านั้น (A1, REQ-4.2)
    req_path = feature_dir / "requirements.md"
    if not req_path.is_file():
        return warn(args.feature, "requirements.md not found next to goal.yaml", args.strict)

    current_sha = hashlib.sha256(req_path.read_bytes()).hexdigest()
    if current_sha == stamped_sha:
        return 0

    generated_at = provenance.get("generated_at", "unknown")
    return warn(
        args.feature,
        f"requirements.md changed since goal.yaml was generated "
        f"(sha256 {stamped_sha[:8]}... -> {current_sha[:8]}..., generated {generated_at}) "
        f"— regenerate or re-review",
        args.strict,
    )


if __name__ == "__main__":
    sys.exit(main())
