# SPIKE-2 — PTY parity proof (§15.2, gate of INV-17)

**Gate for:** interactive surface = real `claude` binary via PTY. **Not passing = interactive is
not 100% CLI parity, do not proceed to Phase 1 F-Term.**
**Script:** `spikes/src/spike2-pty.ts` · **Run:** `node spikes/src/spike2-pty.ts`
**Deps:** `node-pty@1.1.0` (preflight: native module loaded on Node 26 — `typeof pty.spawn === 'function'`).

## Automated subset — observed (2026-07-06, Node 26)

```
PASS TUI banner rendered — 3600 bytes of TUI output
PASS slash command /status works in-terminal
PASS PTY survives idle detach (backend-owned) — pid=27802
PASS claude --resume renders an existing session — session=0cb1ecd0… 3184 bytes
SPIKE2 VERDICT: PASS (automated subset — manual checklist in SPIKE-2.md)
```

Covers §15.2 items (a) slash command works, (b) `claude --resume` opens an existing session,
(d) PTY is backend-owned and survives a client detach. Only slash commands were sent — no model
prompt, no quota consumed.

## Manual remainder (TUI-visual — cannot be asserted headlessly)

- **(c) permission prompt renders in-terminal and is answerable by typing** — drive a real tool
  call in the spawned PTY and confirm the CLI's own approval prompt appears and accepts keystrokes.
- **(e) `/usage` shows it counts against the Max quota with no API bill** — `/usage` is a TUI
  slash command; its rendered panel must be read by a human (confirmed non-capturable headlessly:
  `claude usage` has no non-interactive output).
- **Windows/ConPTY** — out of Phase 0 scope (dev + CI are darwin); verify per node-pty on Windows
  before shipping F-Term cross-platform.

## Verdict: PASS (automated subset) · PARTIAL on the manual checklist above

The backend-owned-PTY + slash-command + resume mechanics are proven. The two TUI-visual checks
(c, e) are recorded as the manual remainder and are NOT claimed as automatically passed (A4).
