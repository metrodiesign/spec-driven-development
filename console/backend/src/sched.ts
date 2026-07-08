// F-Sched (spec §8, REQ-16). Starts/stops the platform loop process or an
// allowlisted opaque script under the SAME quota guard `platform loop run
// --live` already uses (`decideAutomationStart`, reused unchanged) — no task
// scheduling, no lease, exactly one registered child at a time (REQ-16.1).

import type { AutomationDecision } from './guards.ts';

export interface SchedDecideInput {
  running: boolean;
  automation: AutomationDecision;
  confirmed: boolean;
}

export type SchedDecision =
  | { ok: true }
  | { refuse: true; reason: 'already_running' | 'automation_deferred' | 'needs_confirmation' };

/**
 * REQ-16.2/16.3/16.6. A KNOWN over-threshold estimate (`quota_threshold`) never
 * yields to a confirm click — overriding a MEASURED limit from a web click
 * would silently loosen it. An UNAVAILABLE estimate (`estimate_unavailable` —
 * today's only reachable case; F-Sched has no more of a real fiveHour/weekly
 * formula than the CLI does) has no number to distrust further, so the
 * two-step confirm token is the web analog of the CLI's
 * `--force-quota-override` (REQ-16.3's "confirm-token override flow").
 */
export function decideSchedStart(input: SchedDecideInput): SchedDecision {
  if (input.running) return { refuse: true, reason: 'already_running' };
  const { automation } = input;
  if ('ok' in automation) return { ok: true };
  if (automation.reason === 'quota_threshold') return { refuse: true, reason: 'automation_deferred' };
  return input.confirmed ? { ok: true } : { refuse: true, reason: 'needs_confirmation' };
}

/**
 * REQ-16.7/16.9: exact-name match only, against the allowlist read from the
 * governed `routing.json`. A traversal attempt ('../x', 'a/../b') simply never
 * equals a real allowlisted name — no separate sanitization needed.
 */
export function scriptAllowed(name: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(name);
}

// --- Thin runtime: exactly one tracked child (REQ-16.1/16.5/16.6) ---

export interface ChildLike {
  readonly pid: number;
  onExit(cb: (code: number | null) => void): void;
  kill(signal?: string): void;
}

export type SpawnChild = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => ChildLike;

export type SchedStatus =
  | { running: true; pid: number; args: string[]; startedAt: number }
  | { running: false; exited?: number | null };

export interface SchedRuntimeDeps {
  spawn: SpawnChild;
  now(): number;
}

export interface SchedRuntime {
  /** Callers gate on `decideSchedStart` first; throws if one slips through anyway. */
  start(file: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }): { pid: number };
  /** SIGTERM the registered child (REQ-16.6). False if none is running. */
  stop(): boolean;
  status(): SchedStatus;
}

export function createSchedRuntime(deps: SchedRuntimeDeps): SchedRuntime {
  let current: { child: ChildLike; args: string[]; startedAt: number } | null = null;
  let exited: number | null | undefined;

  return {
    start(file, args, opts) {
      if (current !== null) throw new Error('sched: a child is already registered');
      const child = deps.spawn(file, args, opts);
      current = { child, args, startedAt: deps.now() };
      child.onExit((code) => {
        exited = code; // REQ-16.5: no auto-respawn — restart is a human action
        current = null;
      });
      return { pid: child.pid };
    },

    stop() {
      if (current === null) return false;
      current.child.kill('SIGTERM');
      return true;
    },

    status() {
      if (current !== null) {
        return { running: true, pid: current.child.pid, args: current.args, startedAt: current.startedAt };
      }
      return exited === undefined ? { running: false } : { running: false, exited };
    },
  };
}
