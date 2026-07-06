// Quota estimate (spec §5.3, REQ-15, INV-13). Estimates come from LOCAL
// transcript timestamps only; caps are NEVER hardcoded; weekly figures require
// an operator-entered reset anchor. Every monetary figure carries the
// "API-equivalent value — not an actual bill" label upstream.

export const ESTIMATE_DISCLAIMER =
  'estimate from local transcripts — official numbers: /usage in the CLI or Settings > Usage';
export const MONEY_DISCLAIMER = 'API-equivalent value — not an actual bill';

export interface UsageConfig {
  /** ISO timestamp of a known weekly reset moment, operator-entered (§5.3). */
  weeklyResetAnchor?: string;
  /** Operator-entered calibration: actual % shown by the official UI. */
  calibratedPercent?: number;
}

export interface FiveHourWindow {
  start: string;
  end: string;
  entryCount: number;
}

/**
 * Group timestamps into rolling 5-hour windows the way the plan meters them:
 * a window opens at the first prompt after the previous window closes.
 */
export function fiveHourWindows(sortedIso: string[], windowMs = 5 * 60 * 60 * 1000): FiveHourWindow[] {
  const windows: FiveHourWindow[] = [];
  let windowStart: number | null = null;
  let count = 0;
  for (const iso of sortedIso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (windowStart === null || t >= windowStart + windowMs) {
      if (windowStart !== null) {
        windows.push({
          start: new Date(windowStart).toISOString(),
          end: new Date(windowStart + windowMs).toISOString(),
          entryCount: count,
        });
      }
      windowStart = t;
      count = 0;
    }
    count += 1;
  }
  if (windowStart !== null) {
    windows.push({
      start: new Date(windowStart).toISOString(),
      end: new Date(windowStart + windowMs).toISOString(),
      entryCount: count,
    });
  }
  return windows;
}

export interface UsageEstimate {
  label: 'estimate';
  disclaimer: string;
  currentWindow: FiveHourWindow | null;
  windowsLast7Days: number;
  weekly:
    | { available: true; sinceReset: string; entryCount: number; calibratedPercent?: number }
    | { available: false; needed: string };
}

export function buildEstimate(sortedIso: string[], config: UsageConfig, nowMs: number): UsageEstimate {
  const windows = fiveHourWindows(sortedIso);
  const last = windows[windows.length - 1];
  const current = last !== undefined && Date.parse(last.end) > nowMs ? last : null;
  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
  const recentWindows = windows.filter((w) => Date.parse(w.start) >= sevenDaysAgo).length;

  let weekly: UsageEstimate['weekly'];
  if (config.weeklyResetAnchor === undefined || Number.isNaN(Date.parse(config.weeklyResetAnchor))) {
    weekly = {
      available: false,
      needed:
        'weekly estimate needs your reset time: enter the reset moment shown in the official ' +
        'usage UI (PUT /api/usage/config { "weeklyResetAnchor": "<ISO>" })',
    };
  } else {
    const anchor = Date.parse(config.weeklyResetAnchor);
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    // Most recent reset at or before now, on the anchor's weekly rhythm.
    const periods = Math.floor((nowMs - anchor) / weekMs);
    const sinceReset = anchor + periods * weekMs;
    const entryCount = sortedIso.filter((iso) => {
      const t = Date.parse(iso);
      return !Number.isNaN(t) && t >= sinceReset && t <= nowMs;
    }).length;
    weekly = {
      available: true,
      sinceReset: new Date(sinceReset).toISOString(),
      entryCount,
      ...(config.calibratedPercent !== undefined
        ? { calibratedPercent: config.calibratedPercent }
        : {}),
    };
  }

  return {
    label: 'estimate',
    disclaimer: ESTIMATE_DISCLAIMER,
    currentWindow: current,
    windowsLast7Days: recentWindows,
    weekly,
  };
}
