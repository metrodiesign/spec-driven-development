---
name: spec-pbt
description: Extract testable properties from requirements and write property-based tests. Use to validate correctness across the whole input space, not just examples.
argument-hint: <feature folder name (optional)>
---

# Property-Based Testing

Resolve the target spec: use $ARGUMENTS if given; if `.claude/specs/` holds more
than one feature and none was named, list them and ask — never guess. If
requirements.md is still `> Status: draft`, warn in Thai and ask for
confirmation before proceeding.

Step 1 — From the active spec's requirements.md, extract PROPERTIES: universal
statements that must hold for ALL valid inputs. Express each as:
  "For any <inputs> where <precondition>, THE SYSTEM SHALL <invariant>"
Link each to its REQ ID and note the input space / generators needed. Present the
list and let me choose which to test.

Step 2 — For the chosen properties, write property-based tests. First check
package.json: if no PBT framework (fast-check / Hypothesis / jqwik / proptest)
is installed, do NOT install one silently — either write the properties as
randomized-input loops on the existing test runner, or propose the framework as
a devDependency (with license + maintenance status) and wait for approval per
tech.md's dependency rule. Generate wide input ranges including edge cases
(empty, max, special characters). Each test cites its REQ ID.

Step 3 — When a test finds a counter-example, report the minimal failing ("shrunk")
input, then ask whether to fix the implementation, the test, or the requirement.

For heavy generation/execution, consider delegating to the `pbt-runner` subagent.
