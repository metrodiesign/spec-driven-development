#!/usr/bin/env bash
# hook-bypass-guard.sh — กันการข้าม pre-commit secret-guard (PreToolUse: Bash)
# block = exit 2; ผ่าน = เงียบ exit 0

C=$(jq -r '.tool_input.command // empty')
[ -n "$C" ] || exit 0
echo "$C" | grep -qE '(^|[[:space:]])git([[:space:]]|$)' || exit 0

block() {
  echo "Blocked: $1" >&2
  exit 2
}

echo "$C" | grep -qE -- '--no-verify' &&
  block '--no-verify ข้าม secret-guard pre-commit hook — commit ตามปกติเพื่อให้ scan ทำงาน'

echo "$C" | grep -q 'core\.hooksPath' &&
  block 'core.hooksPath ปิด git hooks ทั้งหมดรวม secret-guard — ห้ามใช้'

echo "$C" | grep -q 'SECRET_GUARD_SKIP=' &&
  block 'SECRET_GUARD_SKIP ข้าม secret scan — ถ้าจำเป็นจริงให้ user รันเองนอก session'

# short flag -n (= --no-verify ของ git commit) รวม combined เช่น -nm, -anm
# สแกน flag เฉพาะช่วงก่อน quote แรก (class [^|;&'"]) — กัน false positive เมื่อ ' -n' อยู่ใน commit message
# (--no-verify ทุกตำแหน่งยังถูกจับโดยบรรทัด 14; residual: -n ที่วางหลัง message ใน quote จะไม่ถูกจับ)
echo "$C" | grep -qE 'git[[:space:]]+commit[^|;&'\''"]*[[:space:]]-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$)' &&
  block 'git commit -n (--no-verify) ข้าม secret-guard — commit ตามปกติ'

exit 0
