#!/usr/bin/env bash
# destructive-guard.sh — PreToolUse(Bash) guard ตาม Destructive Ops + Workflow rules
# block = exit 2 พร้อมเหตุผลระบุกฎที่ติด; ผ่าน = เงียบ exit 0
# trade-off ที่รู้ตัว: มอง command เป็น string แบนๆ ไม่ parse shell quoting —
# คำสั่ง destructive ที่อยู่ใน quoted string (เช่นเขียน docs/test) อาจโดน block เกินจริง
# (ทิศ fail-safe); ห้ามแก้ด้วย prefix-skip echo/grep เพราะเป็น bypass hole

C=$(jq -r '.tool_input.command // empty')
[ -n "$C" ] || exit 0

# anchor ตำแหน่ง token คำสั่ง: ต้นบรรทัด / หลัง ; & | $( / หลัง whitespace
# (ครอบ indent, xargs/sudo/env-prefix, path prefix เช่น /bin/rm) + optional rtk proxy
POS='(^|[;&|][[:space:]]*|\$\([[:space:]]*|[[:space:]])(rtk[[:space:]]+(proxy[[:space:]]+)?)?([^[:space:]]*/)?'

block() {
  echo "Blocked: $1" >&2
  exit 2
}

# rm recursive+force ทุกรูปสะกด (-rf, -fr, -r -f, --recursive --force):
# ดึง span ของแต่ละ rm invocation (จบที่ separator ถัดไป) แล้วเช็ก r+f ภายใน span เดียวกัน
# — กัน flag จากคนละคำสั่ง (เช่น grep -r ... && rm -f ...) มา AND กันผิดๆ
RM_SPANS=$(echo "$C" | grep -oE "${POS}rm[[:space:]][^;&|]*")
if [ -n "$RM_SPANS" ]; then
  while IFS= read -r SPAN; do
    if echo "$SPAN" | grep -qE '[[:space:]](-[A-Za-z]*[rR][A-Za-z]*|--recursive)([[:space:]]|$)' &&
      echo "$SPAN" | grep -qE '[[:space:]](-[A-Za-z]*f[A-Za-z]*|--force)([[:space:]]|$)'; then
      block 'rm แบบ recursive+force — ยืนยันเป้าหมายกับ user ก่อน (Destructive Ops rules)'
    fi
  done <<<"$RM_SPANS"
fi

echo "$C" | grep -qE "${POS}git[[:space:]]+reset[[:space:]]+--hard" &&
  block 'git reset --hard — ยืนยันเป้าหมายก่อน (Destructive Ops rules)'

echo "$C" | grep -qE "${POS}git[[:space:]]+clean[[:space:]]([^;&|]*[[:space:]])?(-[A-Za-z]*f[A-Za-z]*|--force)([[:space:]]|$)" &&
  block 'git clean -f — ยืนยันเป้าหมายก่อน (Destructive Ops rules)'

echo "$C" | grep -qE "${POS}find[[:space:]][^;&|]*[[:space:]]-delete([[:space:]]|$)" &&
  block 'find -delete — ยืนยันเป้าหมายก่อน (Destructive Ops rules)'

echo "$C" | grep -qE "${POS}git[[:space:]]+push[[:space:]][^;&|]*--force(-with-lease)?([[:space:]]|$)" &&
  block 'force push (Workflow rules: ห้าม force push)'

# short flag -f (รวมแบบ combined เช่น -uf) — จำกัด span ไม่ให้ข้าม command separator
echo "$C" | grep -qE "${POS}git[[:space:]]+push[[:space:]]+([^;&|]*[[:space:]])?-[A-Za-z]*f[A-Za-z]*([[:space:]]|$)" &&
  block 'force push -f (Workflow rules: ห้าม force push)'

# branch protection: commit/push ขณะอยู่บน main/develop หรือ push ระบุ main/develop
if echo "$C" | grep -qE "${POS}git[[:space:]]+(commit|push)([[:space:]]|$)"; then
  BR=$(git branch --show-current 2>/dev/null)
  if [ "$BR" = "main" ] || [ "$BR" = "develop" ]; then
    block "git commit/push บน branch $BR — ต้อง branch แยกแล้วผ่าน PR (Workflow rules)"
  fi
  echo "$C" | grep -qE "${POS}git[[:space:]]+push[[:space:]][^;&|]*([[:space:]]|:)(main|develop)([[:space:]]|$)" &&
    block 'git push ตรงเข้า main/develop — ต้องผ่าน PR (Workflow rules)'
fi

exit 0
