// `platform loop run` support (REQ-8.1 edge-parse, REQ-11.3 live guards). The
// composition root parses goal.yaml HERE (the `yaml` dep lives in the console,
// keeping core zero-dependency) and hands core the validated object + raw bytes.
// Live runs are gated STRUCTURALLY, not just by procedure.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import {
  freezeContract,
  type OfflineDependencyPolicy,
  type Role,
  type TaskContract,
} from 'core';
import { PASS_FAIL_PROBES, type ConformanceRecord } from 'aal';

import { validateGoalShape } from './goal-schema.ts';
import { validateTaskGraphShape } from './task-graph-schema.ts';

/**
 * Parse goal.yaml at the edge and freeze it by raw-byte hash in core (REQ-8.1).
 * Schema validation runs here first (phase5-stage2 REQ-2.1) — shape errors surface
 * with every failing path (REQ-2.2) before freeze; freezeContract stays the final
 * semantic gate (REQ-2.4).
 */
export function loadGoalContract(path: string): TaskContract {
  const rawBytes = readFileSync(path);
  const parsed: unknown = parseYaml(rawBytes.toString('utf8'));
  const shapeErrors = validateGoalShape(parsed);
  if (shapeErrors.length > 0) {
    throw new Error(`goal file failed schema validation:\n  ${shapeErrors.join('\n  ')}`);
  }
  return freezeContract(rawBytes, parsed);
}

/**
 * The promoted task graph sitting next to goal.yaml, or undefined when there is none
 * (phase5-stage4 REQ-4.10). ONLY `task-graph.json` is read: a generated
 * `task-graph.draft.json` is invisible here by construction, so a draft can never
 * start a run (REQ-4.7 — promotion stays a human rename, INV-3/INV-16). Shape errors
 * throw HERE, before a run opens, so a human sees every failing path at once; the
 * semantic planning gate belongs to the run itself (REQ-4.8/D5), which is why this
 * returns the raw bytes alongside the parsed object rather than freezing.
 */
export function loadTaskGraphOption(goalPath: string): { rawBytes: Uint8Array; parsed: unknown } | undefined {
  const path = join(dirname(goalPath), 'task-graph.json');
  if (!existsSync(path)) return undefined;
  const rawBytes = readFileSync(path);
  const parsed: unknown = JSON.parse(rawBytes.toString('utf8'));
  const shapeErrors = validateTaskGraphShape(parsed);
  if (shapeErrors.length > 0) {
    throw new Error(`task graph file failed schema validation:\n  ${shapeErrors.join('\n  ')}`);
  }
  return { rawBytes, parsed };
}

const PHASE0_ROLES = new Set<Role>([
  'planner',
  'test_designer',
  'implementer',
  'diagnostician',
  'reviewer',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.split('/').some((component) => component === '' || component === '.' || component === '..')
  );
}

/**
 * Parse the governance-pinned minimal offline dependency policy at the production
 * edge. An invalid or missing policy fails closed before adapter construction; the
 * returned object can authorize only exact, lifecycle-disabled, network:none installs.
 */
export function loadOfflineDependencyPolicy(path: string): OfflineDependencyPolicy {
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `offline dependency policy unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const raw = isRecord(root) ? root['offlineDependency'] : undefined;
  if (!isRecord(raw)) {
    throw new Error('security-plane offlineDependency policy is missing');
  }
  const allowedRoles = raw['allowedRoles'];
  const commands = raw['commands'];
  const manifestPath = raw['manifestPath'];
  const manifestHash = raw['manifestHash'];
  const lockfilePath = raw['lockfilePath'];
  const lockfileHash = raw['lockfileHash'];
  const approvedSourceHashes = raw['approvedSourceHashes'];
  const approvedSources = raw['approvedSources'];
  const approvedOutputMetadata = raw['approvedOutputMetadata'];
  const persistentOutputRoots = raw['persistentOutputRoots'];
  if (
    raw['version'] !== 1 ||
    !isStringArray(allowedRoles) ||
    allowedRoles.length === 0 ||
    !allowedRoles.every((role): role is Role => PHASE0_ROLES.has(role as Role)) ||
    !isStringArray(commands) ||
    commands.length === 0 ||
    !commands.every(
      (command) =>
        command.includes('--offline') &&
        command.includes('--frozen-lockfile') &&
        command.includes('--ignore-scripts'),
    ) ||
    !isSafeRelativePath(manifestPath) ||
    typeof manifestHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(manifestHash) ||
    !isSafeRelativePath(lockfilePath) ||
    typeof lockfileHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(lockfileHash) ||
    !isStringArray(approvedSourceHashes) ||
    approvedSourceHashes.length === 0 ||
    !approvedSourceHashes.every((hash) => /^[0-9a-f]{64}$/u.test(hash)) ||
    !Array.isArray(approvedSources) ||
    approvedSources.length === 0 ||
    approvedSources.length !== approvedSourceHashes.length ||
    !approvedSources.every(
      (source) =>
        isRecord(source) &&
        typeof source['packageName'] === 'string' &&
        source['packageName'].length > 0 &&
        isSafeRelativePath(source['targetPath']) &&
        source['specifier'] === `file:${source['targetPath']}` &&
        isSafeRelativePath(source['sourcePath']) &&
        typeof source['contentHash'] === 'string' &&
        approvedSourceHashes.includes(source['contentHash']),
    ) ||
    !isStringArray(persistentOutputRoots) ||
    persistentOutputRoots.length === 0 ||
    !persistentOutputRoots.every(isSafeRelativePath) ||
    !Array.isArray(approvedOutputMetadata) ||
    approvedOutputMetadata.length === 0 ||
    !approvedOutputMetadata.every(
      (metadata) =>
        isRecord(metadata) &&
        isSafeRelativePath(metadata['path']) &&
        typeof metadata['validator'] === 'string' &&
        [
          'exact_lockfile_v1',
          'pnpm_modules_json_v1',
          'pnpm_package_map_json_v1',
          'pnpm_workspace_state_json_v1',
        ].includes(metadata['validator']) &&
        (metadata['validator'] === 'pnpm_modules_json_v1'
          ? typeof metadata['packageManager'] === 'string' &&
            /^pnpm@\d+\.\d+\.\d+$/u.test(metadata['packageManager'])
          : metadata['packageManager'] === undefined) &&
        persistentOutputRoots.some(
          (root) =>
            metadata['path'] === root ||
            (typeof metadata['path'] === 'string' &&
              metadata['path'].startsWith(`${root}/`)),
        ),
    ) ||
    new Set(
      approvedOutputMetadata.flatMap((metadata) =>
        isRecord(metadata) && typeof metadata['path'] === 'string'
          ? [metadata['path']]
          : [],
      ),
    ).size !== approvedOutputMetadata.length ||
    raw['lifecycleScripts'] !== 'disabled' ||
    raw['network'] !== 'none'
  ) {
    throw new Error('security-plane offlineDependency policy is invalid');
  }
  return {
    version: 1,
    allowedRoles,
    commands,
    manifestPath,
    manifestHash,
    lockfilePath,
    lockfileHash,
    approvedSourceHashes,
    approvedSources: approvedSources.map((source) => {
      const record = source as Record<string, string>;
      return {
        packageName: record['packageName'] as string,
        specifier: record['specifier'] as string,
        targetPath: record['targetPath'] as string,
        sourcePath: resolve(dirname(path), record['sourcePath'] as string),
        contentHash: record['contentHash'] as string,
      };
    }),
    approvedOutputMetadata: approvedOutputMetadata.map((metadata) => {
      const record = metadata as Record<string, unknown>;
      return {
        path: record['path'] as string,
        validator: record['validator'] as
          | 'exact_lockfile_v1'
          | 'pnpm_modules_json_v1'
          | 'pnpm_package_map_json_v1'
          | 'pnpm_workspace_state_json_v1',
        ...(typeof record['packageManager'] === 'string'
          ? { packageManager: record['packageManager'] }
          : {}),
      };
    }),
    persistentOutputRoots,
    lifecycleScripts: 'disabled',
    network: 'none',
  };
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
