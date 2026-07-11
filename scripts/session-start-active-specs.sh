#!/usr/bin/env bash
# session-start-active-specs.sh — active (non-archived) spec dirs for the SessionStart
# hook's "Active specs" line (sdd-spec-context-loading REQ-2.1/2.2). Archived specs
# (.ai/specs/archive/*) are excluded so the always-on context stays proportional to
# live work.
ls .ai/specs 2>/dev/null | grep -v '^archive$' | tr '\n' ' '
