#!/usr/bin/env bash
# hook-bypass-guard.test.sh — adversarial test สำหรับ hook-bypass-guard.sh
# รัน: bash .claude/hooks/tests/hook-bypass-guard.test.sh   (exit 0 = ผ่านครบ)
# ทุกเคส = JSON payload ป้อน stdin; ตรวจ exit code (2 = block, 0 = allow).
# หมายเหตุ: payload เป็นเพียง "ข้อความคำสั่ง" ที่ป้อนให้ hook อ่าน — ไม่มีการรัน git จริง.
set -u

HOOK="$(cd "$(dirname "$0")/.." && pwd)/hook-bypass-guard.sh"
pass=0
fail=0

check() { # $1=expect(block|allow) $2=desc $3=command-string
  local want=2
  [ "$1" = allow ] && want=0
  printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$3" | jq -Rs .)" | "$HOOK" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL [$1] $2 -> exit $rc (want $want) :: $3"
  fi
}

# --- MUST BLOCK: bypass attempts ---
check block "long --no-verify"          'git commit --no-verify -m x'
check block "short -n"                  'git commit -n -m x'
check block "combined -nm"              'git commit -nm x'
check block "combined -anm"             'git commit -anm x'
check block "-n after other flags"      'git commit -a -n -m "msg"'
check block "core.hooksPath override"   'git -c core.hooksPath=/dev/null commit -m x'
check block "SECRET_GUARD_SKIP env"     'SECRET_GUARD_SKIP=1 git commit -m x'

# --- MUST ALLOW: legit commits / non-commit git ---
check allow "plain commit"              'git commit -m "normal message"'
# regression (bug fixed): ' -n' inside the quoted commit message must NOT block
check allow "-n inside message"         'git commit -m "fix -n flag handling"'
check allow "-n word mid-message"       'git commit -m "document the -n behavior"'
check allow "git status"                'git status'
check allow "git grep -n"               'git grep -n foo'

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
