#!/usr/bin/env bash
# hook-bypass-guard.test.sh — adversarial test สำหรับ bypass guard
# รัน: bash .claude/hooks/tests/hook-bypass-guard.test.sh   (exit 0 = ผ่านครบ)
# หลัง refactor: logic อยู่ใน .ai/bin/check-bypass.sh; .claude/hooks/hook-bypass-guard.sh
# เป็น thin adapter (jq stdin -> argv). ทุกเคสรัน 2 ทางเพื่อพิสูจน์ parity:
#   1) ผ่าน Claude adapter (JSON payload -> stdin)  2) ตรง engine (.ai/bin, argv)
# ตรวจ exit code (2 = block, 0 = allow). payload เป็นเพียง "ข้อความคำสั่ง" — ไม่รัน git จริง.
set -u

HOOK="$(cd "$(dirname "$0")/.." && pwd)/hook-bypass-guard.sh"
ENGINE="$(cd "$(dirname "$0")/../../../.ai/bin" && pwd)/check-bypass.sh"
pass=0
fail=0

check() { # $1=expect(block|allow) $2=desc $3=command-string
  local want=2
  [ "$1" = allow ] && want=0

  # via Claude adapter: JSON payload on stdin -> adapter -> engine (argv)
  printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$3" | jq -Rs .)" | "$HOOK" >/dev/null 2>&1
  local rc_adapter=$?
  if [ "$rc_adapter" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL [adapter][$1] $2 -> exit $rc_adapter (want $want) :: $3"
  fi

  # direct against engine: command as argv (the contract the adapter uses)
  "$ENGINE" "$3" >/dev/null 2>&1
  local rc_engine=$?
  if [ "$rc_engine" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL [engine][$1] $2 -> exit $rc_engine (want $want) :: $3"
  fi
}

# --- MUST BLOCK: bypass attempts ---
check block "long --no-verify"          'git commit --no-verify -m x'
check block "short -n"                  'git commit -n -m x'
check block "combined -nm"              'git commit -nm x'
check block "combined -anm"             'git commit -anm x'
check block "-n after other flags"      'git commit -a -n -m "msg"'
check block "core.hooksPath override"   'git -c core.hooksPath=/dev/null commit -m x'
# git config keys are case-insensitive: lowercase/upper variants disable hooks too
check block "core.hookspath lowercase"  'git -c core.hookspath=/dev/null commit -m x'
check block "CORE.HOOKSPATH upper"       'git -c CORE.HOOKSPATH=/dev/null commit -m x'
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
