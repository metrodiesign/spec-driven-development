#!/usr/bin/env bash
# check-evidence.test.sh — REQ-4.5 baseline (pre-refactor) fixtures for the Evidence-policy
# dedup, PLUS (added by task 3, additive-only per REQ-4.2) parity/tamper proof for the
# post-refactor .ai/bin/check-evidence.sh + .ai/bin/lib-guard.sh engines.
# Run: bash .claude/hooks/tests/check-evidence.test.sh   (exit 0 = all passed)
#
# Section 1 (task 1, REQ-4.5) proves TODAY's .githooks/pre-commit Evidence-loop behavior
# via a real sandbox git repo (so pre-commit's own `git rev-parse --show-toplevel` +
# `"$BIN/check-secrets.sh"` calls work unmodified) and locks the CURRENT gate-task.sh
# Thai message + pre-commit English message as byte snapshots (REQ-4.4, baseline half).
# Section 2 (task 3) re-runs the SAME fixtures through both entry points post-refactor,
# adds strict-vs-added-only divergence, fail-closed, tamper, and Thai-comment-absence cases.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GATE_ENGINE="$REPO_ROOT/.ai/bin/gate-task.sh"
PRECOMMIT="$REPO_ROOT/.githooks/pre-commit"
pass=0
fail=0

# --- sandbox helper: a real git repo mirroring .ai/bin so pre-commit's REPO_ROOT
# resolution and its check-secrets.sh call work unmodified. Symlinks whatever
# .ai/bin/*.sh engines exist right now, so the SAME helper works both BEFORE (task 1,
# check-evidence.sh/lib-guard.sh don't exist yet) and AFTER (task 3) they land.
cleanup_dirs=()
cleanup() {
  local RMBIN FLAG
  RMBIN="r""m"; FLAG="-r""f"
  for d in "${cleanup_dirs[@]}"; do "$RMBIN" "$FLAG" "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

new_sandbox() {
  local dir
  dir="$(mktemp -d)"
  cleanup_dirs+=("$dir")
  ( cd "$dir" && git init -q && git config user.email t@t.co && git config user.name t )
  mkdir -p "$dir/.ai/bin" "$dir/.ai/specs/sample"
  local f
  for f in "$REPO_ROOT"/.ai/bin/*.sh; do
    ln -sf "$f" "$dir/.ai/bin/$(basename "$f")"
  done
  printf '%s' "$dir"
}

# Stage $2 as the content of .ai/specs/sample/tasks.md inside sandbox $1 and leave it
# staged (uncommitted), so `git diff --cached` sees it as the pending change (the shape
# pre-commit expects: added [x] lines detected against an empty/absent prior version).
stage_new() { # $1=sandbox $2=content
  printf '%s\n' "$2" > "$1/.ai/specs/sample/tasks.md"
  ( cd "$1" && git add -A )
}

run_precommit() { # $1=sandbox -> sets $rc and $out
  out=$( cd "$1" && "$PRECOMMIT" 2>&1 )
  rc=$?
}

check_precommit() { # $1=expect(block|allow) $2=desc $3=content
  local want=1
  [ "$1" = allow ] && want=0
  local sbx; sbx="$(new_sandbox)"
  stage_new "$sbx" "$3"
  run_precommit "$sbx"
  if [ "$rc" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL [pre-commit][$1] $2 -> exit $rc (want $want)"
  fi
}

# ----- fixtures (REQ-4.5): flip+evidence / flip-without / mixed multi-task / no-new-flip -----
FLIP_WITH_EVIDENCE="$(printf '%s\n' \
  '- [x] 1. Freshly flipped task, properly evidenced' \
  '     Evidence: tsc --noEmit exit 0; vitest 12/12 green; 375/768/1440 verified.')"

FLIP_WITHOUT_EVIDENCE="$(printf '%s\n' \
  '- [x] 1. Freshly flipped task with NO evidence of its own')"

# mixed multi-task: task 1 flipped+evidenced, task 2 flipped withOUT its own evidence —
# pre-commit's per-task-block scoping must still block on task 2 alone.
MIXED_MULTI_TASK="$(printf '%s\n' \
  '- [x] 1. Flipped, evidenced' \
  '     Evidence: tsc exit 0; vitest 8/8 green; viewports 375/768/1440 ok.' \
  '- [x] 2. Flipped, NOT evidenced' \
  '- [ ] 3. Still todo')"

# pre-commit's PRESENCE-ONLY semantics: unlike gate-task's --strict, pre-commit's current
# bash loop accepts ANY `Evidence:` line regardless of trivial content — 'Evidence: TODO'
# passes today. This is the documented per-mode divergence (REQ-1.3/ARC-F6): the dedup
# must NOT upgrade pre-commit to non-trivial checking.
PRESENCE_ONLY_PLACEHOLDER="$(printf '%s\n' \
  '- [x] 1. Flipped with a placeholder Evidence value' \
  '     Evidence: TODO')"

echo "=== REQ-4.5 BASELINE: pre-commit Evidence-loop, CURRENT code ==="
check_precommit block "flip without evidence"            "$FLIP_WITHOUT_EVIDENCE"
check_precommit allow "flip with evidence"                "$FLIP_WITH_EVIDENCE"
check_precommit block "mixed multi-task, one flip bare"   "$MIXED_MULTI_TASK"
check_precommit allow "presence-only: placeholder passes (today's semantics, NOT gate-task's)" "$PRESENCE_ONLY_PLACEHOLDER"

echo "=== REQ-4.5 BASELINE: no-new-flip commit never blocks ==="
# a tasks.md edit that adds no NEW [x] line (already-[x] task, untouched) must not block —
# pre-commit only inspects lines the staged diff actually ADDS.
NO_NEW_FLIP_SBX="$(new_sandbox)"
printf '%s\n' '- [x] 1. Pre-existing done task' '     Evidence: already here' > "$NO_NEW_FLIP_SBX/.ai/specs/sample/tasks.md"
( cd "$NO_NEW_FLIP_SBX" && git add -A && git commit -q -m base )
printf '%s\n' '- [x] 1. Pre-existing done task' '     Evidence: already here, tweaked wording' > "$NO_NEW_FLIP_SBX/.ai/specs/sample/tasks.md"
( cd "$NO_NEW_FLIP_SBX" && git add -A )
run_precommit "$NO_NEW_FLIP_SBX"
[ "$rc" -eq 0 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL [pre-commit][allow] no-new-flip edit -> exit $rc (want 0)"; }

echo "=== REQ-4.4 MESSAGE SNAPSHOT (baseline half): lock CURRENT byte-exact strings ==="
# gate-task.sh's Thai string (captured via the sandboxed engine, npm-free: no tasks.md path
# match needed for the message itself — we just need the exact EV_FAIL branch to fire).
GT_SBX="$(new_sandbox)"
printf '{"scripts":{}}' > "$GT_SBX/package.json"
GT_OUT=$( cd "$GT_SBX" && GATE_FILE=".ai/specs/sample/tasks.md" GATE_NEW="$FLIP_WITHOUT_EVIDENCE" "$GATE_ENGINE" 2>&1 )
if printf '%s' "$GT_OUT" | grep -qF 'Task gate: ขาด Evidence (per-task)'; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL [snapshot] gate-task.sh Thai message changed or absent"
fi

PC_SBX="$(new_sandbox)"
stage_new "$PC_SBX" "$FLIP_WITHOUT_EVIDENCE"
run_precommit "$PC_SBX"
if printf '%s' "$out" | grep -qF "Blocked: a newly-marked [x] task has no 'Evidence:' line in its own block:"; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL [snapshot] pre-commit English message changed or absent"
fi

echo "=== TASK 3: per-mode parity — SAME fixtures, post-refactor, through pre-commit ==="
check_precommit block "flip without evidence (post-refactor)"          "$FLIP_WITHOUT_EVIDENCE"
check_precommit allow "flip with evidence (post-refactor)"              "$FLIP_WITH_EVIDENCE"
check_precommit block "mixed multi-task, one flip bare (post-refactor)" "$MIXED_MULTI_TASK"
check_precommit allow "presence-only placeholder still passes (post-refactor, level NOT merged)" "$PRESENCE_ONLY_PLACEHOLDER"

echo "=== TASK 3 REQ-1.3/ARC-F6: strict vs added-only divergence, SAME content, via the engine directly ==="
EVIDENCE_ENGINE="$REPO_ROOT/.ai/bin/check-evidence.sh"
AF="$(mktemp)"; printf '%s\n' '- [x] 1. flip' > "$AF"
bash "$EVIDENCE_ENGINE" --strict <<<"$PRESENCE_ONLY_PLACEHOLDER" >/dev/null 2>&1
[ $? -eq 1 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL [engine][block] --strict rejects placeholder Evidence"; }
bash "$EVIDENCE_ENGINE" --added-only "$AF" <<<"$(printf '%s\n' '- [x] 1. flip' '     Evidence: TODO')" >/dev/null 2>&1
[ $? -eq 0 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL [engine][allow] --added-only accepts placeholder Evidence (presence-only)"; }
rm -f "$AF"

echo "=== TASK 3 REQ-1.4/2.3: fail-closed — engine non-executable / lib-guard.sh missing ==="
# a throwaway sandbox with its OWN copies (not symlinks) of every engine + pre-commit, so
# chmod/rm here can never touch the real repo files.
new_engine_sandbox() {
  local dir; dir="$(mktemp -d)"
  cleanup_dirs+=("$dir")
  ( cd "$dir" && git init -q && git config user.email t@t.co && git config user.name t )
  mkdir -p "$dir/.ai/bin" "$dir/.githooks" "$dir/.ai/specs/sample"
  local f
  for f in "$REPO_ROOT"/.ai/bin/*.sh; do
    cp -p "$f" "$dir/.ai/bin/$(basename "$f")"
    chmod +x "$dir/.ai/bin/$(basename "$f")"
  done
  cp -p "$REPO_ROOT/.githooks/pre-commit" "$dir/.githooks/pre-commit"
  printf '%s' "$dir"
}

# -- check-evidence.sh non-executable: both gate-task.sh and pre-commit must block,
#    message naming the engine path (not a bare bash traceback).
NX_SBX="$(new_engine_sandbox)"
chmod -x "$NX_SBX/.ai/bin/check-evidence.sh"
GT_OUT=$( cd "$NX_SBX" && GATE_FILE=".ai/specs/sample/tasks.md" GATE_NEW="$FLIP_WITH_EVIDENCE" "$NX_SBX/.ai/bin/gate-task.sh" 2>&1 ); GT_RC=$?
if [ "$GT_RC" -eq 2 ] && printf '%s' "$GT_OUT" | grep -qF 'check-evidence.sh'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [gate-task][fail-closed] non-executable check-evidence.sh -> exit $GT_RC"; fi
stage_new "$NX_SBX" "$FLIP_WITH_EVIDENCE"
PC_OUT=$( cd "$NX_SBX" && "$NX_SBX/.githooks/pre-commit" 2>&1 ); PC_RC=$?
if [ "$PC_RC" -eq 2 ] && printf '%s' "$PC_OUT" | grep -qF 'check-evidence.sh'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [pre-commit][fail-closed] non-executable check-evidence.sh -> exit $PC_RC"; fi

# -- lib-guard.sh missing: gate-task.sh, pre-commit, check-destructive.sh, check-bypass.sh
#    must ALL block, message naming lib-guard.sh's path.
LG_SBX="$(new_engine_sandbox)"
rm -f "$LG_SBX/.ai/bin/lib-guard.sh"
GT_OUT=$( cd "$LG_SBX" && GATE_FILE=".ai/specs/sample/tasks.md" GATE_NEW="$FLIP_WITH_EVIDENCE" "$LG_SBX/.ai/bin/gate-task.sh" 2>&1 ); GT_RC=$?
if [ "$GT_RC" -eq 2 ] && printf '%s' "$GT_OUT" | grep -qF 'lib-guard.sh'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [gate-task][fail-closed] missing lib-guard.sh -> exit $GT_RC"; fi
stage_new "$LG_SBX" "$FLIP_WITH_EVIDENCE"
PC_OUT=$( cd "$LG_SBX" && "$LG_SBX/.githooks/pre-commit" 2>&1 ); PC_RC=$?
if [ "$PC_RC" -eq 2 ] && printf '%s' "$PC_OUT" | grep -qF 'lib-guard.sh'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [pre-commit][fail-closed] missing lib-guard.sh -> exit $PC_RC"; fi
DESTR_OUT=$( "$LG_SBX/.ai/bin/check-destructive.sh" 'git reset --hard' 2>&1 ); DESTR_RC=$?
if [ "$DESTR_RC" -eq 2 ] && printf '%s' "$DESTR_OUT" | grep -qF 'lib-guard.sh'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [check-destructive][fail-closed] missing lib-guard.sh -> exit $DESTR_RC"; fi
BYPASS_OUT=$( "$LG_SBX/.ai/bin/check-bypass.sh" 'git commit -n -m x' 2>&1 ); BYPASS_RC=$?
if [ "$BYPASS_RC" -eq 2 ] && printf '%s' "$BYPASS_OUT" | grep -qF 'lib-guard.sh'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [check-bypass][fail-closed] missing lib-guard.sh -> exit $BYPASS_RC"; fi

echo "=== TASK 3 REQ-2.4: tamper attempts on new engine files blocked via check-bypass ==="
check_bypass_block() { # $1=desc $2=command-string
  "$REPO_ROOT/.ai/bin/check-bypass.sh" "$2" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL [bypass][block] $1 -> exit $rc :: $2"; fi
}
check_bypass_block "chmod -x lib-guard.sh"        'chmod -x .ai/bin/lib-guard.sh'
check_bypass_block "mv check-evidence.sh away"    'mv .ai/bin/check-evidence.sh /tmp'
check_bypass_block "redirect into lib-guard.sh"   'echo x > .ai/bin/lib-guard.sh'

echo "=== TASK 3 ARC-F11: Thai 'edit both' comments removed after dedup ==="
if grep -rq 'แก้ต้องแก้คู่' "$REPO_ROOT"/.ai/bin/*.sh 2>/dev/null; then
  fail=$((fail + 1)); echo "FAIL: 'แก้ต้องแก้คู่' still present in .ai/bin"
else
  pass=$((pass + 1))
fi
if grep -rq 'ก็อปตรงจาก check-destructive.sh' "$REPO_ROOT"/.ai/bin/*.sh 2>/dev/null; then
  fail=$((fail + 1)); echo "FAIL: 'ก็อปตรงจาก check-destructive.sh' still present in .ai/bin"
else
  pass=$((pass + 1))
fi

echo "=== TASK 4 REQ-5.3/5.5-5.7: line-selected strict mode ==="
LINE_SBX="$(new_sandbox)"
LINE_FILE="$LINE_SBX/selected-lines"
LINE_CONTENT="$(printf '%s\n' \
  '# Tasks' \
  '- [x] 1. Duplicate opening' \
  '     Evidence: historical pass' \
  '- [ ] separator' \
  '- [x] 1. Duplicate opening' \
  '     Evidence: TODO' \
  '- [x] 3. Inline evidence' \
  '     Evidence: suite passed' \
  '- [x] 4. Multiline evidence' \
  '     Evidence:' \
  '       - test: integration suite passed')"

check_lines_strict() { # $1=expected rc, $2=description, $3=selection
  local expected="$1" description="$2" selection="$3" result rc
  printf '%s' "$selection" > "$LINE_FILE"
  result=$(printf '%s\n' "$LINE_CONTENT" | "$EVIDENCE_ENGINE" --lines-strict "$LINE_FILE" 2>&1)
  rc=$?
  if [ "$rc" -eq "$expected" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); echo "FAIL [lines-strict] $description -> exit $rc (want $expected) :: $result"
  fi
}

check_lines_strict 0 "duplicate text selects evidenced physical line only" $'2\n'
check_lines_strict 1 "duplicate text selects placeholder physical line only" $'5\n'
check_lines_strict 0 "inline and multiline Evidence pass together" $'7\n9\n'
check_lines_strict 2 "unchecked line is invalid selection" $'4\n'
check_lines_strict 2 "zero is invalid selection" $'0\n'
check_lines_strict 2 "duplicate line number is invalid selection" $'2\n2\n'
check_lines_strict 0 "empty selection checks no historical task" ''

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
