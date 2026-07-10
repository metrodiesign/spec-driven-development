# Implementation Tasks: bugfix-fchat-hardening — WS redaction + permission isolation
> Status: approved 2026-07-09

> Bugfix spec: bugfix.md. Backend-only (console/backend); both defects are fixed
> together since they land in the same two functions of the same file.

- [x] 1. F-Chat WS redaction + permission isolation — wrap `chat-runtime.ts`'s WS
      `send` sink so every outgoing event is redacted via the existing
      `redactText` (reusing `security.ts`, same function the Fastify `onSend`
      hook already uses) before `ws.send`; plumb `homeDir` into
      `createChatRuntime`/`liveChatQuery` for this. Separately, in
      `liveChatQuery`'s SDK `query(...)` call, set `settingSources: []` and
      `permissionMode: 'default'` — extract the options-construction into a small
      exported pure function so the literal values are unit-testable without
      invoking the real SDK (mirrors how `chat.ts` already keeps its SDK-call
      surface injectable/testable). Must not touch `chat.ts`'s tested options type
      (F3/F4 land only in the real-SDK wiring layer, consistent with
      `chat-runtime.ts`/`term-runtime.ts`'s existing untested-in-CI-by-design
      split), must not touch F-Term or the loop adapter's (`anthropic.ts`) own
      isolation settings.
      Satisfies: F1, F2, F3, F4, B1, B2, B3, B4, B5, B6, B7, B8.
      Verify: `pnpm -C console/backend test && pnpm -r typecheck`.
      Evidence:
        - test: `pnpm -C console/backend test` -> 277 passed / 0 failed (10 new
          in `chat-runtime.test.ts`: `buildLiveQueryOptions` always carries
          `settingSources:[]` + `permissionMode:'default'` [F3/F4] while still
          passing `cwd`/`canUseTool` through and keeping `resume`/`forkSession`
          conditionally-included exactly as before; `redactChatEvent` — a clean
          `stream_delta` round-trips byte-identical [B1], a token embedded in
          `stream_delta` TEXT is redacted [F1, the actual echoed-secret leak
          scenario], a token embedded in a `tool_card`'s input VALUE is
          redacted too [F1, the Bearer-header-in-a-Bash-command scenario],
          `toolUseId` survives verbatim [B3], `sdkSessionId` on a `done` event
          survives verbatim [B2], a credential path collapses to `[credential-
          path-redacted]` and the home dir to `~` [matches the existing HTTP
          `onSend` behavior], output stays valid JSON even with quotes/
          backslashes/tokens mixed in [wire contract intact]; all 267
          pre-existing tests stayed green unchanged, including F-Term's own
          suite [B4] and the untouched `chat.test.ts` [B6])
        - test: `pnpm -r typecheck` -> 6/6 packages clean
        - other: `pnpm lint` -> no issues; `pnpm vendor-check` -> core/aal
          vendor-name-free (INV-7, untouched by this task)
        - viewports: n/a — backend-only, no UI touched
        - deviations: no live-SDK/browser pass for this task — F1-F4 are pure
          functions (`buildLiveQueryOptions`/`redactChatEvent`) exercised
          directly and exhaustively by the unit tests above, which is the full
          extent of what's provable without spending real API quota; a real
          end-to-end proof (actual SDK subprocess, actual `.env` secret,
          actual browser) is this project's own established separate "LIVE
          pass" task category (e.g. Phase-4 task 12), not a bugfix's scope —
          spending quota here would duplicate that category without adding
          coverage the pure-function tests don't already give. `chat.ts` (the
          tested, SDK-import-free options type) was NOT touched — confirmed by
          diff: F3/F4 land only in `chat-runtime.ts`'s `buildLiveQueryOptions`.
          `redactChatEvent` redacts the WHOLE serialized frame in one pass
          (not per-field) since every `ChatServerEvent` is a complete,
          non-streamed object in this codebase (confirmed during
          investigation: no `stream_event`/partial-message handling exists) —
          marked with a `ponytail:` comment naming the ceiling (would need a
          holdback buffer if token-level streaming is ever added) and the
          upgrade path, per the project's own shortcut-marking convention.
