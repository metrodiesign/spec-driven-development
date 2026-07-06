# SPIKE-4 — Subscription billing proof (§15.4, gate of INV-12)

**Gate for:** the platform bills the Max subscription, never the API. **Not passing = do not
proceed.**
**Script:** `spikes/src/spike4-billing.ts` · **Run:** `node spikes/src/spike4-billing.ts`

## What it proves (automated subset)

With every auth env var stripped (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`), a `query()` turn still succeeds via the `/login`
credential chain — proving the platform does not depend on an API key.

Credential storage is platform-specific and is checked for EXISTENCE ONLY, never read (INV-12): on
this machine the credential lives in the macOS Keychain (`Claude Code-credentials`), not a
`.credentials.json` file.

## Observed (2026-07-06)

```
PASS auth env vars stripped for child
PASS subscription credential present (existence only, never read)
PASS query() succeeded with NO auth env vars (login chain used) — SPIKE3 VERDICT: PASS
SPIKE4 VERDICT: PASS (automated subset — quota movement is the manual step)
```

## Manual remainder (human eye required)

Open `/usage` in the interactive CLI **before and after** running a spike turn and confirm:
1. the Max quota moved (the turn counted against the subscription), and
2. no API bill/credit was consumed.

`/usage` is a TUI panel with no non-interactive output (`claude usage` produces none headlessly),
so this step cannot be automated and is NOT claimed as passed here.

## Verdict: PASS (automated subset) · PARTIAL on the manual `/usage` before/after check

The no-API-key success path is proven. The quota-moved / no-bill confirmation is the recorded
manual remainder (A4).
