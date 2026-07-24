#!/usr/bin/env bash
# hook-bypass-guard.sh — กันการข้าม pre-commit secret-guard (PreToolUse: Bash)
# block = exit 2; ผ่าน = เงียบ exit 0

C="${1:-$(cat)}"
[ -n "$C" ] || exit 0

BIN="$(cd "$(dirname "$0")" && pwd)"
LIBGUARD="$BIN/lib-guard.sh"
[ -r "$LIBGUARD" ] || { echo "Blocked: missing guard fragment $LIBGUARD — cannot verify bypass patterns" >&2; exit 2; }
# shellcheck source=lib-guard.sh
. "$LIBGUARD"

block() {
  echo "Blocked: $1" >&2
  exit 2
}

# --- guard/floor tamper (independent of the 'git' short-circuit below) ---
# A command that disables or overwrites the enforcement floor must block even
# when it contains no standalone `git` token (chmod/mv/rm of .githooks or the
# .ai/bin/check-*.sh|gate-task.sh engines, or pointing git's hooksPath away).
# This is the runnable backstop for the "do not weaken the guards" rule.
# GUARD = a guard/floor path, matched both as a file INSIDE the dir and as the
# WHOLE directory itself (no trailing slash) — `rm -r .githooks` / `chmod 000
# .githooks` / `mv .githooks /tmp/bak` / `rm -rf .ai/bin` disable the floor just
# as effectively as targeting one file inside it, so the trailing slash is
# OPTIONAL ((/|$|[[:space:]])) and the bare dir form is covered.
GUARD='(\.githooks(/[^[:space:]]*)?|\.ai/bin(/check-[^[:space:]]*\.sh|/gate-task\.sh|/lib-guard\.sh|/?))([[:space:]]|$)'
# in-place destroy / move-away / write-to: chmod/chown/rm/truncate operate ON
# their path arg, `tee FILE` writes TO its file arg, and `mv` of a guard path
# REMOVES the floor from its place whether the guard is the source (move away)
# or the destination (overwrite). For these verbs a guard path ANYWHERE after
# the verb is the target.
echo "$C" | grep -qE "(chmod|chown|rm|truncate|tee|mv)[[:space:]].*$GUARD" &&
  block 'disable/move/overwrite guard or floor (.githooks | .ai/bin/check-*.sh | gate-task.sh) — ห้ามปิด ย้าย หรือทับ enforcement floor'
# copy/link/install where a guard path is the DESTINATION overwrites the floor.
# Unlike mv, `cp`/`ln`/`install` with the guard as the FIRST operand is a benign
# READ (e.g. `cp .githooks/pre-commit pre-commit.bak` backs the hook OUT), so the
# guard must NOT be the first operand — require a non-guard operand before it.
echo "$C" | grep -qE "(cp|ln|install)[[:space:]]+[^[:space:]]+[[:space:]].*$GUARD" &&
  block 'overwrite into guard or floor (.githooks | .ai/bin/check-*.sh | gate-task.sh) — ห้ามทับ enforcement floor'
# redirect/write INTO a guard/floor file (e.g. `echo >> .githooks/pre-commit`,
# overwrite an engine, or pipe into .git/config) disables it just the same
echo "$C" | grep -qE '>[[:space:]]*(\.githooks/|\.ai/bin/check-[^[:space:]]*\.sh|\.ai/bin/gate-task\.sh|\.ai/bin/lib-guard\.sh|[^[:space:]]*\.git/config)' &&
  block 'redirect/overwrite into guard, floor, or .git/config — ห้ามปิดหรือทับ enforcement floor'
# setting hooksPath via config WRITE points hooks at an empty dir and disables the
# secret-guard floor regardless of a `git` token. block only WRITES; a read-only
# query (`git config core.hooksPath`, `git config --get core.hooksPath`) is harmless
# and must pass (issue #27). case-insensitive: section.key names are case-insensitive.
# 1) inline `-c core.hooksPath=...` / any `key=value` set form (has '=')
echo "$C" | grep -qiE 'core\.hookspath[[:space:]]*=' &&
  block 'set core.hooksPath (inline -c / =value) ปิด git hooks floor — ห้ามใช้'
# 2) `git config ... core.hooksPath <value>`: a non-flag value token AFTER the key = WRITE
echo "$C" | grep -qiE 'config[^|;&]*core\.hookspath[[:space:]]+[^-[:space:]]' &&
  block 'git config core.hooksPath <value> เขียนทับ hooks floor — ห้ามใช้ (read-only query ผ่านได้)'
# 3) `git config` WRITE flags on hooksPath: --unset / --unset-all / --replace-all / --add
echo "$C" | grep -qiE 'config[^|;&]*(--unset(-all)?|--replace-all|--add)[^|;&]*core\.hookspath|config[^|;&]*core\.hookspath[^|;&]*(--unset(-all)?|--replace-all|--add)' &&
  block 'git config --unset/--replace-all/--add core.hooksPath แก้ hooks floor — ห้ามใช้'

# SECRET_GUARD_SKIP= is an env var honored by check-secrets.sh — it is set in one
# command and consumed by a LATER commit, so like the floor-tamper checks above it
# must block independently of a `git` token (the prefilter below returns early for
# any command lacking one, which previously let a standalone `SECRET_GUARD_SKIP=1`
# export fail open).
echo "$C" | grep -q 'SECRET_GUARD_SKIP=' &&
  block 'SECRET_GUARD_SKIP ข้าม secret scan — ถ้าจำเป็นจริงให้ user รันเองนอก session'

# Normalize executable spelling for matching only; never execute this copy.
# Shell accepts \git, "git", $'git', and absolute paths ending in /git as the
# same executable class. The old standalone-token prefilter returned early for
# all of them and skipped every bypass check below. Strip the `$` ONLY when it
# sits directly before a quote (ANSI-C $'...' / locale $"...") — a bare `$word`
# is a variable expansion, not the git executable, and must not match.
N=$(printf '%s' "$C" | sed -E "s/\\\$(['\"])/\\1/g" | tr -d '\\'\''"')
GPOS='(^|[;&|][[:space:]]*|[[:space:]])'
GIT_EXE='([^[:space:]]*/)?git'
echo "$N" | grep -qE "${GPOS}${GIT_EXE}([[:space:]]|$)" || exit 0

echo "$C" | grep -qE -- '--no-verify' &&
  block '--no-verify ข้าม secret-guard pre-commit hook — commit ตามปกติเพื่อให้ scan ทำงาน'

# short flag -n (= --no-verify ของ git commit) รวม combined เช่น -nm, -anm
# de-quote ก่อน: ลบเนื้อใน '...' และ "..." ออกเป็นช่องว่าง เพื่อไม่ให้ -n ใน
# commit message เป็น false positive — แต่ -n จริงที่วางก่อน/หลัง quoted message
# (และหลัง line continuation) จะยังเหลืออยู่ในสตริงที่สแกน จึงถูกจับทุกตำแหน่ง
# (--no-verify ทุกตำแหน่งยังถูกจับโดยบรรทัด --no-verify ด้านบนแยกต่างหาก)
# collapse newlines to spaces FIRST so a quoted message spanning a literal newline is
# a single line when de-quoted — otherwise sed (line-oriented) leaves an in-message -n
# behind and false-blocks (issue #28). real -n/--no-verify outside quotes still survives.
# GO (git global-options regex, covers `git -c user.x=y commit -nm` etc — anchor-adjacent
# bypass class PR #38/#39) — single source in lib-guard.sh, sourced above.
# Normalize only whitespace-delimited words whose de-quoted basename is `git`.
# Other quoted spans stay byte-for-byte intact so the next sed can still remove
# commit-message text such as "-n". This also collapses g""it, \git, "git",
# and quoted/unquoted absolute paths without flattening every argument.
CQ=$(printf '%s' "$C" | awk '
  {
    for (i = 1; i <= NF; i += 1) {
      normalized = $i
      gsub(/\$\047/, "\047", normalized)
      gsub(/\$"/, "\"", normalized)
      gsub(/\\/, "", normalized)
      gsub(/\047/, "", normalized)
      gsub(/"/, "", normalized)
      base = normalized
      sub(/^.*\//, "", base)
      if (base == "git") $i = normalized
    }
    print
  }
')
DQ=$(printf '%s' "$CQ" | tr '\n' ' ' | sed -e "s/'[^']*'/ /g" -e 's/"[^"]*"/ /g')
# ponytail: flat-string de-quote — a flag WRAPPED in quotes (`git commit "-nm"`) is
# stripped together with its quoted span and slips this Tier-2 check. Not fixable by
# regex without false-blocking every message that contains `-n` (issue #28, why we
# de-quote at all); a real fix needs shell tokenization, out of scope for a string
# guard. Tier-1 CI `check-secrets.sh --all` re-scans server-side and is the backstop.
echo "$DQ" | grep -qE "${GPOS}${GIT_EXE}${GO}[[:space:]]+commit.*[[:space:]]-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|\$)" &&
  block 'git commit -n (--no-verify) ข้าม secret-guard — commit ตามปกติ'

exit 0
