// Shared fetch hook (bugfix-console-fetch-status F4) — replaces the three
// byte-identical local copies that used to live in App.tsx/Loop.tsx/
// Surfaces.tsx. React-specific (useState/useEffect), so it stays out of
// logic/ (DOM-free by convention there) — same split rationale as
// I18nContext.tsx next to logic/i18n.ts.

import { useEffect, useState } from 'react';

import { fetchStateFromResponse, FETCH_LOADING, FETCH_ERROR, type FetchState } from './logic/fetchState.ts';

export function useFetch<T>(url: string | null): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>(FETCH_LOADING);
  useEffect(() => {
    if (url === null) return;
    let alive = true;
    fetch(url)
      .then((r) =>
        r.json().then((body: T) => {
          if (alive) setState(fetchStateFromResponse(r.ok, body));
        }),
      )
      .catch(() => {
        if (alive) setState(FETCH_ERROR);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return state;
}
