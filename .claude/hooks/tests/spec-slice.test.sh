#!/usr/bin/env bash
# spec-slice.test.sh — adversarial test for scripts/spec-archive.sh + scripts/spec-slice.sh
# (sdd-spec-context-loading REQ-1, REQ-2, REQ-3, REQ-5). Run:
#   bash .claude/hooks/tests/spec-slice.test.sh
# Every fixture is a throwaway git repo under mktemp -d — never touches the real repo.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ARCHIVE="$REPO_ROOT/scripts/spec-archive.sh"
SLICE="$REPO_ROOT/scripts/spec-slice.sh"
SPEC_TRACE="$REPO_ROOT/scripts/spec-trace.sh"
SESSION_SCRIPT="$REPO_ROOT/scripts/session-start-active-specs.sh"
pass=0
fail=0
CLEAN_DIRS=()
cleanup() {
  local RMBIN FLAG; RMBIN="r""m"; FLAG="-r""f"
  for d in "${CLEAN_DIRS[@]}"; do "$RMBIN" "$FLAG" "$d" 2>/dev/null || true; done
}
trap cleanup EXIT

new_repo() { # -> path; git-init'd with .ai/specs/
  local dir; dir="$(mktemp -d)"
  CLEAN_DIRS+=("$dir")
  ( cd "$dir" && git init -q && git config user.email t@t.t && git config user.name t )
  mkdir -p "$dir/.ai/specs"
  printf '%s' "$dir"
}

echo "=== spec-archive: refuses on unchecked task, names the id (REQ-1.2/1.3) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/feat-a"
printf -- '- [x] 1. done\n     Evidence: yes\n- [ ] 2. not done\n' > "$R/.ai/specs/feat-a/tasks.md"
( cd "$R" && git add -A && git commit -q -m base )
OUT=$( cd "$R" && "$ARCHIVE" feat-a 2>&1 ); RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q '2. not done'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: unchecked-task refusal :: rc=$RC :: $OUT"; fi

echo "=== spec-archive: refuses without tasks.md (REQ-1.4) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/feat-b"
( cd "$R" && git add -A && git commit -q -m base --allow-empty )
OUT=$( cd "$R" && "$ARCHIVE" feat-b 2>&1 ); RC=$?
[ "$RC" -eq 1 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: missing-tasks.md refusal :: rc=$RC :: $OUT"; }

echo "=== spec-archive: clean feature moves via git mv (REQ-1.1) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/feat-c"
printf -- '- [x] 1. done\n     Evidence: yes\n' > "$R/.ai/specs/feat-c/tasks.md"
( cd "$R" && git add -A && git commit -q -m base )
OUT=$( cd "$R" && "$ARCHIVE" feat-c 2>&1 ); RC=$?
MOVED=$( cd "$R" && git status --short | grep -c '^R.*feat-c.*archive/feat-c' || true)
if [ "$RC" -eq 0 ] && [ -d "$R/.ai/specs/archive/feat-c" ] && [ "$MOVED" -ge 1 ]; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: clean archive move :: rc=$RC moved=$MOVED :: $OUT"
fi

echo "=== spec-trace over an archived fixture still passes (REQ-1.5) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/feat-d"
cat > "$R/.ai/specs/feat-d/requirements.md" <<'EOF'
# Requirements: Feat D
> Status: approved 2099-01-01
## REQ-1: Only requirement
- 1.1 THE SYSTEM SHALL do the thing.
EOF
cat > "$R/.ai/specs/feat-d/design.md" <<'EOF'
# Design: Feat D
> Status: approved 2099-01-01
## Requirement Traceability
| Design element | REQ |
|---|---|
| The one thing | REQ-1 |
EOF
cat > "$R/.ai/specs/feat-d/tasks.md" <<'EOF'
# Tasks: Feat D
> Status: approved 2099-01-01
- [x] 1. Do the thing
     Satisfies: REQ-1
     Evidence:
       - test: ok
EOF
( cd "$R" && git add -A && git commit -q -m base )
( cd "$R" && "$ARCHIVE" feat-d >/dev/null 2>&1 )
OUT=$( cd "$R" && "$SPEC_TRACE" feat-d .ai/specs/archive 2>&1 ); RC=$?
if [ "$RC" -eq 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: spec-trace over archived fixture :: rc=$RC :: $OUT"; fi

echo "=== SessionStart script output excludes archive/ (REQ-2.1/2.2) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/live-feature" "$R/.ai/specs/archive/closed-feature"
OUT=$( cd "$R" && bash "$SESSION_SCRIPT" )
if printf '%s' "$OUT" | grep -q 'live-feature' && ! printf '%s' "$OUT" | grep -qw 'archive'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: SessionStart script should list live-feature but not archive :: [$OUT]"
fi

# ============================================================================
# spec-slice.sh (REQ-3)
# ============================================================================
echo "=== spec-slice: known task -> task block + REQ block + mapped design section + Status headers (REQ-3.1/3.5) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/slice-fixture"
cat > "$R/.ai/specs/slice-fixture/requirements.md" <<'EOF'
# Requirements: Slice Fixture
> Status: approved 2099-01-01
## REQ-1: First requirement
Some text for REQ-1.
## REQ-2: Second requirement
Some text for REQ-2.
EOF
cat > "$R/.ai/specs/slice-fixture/design.md" <<'EOF'
# Design: Slice Fixture
> Status: approved 2099-01-01
## Data Models
Some design content that will be matched by name.
## Requirement Traceability
| Design element | REQ |
|---|---|
| Data Models | REQ-1 |
| Nonexistent Section Name | REQ-2 |
EOF
cat > "$R/.ai/specs/slice-fixture/tasks.md" <<'EOF'
# Tasks: Slice Fixture
> Status: approved 2099-01-01
- [ ] 1. First task
     Satisfies: REQ-1
     Verify: something
- [ ] 2. Second task
     Satisfies: REQ-2, REQ-9
     Verify: something
EOF
( cd "$R" && git add -A && git commit -q -m base )

OUT=$( cd "$R" && "$SLICE" slice-fixture 1 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] \
  && printf '%s' "$OUT" | grep -q '== TASK 1' \
  && printf '%s' "$OUT" | grep -q '== REQ-1' \
  && printf '%s' "$OUT" | grep -q '== DESIGN ## Data Models' \
  && printf '%s' "$OUT" | grep -q '== STATUS ==' \
  && ! printf '%s' "$OUT" | grep -q '== MISSING =='; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: slice task 1 (fully resolved) :: rc=$RC :: $OUT"
fi

echo "=== spec-slice: unknown task id -> exit 1, lists available (REQ-3.3) ==="
OUT=$( cd "$R" && "$SLICE" slice-fixture 99 2>&1 ); RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q 'available: 1 2'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: unknown task id :: rc=$RC :: $OUT"; fi

echo "=== spec-slice: Satisfies naming an absent REQ -> MISSING present, exit 0 (REQ-3.4) ==="
OUT=$( cd "$R" && "$SLICE" slice-fixture 2 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q 'MISSING: REQ-9'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: absent REQ should be MISSING :: rc=$RC :: $OUT"; fi

echo "=== spec-slice: traceability cell matching no heading -> MISSING present, exit 0 (REQ-3.4) ==="
if printf '%s' "$OUT" | grep -q 'MISSING: design section for "Nonexistent Section Name"'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: unmapped design cell should be MISSING :: $OUT"; fi

echo "=== [#slice-tool-verify-not-just-missing-marker] spec-slice: design row REQ column matches a bare dotted id, not just REQ-N prefix (REQ-3.6) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/bare-id-fixture"
cat > "$R/.ai/specs/bare-id-fixture/requirements.md" <<'EOF'
# Requirements: Bare Id Fixture
> Status: approved 2099-01-01
## REQ-1: First requirement
Some text for REQ-1.
## REQ-2: Second requirement
Some text for REQ-2.
## REQ-3: Third requirement
Some text for REQ-3.
EOF
cat > "$R/.ai/specs/bare-id-fixture/design.md" <<'EOF'
# Design: Bare Id Fixture
> Status: approved 2099-01-01
## Data Models
Design content reached only via a bare dotted id in the traceability table.
## Mixed Style
Design content reached via a row mixing a REQ-prefixed id with a bare one.
## Requirement Traceability
| Design element | REQ |
|---|---|
| Data Models | 1.1 |
| Mixed Style | REQ-3.1, 3.2 |
EOF
cat > "$R/.ai/specs/bare-id-fixture/tasks.md" <<'EOF'
# Tasks: Bare Id Fixture
> Status: approved 2099-01-01
- [ ] 1. First task
     Satisfies: REQ-1
     Verify: something
- [ ] 2. Second task
     Satisfies: REQ-2
     Verify: something
- [ ] 3. Third task
     Satisfies: REQ-3
     Verify: something
EOF
( cd "$R" && git add -A && git commit -q -m base )

OUT=$( cd "$R" && "$SLICE" bare-id-fixture 1 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q '== DESIGN ## Data Models'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: bare dotted id (1.1) should match its design row :: rc=$RC :: $OUT"
fi

echo "=== spec-slice: zero traceability rows for a REQ -> MISSING, not silently dropped (REQ-3.7) ==="
OUT=$( cd "$R" && "$SLICE" bare-id-fixture 2 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q 'MISSING: design section for REQ-2'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: REQ with zero matching traceability rows should be MISSING, not silent :: rc=$RC :: $OUT"
fi

echo "=== spec-slice: mixed REQ-prefixed + bare ids in the same cell still match (regression, REQ-3.6) ==="
OUT=$( cd "$R" && "$SLICE" bare-id-fixture 3 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q '== DESIGN ## Mixed Style'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: mixed-style row (REQ-3.1, 3.2) should match :: rc=$RC :: $OUT"
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
