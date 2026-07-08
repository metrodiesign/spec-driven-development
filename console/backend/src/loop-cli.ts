// `platform loop run` support (REQ-8.1 edge-parse, REQ-11.3 live guards). The
// composition root parses goal.yaml HERE (the `yaml` dep lives in the console,
// keeping core zero-dependency) and hands core the validated object + raw bytes.
// Live runs are gated STRUCTURALLY, not just by procedure.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { freezeContract, type TaskContract } from 'core';
import { PASS_FAIL_PROBES, type ConformanceRecord } from 'aal';

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
/**
 * `adapterId`, when given, restricts the glob to that lineage's own records
 * (`conformance-<adapterId>-*.json`) — otherwise a second lineage's conformance run
 * (e.g. Codex, task 13) can outrank an older-but-relevant record by raw timestamp
 * alone, handing the caller a record for an adapter it isn't even about to construct
 * (live task 13 residual — the CLI's live loop path is Claude-only today).
 */
export function latestConformanceRecordPath(dir: string, adapterId?: string): string | null {
  if (!existsSync(dir)) return null;
  const pattern = adapterId !== undefined ? new RegExp(`^conformance-${adapterId}-.+\\.json$`) : /^conformance-.+\.json$/;
  const names = readdirSync(dir)
    .filter((n) => pattern.test(n))
    .sort();
  const last = names.at(-1);
  return last === undefined ? null : join(dir, last);
}

/**
 * Guarded read of a persisted ConformanceRecord — a corrupt, truncated, or
 * hand-edited file returns null (caller refuses with guidance BEFORE the typed
 * confirmation, never a cryptic post-confirm crash). Validates the FULL shape
 * the registry consumes: every pass/fail probe id present with a boolean `pass`
 * and a non-empty evidenceRef, plus p7 score + evidenceRef.
 */
export function readConformanceRecord(path: string): ConformanceRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed['adapterId'] !== 'string' || typeof parsed['modelVersion'] !== 'string') return null;
    if (typeof parsed['ranAt'] !== 'string') return null;
    const probes = parsed['probes'];
    if (!Array.isArray(probes)) return null;
    const validProbe = (p: unknown): p is { id: string; pass: boolean; evidenceRef: string } =>
      p !== null &&
      typeof p === 'object' &&
      typeof (p as { id?: unknown }).id === 'string' &&
      typeof (p as { pass?: unknown }).pass === 'boolean' &&
      typeof (p as { evidenceRef?: unknown }).evidenceRef === 'string' &&
      (p as { evidenceRef: string }).evidenceRef.length > 0;
    if (!probes.every(validProbe)) return null;
    const ids = new Set(probes.map((p) => p.id));
    if (!PASS_FAIL_PROBES.every((id) => ids.has(id))) return null;
    const p7 = parsed['p7'] as { susceptibilityScore?: unknown; evidenceRef?: unknown } | undefined;
    if (p7 === undefined || p7 === null || typeof p7 !== 'object') return null;
    if (typeof p7.susceptibilityScore !== 'number' || typeof p7.evidenceRef !== 'string' || p7.evidenceRef.length === 0) return null;
    return parsed as unknown as ConformanceRecord;
  } catch {
    return null;
  }
}
