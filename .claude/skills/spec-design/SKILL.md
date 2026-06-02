---
name: spec-design
description: Generate the design.md artifact from approved requirements. Use after requirements are approved.
---

# Generate design.md

First read the active spec's requirements.md and the project rules
(@.claude/rules/tech.md, @.claude/rules/structure.md). Then write
`.claude/specs/<feature>/design.md`:

  # Design: <Feature Name>
  ## Architecture Overview        — components and responsibilities
  ## Sequence Diagrams            — Mermaid for key flows
  ## Data Models & Interfaces     — schemas, types, API contracts
  ## Technology Decisions         — choices + rationale (prefer tech.md)
  ## Error Handling Strategy      — how each error case is handled
  ## Testing Strategy             — unit/integration/property; map to REQ IDs
  ## Requirement Traceability     — table: design element → REQ-x.y it satisfies

For a deeper architectural pass, consider delegating to the `spec-architect`
subagent. When done: STOP for my review, then suggest `/spec-tasks`.
