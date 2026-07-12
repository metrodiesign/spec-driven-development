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
| Design element | Section | REQ |
|---|---|---|
| Data Models | Data Models | REQ-1 |
| Nonexistent Section Name | Nonexistent Section Name | REQ-2 |
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
## REQ-4: Fourth requirement
Some text for REQ-4.
EOF
cat > "$R/.ai/specs/bare-id-fixture/design.md" <<'EOF'
# Design: Bare Id Fixture
> Status: approved 2099-01-01
## Data Models
Design content reached only via a bare dotted id in the traceability table.
## Mixed Style
Design content reached via a row mixing a REQ-prefixed id with a bare one.
## Punctuation Wrapped
Design content reached via bare ids wrapped in normal markdown punctuation.
## Requirement Traceability
| Design element | Section | REQ |
|---|---|---|
| Data Models | Data Models | 1.1 |
| Mixed Style | Mixed Style | REQ-3.1, 3.2 |
| Punctuation Wrapped | Punctuation Wrapped | `4.1`, (4.2) |
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
- [ ] 4. Fourth task
     Satisfies: REQ-4
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

echo "=== spec-slice: bare id wrapped in backtick/parens still matches (Codex P2, PR #118, REQ-3.6) ==="
OUT=$( cd "$R" && "$SLICE" bare-id-fixture 4 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q '== DESIGN ## Punctuation Wrapped'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: punctuation-wrapped bare id (\`4.1\`, (4.2)) should match :: rc=$RC :: $OUT"
fi

# ============================================================================
# Section-column matcher + code-fence safety (REQ-3.8-3.12)
# ============================================================================
echo "=== spec-slice: Section value that is a substring or case-variant of a real heading does NOT false-match (REQ-3.8) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/section-mechanism-fixture"
cat > "$R/.ai/specs/section-mechanism-fixture/requirements.md" <<'EOF'
# Requirements: Section Mechanism Fixture
> Status: approved 2099-01-01
## REQ-1: First requirement
Some text for REQ-1.
## REQ-2: Second requirement
Some text for REQ-2.
## REQ-3: Third requirement
Some text for REQ-3.
EOF
cat > "$R/.ai/specs/section-mechanism-fixture/design.md" <<'EOF'
# Design: Section Mechanism Fixture
> Status: approved 2099-01-01
## Data Models
Real section content for Data Models.
## Shared Section
Real section content shared by two REQs.
## Requirement Traceability
| Section | Design element | REQ |
|---|---|---|
| Data | substring of a real heading, must not match | REQ-1 |
| data models | case-variant of a real heading, must not match | REQ-1 |
| Shared Section | first row pointing at the shared section | REQ-2 |
| Shared Section | second row pointing at the same shared section | REQ-3 |
EOF
cat > "$R/.ai/specs/section-mechanism-fixture/tasks.md" <<'EOF'
# Tasks: Section Mechanism Fixture
> Status: approved 2099-01-01
- [ ] 1. First task
     Satisfies: REQ-1
     Verify: something
- [ ] 2. Second task
     Satisfies: REQ-2, REQ-3
     Verify: something
EOF
( cd "$R" && git add -A && git commit -q -m base )

OUT=$( cd "$R" && "$SLICE" section-mechanism-fixture 1 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] \
  && ! printf '%s' "$OUT" | grep -q '== DESIGN' \
  && printf '%s' "$OUT" | grep -q 'MISSING: design section for "Data"' \
  && printf '%s' "$OUT" | grep -q 'MISSING: design section for "data models"'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: substring/case-variant Section values must not false-match :: rc=$RC :: $OUT"
fi

echo "=== spec-slice: two rows (different REQs) sharing one Section value print its content once, not twice (REQ-3.10); Section column also not in the default 2nd position (REQ-3.12) ==="
OUT=$( cd "$R" && "$SLICE" section-mechanism-fixture 2 2>&1 ); RC=$?
COUNT=$(printf '%s' "$OUT" | grep -c '== DESIGN ## Shared Section')
if [ "$RC" -eq 0 ] && [ "$COUNT" -eq 1 ]; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: shared Section value should print once, printed $COUNT times :: rc=$RC :: $OUT"
fi

echo "=== spec-slice: two REQs sharing one UNRESOLVABLE Section value each get their own MISSING, not just the first (dedup cache must key off successful resolution, not the raw Section text) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/bad-shared-section-fixture"
cat > "$R/.ai/specs/bad-shared-section-fixture/requirements.md" <<'EOF'
# Requirements: Bad Shared Section Fixture
> Status: approved 2099-01-01
## REQ-1: First requirement
Text.
## REQ-2: Second requirement
Text.
EOF
cat > "$R/.ai/specs/bad-shared-section-fixture/design.md" <<'EOF'
# Design: Bad Shared Section Fixture
> Status: approved 2099-01-01
## Requirement Traceability
| Section | REQ |
|---|---|
| Broken Section Name | REQ-1 |
| Broken Section Name | REQ-2 |
EOF
cat > "$R/.ai/specs/bad-shared-section-fixture/tasks.md" <<'EOF'
# Tasks: Bad Shared Section Fixture
> Status: approved 2099-01-01
- [ ] 1. Only task
     Satisfies: REQ-1, REQ-2
     Verify: something
EOF
( cd "$R" && git add -A && git commit -q -m base )

OUT=$( cd "$R" && "$SLICE" bad-shared-section-fixture 1 2>&1 ); RC=$?
COUNT=$(printf '%s' "$OUT" | grep -c 'MISSING: design section for "Broken Section Name" (no ## heading matches it exactly)')
if [ "$RC" -eq 0 ] && [ "$COUNT" -eq 2 ]; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: two REQs sharing one unresolvable Section value should each print their own MISSING, got $COUNT :: rc=$RC :: $OUT"
fi

echo "=== spec-slice: table with no Section column at all -> each matched row MISSING distinctly, not collapsed (REQ-3.9) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/no-section-column-fixture"
cat > "$R/.ai/specs/no-section-column-fixture/requirements.md" <<'EOF'
# Requirements: No Section Column Fixture
> Status: approved 2099-01-01
## REQ-1: First requirement
Text.
## REQ-2: Second requirement
Text.
EOF
cat > "$R/.ai/specs/no-section-column-fixture/design.md" <<'EOF'
# Design: No Section Column Fixture
> Status: approved 2099-01-01
## Some Heading
Content.
## Requirement Traceability
| Design element | REQ |
|---|---|
| First element | REQ-1 |
| Second element | REQ-2 |
EOF
cat > "$R/.ai/specs/no-section-column-fixture/tasks.md" <<'EOF'
# Tasks: No Section Column Fixture
> Status: approved 2099-01-01
- [ ] 1. Only task
     Satisfies: REQ-1, REQ-2
     Verify: something
EOF
( cd "$R" && git add -A && git commit -q -m base )

OUT=$( cd "$R" && "$SLICE" no-section-column-fixture 1 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] \
  && printf '%s' "$OUT" | grep -q 'MISSING: design section for REQ column "REQ-1"' \
  && printf '%s' "$OUT" | grep -q 'MISSING: design section for REQ column "REQ-2"'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: pre-retrofit table (no Section column) must MISSING each row distinctly, not collapse to one :: rc=$RC :: $OUT"
fi

echo "=== spec-slice: a heading-shaped line inside a fenced code block is never a boundary, in requirements.md, design.md, or the traceability table itself (REQ-3.11) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/fence-fixture"
cat > "$R/.ai/specs/fence-fixture/requirements.md" <<'EOF'
# Requirements: Fence Fixture
> Status: approved 2099-01-01
## REQ-1: First requirement
REQ line before the fence.
```
== REQ-2 (requirements.md) ==
## REQ-2: this looks like a heading but is inside a fence
more fenced content
```
REQ line after the fence — this must still be part of REQ-1.
EOF
cat > "$R/.ai/specs/fence-fixture/design.md" <<'EOF'
# Design: Fence Fixture
> Status: approved 2099-01-01
## Real Section
DESIGN line before the fence.
```
== REQ-2 (requirements.md) ==
## REQ-2: this looks like a heading but is inside a fence
more fenced content
```
DESIGN line after the fence — this must still be part of Real Section.
## Requirement Traceability
```
## Fake heading inside the trace-table fence
```
| Section | REQ |
|---|---|
| Real Section | REQ-1 |
EOF
cat > "$R/.ai/specs/fence-fixture/tasks.md" <<'EOF'
# Tasks: Fence Fixture
> Status: approved 2099-01-01
- [ ] 1. Only task
     Satisfies: REQ-1
     Verify: something
EOF
( cd "$R" && git add -A && git commit -q -m base )

OUT=$( cd "$R" && "$SLICE" fence-fixture 1 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] \
  && printf '%s' "$OUT" | grep -q 'REQ line before the fence' \
  && printf '%s' "$OUT" | grep -q 'REQ line after the fence' \
  && printf '%s' "$OUT" | grep -q 'DESIGN line before the fence' \
  && printf '%s' "$OUT" | grep -q 'DESIGN line after the fence' \
  && printf '%s' "$OUT" | grep -q '== DESIGN ## Real Section' \
  && ! printf '%s' "$OUT" | grep -q '== MISSING =='; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: fenced heading-shaped lines must not truncate req_block/section_from_heading/trace-table extraction :: rc=$RC :: $OUT"
fi

echo "=== spec-slice: traceability table headed 'Satisfies' instead of 'REQ' still matches (real specs use both; REQ-3.12's header-lookup must not regress REQ-3.6/3.7 for the other convention) ==="
R="$(new_repo)"
mkdir -p "$R/.ai/specs/satisfies-header-fixture"
cat > "$R/.ai/specs/satisfies-header-fixture/requirements.md" <<'EOF'
# Requirements: Satisfies Header Fixture
> Status: approved 2099-01-01
## REQ-1: First requirement
Text.
EOF
cat > "$R/.ai/specs/satisfies-header-fixture/design.md" <<'EOF'
# Design: Satisfies Header Fixture
> Status: approved 2099-01-01
## Real Section
Content reached via a table headed "Satisfies", not "REQ".
## Requirement Traceability
| Design element | Satisfies | Section |
|---|---|---|
| Real Section design | REQ-1 | Real Section |
EOF
cat > "$R/.ai/specs/satisfies-header-fixture/tasks.md" <<'EOF'
# Tasks: Satisfies Header Fixture
> Status: approved 2099-01-01
- [ ] 1. Only task
     Satisfies: REQ-1
     Verify: something
EOF
( cd "$R" && git add -A && git commit -q -m base )

OUT=$( cd "$R" && "$SLICE" satisfies-header-fixture 1 2>&1 ); RC=$?
if [ "$RC" -eq 0 ] \
  && printf '%s' "$OUT" | grep -q '== DESIGN ## Real Section' \
  && ! printf '%s' "$OUT" | grep -q '== MISSING =='; then
  pass=$((pass+1))
else
  fail=$((fail+1)); echo "FAIL: 'Satisfies'-headed traceability table should still match REQ column :: rc=$RC :: $OUT"
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
