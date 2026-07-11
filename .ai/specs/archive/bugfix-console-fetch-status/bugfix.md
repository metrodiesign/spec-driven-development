# Bugfix: Console web app crashes blank on any non-2xx API response
> Status: approved 2026-07-09

## Current Behavior (Defect)

WHEN any of `console/web/src`'s data-fetching call sites receives a non-2xx HTTP
response from `console/backend`, THE SYSTEM treats the parsed JSON error body as
valid success data, because none of these call sites check `response.ok` /
`response.status` before parsing and storing the body:

- Three byte-identical, copy-pasted `useFetch<T>` hooks: `App.tsx:89-107`,
  `Loop.tsx:29-43`, `Surfaces.tsx:11-25`.
- Four hand-rolled equivalents with the same flaw: `Issues.tsx:26-31`,
  `Chat.tsx:39-44`, `Sched.tsx:29-34`, `TerminalPanel.tsx:31-36`.

`console/backend/src/app.ts` registers no `setErrorHandler`/`setNotFoundHandler`,
so error responses come back in one of two shapes — Fastify's default
`{message, error, statusCode}` (real 404s, e.g. when `loopRunsRoot`/`issuesDir`
is left unwired: `app.ts:739`, `app.ts:857`) or a custom `{error}` single-key
shape (explicit 4xx handlers) — and **neither** shape contains the field the
calling component expects. The component's very next unguarded property access
therefore throws `TypeError: Cannot read properties of undefined`:

| Fetch (file:line) | Throwing access (file:line) |
|---|---|
| `App.tsx:115` `/api/status` | `App.tsx:172,174` `status.cli.available`, `status.activeRuns.length` |
| `App.tsx:117` `/api/projects` | `App.tsx:212,216` `projectsRes.projects.length`/`.map` |
| `App.tsx:118` `/api/usage/estimate` | `App.tsx:187` → `format.ts:33` `w.end` |
| `App.tsx:122` `/api/sessions` | `App.tsx:247,262` `sessionsRes.warnings.length`/`.sessions.map` |
| `Loop.tsx:56` `/api/loop/runs` | `Loop.tsx:108,144,148` `runsRes.runs.find`/`.length`/`.map` |
| `Surfaces.tsx:44` `/api/system/stats` | `Surfaces.tsx:60` → `surfaces.ts:23` `s.loadAvg[0]` |
| `Surfaces.tsx:46` `/api/subagents` | `Surfaces.tsx:108` → `surfaces.ts:34` `undefined.length` |
| `Surfaces.tsx:47` `/api/skills` | `Surfaces.tsx:113` → `surfaces.ts:34` `undefined.length` |
| `Issues.tsx:27` `/api/issues` | `Issues.tsx:29,97` `setIssues(undefined)` → `.length` |
| `Chat.tsx:40` `/api/usage/estimate` | `Chat.tsx:42,98` → `format.ts:33` `w.end` |

`Sched.tsx:30` and `TerminalPanel.tsx:32` have the identical missing-`r.ok`-check
flaw but happen not to crash today (their consumers tolerate `undefined`
silently — e.g. `TerminalPanel.tsx`'s `sessions.length` on a non-array reads as
`undefined`, coerces falsy, shows an empty list instead of throwing). Same root
cause, no visible symptom yet.

Because **zero React error boundary exists anywhere in the component tree**
(`console/web/src/main.tsx:10-16` is a bare
`createRoot(...).render(<StrictMode><I18nProvider><App/></I18nProvider></StrictMode>)`
with nothing catching a render-time throw), any single one of the throws above
unmounts the **entire** SPA — the whole console goes blank, not just the
affected widget.

**Repro steps** (matches `.ai/specs/platform-phase4/tasks.md` task 9/10's own
recorded — and twice-deferred — evidence):
1. Start `platform console` with `loopRunsRoot` (or `issuesDir`) left unwired.
2. Navigate to the Loop page (or Issues page).
3. `GET /api/loop/runs` (or `/api/issues`) 404s with Fastify's default body
   `{message:"Route GET:/api/loop/runs not found",error:"Not Found",statusCode:404}`.
4. `Loop.tsx:144`'s `runsRes.runs.length` throws — reproduced directly against
   this exact body shape via a Node repro during investigation, not merely
   inferred.
5. The entire console SPA renders blank with no operator-visible error, only a
   browser-console stack trace.

## Expected Behavior

- F1  WHEN any of the ten fetch call sites listed above (`App.tsx`'s
      `useFetch`, `Loop.tsx`'s `useFetch`, `Surfaces.tsx`'s `useFetch`,
      `Issues.tsx`'s `refresh`, `Chat.tsx`'s quota fetch, `Sched.tsx`'s
      `refreshStatus`, `TerminalPanel.tsx`'s `refreshSessions`) receives an
      HTTP response with `response.ok === false`, THE SYSTEM SHALL treat it as
      a fetch error and SHALL NOT parse-and-store the error body as success
      data.
- F2  WHEN a fetch call site under F1 encounters a non-ok response, THE SYSTEM
      SHALL set that call site's state to an error indicator that is
      distinguishable from both its initial loading value and any successful
      data value.
- F3  WHEN a component consuming a data hook under F1 observes the error
      indicator from F2, THE SYSTEM SHALL render a visible "unavailable" state
      for that section instead of a permanent loading spinner and instead of
      throwing.
- F4  THE SYSTEM SHALL consolidate the three duplicated `useFetch<T>`
      implementations (`App.tsx`, `Loop.tsx`, `Surfaces.tsx`) into one shared
      hook implementing F1-F3, imported by all three call sites.
- F5  THE SYSTEM SHALL apply the F1-F3 contract to `Issues.tsx`, `Chat.tsx`,
      `Sched.tsx`, and `TerminalPanel.tsx`'s hand-rolled fetches as well (user
      decision: fix all ten call sites in this pass, not only the eight that
      throw today — same root cause, same fix pattern).
- F6  THE SYSTEM SHALL wrap the root React render tree (`main.tsx`) in an
      error boundary component so an unanticipated render-time throw anywhere
      in the tree degrades to a visible fallback UI instead of unmounting the
      entire SPA.
- F7  WHEN the error boundary from F6 catches a render error, THE SYSTEM SHALL
      log the error (e.g. `console.error`) for operator diagnosis without
      re-throwing.

## Unchanged Behavior

- B1  WHEN any fetch call site under F1 receives a 2xx response with a body
      matching its expected shape, THE SYSTEM SHALL CONTINUE TO render using
      that data exactly as today — the fix is a no-op on the happy path.
- B2  WHEN `useFetch` is invoked with `url === null` (`App.tsx`'s auth-gated
      calls, `Surfaces.tsx`'s MCP call), THE SYSTEM SHALL CONTINUE TO skip the
      fetch entirely and return `null` — this is not the F2 error indicator.
- B3  WHEN a fetch's promise rejects at the network/parse level (not an HTTP
      error status), THE SYSTEM SHALL CONTINUE TO be handled by the existing
      `.catch` fallback, which now also produces the F2 error indicator.
- B4  WHEN a component unmounts before its in-flight fetch resolves, THE
      SYSTEM SHALL CONTINUE TO discard the late result — the existing `alive`
      flag guards (`App.tsx:93/102`, `Loop.tsx:33/38`, `Surfaces.tsx:15/20`)
      must remain intact.
- B5  WHEN any already-guarded call site runs — `useAuthGate`
      (`App.tsx:54-60`, decides routing from `r.status` directly), Loop's
      poll/mutate calls (`Loop.tsx:83,88,92,94,124`), or the existing mutation
      calls in Issues/Sched/TerminalPanel/Chat/Login that already check
      `r.ok`/`r.status` — THE SYSTEM SHALL CONTINUE TO behave exactly as
      today. This bugfix must not wrap or alter any already-correct call
      site, especially `useAuthGate`.
- B6  WHEN a 2xx response arrives, THE SYSTEM SHALL CONTINUE TO NOT display
      the F6/F7 error boundary fallback UI — it must never trigger on any
      currently-passing path.
- B7  WHEN `I18nProvider` wraps the tree (`main.tsx:13`), THE SYSTEM SHALL
      CONTINUE TO provide `t()` inside the F6 error boundary's fallback UI (or
      the fallback uses static text if placed outside the provider) — the
      fallback must not itself crash if i18n context is unavailable.
