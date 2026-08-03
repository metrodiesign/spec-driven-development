import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import type { EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { ReportIntegrity } from './report-integrity.ts';
import type { AuthenticatedGateReport, GateReport } from '../types.ts';

/** The only role allowed to introduce or replace a frozen RED artifact. */
export type RedArtifactSourceRole = 'test_designer';

/** A core-minted identity for a test that was observed failing for its expected reason. */
export interface RedArtifactRecord {
  path: string;
  contentRef: string;
  contentHash: string;
  expectedFailureFingerprint: string;
  sourceRole: RedArtifactSourceRole;
  frozenBy: 'core';
  /** Authenticated core gate report that observed the RED result. */
  reportRef: string;
  reportHash: string;
  observedArtifactHash: string;
}

export interface RedObservation {
  sourceRole: RedArtifactSourceRole;
  /** Core, rather than the agent, must have observed the failing result. */
  observedByCore: true;
  pass: false;
  expectedFailureFingerprint: string;
  /** Content-addressed, authenticated GateReport bytes. */
  reportRef: string;
  reportHash: string;
  /** Artifact bytes captured by core at the same observation boundary. */
  artifactRef: string;
  artifactHash: string;
  artifactPath: string;
  runId: string;
  taskId: string;
}

const CORE_OBSERVATION = new WeakSet<object>();

export type RedArtifactErrorCode =
  | 'red_artifact_frozen'
  | 'red_observation_required'
  | 'red_artifact_unchanged'
  | 'red_artifact_invalid';

export class RedArtifactError extends Error {
  readonly code: RedArtifactErrorCode;

  constructor(code: RedArtifactErrorCode, message: string) {
    super(message);
    this.name = 'RedArtifactError';
    this.code = code;
  }
}

export interface FrozenRedArtifactIndex {
  get(path: string): RedArtifactRecord | undefined;
  paths(): readonly string[];
}

export interface RedArtifactStore extends FrozenRedArtifactIndex {
  /** Freeze a candidate only after core observed its expected RED result. */
  freeze(
    worktreeDir: string,
    path: string,
    observation: RedObservation,
  ): RedArtifactRecord;
  /** Replace an existing record atomically after a test-designer re-RED. */
  replaceAfterObservedRed(
    worktreeDir: string,
    path: string,
    observation: RedObservation,
  ): RedArtifactRecord;
}

export interface RedArtifactStoreOptions {
  evidence?: EvidenceStore;
  log?: EventLog;
  reportIntegrity?: ReportIntegrity;
  /** Current worktree used to verify the observed artifact before admission. */
  worktreeDir?: string;
  runId?: string;
  taskId?: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalReportBytes(report: AuthenticatedGateReport): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(report));
}

function reportFingerprint(report: GateReport): string {
  const failed = report.checks
    .filter((check) => check.pass === false)
    .map((check) => `${check.name}|${check.detail ?? ''}|${check.evidenceRef}`)
    .join('\n');
  return sha256(new TextEncoder().encode(`${report.tier}|${report.gateConfigHash}|${failed}`));
}

/**
 * Mint the only observation accepted by freeze/replace. The report must be
 * signed and verified by core, and the artifact bytes are captured into the
 * immutable evidence store at the same boundary. Callers cannot choose a
 * fingerprint or set `observedByCore` as a free boolean.
 */
export function createCoreRedObservation(options: {
  worktreeDir: string;
  path: string;
  report: GateReport;
  reportIntegrity: ReportIntegrity;
  evidence: EvidenceStore;
  runId: string;
  taskId: string;
}): RedObservation {
  const verified = options.reportIntegrity.verifyGateReport(options.report, {
    runId: options.runId,
    taskId: options.taskId,
  });
  if (verified.pass !== false || !verified.checks.some((check) => check.pass === false)) {
    throw new RedArtifactError(
      'red_observation_required',
      'RED observation requires an authenticated failing core gate report',
    );
  }
  const path = normalizeArtifactPath(options.worktreeDir, options.path);
  const bytes = readCandidate(options.worktreeDir, path);
  const artifactRef = options.evidence.put(bytes);
  const reportBytes = canonicalReportBytes(verified);
  const reportRef = options.evidence.put(reportBytes);
  const observation = Object.freeze({
    sourceRole: 'test_designer',
    observedByCore: true,
    pass: false,
    expectedFailureFingerprint: reportFingerprint(verified),
    reportRef,
    reportHash: sha256(reportBytes),
    artifactRef,
    artifactHash: sha256(bytes),
    artifactPath: path,
    runId: options.runId,
    taskId: options.taskId,
  }) as RedObservation;
  CORE_OBSERVATION.add(observation);
  return observation;
}

function normalizeArtifactPath(worktreeDir: string, candidate: string): string {
  if (candidate.length === 0 || candidate.startsWith('/') || candidate.includes('\\')) {
    throw new RedArtifactError('red_artifact_invalid', `invalid RED artifact path: ${candidate}`);
  }
  const root = realpathSync(worktreeDir);
  const absolute = resolve(root, candidate);
  const normalized = relative(root, absolute);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.length === 0) {
    throw new RedArtifactError('red_artifact_invalid', `RED artifact path escapes worktree: ${candidate}`);
  }
  return normalized.split(sep).join('/');
}

function readCandidate(worktreeDir: string, path: string): Uint8Array {
  const absolute = resolve(worktreeDir, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile()) {
    throw new RedArtifactError(
      'red_artifact_invalid',
      `RED artifact must be a regular file: ${path}`,
    );
  }
  const root = realpathSync(worktreeDir);
  const parent = realpathSync(dirname(absolute));
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
    throw new RedArtifactError(
      'red_artifact_invalid',
      `RED artifact parent escapes worktree: ${path}`,
    );
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new RedArtifactError(
        'red_artifact_invalid',
        `RED artifact target is not a regular file: ${path}`,
      );
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validateObservation(observation: RedObservation): void {
  if (
    !CORE_OBSERVATION.has(observation) ||
    observation.sourceRole !== 'test_designer' ||
    observation.observedByCore !== true ||
    observation.pass !== false ||
    observation.expectedFailureFingerprint.trim().length === 0 ||
    typeof observation.reportRef !== 'string' ||
    typeof observation.reportHash !== 'string' ||
    typeof observation.artifactRef !== 'string' ||
    typeof observation.artifactHash !== 'string' ||
    typeof observation.artifactPath !== 'string' ||
    typeof observation.runId !== 'string' ||
    typeof observation.taskId !== 'string'
  ) {
    throw new RedArtifactError(
      'red_observation_required',
      'freezing a RED artifact requires a core-observed failing test-designer result',
    );
  }
}

export function createRedArtifactStore(options: RedArtifactStoreOptions = {}): RedArtifactStore {
  const records = new Map<string, RedArtifactRecord>();

  const verifyPersistedRecord = (payload: Record<string, unknown>, seq: number): RedArtifactRecord => {
    if (
      typeof payload.path !== 'string' ||
      typeof payload.contentRef !== 'string' ||
      typeof payload.contentHash !== 'string' ||
      typeof payload.reportRef !== 'string' ||
      typeof payload.reportHash !== 'string' ||
      typeof payload.observedArtifactHash !== 'string' ||
      typeof payload.expectedFailureFingerprint !== 'string' ||
      payload.sourceRole !== 'test_designer' ||
      payload.frozenBy !== 'core'
    ) {
      throw new RedArtifactError('red_artifact_invalid', `invalid RED provenance event at seq=${seq}`);
    }
    if (
      payload.path.startsWith('/') ||
      payload.path.split('/').some((part) => part === '..' || part.length === 0) ||
      !/^[0-9a-f]{64}$/u.test(payload.contentHash) ||
      !/^[0-9a-f]{64}$/u.test(payload.reportHash) ||
      !/^[0-9a-f]{64}$/u.test(payload.observedArtifactHash) ||
      payload.expectedFailureFingerprint.trim().length === 0
    ) {
      throw new RedArtifactError('red_artifact_invalid', `invalid RED provenance content at seq=${seq}`);
    }
    if (options.evidence === undefined || options.reportIntegrity === undefined || options.runId === undefined || options.taskId === undefined) {
      throw new RedArtifactError(
        'red_artifact_invalid',
        'rehydrating RED provenance requires evidence, report integrity, runId, and taskId',
      );
    }
    let artifactBytes: Uint8Array;
    let reportBytes: Uint8Array;
    try {
      artifactBytes = options.evidence.get(payload.contentRef);
      reportBytes = options.evidence.get(payload.reportRef);
    } catch (error) {
      throw new RedArtifactError(
        'red_artifact_invalid',
        `RED provenance evidence unavailable at seq=${seq}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      sha256(artifactBytes) !== payload.contentHash ||
      sha256(artifactBytes) !== payload.observedArtifactHash ||
      sha256(reportBytes) !== payload.reportHash
    ) {
      throw new RedArtifactError('red_artifact_invalid', `RED provenance hash mismatch at seq=${seq}`);
    }
    if (options.worktreeDir !== undefined) {
      try {
        const current = readCandidate(options.worktreeDir, payload.path);
        if (sha256(current) !== payload.contentHash) {
          throw new RedArtifactError(
            'red_artifact_invalid',
            `current RED artifact does not match frozen provenance at seq=${seq}`,
          );
        }
      } catch (error) {
        if (error instanceof RedArtifactError) throw error;
        throw new RedArtifactError(
          'red_artifact_invalid',
          `current RED artifact unavailable at seq=${seq}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let report: AuthenticatedGateReport;
    try {
      report = JSON.parse(new TextDecoder().decode(reportBytes)) as AuthenticatedGateReport;
      report = options.reportIntegrity.verifyGateReport(report, {
        runId: options.runId,
        taskId: options.taskId,
      });
    } catch (error) {
      throw new RedArtifactError(
        'red_artifact_invalid',
        `RED provenance report authentication failed at seq=${seq}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      report.pass !== false ||
      !report.checks.some((check) => check.pass === false) ||
      reportFingerprint(report) !== payload.expectedFailureFingerprint
    ) {
      throw new RedArtifactError('red_artifact_invalid', `RED provenance report is not an authenticated RED at seq=${seq}`);
    }
    return {
      path: payload.path,
      contentRef: payload.contentRef,
      contentHash: payload.contentHash,
      expectedFailureFingerprint: payload.expectedFailureFingerprint,
      sourceRole: 'test_designer',
      frozenBy: 'core',
      reportRef: payload.reportRef,
      reportHash: payload.reportHash,
      observedArtifactHash: payload.observedArtifactHash,
    };
  };

  if (options.log !== undefined && options.taskId !== undefined && options.runId !== undefined) {
    const latest = new Map<string, { payload: Record<string, unknown>; seq: number }>();
    for (const event of options.log.all({ taskId: options.taskId })) {
      if (event.runId !== options.runId || event.type !== 'RED_ARTIFACT_FROZEN') continue;
      if (typeof event.payload.path !== 'string') {
        throw new RedArtifactError('red_artifact_invalid', `invalid RED provenance path at seq=${event.seq}`);
      }
      latest.set(event.payload.path, { payload: event.payload, seq: event.seq });
    }
    for (const [path, event] of latest) {
      records.set(path, verifyPersistedRecord(event.payload, event.seq));
    }
  }

  const persist = (record: RedArtifactRecord, replaced: boolean): void => {
    if (options.log === undefined || options.runId === undefined || options.taskId === undefined) return;
    options.log.append({
      runId: options.runId,
      taskId: options.taskId,
      type: 'RED_ARTIFACT_FROZEN',
      payload: { ...record, ...(replaced ? { replaced: true } : {}) },
    });
  };

  const materialize = (
    worktreeDir: string,
    candidate: string,
    observation: RedObservation,
    previous: RedArtifactRecord | undefined,
  ): RedArtifactRecord => {
    validateObservation(observation);
    if (
      (options.runId !== undefined && observation.runId !== options.runId) ||
      (options.taskId !== undefined && observation.taskId !== options.taskId)
    ) {
      throw new RedArtifactError(
        'red_observation_required',
        'RED observation identity does not match the owning run/task',
      );
    }
    const path = normalizeArtifactPath(worktreeDir, candidate);
    const bytes = readCandidate(worktreeDir, path);
    const contentHash = sha256(bytes);
    if (previous !== undefined && previous.contentHash === contentHash) {
      throw new RedArtifactError(
        'red_artifact_unchanged',
        `test-designer correction must produce a new RED artifact hash: ${path}`,
      );
    }
    if (observation.artifactPath !== path || observation.artifactHash !== contentHash) {
      throw new RedArtifactError(
        'red_artifact_invalid',
        `RED observation does not match the current artifact bytes: ${path}`,
      );
    }
    if (options.evidence === undefined) {
      throw new RedArtifactError('red_artifact_invalid', 'RED provenance requires an evidence store');
    }
    const evidenceBytes = options.evidence.get(observation.artifactRef);
    if (sha256(evidenceBytes) !== contentHash || sha256(evidenceBytes) !== observation.artifactHash) {
      throw new RedArtifactError('red_artifact_invalid', `RED observation artifact evidence hash mismatch: ${path}`);
    }
    const reportBytes = options.evidence.get(observation.reportRef);
    if (sha256(reportBytes) !== observation.reportHash) {
      throw new RedArtifactError('red_artifact_invalid', `RED observation report evidence hash mismatch: ${path}`);
    }
    if (options.reportIntegrity === undefined) {
      throw new RedArtifactError('red_artifact_invalid', 'RED provenance requires report integrity');
    }
    try {
      const report = options.reportIntegrity.verifyGateReport(
        JSON.parse(new TextDecoder().decode(reportBytes)) as GateReport,
        { runId: observation.runId, taskId: observation.taskId },
      );
      if (
        report.pass !== false ||
        !report.checks.some((check) => check.pass === false) ||
        reportFingerprint(report) !== observation.expectedFailureFingerprint
      ) {
        throw new RedArtifactError('red_observation_required', 'RED observation report is not an authenticated RED result');
      }
    } catch (error) {
      if (error instanceof RedArtifactError) throw error;
      throw new RedArtifactError(
        'red_observation_required',
        `RED observation report authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const record: RedArtifactRecord = {
      path,
      contentRef: observation.artifactRef,
      contentHash,
      expectedFailureFingerprint: observation.expectedFailureFingerprint,
      sourceRole: 'test_designer',
      frozenBy: 'core',
      reportRef: observation.reportRef,
      reportHash: observation.reportHash,
      observedArtifactHash: observation.artifactHash,
    };
    persist(record, previous !== undefined);
    records.set(path, record);
    return record;
  };

  return {
    get(path) {
      const normalized = path.replaceAll('\\', '/');
      if (normalized.startsWith('/')) return undefined;
      const parts: string[] = [];
      for (const part of normalized.split('/')) {
        if (part.length === 0 || part === '.') continue;
        if (part === '..') {
          if (parts.length === 0) return undefined;
          parts.pop();
          continue;
        }
        parts.push(part);
      }
      const canonical = parts.join('/');
      return records.get(canonical);
    },
    paths() {
      return [...records.keys()].sort();
    },
    freeze(worktreeDir, path, observation) {
      const normalized = normalizeArtifactPath(worktreeDir, path);
      if (records.has(normalized)) {
        throw new RedArtifactError(
          'red_artifact_frozen',
          `RED artifact is already frozen: ${normalized}`,
        );
      }
      return materialize(worktreeDir, normalized, observation, undefined);
    },
    replaceAfterObservedRed(worktreeDir, path, observation) {
      const normalized = normalizeArtifactPath(worktreeDir, path);
      const previous = records.get(normalized);
      if (previous === undefined) {
        throw new RedArtifactError(
          'red_artifact_invalid',
          `cannot replace an unfrozen RED artifact: ${normalized}`,
        );
      }
      // materialize() updates the map only after every validation and hash read,
      // so a failed correction leaves the prior provenance intact.
      return materialize(worktreeDir, normalized, observation, previous);
    },
  };
}
