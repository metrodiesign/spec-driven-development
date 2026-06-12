---
name: spec-design
description: Generate the design.md artifact from approved requirements. Use after requirements are approved.
argument-hint: <feature folder name (optional)>
---

# Generate design.md

Resolve the target spec: use $ARGUMENTS if given; if `.claude/specs/` holds more
than one feature and none was named, list them and ask — never guess.

First read the active spec's requirements.md and the project rules
(@.claude/rules/tech.md, @.claude/rules/structure.md). If requirements.md is
still `> Status: draft`, warn in Thai and ask for confirmation before
proceeding — and if I confirm, flip requirements.md to
`> Status: approved <YYYY-MM-DD>` as part of that confirmation. Then write
`.claude/specs/<feature>/design.md`:

  # Design: <Feature Name>
  > Status: draft

  ## Architecture Overview        — components and responsibilities
  ## Sequence Diagrams            — Mermaid for key flows
  ## Data Models & Interfaces     — schemas, types, API contracts
  ## Technology Decisions         — choices + rationale (prefer tech.md)
  ## Error Handling Strategy      — how each error case is handled
  ## Testing Strategy             — unit/integration/property; map to REQ IDs
  ## Requirement Traceability     — table: design element → REQ-x.y it satisfies

Sync mode: if design.md already exists and requirements.md changed after it was
written, do NOT regenerate the whole file — patch only the sections affected by
the changed REQs, preserving approved decisions, and update the traceability
table to match. If design.md was already approved, re-stamp its header:
`> Status: approved <original date>, amended <YYYY-MM-DD>`.

For a deeper architectural pass, consider delegating to the `spec-architect`
subagent. When done: STOP for my review, then suggest `/spec-tasks`. When I
explicitly approve, flip the header to `> Status: approved <YYYY-MM-DD>` before
the next phase.
