# Implementation Tasks: bugfix-console-fetch-status — fetch HTTP-status guard + error boundary
> Status: approved 2026-07-09

> Bugfix spec: bugfix.md. Both tasks are frontend-only (console/web), no backend changes.
> Task 2 is a deliberately separate commit from task 1 (user decision — defense-in-depth
> for the whole crash class, not the same change as the direct root-cause fix).

- [x] 1. Fetch-status guard across console/web — extract a pure decision helper
      (co-located under `console/web/src/logic/`, DOM-free, unit-testable like
      `logic/theme.ts`/`logic/i18n.ts`) that turns `(ok: boolean, body: unknown)`
      into a distinct error-vs-data result; build one shared `useFetch<T>` hook on
      top of it and have `App.tsx`, `Loop.tsx`, `Surfaces.tsx` import it instead of
      their three byte-identical local copies; apply the same ok-check +
      distinct-error-state contract inline to the hand-rolled fetches in
      `Issues.tsx`, `Chat.tsx`, `Sched.tsx`, `TerminalPanel.tsx`; update every
      consumer listed in bugfix.md's call-site table to branch on the new error
      state and render a visible "unavailable" block instead of an unguarded
      `.length`/`.map`/property access. Must not touch already-guarded call sites
      (`useAuthGate`, Loop's poll/mutate, existing mutation calls in
      Issues/Sched/TerminalPanel/Chat/Login) — they stay exactly as-is.
      Satisfies: F1, F2, F3, F4, F5, B1, B2, B3, B4, B5, B6.
      Verify: `pnpm -C console/web test && pnpm -r typecheck`.
      Evidence:
        - test: `pnpm -C console/web test` -> 70 passed / 0 failed (5 new in
          `logic/fetchState.test.ts`: ok response yields a data state carrying
          the body, a non-ok response never surfaces the body for both the
          Fastify-default `{message,error,statusCode}` shape and the custom
          `{error}` shape, all three states pairwise distinguishable, and a
          direct repro test proving a non-ok result never throws
          `Cannot read properties of undefined` the way the old ungated
          `useFetch` did; all 65 pre-existing tests stayed green unchanged)
        - test: `pnpm -r typecheck` -> 6/6 packages clean
        - other: `pnpm lint` -> no issues
        - viewports: n/a — no responsive/viewport claim; browser-verified
          interactively instead (see below), not by viewport
        - browser: built `console/web` (`vite build`) and served it through a
          REAL `buildApp` (no mocks, no `loopRunsRoot`/`issuesDir`/`auth` wired
          — the exact repro condition from bugfix.md) on
          `http://127.0.0.1:9879/` via a throwaway fixture script
          (`console/backend/scratch-verify-bugA.ts`, deleted after use — never
          touched the user's real `~/.claude`/`~/.platform`). Confirmed via
          chrome-devtools MCP: the full page loads top to bottom with NO blank
          screen; the Loop/Sched/Issues sections (whose backing routes 404 in
          this fixture) each render the new `"unavailable — try again later"`
          text instead of throwing; every other section (CLI status, Usage,
          Projects, Governance surfaces) renders normally since their routes
          have no dir-wiring dependency. Console showed only the 4 expected
          network 404s (Loop/Issues/Sched routes genuinely absent, by design of
          this fixture) and one pre-existing, unrelated a11y advisory (a form
          field missing `id`/`name` — not touched by this task); zero JS
          errors, zero uncaught exceptions.
        - deviations: none from bugfix.md. `auth.kind==='data'` gating also
          fixed two "flaw but not crash" sites bugfix.md didn't itemize as
          separate F-IDs (the `/api/auth` shadowing banner and Surfaces'
          `doctor` line both used to tolerate an error-shaped body silently as
          if it were real data — e.g. the auth banner could show a false "ok"
          state on a fetch failure); both now correctly show nothing on error
          rather than misleading content, a natural consequence of the same
          `.kind==='data'` guard applied everywhere, not a separate change.

- [ ] 2. Root error boundary — add a minimal class-component error boundary
      (`getDerivedStateFromError`/`componentDidCatch`, logs via `console.error`,
      never re-throws) and wrap `<App/>` with it in `main.tsx`, placed so its
      fallback UI can still call `t()` from `I18nProvider`. Defense-in-depth for
      the whole crash class (any future render throw), not only the fetch paths
      task 1 fixes.
      Satisfies: F6, F7, B7. Depends on: none.
      Verify: `pnpm -r typecheck && pnpm -r build`, plus a browser-verify pass
      (chrome-devtools MCP against a real `buildApp` fixture forcing a render
      throw — e.g. an intentionally malformed fixture response) confirming the
      fallback renders instead of a blank page. This claim is UI-observable-only;
      no DOM/component test infra exists in this repo (confirmed during
      investigation — `console/web`'s test runner covers only `src/logic/**`), so
      it is proven live per
      `.claude/skills/spec-implement/references/browser-verify.md` rather than by
      adding a new test dependency for one boundary component.
