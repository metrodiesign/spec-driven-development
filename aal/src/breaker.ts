// Circuit breaker per (adapterId, modelVersion) key (§10.2, REQ-1). A pure state
// machine — closed -> open (failure rate over a sliding window of recent sends) ->
// half_open (one probe admitted after openMs) -> closed (probe succeeds) / open
// (probe fails). Vendor-name-free (INV-7) with an INJECTED clock: the module never
// reads the wall clock, so transitions are replayable. Transitions emit through an
// injected sink; the composition root maps them to BREAKER_STATE_CHANGED events
// (aal stays log-agnostic like the rest of Ring 1).

import type { AdapterErrorKind } from './protocol.ts';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  /** Recent sends considered when computing the failure rate. */
  windowSize: number;
  /** Failure fraction (0,1] that trips closed -> open once the window is full. */
  failureThreshold: number;
  /** Cooldown after opening before a single half-open probe is admitted. */
  openMs: number;
}

/** One transition, handed to the sink; the composition root stamps the event type. */
export interface BreakerTransition {
  key: string;
  from: BreakerState;
  to: BreakerState;
  at: number;
}

export type BreakerSink = (t: BreakerTransition) => void;

export interface Breaker {
  /** Current state for a key; promotes open -> half_open once openMs has elapsed. */
  state(key: string): BreakerState;
  recordSuccess(key: string): void;
  recordFailure(key: string, kind: AdapterErrorKind): void;
  /** Half-open single-flight: true for exactly one in-flight probe per open window. */
  allowProbe(key: string): boolean;
}

/** The one breaker key shape — shared by the registry and the source. */
export const breakerKey = (adapterId: string, modelVersion: string): string =>
  `${adapterId}@${modelVersion}`;

/** Conservative defaults; the governance-pinned numbers land in automation.json (Task 9). */
export const DEFAULT_BREAKER_OPTIONS: BreakerOptions = {
  windowSize: 5,
  failureThreshold: 0.5,
  openMs: 30_000,
};

interface KeyState {
  status: BreakerState;
  /** true = success; bounded to windowSize most-recent sends. */
  window: boolean[];
  openedAt: number;
  probeInFlight: boolean;
}

export function createBreaker(
  opts: BreakerOptions,
  now: () => number,
  sink: BreakerSink,
): Breaker {
  const keys = new Map<string, KeyState>();

  function ensure(key: string): KeyState {
    let s = keys.get(key);
    if (s === undefined) {
      s = { status: 'closed', window: [], openedAt: 0, probeInFlight: false };
      keys.set(key, s);
    }
    return s;
  }

  function emit(key: string, from: BreakerState, to: BreakerState): void {
    sink({ key, from, to, at: now() });
  }

  /** Time-based open -> half_open promotion (the one transition the clock drives). */
  function promote(key: string, s: KeyState): void {
    if (s.status === 'open' && now() - s.openedAt >= opts.openMs) {
      s.status = 'half_open';
      s.probeInFlight = false;
      emit(key, 'open', 'half_open');
    }
  }

  function tripsOpen(s: KeyState): boolean {
    if (s.window.length < opts.windowSize) return false;
    const failures = s.window.filter((ok) => !ok).length;
    return failures / s.window.length >= opts.failureThreshold;
  }

  return {
    state(key) {
      const s = ensure(key);
      promote(key, s);
      return s.status;
    },

    allowProbe(key) {
      const s = ensure(key);
      promote(key, s);
      if (s.status === 'closed') return true;
      if (s.status === 'open') return false;
      // half_open: admit exactly one probe until its outcome is recorded.
      if (s.probeInFlight) return false;
      s.probeInFlight = true;
      return true;
    },

    recordSuccess(key) {
      const s = ensure(key);
      if (s.status === 'half_open') {
        s.status = 'closed';
        s.window = [];
        s.probeInFlight = false;
        emit(key, 'half_open', 'closed');
        return;
      }
      s.window.push(true);
      if (s.window.length > opts.windowSize) s.window.shift();
    },

    recordFailure(key, _kind) {
      const s = ensure(key);
      if (s.status === 'half_open') {
        // A failed probe re-opens the breaker for another cooldown.
        s.status = 'open';
        s.openedAt = now();
        s.window = [];
        s.probeInFlight = false;
        emit(key, 'half_open', 'open');
        return;
      }
      if (s.status !== 'closed') return; // open: nothing to recompute
      s.window.push(false);
      if (s.window.length > opts.windowSize) s.window.shift();
      if (tripsOpen(s)) {
        s.status = 'open';
        s.openedAt = now();
        s.window = [];
        emit(key, 'closed', 'open');
      }
    },
  };
}
