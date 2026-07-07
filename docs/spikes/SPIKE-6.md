# SPIKE-6 — Codex CLI headless propose-only + billing (Phase 3 gate)

**Gate for:** `adapters/codex.ts` (Ring 2, Phase 3 — unified-platform-spec v1.2 §14) — the
propose/dispose invariant (INV-1/INV-9, P6 analog) must hold for a second lineage before any
adapter design is locked.
**Run (manual, spends Codex quota — never CI):** commands below, throwaway; artifacts kept only
in session scratchpad, not committed.

## What it proves

`codex exec` (non-interactive) can return a schema-conforming structured proposal WITHOUT
executing anything, on subscription auth, with per-turn usage numbers — i.e. Codex is wireable
behind the AAL as a propose-only adapter.

## Observed (2026-07-08, codex-cli 0.139.0, darwin)

Probe command:

```
codex exec --sandbox read-only --ephemeral --skip-git-repo-check --ignore-user-config \
  --output-schema schema.json -o last.json --json "<propose-only prompt>" < /dev/null
```

Results:

```
PASS propose-only: exit=0, work dir untouched (no file created), model proposed instead of acting
PASS structured output: last message = {"actions":[{"type":"WRITE_FILE","path":"hello.txt",
     "content":"hello-spike6"}],"summary":"..."} — conforms to --output-schema exactly
PASS auth/billing: `codex login status` = "Logged in using ChatGPT" (subscription, no API key)
PASS events: --json JSONL = thread.started, turn.started, item.completed, turn.completed
     with usage {input_tokens:26459, cached_input_tokens:2432, output_tokens:87,
     reasoning_output_tokens:37} — enough to normalize costUnits (§7.1)
```

## Caveats recorded (adapter design inputs)

1. **stdin MUST be closed on spawn.** With a piped-but-open stdin, `codex exec` prints
   "Reading additional input from stdin..." and blocks forever waiting for EOF. First run hung
   3 min until SIGTERM (exit 143). Adapter spawns with `stdin: 'ignore'` (or `< /dev/null`).
2. **No headless quota signal.** No `codex usage` subcommand; no rate-limit fields in the JSONL
   events. A §5.4-style quotaProbe is NOT available for this lineage → breaker for
   `codex@<model>` degrades to error-rate-only (429/limit errors as signals). Recorded, not
   assumed.
3. **Config independence confirmed at the flag level.** `--ignore-user-config` (skips
   `$CODEX_HOME/config.toml`, auth still works), `-c key=value` overrides, `--ephemeral` (no
   session files), `-C <dir>`, `--skip-git-repo-check` — the adapter can pass everything
   explicitly and depend on no machine config. Known separately (memory, codex 0.135/0.139):
   project `.codex/config.toml` [hooks] do not fire in headless `codex exec`.
4. Prompt-level "do not execute" is NOT the enforcement — `--sandbox read-only` is. The adapter
   must always pass an explicit sandbox flag; conformance P6 verifies proposals-only on the wire.
5. Model selection via `-m/--model`; the JSONL events do not echo the model id — the adapter must
   record the model it requested in `adapterMeta.modelVersion` itself.

## Verdict: PASS

Codex adapter design can proceed (Phase 3 tasks touching `adapters/codex.ts`). Expected residual:
first LIVE conformance run may still re-hit the INV-16 wire-vocabulary lesson from Phase 1 — fix
belongs in the Ring 2 prompt, never in weakened verdicts.
