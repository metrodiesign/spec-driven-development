#!/usr/bin/env bash
# spec-edit-guard.sh — PreToolUse(Edit) guard (Tier 5 item 3)
# WARN (non-blocking) when editing an APPROVED requirements.md while its sibling
# tasks.md still has an open task. Always exit 0 — this informs, never blocks.

INPUT=$(cat 2>/dev/null)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

# only requirements.md under .claude/specs/** — editing tasks.md/design.md is silent
case "$FILE" in
  */.claude/specs/*/requirements.md) ;;
  .claude/specs/*/requirements.md) ;;
  *) exit 0 ;;
esac

# read the file on disk (ground truth); a not-yet-written file has nothing to warn about
[ -f "$FILE" ] || exit 0

# only when the spec is marked approved (covers "approved <date>", "(quick, no gates)",
# "approved <orig>, amended <date>"); draft or no Status line -> silent
grep -m1 -iE '^> *Status: *approved' "$FILE" >/dev/null 2>&1 || exit 0

# only when the sibling tasks.md still has an open task
TASKS="${FILE%/requirements.md}/tasks.md"
[ -f "$TASKS" ] || exit 0
OPEN=$(grep -cE '^[[:space:]]*- \[ \]' "$TASKS" 2>/dev/null)
[ "${OPEN:-0}" -gt 0 ] 2>/dev/null || exit 0

jq -n --arg f "$FILE" --arg n "$OPEN" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:("เตือน: " + $f + " ถูก mark approved แล้ว แต่ยังมี " + $n + " task ค้างใน tasks.md (- [ ]). การแก้ requirements ตอนนี้ต้อง propagate ไป design.md/tasks.md (CLAUDE.md: keep specs in sync) และอาจต้อง re-approve. ยืนยันว่าตั้งใจแก้.")}}'
exit 0
