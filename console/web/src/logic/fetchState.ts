// Pure fetch-result classification (bugfix-console-fetch-status F1/F2). A
// non-2xx response must never be treated as success data — the view stays
// thin, same split as logic/auth.ts.

export type FetchState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'data'; readonly value: T };

export const FETCH_LOADING: FetchState<never> = { kind: 'loading' };
export const FETCH_ERROR: FetchState<never> = { kind: 'error' };

/**
 * WHEN a response is not ok, THE SYSTEM SHALL treat it as an error and SHALL
 * NOT surface the parsed body as data (F1) — the error indicator is
 * distinguishable from both `FETCH_LOADING` and a `'data'` result (F2),
 * regardless of what shape the error body happens to be (the backend returns
 * at least two different shapes for a non-ok response; neither is trusted).
 */
export function fetchStateFromResponse<T>(ok: boolean, body: T): FetchState<T> {
  return ok ? { kind: 'data', value: body } : FETCH_ERROR;
}
