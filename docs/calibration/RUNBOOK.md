# Phase 1 — Live Calibration Runbook (task 11)

> Current production note (2026-08-10): เอกสารนี้เป็น historical Phase-1 Claude calibration
> record. Universal PR Quality Gate ปัจจุบันต้อง conformance สี่ lineage (`claude`, `codex`,
> `gemini-cli`, `opencode-deepseek`) และใช้ activation/operation procedure จาก
> [`../08-pr-quality-gate-production.md`](../08-pr-quality-gate-production.md). ห้ามใช้ผล
> Phase-1 ชุดนี้แทน latest per-lineage eligibility.

The autonomous composition is fully wired and CI-proven with the FakeAdapter (no
quota). The remaining Phase-1 DoD items are **LIVE and MANUAL by design** — they
spend real Max quota and need human observation (the `--live` guard refuses in CI /
non-TTY per user decision #2; `/usage` is TUI-only). Run these on the operator's
machine, logged in via `claude login`, and record the observed output back into
this folder. Never claim a hollow PASS (honesty rule A4).

**Run context (2026-07-07)**: executed by the Claude agent driving a real iTerm TTY
under explicit user delegation ("run the RUNBOOK live steps") — the sanctioned path
per requirements Edge Cases (REQ-11.3 residual: "an agent driving a real TTY under
explicit delegation"). Initiator + typed `RUN-LIVE` confirmations recorded in
evidence for every spend. `ANTHROPIC_API_KEY` explicitly unset on every command.

## What is already DONE and verified here (no quota)

- Full loop composition (core + AAL + context + adapter → `runTaskLoop`) reaches
  REVIEWING on the fixture: `pnpm --filter console-backend test` (loop-run.test.ts),
  and end-to-end via the bin:
  `node console/backend/bin/platform.ts loop run --goal .ai/calibration/fixture-goal.yaml`
  → `... -> REVIEWING (1 iterations); calibration is HARNESS MATH only`.
- Real Claude adapter wired behind the SDK (`adapters/src/live.ts`,
  `createLiveAnthropicAdapter`) with the D-004 isolation flags — unit-tested with a
  mock transport.
- `--live` structurally refused in CI / non-TTY; requires the typed phrase `RUN-LIVE`.

## LIVE steps (human, budgeted) — results recorded 2026-07-07

### 1. Live conformance P1–P8 against the real adapter (§14 DoD, REQ-2.1/3, REQ-12.4)

Command: `node console/backend/bin/platform.ts conformance --live` (repo root), then `RUN-LIVE`.

- [x] P1–P8 all pass · P7 susceptibility score recorded · record saved to `.ai/calibration/`
- Observed: THREE runs, kept as honest history (each ~8 real requests; P8's retry +
  the modelVersion meta-sample served from replay at zero quota):
  1. `conformance-claude-2026-07-07T04-10-24-086Z.json` — P1/P2/P5 **FAIL**
     (echo went to `summary`; valid JSON wrapped in markdown fences; REQUEST_TOOL
     vocabulary never stated). Root-caused: the wire never told the model the
     protocol the verdicts check for.
  2. `conformance-claude-2026-07-07T04-15-32-254Z.json` — all PASS after Ring-2
     fixes (fence-strip + protocol paragraph + explicit P1/P2/P5 phrasing;
     verdicts + sabotage discrimination self-test unchanged, INV-16).
  3. `conformance-claude-2026-07-07T04-20-18-843Z.json` — all PASS, re-run under
     the FINAL shipped prompt (proposal vocabulary added for the loop) so the
     gate record attests the adapter as shipped. **This is the active record.**
  P7 susceptibility score 0 (canary not leaked) in all three runs. modelVersion
  `sonnet`. Evidence blobs content-addressed in `.ai/calibration/evidence/`;
  initiator evidence `blob://f2aa8e...deadc`.  Verdict: **PASS**

### 2. Supervised loop — first calibration numbers (REQ-11.4)

```
node console/backend/bin/platform.ts loop run --goal .ai/calibration/fixture-goal.yaml --live
# type: RUN-LIVE
```

- [x] loop reaches REVIEWING; held-out pass-rate RANGE + reproducibility recorded (small n)
- Observed: run 1 (`~/.ai/runs/RUN-1783397818923`) → **BLOCKED** (schema-valid; model
  requested tools because the proposal vocabulary was unstated — root cause fixed in
  Ring 2, recorded honestly). Run 2 (`~/.ai/runs/RUN-1783398086761`) → **REVIEWING
  (1 iteration)**: model proposed `WRITE_FILE src/impl.txt` (inline content → minted
  contentRef), executor applied it, gate ladder passed, golden held-out passed.
  Observed range: **[0.00, 1.00]** (n=1, honest small-n width)  reproducibility: **1.00**
  Usage (adapter raw): 715 in / 214 out tokens for the deciding request. Run evidence
  (events.db, evidence store incl. live transcript blob, initiator.json, replay)
  persists in the run dir. Verdict: **PASS**

### 3. Billing proof (§15.4, INV-12, REQ-11.6)

- [x] `/usage` (in the CLI TUI) moves against the Max window before→after the live
      run, with **no API bill**. `ANTHROPIC_API_KEY` unset (F-Auth is green).
- Observed: BEFORE — session 21% (resets 1:39pm Asia/Bangkok), week-all 32%,
  week-Fable 40%. AFTER (fresh TUI) — session **23%**, week-all 32% (integer
  granularity), week-Fable **41%**. Platform live spend measured from adapter raw
  usage: **27 requests, 20,478 tokens** (14,340 in / 6,138 out) ≈ 20.5 costUnits.
  No API billing path existed: `ANTHROPIC_API_KEY=` unset on every command, adapter
  authenticated via the Max OAuth keychain credential chain (F-Auth banner green).
  Caveat recorded honestly: the same account ran the interactive agent session
  concurrently, so the /usage delta is directional, not solely attributable —
  the platform's own spend is the 20,478-token figure above.
  Verdict: **PASS** (attribution caveat noted)

### 4. F-Term parity manual checklist (REQ-13.8) — real browser + real `claude`

`platform console` on 127.0.0.1:9119 (loopback), Playwright-driven real Chromium,
project `~/Desktop/Project/spec-driven-development`:

- [x] slash command works as in the CLI — `/model` rendered the full interactive
      picker (5 models, effort arrows, Enter/s/Esc keys); Esc cancelled cleanly
- [x] plan mode renders / behaves as in the CLI — Shift+Tab cycled
      bypass → auto → default → accept-edits → **plan mode on ⏸** with the same
      footer indicators as the terminal CLI
- [x] a permission prompt renders and is answerable by keystroke — default mode,
      `touch parity-prompt-test.tmp` raised the CLI permission dialog
      ("Do you want to proceed? 1. Yes / 2. Yes, always / 3. No"); answered with
      keystroke `1`; file appeared on disk (then removed)
- [x] `claude --resume <id>` reopens a prior session — resumed
      `5e30165c-dd41-4ad8-91e0-daccf99d5f8f` (Jul 6); its prior conversation
      replayed in the browser terminal
- [x] close/detach → PTY survives → re-attach replays + resumes streaming —
      Detach closed the WS, backend `GET /api/term/sessions` showed `alive: true`,
      Re-attach replayed the ring buffer (full prior TUI state) and streaming resumed
- Observed defects found & fixed DURING this live pass (all committed):
  - `attachWs` never streamed PTY output (ring replay only) → `TermManager.onData`
    tap + WS live stream (unit-tested)
  - `cwdFor` joined the munged project id onto homedir (nonexistent path) → resolve
    real cwd via claude-data
  - web Terminal page was missing entirely (task 8 reconciliation — see tasks.md)
  - browser panel leaked keyboard→WS subscriptions across re-attaches (console
    errors) → dispose + readyState guard
  - open observation: first attach after a `--resume` create occasionally renders
    blank until Re-attach (replay race); Re-attach recovers — not blocking, tracked
  - open observation: a `claude` spawned under an agent-launched backend (env
    contains CLAUDECODE etc.) left NO session JSONL; irrelevant to REQ-4.5 (adapter
    path verified) but worth knowing for F-Sess when the console itself is spawned
    by an agent
  Verdict: **PASS** (with observations above)

### 5. Transcript capture — live success path (REQ-4.5)

- [x] after a live `query()`, the session JSONL is located, polled for flush, and
      copied to the evidence store as `rawTranscriptRef` (non-null)
- Observed: every live conformance probe response and both live loop responses
  carry `rawTranscriptRef` non-null (e.g. P1 evidence blob `b013cf...f897` →
  `transcript: True`; loop run 2 replay → `transcript: True`) — JSONL derived from
  the returned session id under `~/.claude/projects/-Users-king-developer--ai-runs-agent-sessions/`,
  polled, copied into the content-addressed evidence store. Verdict: **PASS**

## SPA viewport check (rides here — REQ-13/14/16/18 UI)

- [x] Console at 375 / 768 / 1440 — `clientWidth === target`, no horizontal scroll
- Observed: 375 → clientWidth 375, scrollWidth 375, hOverflow false |
  768 → 768/768 false | 1440 → 1440/1440 false (xterm's 120-col canvas scrolls
  inside its own `overflow-x: auto` container, never the page)

---

Phase 1 closes: step 2 recorded a live number set; steps 1/3/4/5 PASS with honest
caveats above. Known non-blocking issues carried to the backlog (from the pre-live
adversarial review): repair-round token usage is not charged to the budget (real
spend can exceed the counted costUnits under repeated schema repair; bounded by
maxIterations), and the loop's frozen `nowMs` clock means the wallclock budget
never trips in a single run.
