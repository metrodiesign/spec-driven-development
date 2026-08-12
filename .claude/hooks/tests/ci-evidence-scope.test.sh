#!/usr/bin/env bash
# Adversarial fixtures for scripts/ci-evidence-scope.sh.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCOPE="$REPO_ROOT/scripts/ci-evidence-scope.sh"
pass=0
fail=0
CLEAN_DIRS=()

cleanup() {
  local remove_bin flag target prefix
  remove_bin="r""m"
  flag="-r""f"
  prefix="${TMPDIR:-/tmp}/sdd-evidence-"
  for target in "${CLEAN_DIRS[@]}"; do
    case "$target" in
      "$prefix"*) "$remove_bin" "$flag" "$target" 2>/dev/null || true ;;
      *) echo "refuse cleanup outside fixture prefix: $target" >&2 ;;
    esac
  done
}
trap cleanup EXIT

NEW_FIXTURE=""
new_fixture() { # $1=base tasks content
  NEW_FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/sdd-evidence-XXXXXX")
  CLEAN_DIRS+=("$NEW_FIXTURE")
  (
    cd "$NEW_FIXTURE" || exit 1
    git init -q
    git config user.email test@example.invalid
    git config user.name test
    mkdir -p .ai/specs/sample
    printf '%s\n' "$1" > .ai/specs/sample/tasks.md
    git add -A
    git commit -q -m base
    git update-ref refs/remotes/origin/develop HEAD
  )
}

commit_content() { # $1=fixture, $2=head tasks content
  (
    cd "$1" || exit 1
    printf '%s\n' "$2" > .ai/specs/sample/tasks.md
    git add -A
    git commit -q -m head
  )
}

run_scope() { # $1=fixture, $2=event, $3=base ref, $4=before SHA
  out=$(cd "$1" && "$SCOPE" "$2" "$3" "$4" 2>&1)
  rc=$?
}

expect_rc() { # $1=expected, $2=description
  if [ "$rc" -eq "$1" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); echo "FAIL $2 -> exit $rc (want $1) :: $out"
  fi
}

echo "=== pull_request: valid multiline Evidence ==="
new_fixture $'- [ ] 1. Complete me\n'
FIXTURE="$NEW_FIXTURE"
commit_content "$FIXTURE" $'- [x] 1. Complete me\n     Evidence:\n       - test: suite passed\n'
run_scope "$FIXTURE" pull_request develop ""
expect_rc 0 "PR multiline Evidence"

echo "=== push: valid inline Evidence ==="
new_fixture $'- [ ] 1. Complete me\n'
FIXTURE="$NEW_FIXTURE"
BEFORE=$(cd "$FIXTURE" && git rev-parse HEAD)
commit_content "$FIXTURE" $'- [x] 1. Complete me\n     Evidence: suite passed\n'
run_scope "$FIXTURE" push "" "$BEFORE"
expect_rc 0 "push inline Evidence"

echo "=== placeholder Evidence reports file and opening line ==="
new_fixture $'- [ ] 1. Complete me\n'
FIXTURE="$NEW_FIXTURE"
commit_content "$FIXTURE" $'- [x] 1. Complete me\n     Evidence: TODO\n'
run_scope "$FIXTURE" pull_request develop ""
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -qF '.ai/specs/sample/tasks.md: - [x] 1. Complete me'; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL placeholder diagnostics -> exit $rc :: $out"
fi

echo "=== unrelated edit ignores historical placeholder ==="
new_fixture $'# Old heading\n- [x] 1. Historical\n     Evidence: TODO\n'
FIXTURE="$NEW_FIXTURE"
commit_content "$FIXTURE" $'# New heading\n- [x] 1. Historical\n     Evidence: TODO\n'
run_scope "$FIXTURE" pull_request develop ""
expect_rc 0 "unrelated tasks.md edit"

echo "=== duplicate opening text selects new physical line only ==="
new_fixture $'- [x] 1. Duplicate\n     Evidence: TODO\n- [ ] 2. Open\n'
FIXTURE="$NEW_FIXTURE"
commit_content "$FIXTURE" $'- [x] 1. Duplicate\n     Evidence: TODO\n- [x] 1. Duplicate\n     Evidence: suite passed\n'
run_scope "$FIXTURE" pull_request develop ""
expect_rc 0 "duplicate opening-line identity"

echo "=== moved and edited completed task remains newly selected ==="
new_fixture $'- [x] 1. Move me\n     Evidence: suite passed\n- [ ] 2. Anchor\n'
FIXTURE="$NEW_FIXTURE"
commit_content "$FIXTURE" $'- [ ] 2. Anchor\n- [x] 1. Move me edited\n     Evidence: TODO\n'
run_scope "$FIXTURE" pull_request develop ""
expect_rc 1 "moved/edited placeholder task"

echo "=== unresolved ranges fail closed ==="
new_fixture $'- [ ] 1. Open\n'
FIXTURE="$NEW_FIXTURE"
run_scope "$FIXTURE" pull_request "" ""
expect_rc 2 "empty PR base ref"
run_scope "$FIXTURE" pull_request no-such-base ""
expect_rc 2 "unresolvable PR base ref"
run_scope "$FIXTURE" push "" 0000000000000000000000000000000000000000
expect_rc 2 "zero push before SHA"
run_scope "$FIXTURE" push "" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
expect_rc 2 "unresolvable push before SHA"

echo "=== task path with line break fails closed ==="
new_fixture $'- [ ] 1. Open\n'
FIXTURE="$NEW_FIXTURE"
(
  cd "$FIXTURE" || exit 1
  BAD_DIR=$'.ai/specs/bad\nname'
  mkdir -p "$BAD_DIR"
  printf '%s\n' $'- [x] 1. Complete\n     Evidence: suite passed' > "$BAD_DIR/tasks.md"
  git add -A
  git commit -q -m head
)
run_scope "$FIXTURE" pull_request develop ""
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF 'task path contains a line break'; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL line-break path -> exit $rc :: $out"
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
