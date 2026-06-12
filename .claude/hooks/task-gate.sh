#!/usr/bin/env bash
# task-gate.sh — quality gate ที่ task boundary (PostToolUse: Edit|Write)
# ยิงเฉพาะเมื่อ checkbox ใน .claude/specs/*/tasks.md ถูก flip เป็น [x]
# เขียว = เงียบ exit 0 (zero token), แดง = exit 2 + stderr ให้โมเดลแก้ก่อน mark เสร็จ

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
case "$FILE" in
  */.claude/specs/*/tasks.md) ;;
  .claude/specs/*/tasks.md) ;;
  *) exit 0 ;;
esac

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
FLIPPED=0
if [ "$TOOL" = "Edit" ]; then
  OLD=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty')
  NEW=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
  OLD_X=$(printf '%s\n' "$OLD" | grep -ci -- '- \[x\]')
  NEW_X=$(printf '%s\n' "$NEW" | grep -ci -- '- \[x\]')
  [ "$NEW_X" -gt "$OLD_X" ] && FLIPPED=1
else
  # Write ทับทั้งไฟล์ เทียบ count ก่อน/หลังไม่ได้ — ยอม trigger เมื่อ content มี [x] ใดๆ
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
  printf '%s\n' "$CONTENT" | grep -qi -- '- \[x\]' && FLIPPED=1
fi
[ "$FLIPPED" -eq 1 ] || exit 0

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
exit 0
