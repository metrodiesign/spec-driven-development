---
name: spec-requirements
description: Generate the requirements.md artifact for the active feature spec using EARS notation. Use after /spec-new and after I've answered clarifying questions.
argument-hint: <feature folder name (optional)>
---

# Generate requirements.md

Resolve the target spec folder: use $ARGUMENTS if given; otherwise use the
feature folder created by /spec-new in this conversation. If neither identifies
one and `.claude/specs/` holds several features, list them and ask — never guess.

Write `.claude/specs/<feature>/requirements.md` with this structure:

  # Requirements: <Feature Name>
  > Status: draft

  ## Overview
  <one paragraph tying this to product.md>

  ## REQ-1: <Capability, e.g. User Registration>
  **User Story:** As a <role>, I want <goal>, so that <benefit>.
  **Acceptance Criteria (EARS):**
  - 1.1  WHEN <event> THE SYSTEM SHALL <behavior>
  - 1.2  IF <error condition> THEN THE SYSTEM SHALL <response>
  - 1.3  WHILE <state> THE SYSTEM SHALL <behavior>

  (repeat REQ-2, REQ-3, ...)

  ## Edge Cases & Open Questions
  <anything ambiguous>

Rules: every requirement is atomic, testable, and has a stable ID. Cover the happy
path AND error/edge cases (use IF...THEN).

When done: STOP. Show me a summary and ask me to review. Suggest I run
`/spec-analyze` next for complex or sensitive features, otherwise `/spec-design`.

When I explicitly approve (in a later turn), flip the header line in the artifact
to `> Status: approved <YYYY-MM-DD>` before starting the next phase — approval
must live in the file, not only in this conversation.
