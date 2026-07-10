# Bugfix: F-Chat leaks secrets over WS and silently bypasses tool approval
> Status: approved 2026-07-09

## Current Behavior (Defect)

**Defect 1 — WS stream bypasses redaction.** WHEN F-Chat streams any event to
a connected browser client, THE SYSTEM sends the raw JSON-stringified event
directly via `ws.send(...)` at its single sink,
`console/backend/src/chat-runtime.ts:81`:
```
send: (event) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); }
```
This never passes through the existing `redactText` secret-redaction function
(`console/backend/src/security.ts:132-139`, which strips `TOKEN_PATTERNS` like
`sk-…`/`ghp_…`/`Bearer …`/JWTs, `CREDENTIAL_PATH_PATTERN` paths, and the
operator's home directory). `redactText` is wired only into Fastify's global
`onSend` hook (`console/backend/src/app.ts:156-159`); once a socket upgrades to
WS (`chat-runtime.ts:54-56`, attached directly to the raw `http.Server` per
`bin/platform.ts:635`), its frames never re-enter the Fastify reply pipeline
and so never reach that hook. All six of `chat.ts`'s `deps.send(...)` call
sites (`approval_request` 141, `error` 147/174/183, `stream_delta` 166,
`tool_card` 168, `done` 180) funnel through this one unguarded sink.

Investigation confirmed the code sends only complete, fully-buffered messages
— there is no partial/token-level streaming (`includePartialMessages` is never
set, no `stream_event` handling exists) — so this is not the "chunk-boundary"
hard problem `.ai/specs/platform-phase4/tasks.md` task 11 originally assumed.

F-Term's raw PTY stream (`term-runtime.ts:87-89`) has the same missing-
redaction mechanism, but is not equally risky: F-Term is loopback-only and
never registered when `behindProxy` is set (`bin/platform.ts:579-586`) and is
CLI-native (never touches the SDK's `canUseTool` bridge at all). F-Chat
deliberately has **no** such loopback gate (`bin/platform.ts:588-596`,
comment: "no loopback/behind-proxy gate") — it is designed to be reachable
over a non-loopback bind with auth. This bugfix is scoped to F-Chat only.

**Defect 2 — canUseTool silently inert under ambient operator settings.**
WHEN `console/backend/src/chat-runtime.ts`'s `liveChatQuery` invokes the
Claude Agent SDK's `query(...)`, THE SYSTEM never sets `permissionMode` or
`settingSources` in the call's `options` (confirmed: only `cwd`, `resume`,
`forkSession`, `canUseTool` are set, `chat-runtime.ts:25-34`). The SDK
subprocess therefore inherits the **console-server operator's own** ambient
`~/.claude/settings.json` in full (`settingSources` omitted = "all sources
are loaded, matches CLI defaults" per the SDK's own type doc). Per the SDK's
`SDKPermissionDeniedMessage` doc (`sdk.d.ts:3899-3900`), `canUseTool` is
invoked only on the interactive "ask" path — an ambient `bypassPermissions`
mode, `dontAsk` mode, or a matching allow-list entry all short-circuit around
it entirely, independently of each other. A tool then executes with **zero**
entry in the approval audit log, even though the UI always renders the
non-parity banner and approval-card affordance as if every tool decision is
gated. Reproduced live: `docs/calibration/RUNBOOK-phase4.md:251-264` recorded
a real `Bash` tool executing with zero `chat_tool_decision` audit entries on a
machine with `defaultMode:bypassPermissions`.

Because F-Chat has no loopback gate (see Defect 1), this is not merely a
same-machine convenience issue: a remote, authenticated chat user can drive
tools on the operator's machine with no per-tool gate at all, contrary to what
the UI communicates. The console-server process is shared across all F-Chat
sessions on that instance (no per-session `env`/`HOME` override), so this is a
per-console-process blast radius, not per-session.

**Repro steps:**
1. *(Defect 1)* Start F-Chat against a project directory whose `.env` contains
   a recognizable secret pattern (e.g. `sk-...`). Prompt the agent to read and
   summarize it; approve the resulting `canUseTool` prompt. Observe the
   assistant's `stream_delta` text (or a `Bash`/`Read` `tool_card`'s
   input/output) arrives at the browser with the literal secret intact —
   `TOKEN_PATTERNS[0]` (`security.ts:121`) would have matched it had
   `redactText` been applied.
2. *(Defect 2)* On a machine where the operator's `~/.claude/settings.json`
   has `"defaultMode":"bypassPermissions"` (or an allow-list entry matching
   the tool the agent picks), open an F-Chat session and prompt the agent to
   run any tool. Observe: the tool executes successfully, but zero
   `approval_request` WS event and zero `chat_tool_decision` audit entry are
   ever produced.

## Expected Behavior

- F1  WHEN `console/backend/src/chat-runtime.ts` sends any WS event to a
      connected client, THE SYSTEM SHALL pass the JSON-stringified event
      through `redactText` (the same function already used for HTTP
      responses) before calling `ws.send`.
- F2  THE SYSTEM SHALL plumb the server's `homeDir` value into
      `createChatRuntime`/`liveChatQuery` so `redactText` receives the same
      `homeDir` argument the HTTP `onSend` hook already uses.
- F3  WHEN `console/backend/src/chat-runtime.ts`'s `liveChatQuery` calls the
      SDK's `query(...)`, THE SYSTEM SHALL set `options.settingSources` to
      `[]` (user-decided isolation level: full isolation, matching the
      existing precedent in `adapters/src/anthropic.ts:172-173` — this also
      means F-Chat sessions no longer load project `CLAUDE.md`, an accepted
      trade-off, not a regression).
- F4  WHEN `console/backend/src/chat-runtime.ts`'s `liveChatQuery` calls the
      SDK's `query(...)`, THE SYSTEM SHALL set `options.permissionMode` to
      `'default'`.

## Unchanged Behavior

- B1  WHEN a WS event is redacted under F1 and contains no secret-matching
      substring, THE SYSTEM SHALL CONTINUE TO deliver byte-identical JSON to
      the client — redaction must be a no-op on clean content.
- B2  WHEN a `done` event is redacted under F1, THE SYSTEM SHALL CONTINUE TO
      deliver its `sdkSessionId` field intact (a UUID, unaffected by
      `TOKEN_PATTERNS`/`CREDENTIAL_PATH_PATTERN`/`homeDir` substitution) so
      resume-chaining (REQ-19.1) keeps working.
- B3  WHEN a `tool_card`/`approval_request` event is redacted under F1, THE
      SYSTEM SHALL CONTINUE TO deliver its `toolUseId` field intact so
      `handleToolDecision`'s (`chat.ts:191-197`) allow/deny matching keeps
      working.
- B4  WHEN F-Term (`term-runtime.ts`) streams PTY output, THE SYSTEM SHALL
      CONTINUE TO behave exactly as today — unmodified by this bugfix.
- B5  WHEN the main task-loop adapter (`adapters/src/anthropic.ts`) runs, THE
      SYSTEM SHALL CONTINUE TO use its own existing
      `settingSources: []`/`tools: []` isolation, unmodified by this bugfix.
- B6  WHEN `chat.ts`'s CI tests run against the scripted fake `queryFn`
      (`chat.test.ts:106-190`), THE SYSTEM SHALL CONTINUE TO pass unmodified —
      F3/F4 land only in `chat-runtime.ts`'s real-SDK wiring (already
      documented as untested-in-CI, mirroring `term-runtime.ts`'s identical
      precedent), never in `chat.ts`'s tested options type.
- B7  WHEN a chat turn completes normally (`done`, `chat.ts:180`), THE SYSTEM
      SHALL CONTINUE TO leave the session open for the next `user_message` —
      F3/F4 must not alter session lifecycle.
- B8  WHEN `canUseTool`'s timeout or WS-drop paths fire, THE SYSTEM SHALL
      CONTINUE TO fail-closed (deny) and audit the decision
      (`chat.ts:130-134,199-205`), unchanged by F3/F4 making the ask-path
      reachable again.
