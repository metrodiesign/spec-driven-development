#!/usr/bin/env bash
# gate-task.sh — harness-agnostic task-boundary quality gate (.ai/bin engine)
# Ported from .claude/hooks/task-gate.sh. The code-green check is STACK-AGNOSTIC: a project
# declares its typecheck/test commands via $SDD_TYPECHECK_CMD / $SDD_TEST_CMD, and a Node
# project that ships package.json scripts is auto-detected for backward-compat; when neither
# is present the check is skipped and only the Evidence gate applies. The Evidence check is
# PER TASK (scoped to each flipped [x] region) and requires non-trivial content, so every
# adapter input shape yields the same verdict (PR #24 findings #6/#19/#20/#28).
#
# Fires only when a .ai/specs/*/tasks.md (or legacy .claude/specs/*/) checkbox is being flipped to [x].
# เขียว = เงียบ exit 0, แดง = exit 2 + stderr ให้แก้ก่อน mark เสร็จ
#
# CACHE (tree-hash skip): the code-green rerun is skipped when the working tree (minus
# spec artifacts) + gate config + toolchain are byte-identical to a previously-green run
# (per-clone, untracked cache at $(git rev-parse --git-dir)/sdd-gate-cache). The Evidence
# stage below NEVER skips. SDD_GATE_NO_CACHE=1 forces a real run. POST-WRITE CONTRACT: the
# cache assumes this engine is invoked AFTER the edit has reached disk — a pre-write
# adapter must export SDD_GATE_NO_CACHE=1 or it will fingerprint the pre-edit tree.
#
# Interface (harness-agnostic):
#   $1 / $GATE_FILE      = tasks.md file path being edited
#   $2 / $GATE_NEW       = the new_string / content the edit introduces (the flip text).
#                          May be a scoped flipped hunk (Claude/Codex) OR the whole
#                          post-edit file (OpenCode) — the engine scopes Evidence PER
#                          TASK so the verdict is IDENTICAL across those input shapes.
# The caller's adapter is responsible for extracting these from its own hook payload.
# When $GATE_NEW carries a "- [x]" line it is treated as a flip; a NON-TRIVIAL Evidence:
# block is then required INSIDE THE REGION of EACH flipped [x] task (not just somewhere
# in the input). A pre-existing Evidence line belonging to a different task therefore
# cannot satisfy the gate for a task that has none of its own.

BIN="$(cd "$(dirname "$0")" && pwd)"
LIBGUARD="$BIN/lib-guard.sh"
[ -r "$LIBGUARD" ] || { echo "Task gate: missing guard fragment $LIBGUARD — ห้าม mark [x] จนกว่า guard พร้อม" >&2; exit 2; }
# shellcheck source=lib-guard.sh
. "$LIBGUARD"

FILE="${1:-${GATE_FILE:-}}"
NEW="${2:-${GATE_NEW:-}}"

is_spec_tasks_path "$FILE" || exit 0

# trigger only on a flip to [x] in the new content
printf '%s\n' "$NEW" | grep -qE -- "$CB_DONE" || exit 0

# --- code-green check (STACK-AGNOSTIC, optional) ---
# The framework does not assume Node/npm. A project declares how its code is proven green:
#   $SDD_TYPECHECK_CMD / $SDD_TEST_CMD  — explicit commands for ANY stack (e.g. "pytest -q").
# Backward-compat: a Node project that ships package.json with "typecheck"/"test" scripts is
# auto-detected so it keeps the original npm behavior with no config. When neither a command
# nor a matching package.json script exists, the check is skipped and only the Evidence gate
# (below) applies. Commands are operator-provided config, run via eval to honor their quoting.
TYPECHECK_CMD="${SDD_TYPECHECK_CMD:-}"
TEST_CMD="${SDD_TEST_CMD:-}"
if [ -z "$TYPECHECK_CMD" ] && [ -f package.json ] && grep -q '"typecheck"' package.json; then
  TYPECHECK_CMD='npm run typecheck --silent'
fi
if [ -z "$TEST_CMD" ] && [ -f package.json ] && grep -q '"test"' package.json; then
  TEST_CMD='npm test --silent'
fi

# --- cache stage (tree-hash skip, REQ-1..4) — placed AFTER auto-detect so KEY hashes
# the RESOLVED commands. Single-exit control flow: this stage can only ever set
# SKIP_SUITE; nothing here exits, so the Evidence stage always runs (REQ-3.4).
compute_key() {  # echoes KEY, or nothing on any failure (caller treats empty = cache disabled)
  [ -f .gitmodules ] && return 0                      # REQ-1.6: dirty submodule invisible to tree hash
  local tmpidx tree salt
  tmpidx=$(mktemp) || return 0
  cp "$(git rev-parse --git-path index)" "$tmpidx" 2>/dev/null || true
  tree=$(GIT_INDEX_FILE="$tmpidx" git add -A 2>/dev/null \
      && GIT_INDEX_FILE="$tmpidx" git rm -r --cached -q --ignore-unmatch \
           .ai/specs .claude/specs 2>/dev/null \
      && GIT_INDEX_FILE="$tmpidx" git write-tree 2>/dev/null) || { rm -f "$tmpidx"; return 0; }
  rm -f "$tmpidx"
  salt=""
  [ -n "${SDD_GATE_TOOLCHAIN_CMD:-}" ] && salt=$(eval "$SDD_GATE_TOOLCHAIN_CMD" 2>/dev/null)
  if [ -f package.json ]; then
    salt="$salt|$(node --version 2>/dev/null)|$(pnpm --version 2>/dev/null)"
  fi
  printf '%s\n%s\n%s\n%s\n' "$tree" "$TYPECHECK_CMD" "$TEST_CMD" "$salt" \
    | git hash-object --stdin 2>/dev/null
}
KEY=$( [ "${SDD_GATE_NO_CACHE:-0}" = 1 ] || compute_key )

CACHE="$(git rev-parse --git-dir 2>/dev/null)/sdd-gate-cache"
SKIP_SUITE=0
if [ -n "$KEY" ] && [ -r "$CACHE" ]; then
  if grep -a -xE '[0-9a-f]{40}' "$CACHE" 2>/dev/null | grep -qxF "$KEY"; then
    SKIP_SUITE=1
    echo "gate cache hit: tree $KEY previously green — skipping typecheck/test (SDD_GATE_NO_CACHE=1 to force)" >&2
  fi
fi

if [ "$SKIP_SUITE" != 1 ]; then
  if [ -n "$TYPECHECK_CMD" ]; then
    OUT=$(eval "$TYPECHECK_CMD" 2>&1) || {
      echo 'Task gate: typecheck ไม่ผ่าน — ห้าม mark [x] จนกว่าเขียว' >&2
      echo "$OUT" | tail -20 >&2
      exit 2
    }
  fi
  if [ -n "$TEST_CMD" ]; then
    OUT=$(eval "$TEST_CMD" 2>&1) || {
      # a runner that exits non-zero ONLY because it found no tests is not a red test —
      # don't block a task that legitimately has none (vitest / pytest phrasings).
      if ! echo "$OUT" | grep -qiE 'no test files found|no tests ran|collected 0 items'; then
        echo 'Task gate: test ไม่ผ่าน — ห้าม mark [x] จนกว่าเขียว' >&2
        echo "$OUT" | tail -20 >&2
        exit 2
      fi
    }
  fi

  # cache append — ONLY on a fully green run just proven above (REQ-2.1/2.2). Dedup
  # existing occurrence before the tail-7 cap so a re-appended key refreshes its
  # position instead of shrinking effective capacity (REQ-4.2, ARC-16). Atomic
  # temp+rename write survives concurrent gate invocations (REQ-2.5). A failure here
  # is a warning only — the suite verdict is already earned; execution CONTINUES to
  # the Evidence stage, never exits (REQ-3.4, ARC-3).
  if [ -n "$KEY" ]; then
    tmp=$(mktemp "$(dirname "$CACHE")/sdd-gate-cache.XXXXXX") && {
      { grep -a -xE '[0-9a-f]{40}' "$CACHE" 2>/dev/null | grep -vxF "$KEY" | tail -7
        printf '%s\n' "$KEY"; } > "$tmp" && mv "$tmp" "$CACHE"
    } || echo "gate cache: append failed (non-fatal) — verdict unaffected" >&2
  fi
fi

# evidence gate (PER TASK, non-trivial content): code-green is checked first (above);
# only then require that EACH flipped `- [x]` task carries its own `Evidence:` line —
# scoped to that task's region — whose value is non-trivial (not empty / placeholder).
# Delegated to the shared engine (.ai/bin/check-evidence.sh --strict, REQ-1.2) so this
# policy cannot half-land relative to pre-commit's --added-only mode. The engine emits
# data only; this message stays here, verbatim, so its text is byte-identical pre/post
# refactor (REQ-4.4).
ENGINE="$BIN/check-evidence.sh"
[ -x "$ENGINE" ] || { echo "Task gate: missing/non-executable Evidence engine at $ENGINE" >&2; exit 2; }
if EV_FAIL=$("$ENGINE" --strict <<<"$NEW"); then
  : # pass
else
  rc=$?
  case $rc in
    1)
      echo 'Task gate: ขาด Evidence (per-task) — แต่ละ task ที่ mark [x] ต้องมี Evidence: ของตัวเอง (test result + viewports 375/768/1440 หรือ n/a + deviations) ในบล็อกของ task นั้น ก่อน mark [x]' >&2
      echo "$EV_FAIL" | head -5 >&2
      ;;
    *)
      echo "Task gate: Evidence engine error (exit $rc) at $ENGINE" >&2
      ;;
  esac
  exit 2
fi
exit 0
