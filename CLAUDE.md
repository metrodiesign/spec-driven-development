# Spec-Driven Development Constitution

This project practices STRICT spec-driven development. Specifications come before
code, ALWAYS. Do not jump to implementation for any non-trivial feature.

## The non-negotiable workflow

Every feature flows through three artifacts under `.claude/specs/<feature-name>/`,
in order, with an APPROVAL GATE after each:

  1. requirements.md  — WHAT the system must do (behavior, in EARS notation)
  2. design.md        — HOW it will be built (architecture)
  3. tasks.md         — discrete, trackable implementation steps

After producing each artifact, STOP and ask me to review before generating the
next. Wait for explicit approval ("approved" / "continue"). The only exception is
when I invoke `/spec-quick`, which runs all phases without gates.

## How to run each phase

Use the project slash commands — do not improvise the structure:
  /spec-new <idea>        choose a workflow and ask clarifying questions
  /spec-requirements      generate requirements.md (EARS)
  /spec-analyze           audit requirements for gaps/conflicts before design
  /spec-design            generate design.md
  /spec-tasks             generate tasks.md
  /spec-implement <id|range|all>  implement one or more cohesive tasks, end-to-end
  /spec-bugfix <bug>      root-cause-first bug workflow
  /spec-pbt               extract properties and write property-based tests
  /spec-retro             session retrospective — run at END of session, BEFORE /clear

## EARS notation (mandatory for requirements)

Write every functional requirement using one of these patterns, each with a
stable ID (REQ-1.2):
  - THE SYSTEM SHALL <behavior>                                   (ubiquitous)
  - WHEN <trigger> THE SYSTEM SHALL <behavior>                    (event-driven)
  - WHILE <state> THE SYSTEM SHALL <behavior>                     (state-driven)
  - WHERE <feature included> THE SYSTEM SHALL <behavior>          (optional)
  - IF <unwanted condition> THEN THE SYSTEM SHALL <response>      (error handling)
Requirements must be atomic, unambiguous, and testable.

## Project standards

See @.claude/rules/product.md for what we're building and why.
See @.claude/rules/tech.md for the tech stack you MUST prefer.
See @.claude/rules/structure.md for file organization and conventions.

## Task sizing (this project runs a large-context, high-effort model)

Size tasks as cohesive, independently verifiable slices of behavior — NOT micro-steps.
Assume you can hold the whole feature in context and implement a complete task
end-to-end in one pass, even when it spans many files. A typical feature is about
5-10 tasks, not 20-30. Do NOT pre-split a task into 1.1/1.2 sub-steps inside
tasks.md; decompose into working steps yourself at execution time using your own
internal TODO list. Prefer vertical slices (model → API → validation → tests) over
horizontal layers that are useless alone.

## Working agreements

- Keep specs in sync: a change in requirements propagates to design and tasks.
- Implement a whole task (it may touch many files) end-to-end, including its tests,
  then mark "- [x]" and state which REQ IDs are now satisfied. Pause for review at
  TASK boundaries, not after every file. Implement several tasks in one go only when
  I ask (a range or "all"), proceeding in dependency order.
- Match the conventions in structure.md exactly.
- When something is ambiguous, batch your questions and ask before assuming.
- Be concise and engineering-focused.

## Context discipline (save tokens WITHOUT losing correctness)

- The spec files in `.claude/specs/<feature>/` are the durable source of truth;
  this conversation is temporary working memory. Before I run /clear, or before
  compaction triggers, make sure the current state — active task ID, decisions and
  their rationale, what's done, and the next step — is written into tasks.md /
  design.md. NEVER clear or compact in the middle of an unfinished task whose state
  lives only in this conversation.
- When compaction runs, ALWAYS preserve: the active spec and task ID, the list of
  modified files, the exact test/build/run commands, and every architectural
  decision with its rationale. Do not drop these even to save space.
- Prefer a fresh session per cohesive task (reload context by reading the spec with
  @) over one long session. A clean, focused context is also more accurate.
- Keep this file lean, but NEVER remove a rule that prevents a real mistake.
  Correctness outranks token savings: if economizing would risk a wrong result,
  do not economize — tell me instead.
