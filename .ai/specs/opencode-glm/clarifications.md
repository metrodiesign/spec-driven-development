# Clarifications: opencode-glm

> Status: draft 2026-08-16 — operator answered the batched questions in-session;
> answers below bind the requirements.

## Workflow choice

**Requirements-First** — same reasoning as glm-5-3-adapter: the behavior is
precedented (the `opencode-deepseek` lane is a working template built on
`reasoning-cli.ts`), and the open questions were policy choices (answered
below), not architecture.

## Context + why this spec exists

`glm-5-3-adapter` (PR #142) delivered the direct-API zai lineage; its LIVE
conformance (task 4) is blocked on Z.ai API balance (error 1113 — the Coding
Plan quota does not apply to the general API per Z.ai's FAQ). The operator
wants GLM-5.3 exercised for real NOW ("เพื่อทดสอบการทำงาน") and OpenCode on
this machine already holds working credentials — so the platform gets its
fifth lineage through the OpenCode CLI, riding the existing credential.

## Machine facts (verified 2026-08-16, binding design inputs)

- `opencode` 1.18.18 at `/opt/homebrew/bin/opencode`
- Credentials configured (`opencode auth list`): **OpenCode Zen (api)** and
  **OpenCode Go (api)** — auth store at `~/.local/share/opencode/auth.json`
- GLM-5.3 is reachable as **`opencode-go/glm-5.3`** (hosted via the OpenCode
  Go gateway; the `opencode/` zen gateway tops out at glm-5.2 today)
- Non-interactive seam: `opencode run --pure --format json --model <id> <prompt>`
  (exactly what `buildOpenCodeReviewArgv` already drives for
  `opencode-deepseek`)

## Operator decisions (2026-08-16, batched questions)

- **D1 — model path: OpenCode Go gateway** (`opencode-go/glm-5.3`). Not the
  Z.ai Coding Plan custom-provider path, not both. Consequence: quota is the
  OpenCode Go account's, and the Z.ai "supported tools" FAQ question is moot
  on this path — the processor is OpenCode's gateway, so the data-governance
  note shifts to `provider_data_policy` (REQ-6) and OpenCode account terms.
- **D2 — registration scope: conformance CLI + LIVE only** — minimal INV-8
  close, same shape as glm-5-3-adapter's D2. PR-gate reviewer slotting and
  loop composition are follow-ups.
- **D3 — terms handling: record and proceed** — no separate blocking terms
  review for this round. Recorded here: hosted-gateway usage rides the
  operator's OpenCode Go account under OpenCode's terms; the ~10-request
  conformance run is the only live traffic this spec adds.

## Identity decisions (agent-chosen, following existing conventions)

- **adapterId `opencode-glm`** — matches the `opencode-deepseek` convention
  (transport-prefixed id).
- **lineage `'zai'` — shared with the `glm` direct-API adapter (PR #142),
  deliberately.** Lineage feeds router diversity/fusion exclusion and
  injection-aware routing; both adapters serve the same model family
  (GLM-5.3), so a fusion panel must NOT treat them as decorrelated, and
  susceptibility routing should bucket them together. Distinct transports,
  one lineage.
- **contextWindowTokens 1_000_000**, model default `opencode-go/glm-5.3`,
  timeout default 600s (thinking models over a hosted gateway — same
  rationale as DEFAULT_KILL_TIMEOUT_MS).

## Assumptions

- **B1 Branch/PR:** `feat/opencode-glm` off `origin/develop` (created);
  PR back to `develop`, squash. Independent of PR #142 — `reasoning-cli.ts`
  and the CLI allowlist hook already exist on `develop`.
- **B2 Reuse:** the adapter is a thin live factory over
  `createReasoningCliAdapter` — no new adapter core, no `core/`/`aal/`
  changes (INV-7/8 unchanged; vendor strings stay in Ring 2 + composition
  roots).
- **B3 Sandbox/auth tension (the one real design problem):** the
  opencode-deepseek factory sandboxes HOME/XDG into a temp dir + deny-all
  config; the OpenCode Go credential lives in the REAL
  `~/.local/share/opencode/auth.json`. Requirements demand authentication
  WITHOUT loosening the deny-all config isolation; the mechanism
  (copying the auth store into the sandboxed data dir vs passing real HOME)
  is a design.md decision with the isolation trade-off stated.
