// Driving side of the LoopControl port (REQ-10). The Human Plane calls
// requestPause/Resume/Kill; the loop polls `port` at iteration boundaries and, when
// pausing, awaits `port.waitResume()`. The loop is single-threaded: a signal can
// only arrive while the loop is yielded (at the resume await or between async
// actions), so a plain mutable signal + one resume resolver is race-free here.

import type { LoopControl } from '../ports.ts';

export interface LoopController {
  /** The port the loop polls (REQ-10.1). */
  port: LoopControl;
  requestPause(): void;
  requestResume(): void;
  requestKill(): void;
}

export function createLoopController(): LoopController {
  let signal: 'none' | 'pause' | 'kill' = 'none';
  let resumeResolve: ((v: 'resume' | 'kill') => void) | null = null;

  return {
    port: {
      poll: () => signal,
      waitResume: () =>
        new Promise<'resume' | 'kill'>((resolve) => {
          // Kill may have arrived before the loop reached the await (REQ-10.7).
          if (signal === 'kill') {
            resolve('kill');
            return;
          }
          resumeResolve = resolve;
        }),
    },
    requestPause() {
      if (signal !== 'kill') signal = 'pause'; // kill is terminal
    },
    requestResume() {
      if (signal === 'kill') return;
      signal = 'none';
      const r = resumeResolve;
      resumeResolve = null;
      r?.('resume');
    },
    requestKill() {
      signal = 'kill';
      const r = resumeResolve;
      resumeResolve = null;
      r?.('kill');
    },
  };
}
