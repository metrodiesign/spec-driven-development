import type { PrGateProjection } from './pr-quality.ts';
import type { RouteState } from './navigation.ts';
import { translate, type Locale } from './i18n.ts';

export type DashboardDestination = 'system' | 'usage' | 'runs' | 'pr-quality';

export function dashboardRoute(current: RouteState, destination: DashboardDestination): RouteState {
  return { area: 'console', view: destination, project: current.project, item: null };
}

export interface UsageEstimateView {
  readonly label: 'estimate';
  readonly disclaimer: string;
  readonly moneyDisclaimer: string;
  readonly currentWindow: { readonly start: string; readonly end: string; readonly entryCount: number } | null;
  readonly windowsLast7Days: number;
  readonly weekly:
    | { readonly available: true; readonly sinceReset: string; readonly entryCount: number; readonly calibratedPercent?: number }
    | { readonly available: false; readonly needed: string };
}

export function usageEstimateLines(usage: UsageEstimateView, locale: Locale = 'en'): readonly string[] {
  const calibration = usage.weekly.available && usage.weekly.calibratedPercent !== undefined
    ? translate(locale, 'usageCalibrated', { percent: usage.weekly.calibratedPercent })
    : '';
  return [
    usage.currentWindow === null
      ? translate(locale, 'usageNoActiveWindow')
      : translate(locale, 'usageCurrentWindow', { count: usage.currentWindow.entryCount }),
    translate(locale, 'usageWindowsLast7Days', { count: usage.windowsLast7Days }),
    usage.weekly.available
      ? translate(locale, 'usageWeeklyEntries', { count: usage.weekly.entryCount, calibration })
      : usage.weekly.needed,
  ];
}

export function latestPrQuality(runs: readonly PrGateProjection[]): PrGateProjection | null {
  return [...runs].sort((left, right) => {
    const updated = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
    return updated !== 0 ? updated : right.runId.localeCompare(left.runId);
  })[0] ?? null;
}
