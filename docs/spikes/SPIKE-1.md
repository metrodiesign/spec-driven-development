# SPIKE-1 — SDK session observability (§15.1)

**Gate for:** Console observability path (F-Sess in Phase 1 via SDK).
**Script:** `spikes/src/spike1-sessions.ts` · **Run:** `node spikes/src/spike1-sessions.ts`

## What it proves

`listSessions` and `getSessionMessages` from `@anthropic-ai/claude-agent-sdk` return real session
data for existing local projects — the SDK is a viable read path for the Sessions browser.

## Observed (2026-07-06, sdk 0.3.200, Node 26)

```
PASS listSessions returns sessions — 25 sessions
PASS session has metadata — id=eaade305… cwd=/Users/king_developer/Desktop/Project/spec-driven-development
PASS getSessionMessages returns messages — 50 msgs, first type=user
SPIKE1 VERDICT: PASS
```

## Verdict: PASS

No manual step. Phase 0 F-Sess reads the JSONL directly (INV-11); this spike confirms the SDK
path is available to become primary in Phase 1.
