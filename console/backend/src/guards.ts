// Automation guard (spec §10.2, REQ-16, INV-13). A PURE, scheduler-agnostic
// decision function: every autonomous entry point (`platform loop run --live`,
// `platform conformance --live`, and F-Sched in Phase 3) evaluates the local
// usage estimate against a policy threshold BEFORE constructing any adapter, so
// automation never burns the interactive window. The guard decides; the
// composition root records the event + exits. Keeping it pure and free of the
// event log / process is what lets Phase-3 F-Sched reuse it unchanged (REQ-16.5).

import { readFileSync } from 'node:fs';

/** Per-window usage estimate (AZ-19): five-hour + weekly, never one collapsed number. */
export interface AutomationEstimate {
  fiveHourPct: number;
  weeklyPct: number;
}

/** Reset times per window, for the defer-until-reset hint (REQ-16.2). */
export interface WindowResets {
  fiveHour?: string;
  weekly?: string;
}

export interface AutomationDecideInput {
  /** `{fiveHourPct, weeklyPct}` from the console usage estimator, or `null` when unavailable. */
  estimate: AutomationEstimate | null;
  /** Defer when the estimate's max window meets/exceeds this (default 85%). */
  thresholdPercent: number;
  /** `--force-quota-override`: bypasses the refusal ONLY — hard budget caps still apply (REQ-16.4). */
  override: boolean;
  resets?: WindowResets;
}

export type AutomationDecision =
  | { ok: true; overridden: boolean }
  | {
      defer: true;
      reason: 'quota_threshold' | 'estimate_unavailable';
      window?: 'fiveHour' | 'weekly';
      percent?: number;
      until?: string;
    };

/**
 * REQ-16.2/16.4/16.6. Refuse a live autonomous run when the estimate's MAX window
 * meets/exceeds the threshold; a null estimate defers fail-closed
 * (`estimate_unavailable`, AZ-10); `--force-quota-override` bypasses exactly the
 * refusal (and nothing else — the hard budget caps live in the loop). `until` is
 * the reset time of the window that tripped (REQ-16.2), when known.
 */
export function decideAutomationStart(input: AutomationDecideInput): AutomationDecision {
  // Override bypasses the refusal only (REQ-16.4) — the flag is an explicit,
  // logged operator decision; the composition root records AUTOMATION_OVERRIDE.
  if (input.override) return { ok: true, overridden: true };
  // A missing estimate (no transcripts / estimator failure) is fail-closed (REQ-16.6).
  if (input.estimate === null) return { defer: true, reason: 'estimate_unavailable' };

  const { fiveHourPct, weeklyPct } = input.estimate;
  const max = Math.max(fiveHourPct, weeklyPct);
  if (max >= input.thresholdPercent) {
    const window: 'fiveHour' | 'weekly' = fiveHourPct >= weeklyPct ? 'fiveHour' : 'weekly';
    const out: Extract<AutomationDecision, { defer: true }> = {
      defer: true,
      reason: 'quota_threshold',
      window,
      percent: max,
    };
    const until = input.resets?.[window];
    if (until !== undefined) out.until = until;
    return out;
  }
  return { ok: true, overridden: false };
}

export interface AutomationConfig {
  thresholdPercent: number;
  /** Default model for autonomous runs — Sonnet keeps Opus for interactive (REQ-16.3). */
  autonomousModel: string;
  /** Production audit sample rate (REQ-8.1); the CI fixture overrides to 100 (REQ-18.4). */
  auditSampleRate: number;
}

const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  thresholdPercent: 85,
  autonomousModel: 'sonnet',
  auditSampleRate: 25,
};

/**
 * Parse `.ai/policies/automation.json`. A missing/corrupt file falls back to the
 * conservative defaults (an absent policy never loosens a bound). The raw bytes
 * are what governance hashes; this loader only reads the tuned numbers.
 */
export function loadAutomationConfig(path: string): AutomationConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AutomationConfig>;
    return {
      thresholdPercent:
        typeof parsed.thresholdPercent === 'number' ? parsed.thresholdPercent : DEFAULT_AUTOMATION_CONFIG.thresholdPercent,
      autonomousModel:
        typeof parsed.autonomousModel === 'string' ? parsed.autonomousModel : DEFAULT_AUTOMATION_CONFIG.autonomousModel,
      auditSampleRate:
        typeof parsed.auditSampleRate === 'number' ? parsed.auditSampleRate : DEFAULT_AUTOMATION_CONFIG.auditSampleRate,
    };
  } catch {
    return { ...DEFAULT_AUTOMATION_CONFIG };
  }
}
