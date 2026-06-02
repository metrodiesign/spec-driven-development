---
name: spec-pbt
description: Extract testable properties from requirements and write property-based tests. Use to validate correctness across the whole input space, not just examples.
---

# Property-Based Testing

Step 1 — From the active spec's requirements.md, extract PROPERTIES: universal
statements that must hold for ALL valid inputs. Express each as:
  "For any <inputs> where <precondition>, THE SYSTEM SHALL <invariant>"
Link each to its REQ ID and note the input space / generators needed. Present the
list and let me choose which to test.

Step 2 — For the chosen properties, write property-based tests using the project's
framework (fast-check / Hypothesis / jqwik / proptest). Generate wide input ranges
including edge cases (empty, max, special characters). Each test cites its REQ ID.

Step 3 — When a test finds a counter-example, report the minimal failing ("shrunk")
input, then ask whether to fix the implementation, the test, or the requirement.

For heavy generation/execution, consider delegating to the `pbt-runner` subagent.
