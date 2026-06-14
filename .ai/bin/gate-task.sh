#!/usr/bin/env bash
# gate-task.sh — harness-agnostic task-boundary quality gate (.ai/bin engine)
# Ported from .claude/hooks/task-gate.sh; typecheck/test/Evidence logic kept verbatim.
#
# Fires only when a .claude/specs/*/tasks.md checkbox is being flipped to [x].
# เขียว = เงียบ exit 0, แดง = exit 2 + stderr ให้แก้ก่อน mark เสร็จ
#
# Interface (harness-agnostic):
#   $1 / $GATE_FILE      = tasks.md file path being edited
#   $2 / $GATE_NEW       = the new_string / content the edit introduces (the flip text)
# The caller's adapter is responsible for extracting these from its own hook payload.
# When $GATE_NEW carries a "- [x]" line it is treated as a flip; an Evidence: block is
# then required inside $GATE_NEW.

FILE="${1:-${GATE_FILE:-}}"
NEW="${2:-${GATE_NEW:-}}"

case "$FILE" in
  */.claude/specs/*/tasks.md) ;;
  .claude/specs/*/tasks.md) ;;
  *) exit 0 ;;
esac

# trigger only on a flip to [x] in the new content
printf '%s\n' "$NEW" | grep -qi -- '- \[x\]' || exit 0

OUT=$(npm run typecheck --silent 2>&1) || {
  echo 'Task gate: typecheck ไม่ผ่าน — ห้าม mark [x] จนกว่าเขียว' >&2
  echo "$OUT" | tail -20 >&2
  exit 2
}
OUT=$(npm test --silent 2>&1) || {
  # vitest exit 1 เมื่อไม่มี test file เลย — ไม่ใช่ test แดง อย่า block task ที่ไม่มี test โดยชอบ
  if ! echo "$OUT" | grep -q 'No test files found'; then
    echo 'Task gate: test ไม่ผ่าน — ห้าม mark [x] จนกว่าเขียว' >&2
    echo "$OUT" | tail -20 >&2
    exit 2
  fi
}

# evidence-presence gate: code-green is checked first (above); only then require an
# `Evidence:` block in the flip text.
if ! printf '%s\n' "$NEW" | grep -qiE '^[[:space:]]*Evidence:'; then
  echo 'Task gate: ขาด Evidence block — บันทึก test result + viewports (375/768/1440 หรือ n/a) + deviations ใต้ task ก่อน mark [x]' >&2
  exit 2
fi
exit 0
