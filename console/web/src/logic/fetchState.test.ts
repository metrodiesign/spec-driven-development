import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchStateFromResponse, FETCH_LOADING, FETCH_ERROR, type FetchState } from './fetchState.ts';

test('fetchStateFromResponse: ok response yields a data state carrying the body (F1 happy path, B1)', () => {
  assert.deepEqual(fetchStateFromResponse(true, { runs: [] }), { kind: 'data', value: { runs: [] } });
});

test('fetchStateFromResponse: non-ok response never surfaces the body, even a Fastify-shaped 404 (F1/F2)', () => {
  // The exact body shape console/backend/src/app.ts's default 404 handler returns.
  const fastifyDefault404 = { message: 'Route GET:/api/loop/runs not found', error: 'Not Found', statusCode: 404 };
  assert.deepEqual(fetchStateFromResponse(false, fastifyDefault404), { kind: 'error' });
});

test('fetchStateFromResponse: non-ok response never surfaces the body, even the custom {error} 4xx shape (F1/F2)', () => {
  assert.deepEqual(fetchStateFromResponse(false, { error: 'bad request' }), { kind: 'error' });
});

test('FETCH_LOADING/FETCH_ERROR/data are three distinct, distinguishable states (F2)', () => {
  const states: FetchState<{ runs: unknown[] }>[] = [FETCH_LOADING, FETCH_ERROR, fetchStateFromResponse(true, { runs: [] })];
  const kinds = states.map((s) => s.kind);
  assert.deepEqual(kinds, ['loading', 'error', 'data']);
  assert.equal(new Set(kinds).size, 3, 'all three kinds must be pairwise distinct');
});

// Repro test (RED before the fix, GREEN after): reproduces the exact defect
// from bugfix.md — consuming `.runs.length` on whatever fetchStateFromResponse
// returns for an error response must never throw the way the old
// `useFetch<T>` (no r.ok check) did when it handed a Fastify 404 body straight
// to a consumer expecting `{ runs: RunSummary[] }`.
test('repro: consuming a non-ok result never throws Cannot read properties of undefined (F1)', () => {
  const fastifyDefault404 = { message: 'Route GET:/api/loop/runs not found', error: 'Not Found', statusCode: 404 };
  const state = fetchStateFromResponse<{ runs: unknown[] }>(false, fastifyDefault404 as unknown as { runs: unknown[] });
  assert.doesNotThrow(() => {
    if (state.kind === 'data') {
      // Only reachable on a genuine ok response — the old bug reached here on a 404 too.
      void state.value.runs.length;
    }
  });
  assert.equal(state.kind, 'error');
});
