# Phase 1 — Live Calibration Runbook (task 11)

The autonomous composition is fully wired and CI-proven with the FakeAdapter (no
quota). The remaining Phase-1 DoD items are **LIVE and MANUAL by design** — they
spend real Max quota and need human observation (the `--live` guard refuses in CI /
non-TTY per user decision #2; `/usage` is TUI-only). Run these on the operator's
machine, logged in via `claude login`, and record the observed output back into
this folder. Never claim a hollow PASS (honesty rule A4).

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

## LIVE steps (human, budgeted) — record results below

### 1. Live conformance P1–P8 against the real adapter (§14 DoD, REQ-2.1/3, REQ-12.4)

Run the conformance suite against `createLiveAnthropicAdapter` and persist the
ConformanceRecord. Registering from a mocked record would make the gate theater —
this must be the REAL adapter. Budget: ~10 requests.

- [ ] P1–P8 all pass · P7 susceptibility score recorded · record saved to `.ai/calibration/`
- Observed: __________________________  Verdict: PASS / PARTIAL(reason) / FAIL

### 2. Supervised loop — first calibration numbers (REQ-11.4)

```
node console/backend/bin/platform.ts loop run --goal .ai/calibration/fixture-goal.yaml --live
# type: RUN-LIVE
```

- [ ] loop reaches REVIEWING; held-out pass-rate RANGE + reproducibility recorded (small n)
- Observed range: __________________  reproducibility: ______  Verdict: PASS / PARTIAL / FAIL

### 3. Billing proof (§15.4, INV-12, REQ-11.6)

- [ ] `/usage` (in the CLI TUI) moves against the Max window before→after the live
      run, with **no API bill**. `ANTHROPIC_API_KEY` unset (F-Auth is green).
- Observed: __________________________  Verdict: PASS / PARTIAL(manual: /usage is TUI-only) / FAIL

### 4. F-Term parity manual checklist (REQ-13.8) — real browser + real `claude`

Start `platform console` (loopback), open the Terminal, and confirm parity with the CLI:

- [ ] slash command (`/model`, `/context`) works as in the CLI
- [ ] plan mode renders / behaves as in the CLI
- [ ] a permission prompt renders in the terminal and is answerable by keystroke
- [ ] `claude --resume <id>` reopens a prior session
- [ ] close the browser tab → PTY survives → re-attach replays + resumes streaming
- Observed: __________________________  Verdict: PASS / PARTIAL / FAIL

### 5. Transcript capture — live success path (REQ-4.5)

- [ ] after a live `query()`, the session JSONL is located, polled for flush, and
      copied to the evidence store as `rawTranscriptRef` (non-null)
- Observed: __________________________  Verdict: PASS / PARTIAL / FAIL

## SPA viewport check (rides here — REQ-13/14/16/18 UI)

- [ ] Console at 375 / 768 / 1440 — `clientWidth === target`, no horizontal scroll
- Observed: 375 ____ | 768 ____ | 1440 ____

---

Phase 1 does NOT close until at least step 2 records a live number set and steps
1/3/4 are PASS or honestly-PARTIAL. Until then task 11 stays unchecked.
