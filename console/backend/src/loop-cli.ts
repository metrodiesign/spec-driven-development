// `platform loop run` support (REQ-8.1 edge-parse, REQ-11.3 live guards). The
// composition root parses goal.yaml HERE (the `yaml` dep lives in the console,
// keeping core zero-dependency) and hands core the validated object + raw bytes.
// Live runs are gated STRUCTURALLY, not just by procedure.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { freezeContract, type TaskContract } from 'core';

/** Parse goal.yaml at the edge and freeze it by raw-byte hash in core (REQ-8.1). */
export function loadGoalContract(path: string): TaskContract {
  const rawBytes = readFileSync(path);
  const parsed: unknown = parseYaml(rawBytes.toString('utf8'));
  return freezeContract(rawBytes, parsed);
}

export interface LiveGuardInput {
  live: boolean;
  ciEnv: boolean;
  isTTY: boolean;
}

export type LiveGuardDecision =
  | { action: 'stub' } // default: FakeAdapter, CI-safe
  | { action: 'refuse'; reason: string }
  | { action: 'confirm'; prompt: string }; // proceed only after a typed confirmation phrase

/**
 * Structural live-run guard (REQ-11.3): --live refuses in CI or without a TTY, so
 * no automated path can reach the real adapter even by mistake; otherwise it
 * requires a typed confirmation phrase (an accountability record, not a security
 * boundary — see requirements Edge Cases).
 */
export function decideLiveRun(input: LiveGuardInput): LiveGuardDecision {
  if (!input.live) return { action: 'stub' };
  if (input.ciEnv) return { action: 'refuse', reason: 'refusing --live: CI environment detected (no quota spend in CI)' };
  if (!input.isTTY) return { action: 'refuse', reason: 'refusing --live: stdin is not a TTY (interactive confirmation required)' };
  return { action: 'confirm', prompt: 'type RUN-LIVE to confirm a real quota-spending run:' };
}

export const LIVE_CONFIRM_PHRASE = 'RUN-LIVE';

/** Claude Code munges a session cwd into its ~/.claude/projects dir name: every non-alphanumeric char becomes '-'. */
export function mungeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Newest persisted live ConformanceRecord in `.ai/calibration/` (REQ-12.4: the live
 * loop registers only through a REAL record — never a synthetic pass). Filenames
 * embed an ISO timestamp, so lexicographic order is chronological.
 */
export function latestConformanceRecordPath(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((n) => /^conformance-.+\.json$/.test(n))
    .sort();
  const last = names.at(-1);
  return last === undefined ? null : join(dir, last);
}

/**
 * Guarded read of a persisted ConformanceRecord — a corrupt or hand-edited file
 * returns null (caller refuses with guidance BEFORE the typed confirmation, so
 * the failure is never a cryptic post-confirm crash).
 */
export function readConformanceRecord(path: string): { adapterId: string; probes: unknown[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { adapterId?: unknown; probes?: unknown } | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.adapterId !== 'string' || !Array.isArray(parsed.probes)) return null;
    return parsed as { adapterId: string; probes: unknown[] };
  } catch {
    return null;
  }
}
