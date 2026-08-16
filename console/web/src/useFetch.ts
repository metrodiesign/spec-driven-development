import { useCallback, useEffect, useRef, useState } from 'react';

import { FETCH_ERROR, FETCH_LOADING, type FetchState } from './logic/fetchState.ts';
import {
  beginRead,
  cancelRead,
  completeRead,
  createReadModel,
  failRead,
  type ReadModel,
  type ReadState,
} from './logic/readState.ts';

export const AUTH_INVALID_EVENT = 'console-auth-invalid';

const protectedReads = new Set<AbortController>();
let authInvalidSignaled = false;

export function abortProtectedReads(): void {
  for (const controller of protectedReads) controller.abort();
  protectedReads.clear();
}

export function resetAuthInvalidSignal(): void {
  authInvalidSignaled = false;
}

function signalAuthInvalid(): void {
  if (authInvalidSignaled) return;
  authInvalidSignaled = true;
  abortProtectedReads();
  window.dispatchEvent(new Event(AUTH_INVALID_EVENT));
}

export async function protectedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) signalAuthInvalid();
  return response;
}

export interface ReadResult<T> {
  readonly state: ReadState<T>;
  readonly inFlight: boolean;
  readonly retry: () => void;
}

export function useRead<T>(url: string | null): ReadResult<T> {
  const [model, setModel] = useState<ReadModel<T>>(() => createReadModel<T>());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const modelRef = useRef(model);

  useEffect(() => {
    if (url === null) {
      const empty = createReadModel<T>();
      modelRef.current = empty;
      setModel(empty);
      return;
    }

    const started = beginRead(modelRef.current, url);
    if (started.identity === null) return;
    const identity = started.identity;
    modelRef.current = started.model;
    setModel(started.model);

    const controller = new AbortController();
    protectedReads.add(controller);

    void protectedFetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`http ${response.status}`);
        const body = (await response.json()) as T;
        const next = completeRead(modelRef.current, identity, body, new Date().toISOString());
        if (next !== modelRef.current) {
          modelRef.current = next;
          setModel(next);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = error instanceof Error ? error.message : 'read failed';
        const next = failRead(modelRef.current, identity, reason);
        if (next !== modelRef.current) {
          modelRef.current = next;
          setModel(next);
        }
      })
      .finally(() => {
        protectedReads.delete(controller);
      });

    return () => {
      controller.abort();
      protectedReads.delete(controller);
      modelRef.current = cancelRead(modelRef.current, identity);
    };
  }, [retryGeneration, url]);

  return {
    state: model.state,
    inFlight: model.active !== null,
    retry: useCallback(() => setRetryGeneration((value) => value + 1), []),
  };
}

/** Compatibility adapter for existing Console panels while they move to richer read state. */
export function useFetch<T>(url: string | null): FetchState<T> {
  const { state } = useRead<T>(url);
  if (state.kind === 'data') return { kind: 'data', value: state.value };
  if (state.kind === 'error') return FETCH_ERROR;
  return FETCH_LOADING;
}
