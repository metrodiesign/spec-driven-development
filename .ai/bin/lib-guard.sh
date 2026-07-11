#!/usr/bin/env bash
# lib-guard.sh — shared regex/matcher fragments sourced by the bash guards (REQ-2, REQ-3).
# Pure definitions only, no side effects, POSIX-compatible (pre-commit runs outside any
# harness). Single source: edit here, every sourcing guard gets the change at once.
#
# Python consumers (scripts/cost_lib.py, scripts/spec_trace.py) intentionally keep their
# OWN checkbox-pattern dialects — this file unifies the THREE BASH surfaces only
# (gate-task.sh, pre-commit, check-destructive.sh/check-bypass.sh); see the pointer
# comments in those python files (REQ-3.2, ARC-F12).

# GO — git global options that can appear between `git` and its subcommand (e.g.
# `git -C . push`, `git -c user.name=x push --force`, `git --no-pager push`); without
# this, an anchor like `git[[:space:]]+push` fails to match and a bypass guard misses the
# command. Covers `-C/-c <arg>` both space-separated and attached (`-cuser.x=y`, `-C.` —
# git accepts both, hence `[[:space:]]*` not `+`), long options that consume a separate
# value token (`--git-dir .git`, `--work-tree .` — must consume the value or it is left
# dangling and the subcommand anchor misses), generic `--flag[=val]`, and the no-arg short
# pager flag `-p`/`-P`. The value-taking long-opt alternative sits before the generic `--`
# so it matches the space-separated form first; the first value token may not itself start
# with a dash (so a flag-looking token cannot be swallowed as a value and hide the
# subcommand). Consumed by both check-destructive.sh and check-bypass.sh (REQ-2.1).
GO='([[:space:]]+(-[cC][[:space:]]*[^[:space:];&|]+|--(git-dir|work-tree|namespace|super-prefix|exec-path|config-env|attr-source|object-format)[[:space:]]+[^[:space:];&|-][^[:space:];&|]*|--[^[:space:];&|]+|-[pP]))*'

# is_spec_tasks_path FILE — true if FILE is a canonical (.ai/specs/*/tasks.md) or legacy
# (.claude/specs/*/tasks.md) spec tasks file, matched either bare or with a leading path
# prefix. Consumed by gate-task.sh (REQ-3.1). NOT sourced by pre-commit's own tasks.md
# file-selection filter (`grep -E '(^|/)tasks\.md$'`), which is deliberately BROADER (any
# staged file literally named tasks.md, not only the spec-shaped path) — narrowing it to
# this matcher would silently shrink which files get Evidence-checked, a gate loosening
# REQ-4 exists to prevent. task-gate.sh (thin PreToolUse adapter) also stays a standalone
# 4-line case statement rather than sourcing this (ARC-F8) — a pointer comment there links
# back here instead.
is_spec_tasks_path() {
  case "$1" in
    */.ai/specs/*/tasks.md|.ai/specs/*/tasks.md|*/.claude/specs/*/tasks.md|.claude/specs/*/tasks.md) return 0 ;;
    *) return 1 ;;
  esac
}

# CB_* — checkbox line matchers (REQ-3.1): CB_DONE = an `- [x]`/`- [X]` line opens a
# completed-task region; CB_TODO = an `- [ ]` line opens/closes an open one; CB_ANY = either.
# The `[[:space:]]` boundary between the dash and the bracket is STRICTER than pre-commit's
# OLD literal-space matcher — on a tab-indented checkbox line the unified engine now closes
# a block where the old bash loop would not have. This is the one documented, accepted
# behavioral hardening from unification (ARC-F2): no artifact in this repo is tab-form, and
# maintaining two boundary dialects to preserve a bug-shaped leniency would defeat the dedup.
CB_DONE='^[[:space:]]*-[[:space:]]\[[xX]\]'
CB_TODO='^[[:space:]]*-[[:space:]]\[[[:space:]]\]'
CB_ANY='^[[:space:]]*-[[:space:]]\[[[:space:]xX]\]'
