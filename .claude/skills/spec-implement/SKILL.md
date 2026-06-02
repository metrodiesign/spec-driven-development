---
name: spec-implement
description: Implement one or more cohesive tasks from the active spec's tasks.md, end-to-end with tests, following project conventions.
argument-hint: <task id, range like 1-3, or "all">
---

# Implement task(s): $ARGUMENTS

Resolve $ARGUMENTS to the target task(s): a single id (e.g. 2), a range (1-3), or
all incomplete tasks. For multiple tasks, work in dependency order.

For EACH task:

1. Read the task plus its linked REQ IDs in requirements.md and the relevant parts
   of design.md and @.claude/rules/structure.md.
2. Plan the task with your own internal TODO list, then implement the WHOLE task in
   one cohesive pass. It may span many files — that is expected; keep the entire
   task in context rather than splitting it across turns.
3. Write or extend tests proving it satisfies its REQ IDs.
4. Mark the task "- [x]" in tasks.md and state which REQ IDs are now satisfied.
5. Give me the exact command to verify (test / build / run).

Pause for my confirmation at each TASK boundary (not after every file). When I
asked for a range or "all", continue to the next task after reporting, stopping
early only if a test fails or a requirement turns out to be infeasible.

For unattended / CI runs, do NOT run "all" in one session (context grows per task
and a session cannot /clear itself). Instead drive one cohesive task per fresh
session — implement, then `/spec-retro`, then clear — via `scripts/pane-loop.sh`.
