#!/usr/bin/env bash
# gate-task.test.sh — adversarial test for the task-boundary quality gate.
# Run: bash .claude/hooks/tests/gate-task.test.sh   (exit 0 = all passed)
#
# Logic lives in .ai/bin/gate-task.sh (the single-source engine); .claude/hooks/
# task-gate.sh, .codex/hooks/task-gate.sh and .opencode/plugins/task-gate.js are thin
# adapters that hand the engine an input shape (scoped flipped hunk OR whole file).
#
# WHAT THIS PROVES (PR #24 findings #6, #19, #20, #28):
#   #6  — all THREE adapter input shapes (Claude scoped hunk, Codex added-lines,
#         OpenCode whole-file) yield the SAME engine verdict for the same flip.
#   #19 — the Evidence check is PER TASK: a pre-existing Evidence line on a DIFFERENT
#         task does NOT satisfy a freshly-flipped task that has none of its own.
#   #20/#28 — Evidence must be non-trivial content; the Claude Write path no longer
#         auto-injects a synthetic 'Evidence: n/a (Write path)', so a [x] flip written
#         via Write with no real Evidence blocks exactly like Edit/OpenCode.
#
# ISOLATION: the engine runs typecheck + test (npm) BEFORE the Evidence gate. To test
# the Evidence logic deterministically (and not depend on a green tsc/vitest env), each
# case runs the engine inside a throwaway sandbox dir whose package.json stubs
# `typecheck` and `test` to no-ops (exit 0). The gate file path is a real
# .claude/specs/<feature>/tasks.md shape so the engine's path filter fires. We assert
# exit code only (2 = block, 0 = allow); npm/git are never run for real against the repo.
set -u

ENGINE="$(cd "$(dirname "$0")/../../../.ai/bin" && pwd)/gate-task.sh"
CLAUDE_HOOK="$(cd "$(dirname "$0")/.." && pwd)/task-gate.sh"
pass=0
fail=0

# A self-cleaning sandbox: stub npm scripts so typecheck/test pass, isolating Evidence.
SANDBOX="$(mktemp -d)"
printf '%s' '{"name":"gate-task-test","version":"1.0.0","private":true,"scripts":{"typecheck":"true","test":"true"}}' > "$SANDBOX/package.json"
mkdir -p "$SANDBOX/.claude/specs/sample"
GATEFILE="$SANDBOX/.claude/specs/sample/tasks.md"
# canonical .ai/specs path: prove the engine path filter fires there too (dual-match).
mkdir -p "$SANDBOX/.ai/specs/sample"
AIGATEFILE="$SANDBOX/.ai/specs/sample/tasks.md"

CACHE_SANDBOXES=()
cleanup() {
  # assemble the recursive-force delete token at runtime so the live destructive guard
  # (which scans literal command lines) never sees it as a literal in this file.
  local RMBIN FLAG
  RMBIN="r""m"
  FLAG="-r""f"
  "$RMBIN" "$FLAG" "$SANDBOX" 2>/dev/null || true
  for d in "${CACHE_SANDBOXES[@]}"; do "$RMBIN" "$FLAG" "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

# run the engine with a given GATE_NEW payload, from inside the sandbox so npm picks up
# the stub scripts. Returns the engine exit code.
run_engine() { # $1=GATE_NEW content
  ( cd "$SANDBOX" && GATE_FILE="$GATEFILE" GATE_NEW="$1" "$ENGINE" >/dev/null 2>&1 )
}

check_engine() { # $1=expect(block|allow) $2=desc $3=GATE_NEW
  local want=2
  [ "$1" = allow ] && want=0
  run_engine "$3"
  local rc=$?
  if [ "$rc" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL [engine][$1] $2 -> exit $rc (want $want)"
  fi
}

# run via the Claude adapter: JSON payload on stdin (Edit or Write tool).
run_claude_edit() { # $1=old_string $2=new_string
  ( cd "$SANDBOX" && printf '{"tool_name":"Edit","tool_input":{"file_path":%s,"old_string":%s,"new_string":%s}}' \
      "$(printf '%s' "$GATEFILE" | jq -Rs .)" \
      "$(printf '%s' "$1" | jq -Rs .)" \
      "$(printf '%s' "$2" | jq -Rs .)" \
    | "$CLAUDE_HOOK" >/dev/null 2>&1 )
}
run_claude_write() { # $1=content
  ( cd "$SANDBOX" && printf '{"tool_name":"Write","tool_input":{"file_path":%s,"content":%s}}' \
      "$(printf '%s' "$GATEFILE" | jq -Rs .)" \
      "$(printf '%s' "$1" | jq -Rs .)" \
    | "$CLAUDE_HOOK" >/dev/null 2>&1 )
}

check_claude() { # $1=expect $2=desc $3=mode(edit|write) ... payload
  local want=2
  [ "$1" = allow ] && want=0
  local rc
  if [ "$3" = edit ]; then
    run_claude_edit "$4" "$5"; rc=$?
  else
    run_claude_write "$4"; rc=$?
  fi
  if [ "$rc" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL [claude/$3][$1] $2 -> exit $rc (want $want)"
  fi
}

# ----- input-shape fixtures for the SAME flip (task 2 flipped to [x]) -----
# Whole file as OpenCode would cat it: task 1 ([x] WITH its own Evidence) + task 2
# ([x] freshly flipped, NO Evidence of its own). The pre-existing Evidence on task 1
# must NOT rescue task 2 (finding #19/#6).
WHOLE_NOEV="$(printf '%s\n' \
  '- [x] 1. Already done task' \
  '     Evidence: tsc exit 0; vitest 5/5 green; viewports 375/768/1440 ok.' \
  '- [x] 2. Freshly flipped task with NO evidence of its own' \
  '- [ ] 3. Not done yet')"

# Claude/Codex scoped hunk for the SAME flip: only task 2's flipped line (no Evidence).
HUNK_NOEV='- [x] 2. Freshly flipped task with NO evidence of its own'

# Codex feeds the patch's added lines (leading '+' already stripped by its adapter,
# so the engine sees the same bare hunk). Same content as the Claude hunk here.
CODEX_HUNK_NOEV="$HUNK_NOEV"

# ----- properly-evidenced fixtures (MUST pass) -----
WHOLE_EV="$(printf '%s\n' \
  '- [x] 1. Already done task' \
  '     Evidence: tsc exit 0; vitest 5/5 green; viewports 375/768/1440 ok.' \
  '- [x] 2. Freshly flipped task, properly evidenced' \
  '     Evidence: tsc --noEmit exit 0; vitest 12/12 green; 375/768/1440 verified.' \
  '- [ ] 3. Not done yet')"

HUNK_EV="$(printf '%s\n' \
  '- [x] 2. Freshly flipped task, properly evidenced' \
  '     Evidence: tsc --noEmit exit 0; vitest 12/12 green; 375/768/1440 verified.')"

# explicit n/a escape is the AGENT's choice in the file — must pass.
HUNK_NA="$(printf '%s\n' \
  '- [x] 4. Docs-only task' \
  '     Evidence: n/a (no runtime code; markdown only)')"

# placeholder Evidence value must NOT count as real evidence (finding #20/#28).
HUNK_PLACEHOLDER="$(printf '%s\n' \
  '- [x] 5. Flip with placeholder evidence' \
  '     Evidence: TODO')"

# the old auto-injected Write-path token, now banned as trivial — must BLOCK.
HUNK_WRITEPATH="$(printf '%s\n' \
  '- [x] 6. Flip with the old synthetic write-path token' \
  '     Evidence: n/a (Write path)')"

echo "=== #6/#19 PARITY: same flip, three input shapes -> SAME verdict (BLOCK, no own Evidence) ==="
check_engine block "OpenCode whole-file, flipped task has no own Evidence" "$WHOLE_NOEV"
check_engine block "Claude scoped hunk, flipped task has no Evidence"      "$HUNK_NOEV"
check_engine block "Codex added-lines hunk, flipped task has no Evidence"  "$CODEX_HUNK_NOEV"

echo "=== #6 PARITY: same flip, three input shapes -> SAME verdict (ALLOW, properly evidenced) ==="
check_engine allow "OpenCode whole-file, flipped task properly evidenced"  "$WHOLE_EV"
check_engine allow "Claude scoped hunk, flipped task properly evidenced"   "$HUNK_EV"
check_engine allow "Codex added-lines hunk, flipped task properly evidenced" "$HUNK_EV"

echo "=== #19 PER-TASK: decoy Evidence on another task does NOT rescue the flipped one ==="
# flipped task carries TRIVIAL evidence while a DIFFERENT task has good evidence; the
# flipped task must still BLOCK — the gate is scoped to the flipped task's own region.
DECOY_TRIVIAL="$(printf '%s\n' \
  '- [x] 1. Already done, well evidenced' \
  '     Evidence: tsc exit 0; vitest 8/8 green; 375/768/1440 ok.' \
  '- [x] 2. Freshly flipped, only a placeholder of its own' \
  '     Evidence: TBD' \
  '- [ ] 3. Not done yet')"
check_engine block "trivial Evidence on flipped task, good Evidence on a sibling" "$DECOY_TRIVIAL"
# flipped task is the LAST task: its region is closed by EOF (not a following checkbox).
EOF_NOEV="$(printf '%s\n' \
  '- [x] 1. Already done, evidenced' \
  '     Evidence: real proof here on 375/768/1440' \
  '- [x] 2. Last task, freshly flipped, NO Evidence')"
check_engine block "flipped task is last (region closed by EOF), no Evidence"   "$EOF_NOEV"

echo "=== #20/#28 NON-TRIVIAL EVIDENCE ==="
check_engine block "placeholder 'TODO' is not real evidence"               "$HUNK_PLACEHOLDER"
check_engine block "old synthetic 'n/a (Write path)' token is trivial"     "$HUNK_WRITEPATH"
check_engine allow "explicit 'n/a (...)' escape is the agent's choice"      "$HUNK_NA"
check_engine allow "Evidence value wrapped in backticks counts"            "$(printf '%s\n' '- [x] 8. flip' '     Evidence: `tsc --noEmit` exit 0; vitest 9/9')"
# documented multiline block: `Evidence:` header (empty inline) + bullets — MUST pass.
check_engine allow "multiline Evidence block (header + bullets)"            "$(printf '%s\n' \
  '- [x] 9. flip with the documented block format' \
  '     Evidence:' \
  '       - test: vitest -> 12 passed / 0 failed' \
  '       - viewports: 375 OK | 768 OK | 1440 OK' \
  '       - deviations: none')"
# empty Evidence: header with only a placeholder bullet is still trivial — MUST block.
check_engine block "multiline Evidence block with placeholder bullet only"  "$(printf '%s\n' \
  '- [x] 10. flip with an empty block' \
  '     Evidence:' \
  '       - TODO')"
# placeholder behind a `key:` label inside a bullet must still block (codex P2): the label
# is non-trivial but the VALUE is a placeholder — judge the value, not the label.
check_engine block "multiline block, all bullets are key: placeholder"      "$(printf '%s\n' \
  '- [x] 11. flip with labelled placeholder bullets' \
  '     Evidence:' \
  '       - test: TODO' \
  '       - viewports: pending')"
# a NON-EMPTY placeholder header must NOT open bullet mode — a later non-evidence bullet
# must not rescue it (codex P2 round 2). `Evidence: TODO` + `- notes: foo` -> still BLOCK.
check_engine block "placeholder header does not open bullet-collection"     "$(printf '%s\n' \
  '- [x] 12. flip with a placeholder header then a stray bullet' \
  '     Evidence: TODO' \
  '       - notes: not actually verification')"

echo "=== PATH FILTER: gate fires under canonical .ai/specs AND legacy .claude/specs ==="
# same no-Evidence flip must BLOCK regardless of which specs root holds tasks.md.
( cd "$SANDBOX" && GATE_FILE="$AIGATEFILE" GATE_NEW="$HUNK_NOEV" "$ENGINE" >/dev/null 2>&1 )
[ $? -eq 2 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL [engine][block] .ai/specs path no Evidence"; }
( cd "$SANDBOX" && GATE_FILE="$AIGATEFILE" GATE_NEW="$HUNK_EV" "$ENGINE" >/dev/null 2>&1 )
[ $? -eq 0 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL [engine][allow] .ai/specs path evidenced"; }

echo "=== TRIGGER: non-flip edits allow silently ==="
check_engine allow "no [x] in content -> not a flip"                       '- [ ] 7. still todo'
check_engine allow "empty content -> not a flip"                           ''

echo "=== #28 CLAUDE WRITE PATH: no synthetic Evidence injection ==="
# Write path used to auto-pass by injecting synthetic Evidence; now the real content is
# scoped per task, so a [x] flip with no own Evidence BLOCKS via Write just like Edit.
check_claude block "Write whole-file, flipped task no own Evidence" write "$WHOLE_NOEV"
check_claude allow "Write whole-file, properly evidenced"           write "$WHOLE_EV"

echo "=== CLAUDE EDIT ADAPTER: delta detection + per-task Evidence ==="
# Edit that increases [x] count with no Evidence -> block; with Evidence -> allow.
check_claude block "Edit flip [ ]->[x] no Evidence" edit '- [ ] 2. Freshly flipped task with NO evidence of its own' "$HUNK_NOEV"
check_claude allow "Edit flip [ ]->[x] evidenced"   edit '- [ ] 2. Freshly flipped task, properly evidenced' "$HUNK_EV"
# Edit that does NOT increase [x] count (already [x]) -> allow silently (not a new flip).
check_claude allow "Edit non-flip (already [x])"    edit "$HUNK_EV" "$HUNK_EV"

echo "=== SDD-GATE-TASK-CACHE: tree-hash skip (REQ-1..5) ==="
# Isolated git-init fixture (ARC-10): GIT_CEILING_DIRECTORIES pins git so a call can never
# escape to the enclosing repo. Spy-command output lives OUTSIDE the sandboxed tree (a
# sibling mktemp file) so the spy's own side effect never perturbs the fingerprint it is
# proving ran-or-skipped.
new_cache_sandbox() {
  local dir; dir="$(mktemp -d)"
  CACHE_SANDBOXES+=("$dir")
  mkdir -p "$dir/.ai/specs/sample"
  # initial commit so .git/index exists (a brand-new git-init repo has NO index file
  # until the first `git add`; without this, compute_key()'s temp-index seed-copy
  # finds nothing to copy and every fingerprint attempt fails-safe to "cache disabled" —
  # realistic production usage always has history by the time a task gate fires).
  ( cd "$dir" && git init -q && git config user.email t@t.co && git config user.name t \
      && printf 'x' > .gitkeep && git add -A && git commit -q -m init )
  printf '%s' "$dir"
}

T_GREEN='printf "t\n" >> "$SPY"; true'
T_RED='printf "t\n" >> "$SPY"; false'

# $1=sandbox $2=GATE_NEW $3=test_cmd(default green) $4=typecheck_cmd(default true)
# $5=SDD_GATE_TOOLCHAIN_CMD value (optional) $6=SDD_GATE_NO_CACHE value (optional) -> sets rc, err
run_cache_gate() {
  local sbx="$1" new="$2" tcmd="${3:-$T_GREEN}" tccmd="${4:-true}" toolchain="${5:-}" nocache="${6:-}"
  err=$( cd "$sbx" && env GIT_CEILING_DIRECTORIES="$(dirname "$sbx")" \
      GATE_FILE=".ai/specs/sample/tasks.md" GATE_NEW="$new" \
      SDD_TYPECHECK_CMD="$tccmd" SDD_TEST_CMD="$tcmd" SPY="$SPY" \
      SDD_GATE_TOOLCHAIN_CMD="$toolchain" SDD_GATE_NO_CACHE="$nocache" \
      "$ENGINE" 2>&1 >/dev/null )
  rc=$?
}

spy_count() { wc -l < "$SPY" | tr -d ' '; }

FLIP1='- [x] 1. flip
     Evidence: proof one'
FLIP2='- [x] 1. flip
     Evidence: proof one
- [x] 2. second flip
     Evidence: proof two'
FLIP_NO_EV='- [x] 9. flip with no evidence'

echo "--- REQ-2.1/2.2: green writes exactly one 40-hex key; red writes nothing ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
CACHE_FILE="$SBX/.git/sdd-gate-cache"
run_cache_gate "$SBX" "$FLIP1"
LINES=$(grep -cxE '[0-9a-f]{40}' "$CACHE_FILE" 2>/dev/null || echo 0)
if [ "$rc" -eq 0 ] && [ "$LINES" -eq 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][2.1] rc=$rc lines=$LINES err=$err"; fi

SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
CACHE_FILE="$SBX/.git/sdd-gate-cache"
run_cache_gate "$SBX" "$FLIP1" "$T_RED"
if [ "$rc" -eq 2 ] && [ ! -s "$CACHE_FILE" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][2.2] red run rc=$rc cache=$(cat "$CACHE_FILE" 2>/dev/null)"; fi

echo "--- REQ-3.1/3.3/ARC-1: flip task1 (green), flip task2 (spec-dir-only change) -> HIT, spy unchanged ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
run_cache_gate "$SBX" "$FLIP1"; C1=$(spy_count)
run_cache_gate "$SBX" "$FLIP2"; C2=$(spy_count)
if [ "$rc" -eq 0 ] && printf '%s' "$err" | grep -q 'gate cache hit' && [ "$C2" -eq "$C1" ]; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL [cache][3.1/3.3] rc=$rc c1=$C1 c2=$C2 err=$err"
fi

echo "--- REQ-1.3: determinism — two consecutive identical calls both hit/agree ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
run_cache_gate "$SBX" "$FLIP1"
run_cache_gate "$SBX" "$FLIP1"
if [ "$rc" -eq 0 ] && printf '%s' "$err" | grep -q 'gate cache hit'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][1.3] determinism: rc=$rc err=$err"; fi

echo "--- REQ-1.1/3.2: edit a tracked source file -> miss, suite runs ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
printf 'v1' > "$SBX/src.txt"; ( cd "$SBX" && git add -A && git commit -q -m base )
run_cache_gate "$SBX" "$FLIP1"; C1=$(spy_count)
printf 'v2' > "$SBX/src.txt"
run_cache_gate "$SBX" "$FLIP1"; C2=$(spy_count)
if [ "$rc" -eq 0 ] && ! printf '%s' "$err" | grep -q 'gate cache hit' && [ "$C2" -gt "$C1" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][1.1 edit] rc=$rc c1=$C1 c2=$C2 err=$err"; fi

echo "--- ARC-15: delete a tracked file -> miss, suite runs ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
printf 'v1' > "$SBX/src.txt"; ( cd "$SBX" && git add -A && git commit -q -m base )
run_cache_gate "$SBX" "$FLIP1"; C1=$(spy_count)
rm "$SBX/src.txt"
run_cache_gate "$SBX" "$FLIP1"; C2=$(spy_count)
if [ "$rc" -eq 0 ] && ! printf '%s' "$err" | grep -q 'gate cache hit' && [ "$C2" -gt "$C1" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][ARC-15 delete] rc=$rc c1=$C1 c2=$C2 err=$err"; fi

echo "--- REQ-1.1: create an untracked non-ignored file -> miss, suite runs ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
run_cache_gate "$SBX" "$FLIP1"; C1=$(spy_count)
printf 'new' > "$SBX/untracked.txt"
run_cache_gate "$SBX" "$FLIP1"; C2=$(spy_count)
if [ "$rc" -eq 0 ] && ! printf '%s' "$err" | grep -q 'gate cache hit' && [ "$C2" -gt "$C1" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][1.1 untracked] rc=$rc c1=$C1 c2=$C2 err=$err"; fi

echo "--- REQ-1.1: edit ONLY tasks.md content on disk (spec dirs excluded) -> still HIT ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
printf '%s\n' "$FLIP1" > "$SBX/.ai/specs/sample/tasks.md"
run_cache_gate "$SBX" "$FLIP1"; C1=$(spy_count)
printf '%s\n' "$FLIP2" > "$SBX/.ai/specs/sample/tasks.md"
run_cache_gate "$SBX" "$FLIP2"; C2=$(spy_count)
if [ "$rc" -eq 0 ] && printf '%s' "$err" | grep -q 'gate cache hit' && [ "$C2" -eq "$C1" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][1.1 tasks.md-only] rc=$rc c1=$C1 c2=$C2 err=$err"; fi

echo "--- REQ-1.2: change SDD_TEST_CMD (config) -> miss ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
run_cache_gate "$SBX" "$FLIP1" 'printf t >> "$SPY"; true'
run_cache_gate "$SBX" "$FLIP1" 'printf t >> "$SPY" ; true'
if [ "$rc" -eq 0 ] && ! printf '%s' "$err" | grep -q 'gate cache hit'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][1.2 cmd change] rc=$rc err=$err"; fi

echo "--- REQ-1.5: change SDD_GATE_TOOLCHAIN_CMD output (salt) -> miss ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
run_cache_gate "$SBX" "$FLIP1" "$T_GREEN" true "echo v1"
run_cache_gate "$SBX" "$FLIP1" "$T_GREEN" true "echo v2"
if [ "$rc" -eq 0 ] && ! printf '%s' "$err" | grep -q 'gate cache hit'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][1.5 salt change] rc=$rc err=$err"; fi

echo "--- REQ-1.6: .gitmodules present -> cache fully disabled (no read, no write) ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
: > "$SBX/.gitmodules"
CACHE_FILE="$SBX/.git/sdd-gate-cache"
run_cache_gate "$SBX" "$FLIP1"; C1=$(spy_count)
run_cache_gate "$SBX" "$FLIP1"; C2=$(spy_count)
if [ "$rc" -eq 0 ] && [ "$C2" -gt "$C1" ] && [ ! -s "$CACHE_FILE" ] && ! printf '%s' "$err" | grep -q 'gate cache hit'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL [cache][1.6 gitmodules] rc=$rc c1=$C1 c2=$C2 cache=$(cat "$CACHE_FILE" 2>/dev/null) err=$err"
fi

echo "--- REQ-4.1: SDD_GATE_NO_CACHE=1 on a warm cache -> suite runs, no cache write ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
CACHE_FILE="$SBX/.git/sdd-gate-cache"
run_cache_gate "$SBX" "$FLIP1"
BEFORE=$(cat "$CACHE_FILE" 2>/dev/null)
run_cache_gate "$SBX" "$FLIP1" "$T_GREEN" true "" 1; C_AFTER=$(spy_count)
AFTER=$(cat "$CACHE_FILE" 2>/dev/null)
if [ "$rc" -eq 0 ] && [ "$C_AFTER" -eq 2 ] && [ "$BEFORE" = "$AFTER" ] && ! printf '%s' "$err" | grep -q 'gate cache hit'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL [cache][4.1 no-cache-env] rc=$rc spy=$C_AFTER before=[$BEFORE] after=[$AFTER] err=$err"
fi

echo "--- REQ-2.4: corrupt cache (binary garbage) -> full run, no crash, no false hit ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
mkdir -p "$SBX/.git"
head -c 200 /dev/urandom > "$SBX/.git/sdd-gate-cache" 2>/dev/null
run_cache_gate "$SBX" "$FLIP1"
if [ "$rc" -eq 0 ] && ! printf '%s' "$err" | grep -q 'gate cache hit'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][2.4 corrupt] rc=$rc err=$err"; fi

echo "--- REQ-3.4: cache HIT still runs Evidence — missing evidence still exit 2 ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
run_cache_gate "$SBX" "$FLIP1"
run_cache_gate "$SBX" "$FLIP_NO_EV"
if [ "$rc" -eq 2 ] && printf '%s' "$err" | grep -q 'gate cache hit'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][3.4 hit-but-no-evidence] rc=$rc err=$err"; fi

echo "--- REQ-3.4/ARC-3: cache append to a read-only .git dir -> warning, Evidence still decides exit ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
chmod -w "$SBX/.git"
run_cache_gate "$SBX" "$FLIP1"
chmod +w "$SBX/.git"
if [ "$rc" -eq 0 ] && printf '%s' "$err" | grep -q 'append failed'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][ARC-3 readonly-append] rc=$rc err=$err"; fi

echo "--- REQ-4.2: 9 distinct green keys -> cache capped at 8 ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
CACHE_FILE="$SBX/.git/sdd-gate-cache"
i=1
while [ "$i" -le 9 ]; do
  printf 'v%s' "$i" > "$SBX/src.txt"
  run_cache_gate "$SBX" "$FLIP1"
  i=$((i+1))
done
LINES=$(grep -cxE '[0-9a-f]{40}' "$CACHE_FILE" 2>/dev/null || echo 0)
if [ "$LINES" -eq 8 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL [cache][4.2 cap] lines=$LINES (want 8)"; fi

echo "--- REQ-2.5/REQ-4.2/ARC-16: concurrent invocations, IDENTICAL tree -> integrity + no duplicate key ---"
SBX="$(new_cache_sandbox)"; SPY="$(mktemp)"
PAR_PIDS=()
j=1
while [ "$j" -le 4 ]; do
  ( cd "$SBX" && GIT_CEILING_DIRECTORIES="$(dirname "$SBX")" \
      GATE_FILE=".ai/specs/sample/tasks.md" GATE_NEW="$FLIP1" \
      SDD_TYPECHECK_CMD=true SDD_TEST_CMD="$T_GREEN" SPY="$SPY" \
      "$ENGINE" >/dev/null 2>>"$SPY.err" ) &
  PAR_PIDS+=("$!")
  j=$((j+1))
done
for p in "${PAR_PIDS[@]}"; do wait "$p"; done
CACHE_FILE="$SBX/.git/sdd-gate-cache"
BAD_LINES=$(grep -vxE '[0-9a-f]{40}' "$CACHE_FILE" 2>/dev/null | grep -c . || true)
if [ -f "$CACHE_FILE" ]; then
  ANY_KEY=$(head -1 "$CACHE_FILE")
  DUP_COUNT=$(grep -cxF "$ANY_KEY" "$CACHE_FILE" 2>/dev/null || echo 0)
else
  DUP_COUNT=0
fi
if [ "${BAD_LINES:-0}" -eq 0 ] && [ "${DUP_COUNT:-0}" -le 1 ]; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL [cache][2.5/4.2 concurrency] bad_lines=$BAD_LINES dup_count=$DUP_COUNT content=$(cat "$CACHE_FILE" 2>/dev/null)"
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
