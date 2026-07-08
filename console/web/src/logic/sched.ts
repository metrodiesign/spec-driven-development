// Pure display logic for F-Sched (REQ-16): status projection + automation-defer
// copy + start-response interpretation. Testable without a DOM (Loop.tsx follows
// the same split — the view stays thin).

export type SchedStatus =
  | { running: true; pid: number; args: string[]; startedAt: number }
  | { running: false; exited?: number | null };

/** One line for the status card — mirrors the backend's exact status shape. */
export function schedStatusLabel(status: SchedStatus): string {
  if (status.running) return `running (pid ${status.pid})`;
  if (status.exited === undefined) return 'idle';
  return `idle (last exit code ${status.exited})`;
}

export interface AutomationDecision {
  reason?: 'quota_threshold' | 'estimate_unavailable';
  window?: 'fiveHour' | 'weekly';
  percent?: number;
  until?: string;
}

/**
 * Copy for the 428 confirm dialog — mirrors the backend's decideSchedStart
 * reasoning (server/sched.ts): a KNOWN over-threshold estimate never yields to
 * confirm; an unavailable estimate does (the web analog of --force-quota-override).
 */
export function automationHint(automation: AutomationDecision): string {
  if (automation.reason === 'quota_threshold') {
    const where = automation.window !== undefined ? ` (${automation.window} at ${automation.percent ?? '?'}%)` : '';
    const wait = automation.until !== undefined ? ` — wait until ${automation.until}` : '';
    return `quota is over a KNOWN threshold${where}; confirming cannot override this${wait}, or recalibrate in Usage`;
  }
  return 'no quota estimate is available to check — confirming starts it anyway, same as --force-quota-override';
}

export type StartOutcome =
  | { kind: 'started'; pid: number; args: string[] }
  | { kind: 'needs_confirmation'; automation: AutomationDecision; confirmToken: string }
  | { kind: 'refused'; reason: string };

interface StartResponseBody {
  pid?: number;
  args?: string[];
  error?: string;
  automation?: AutomationDecision;
  confirmToken?: string;
}

/** Interpret POST /api/sched/start's status + body into a display-ready outcome. */
export function interpretStartResponse(status: number, body: StartResponseBody): StartOutcome {
  if (status === 200) return { kind: 'started', pid: body.pid ?? 0, args: body.args ?? [] };
  if (status === 428 && body.automation !== undefined && body.confirmToken !== undefined) {
    return { kind: 'needs_confirmation', automation: body.automation, confirmToken: body.confirmToken };
  }
  return { kind: 'refused', reason: body.error ?? `http ${status}` };
}
