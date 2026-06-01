---
name: spec-bugfix
description: Run a root-cause-first bugfix spec. Use for bugs in critical paths, recurring regressions, or unclear root causes.
argument-hint: <bug description>
---

# Bugfix Spec

Bug: $ARGUMENTS

Phase 1 — Delegate root-cause analysis to the `bug-investigator` subagent.
  Present its findings to me and STOP. Wait for me to confirm the root cause.

Phase 2 (after I confirm) — Create `.claude/specs/bugfix-<short>/` with a fix spec
  that documents the fix AND captures unchanged behavior:
      WHEN <condition> THEN THE SYSTEM SHALL CONTINUE TO <existing behavior>

Phase 3 — Produce tasks plus regression/property tests that validate BOTH
  (a) the bug is fixed and (b) the "SHALL CONTINUE TO" behaviors still hold.
