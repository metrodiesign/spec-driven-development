---
name: spec-tasks
description: Generate the tasks.md implementation checklist from the approved design. Use after design is approved.
---

# Generate tasks.md

Read the active spec's design.md and requirements.md, then write
`.claude/specs/<feature>/tasks.md`. Size tasks for a large-context, high-effort
model: each task is a COHESIVE, INDEPENDENTLY VERIFIABLE slice that you can
implement end-to-end in one pass, even if it spans many files.

# Implementation Tasks: <Feature Name>

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. <Cohesive capability> — <one line: scope + what "done" means>
     Satisfies: REQ-1 (all criteria). Verify: <test / command>.
- [ ] 2. <Cohesive capability> — <scope + done>
     Satisfies: REQ-2. Depends on: 1. Verify: <test / command>.
- [ ] 3. <Cohesive capability> [optional] — <scope + done>
     Satisfies: REQ-3. Batch: B1.
- [ ] 4. <Cohesive capability> — <scope + done>
     Satisfies: REQ-4. Batch: B1.

## Suggested execution batches

> Optional. Tasks sharing a `Batch:` tag are small, same-type, and share context
> → run them in ONE session so the cold cache-write of the prompt prefix is paid
> once, not per task. Feed to the orchestrator with `+`:
> scripts/pane-loop.sh <feature> 3+4 # B1
> Tasks with no `Batch:` tag run one-per-session (fresh context = more accurate).

Rules:

- Aim for the FEWEST tasks that keep each one independently verifiable. A typical
  feature is ~5-10 tasks, not 20-30. If a "task" can't be verified on its own,
  fold it into the task it serves.
- Each task is ONE coherent behavior / vertical slice (e.g. "user registration
  end-to-end: model → endpoint → validation → tests"), never a horizontal layer
  ("create the model", "create the repository") that does nothing alone.
- Map each task to a whole REQ or a tightly-related group; list the REQ IDs.
- Do NOT write 1.1/1.2 sub-tasks — the implementing model handles micro-sequencing
  internally with its own TODO list.
- Order coarsely: shared/foundational tasks first. Note a dependency only when real.
- Mark [optional] for non-essential tasks.
- Tag `Batch: <id>` ONLY on tasks that are ALL of: small, the same type (e.g. several
  data-only files, several static sections, a cluster of UI-polish fixes), touch the
  same area, and BENEFIT from shared context. Same tag = same execution session.
  Do NOT batch big/foundational/distinct-domain tasks — those want a fresh, focused
  session (more accurate). Batching is an EXECUTION hint only: it never merges tasks
  or changes their independent verifiability / REQ mapping. When unsure, leave untagged.

When done: STOP for my review. Then ask whether to implement a specific task
(`/spec-implement <n>`), a range (`/spec-implement 1-3`), or everything
(`/spec-implement all`); and note any `Batch:` groups so the orchestrator can run
them in one session (`scripts/pane-loop.sh <feature> 3+4`).
