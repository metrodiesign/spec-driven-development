#!/usr/bin/env bash
# destructive-guard.test.sh — adversarial test สำหรับ destructive guard
# รัน: bash .claude/hooks/tests/destructive-guard.test.sh   (exit 0 = ผ่านครบ)
# logic อยู่ใน .ai/bin/check-destructive.sh; .claude/hooks/destructive-guard.sh เป็น thin
# adapter (jq stdin -> argv). ทุกเคสรัน 2 ทางพิสูจน์ parity: 1) Claude adapter (JSON->stdin)
# 2) ตรง engine (.ai/bin, argv). ตรวจ exit code (2 = block, 0 = allow). ไม่รัน git/rm จริง.
# NOTE: เคส "commit/push ขณะอยู่บน main/develop" ขึ้นกับ branch ปัจจุบัน — ไม่ทดสอบที่นี่
# (env-dependent); ทดสอบเฉพาะกฎที่ตัดสินจาก command string.
set -u

HOOK="$(cd "$(dirname "$0")/.." && pwd)/destructive-guard.sh"
ENGINE="$(cd "$(dirname "$0")/../../../.ai/bin" && pwd)/check-destructive.sh"
pass=0
fail=0

check() { # $1=expect(block|allow) $2=desc $3=command-string
  local want=2
  [ "$1" = allow ] && want=0

  printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$3" | jq -Rs .)" | "$HOOK" >/dev/null 2>&1
  local rc_adapter=$?
  if [ "$rc_adapter" -eq "$want" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL [adapter][$1] $2 -> exit $rc_adapter (want $want) :: $3"
  fi

  "$ENGINE" "$3" >/dev/null 2>&1
  local rc_engine=$?
  if [ "$rc_engine" -eq "$want" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL [engine][$1] $2 -> exit $rc_engine (want $want) :: $3"
  fi
}

# --- MUST BLOCK: destructive ---
check block "rm -rf"                 'rm -rf /tmp/x'
check block "rm -fr"                 'rm -fr /tmp/x'
check block "rm -r -f split"         'rm -r -f /tmp/x'
check block "indented rm -rf"        '   rm -rf /tmp/x'
check block "/bin/rm -rf path"       '/bin/rm -rf /tmp/x'
check block "rtk proxy rm -rf"       'rtk proxy rm -rf /tmp/x'
check block "git reset --hard"       'git reset --hard HEAD~1'
check block "git clean -fd"          'git clean -fd'
check block "find -delete"           'find . -name "*.tmp" -delete'
check block "push --force"           'git push --force origin feat'
check block "push --force-with-lease" 'git push --force-with-lease origin feat'
check block "push -f"                'git push -f origin feat'
# regression (review High): '+'-refspec force pushes were silently allowed
check block "push +refspec"          'git push origin +feat:feat'
check block "push +bare-ref"         'git push origin +experimental'
check block "push +develop"          'git push origin +develop'
check block "push +main"             'git push origin +main'
check block "push +HEAD:main"        'git push origin +HEAD:main'
# branch-target protection (command-string based)
check block "push to develop"        'git push origin develop'
check block "push HEAD:main"         'git push origin HEAD:main'

# --- MUST ALLOW: safe ---
check allow "rm single file"         'rm /tmp/onefile'
check allow "push feature branch"    'git push origin feat'
check allow "push HEAD:feat"         'git push origin HEAD:feat'
check allow "push full refspec"      'git push origin refs/heads/feat:refs/heads/feat'
check allow "grep -r (not rm)"       'grep -r foo .'
check allow "ls and echo"           'ls && echo ok'
check allow "git status"             'git status'

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
