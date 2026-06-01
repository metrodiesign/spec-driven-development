---
name: spec-analyze
description: Audit the requirements.md of the active spec for logical issues before moving to design. Use for complex features or compliance-sensitive domains.
---

# Analyze Requirements

Read the active spec's requirements.md and report issues in FOUR categories:

  1. Logical inconsistencies — requirements that contradict each other
  2. Ambiguities — statements open to more than one interpretation
  3. Conflicting constraints — requirements that cannot all hold at once
  4. Gaps — missing scenarios, unhandled edge cases, undefined error behavior

For each issue: cite the REQ ID, explain the problem, propose a concrete fix.
Do NOT silently edit the file — present the analysis and let me decide what to apply.
