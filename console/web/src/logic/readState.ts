export type ReadState<T> =
  | { readonly kind: 'idle'; readonly previous: T | null }
  | { readonly kind: 'loading'; readonly previous: T | null }
  | { readonly kind: 'data'; readonly value: T; readonly readAt: string; readonly stale: false }
  | {
      readonly kind: 'error';
      readonly previous: T | null;
      readonly readAt: string | null;
      readonly stale: boolean;
      readonly reason: string;
    };

export interface RequestIdentity {
  readonly sourceKey: string;
  readonly generation: number;
}

export interface ReadModel<T> {
  readonly state: ReadState<T>;
  readonly sourceKey: string | null;
  readonly active: RequestIdentity | null;
  readonly generation: number;
  readonly lastReadAt: string | null;
}

export interface StartedRead<T> {
  readonly model: ReadModel<T>;
  readonly identity: RequestIdentity | null;
}

export function createReadModel<T>(): ReadModel<T> {
  return { state: { kind: 'idle', previous: null }, sourceKey: null, active: null, generation: 0, lastReadAt: null };
}

function previousValue<T>(state: ReadState<T>): T | null {
  if (state.kind === 'data') return state.value;
  return state.previous;
}

export function sameRequest(left: RequestIdentity | null, right: RequestIdentity): boolean {
  return left?.sourceKey === right.sourceKey && left.generation === right.generation;
}

export function beginRead<T>(current: ReadModel<T>, sourceKey: string): StartedRead<T> {
  if (current.active?.sourceKey === sourceKey) return { model: current, identity: null };
  const sameSource = current.sourceKey === sourceKey;
  const identity = { sourceKey, generation: current.generation + 1 };
  return {
    identity,
    model: {
      state: { kind: 'loading', previous: sameSource ? previousValue(current.state) : null },
      sourceKey,
      active: identity,
      generation: identity.generation,
      lastReadAt: sameSource ? current.lastReadAt : null,
    },
  };
}

export function completeRead<T>(
  current: ReadModel<T>,
  identity: RequestIdentity,
  value: T,
  readAt: string,
): ReadModel<T> {
  if (!sameRequest(current.active, identity)) return current;
  return {
    ...current,
    state: { kind: 'data', value, readAt, stale: false },
    active: null,
    lastReadAt: readAt,
  };
}

export function failRead<T>(current: ReadModel<T>, identity: RequestIdentity, reason: string): ReadModel<T> {
  if (!sameRequest(current.active, identity)) return current;
  const previous = previousValue(current.state);
  return {
    ...current,
    state: { kind: 'error', previous, readAt: current.lastReadAt, stale: previous !== null, reason },
    active: null,
  };
}

export function cancelRead<T>(current: ReadModel<T>, identity: RequestIdentity): ReadModel<T> {
  if (!sameRequest(current.active, identity)) return current;
  const previous = previousValue(current.state);
  return {
    ...current,
    state:
      previous !== null && current.lastReadAt !== null
        ? { kind: 'data', value: previous, readAt: current.lastReadAt, stale: false }
        : { kind: 'idle', previous: null },
    active: null,
  };
}

export function shouldPoll(mounted: boolean, visible: boolean, inFlight: boolean): boolean {
  return mounted && visible && !inFlight;
}

export function boundedPageLimit(requested: number): number {
  if (!Number.isFinite(requested)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(requested)));
}

export function mergeBySequence<T extends { readonly seq: number }>(
  current: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  const bySequence = new Map<number, T>();
  for (const record of current) bySequence.set(record.seq, record);
  for (const record of incoming) bySequence.set(record.seq, record);
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}
