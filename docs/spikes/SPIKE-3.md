# SPIKE-3 — SDK query() streaming + canUseTool (§15.3)

**Gate for:** SDK enhanced view / autonomous adapter path (NOT interactive parity).
**Script:** `spikes/src/spike3-query.ts` · **Run:** `node spikes/src/spike3-query.ts`

## What it proves

`query()` streams a turn and the `canUseTool` callback gates a permissioned tool. Verified SDK
behavior recorded during this spike (sdk 0.3.200):

- A bare tool name in `allowedTools` auto-approves the tool BEFORE `canUseTool` (SDK warns
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`).
- The machine's `settings.json` allow-rules ALSO shadow the callback → `settingSources: []` is
  required for it to be authoritative.
- Read-only tools bypass `canUseTool`; **Write** reliably triggers it — so the proof offers Write
  and DENIES it.

## Observed (2026-07-06, model=haiku)

```
PASS streaming produced events — 20 events
PASS canUseTool fired for the permissioned Write tool — calls: Read,Write
PASS read executed (magic word surfaced)
PASS deny honored — out.txt not created (nothing executed past the gate)
PASS turn completed on subscription creds (no auth error) — subtype=success
SPIKE3 VERDICT: PASS
```

## Verdict: PASS

Feeds docs/DEVIATIONS.md D-004 (`tools: []` vs `allowedTools: []`).
