import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { evaluateEligibility, parseFusionProfiles, parseRoutingConfig } from 'aal';
import type { AdapterDescriptor as StaticAdapterDescriptor } from 'adapters';

export interface SourceStamp {
  readonly source: string;
  readonly sourceTimestamp: string | null;
  readonly sequence: number | null;
  readonly freshness: 'recorded' | 'unknown';
}

export interface ProjectionIssue {
  readonly field: string;
  readonly code: 'source-unavailable' | 'invalid-record' | 'evidence-unavailable' | 'redacted';
  readonly reason: string;
  readonly source?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface ProjectionEnvelope<T> {
  readonly data: T;
  readonly readAt: string;
  readonly issues: readonly ProjectionIssue[];
}

export type RecordedDimension<T> =
  | { readonly status: 'known'; readonly value: T; readonly provenance: SourceStamp }
  | { readonly status: 'unknown'; readonly reason: string; readonly provenance?: SourceStamp }
  | {
      readonly status: 'invalid-record';
      readonly reason: string;
      readonly provenance: SourceStamp;
      readonly previousValid?: { readonly value: T; readonly provenance: SourceStamp };
    };

export interface CoreTaskState {
  readonly taskId: string;
  readonly currentState: RecordedDimension<string>;
}

export interface CoreRunSummary {
  readonly runId: string;
  readonly lifecycle: RecordedDimension<'active' | 'ended'>;
  readonly taskStates: readonly CoreTaskState[];
  readonly currentTaskId: RecordedDimension<string | null>;
  readonly pendingApprovals: RecordedDimension<number>;
  readonly latestSequence: RecordedDimension<number>;
  readonly provenance: SourceStamp;
}

export interface CoreRunTotals {
  readonly activeRuns: number;
  readonly pendingApprovals: number;
}

export interface TaskNode {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly satisfies: readonly string[];
  readonly state: RecordedDimension<string>;
  readonly risk: RecordedDimension<string | null>;
  readonly diffBudget: RecordedDimension<number | null>;
}

export interface EvidenceMetadata {
  readonly ref: string;
  readonly digest: string | null;
  readonly available: boolean;
  readonly byteLength: number | null;
}

export interface GateProjection {
  readonly tier: 'T0' | 'T1' | 'T2' | 'T3';
  readonly verdict: boolean | 'not_enabled';
  readonly sequence: number;
  readonly evidence: readonly EvidenceMetadata[];
}

export interface BudgetProjection {
  readonly used: { readonly iterations: number; readonly costUnits: number; readonly wallclockMs: number };
  readonly cap: { readonly iterations: number; readonly costUnits: number; readonly wallclockMs: number };
  readonly recordedAt: string;
}

export interface CoreEventProjection {
  readonly seq: number;
  readonly ts: string;
  readonly taskId: string | null;
  readonly type: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
  readonly redactedFields: readonly string[];
}

export interface CoreRunDetail {
  readonly summary: CoreRunSummary;
  readonly taskGraph: RecordedDimension<{
    readonly graphHash: string | null;
    readonly mode: 'multi-task' | 'single-task';
    readonly tasks: readonly TaskNode[];
  }>;
  readonly latestGatesByTask: Readonly<Record<string, readonly GateProjection[]>>;
  readonly budgetsByTask: Readonly<Record<string, RecordedDimension<BudgetProjection>>>;
}

export interface ConformanceSummary {
  readonly modelVersion: string;
  readonly probes: Readonly<Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P8', boolean>>;
  readonly p7SusceptibilityScore: number;
}

export interface RoutingRoleProjection {
  readonly context: 'autonomous-loop' | 'pr-quality';
  readonly role: string;
  readonly orderedTargets: readonly string[];
  readonly fallbackOrder: readonly string[];
  readonly basis: 'recorded' | 'configured' | 'unknown';
  readonly provenance: SourceStamp;
}

export interface RoutingTargetProjection {
  readonly target: string;
  readonly breaker: RecordedDimension<{ readonly state: 'closed' | 'open' | 'half_open' }>;
  readonly rateLimitPolicy: RecordedDimension<{ readonly capacity: number; readonly refillPerSec: number }>;
  readonly recordedLimitState: RecordedDimension<{ readonly limited: boolean; readonly availableTokens: number | null }>;
  readonly conformance: RecordedDimension<ConformanceSummary>;
}

export interface FusionProfileProjection {
  readonly artifact: string;
  readonly panelSize: number;
  readonly diversity: string;
  readonly resolve: string;
  readonly budgetCapCostUnits: number;
  readonly estimateCostUnitsPerCandidate: number;
  readonly provenance: SourceStamp;
}

export interface FusionProjection {
  readonly profiles: readonly FusionProfileProjection[];
  readonly plannerRoleEnabled: boolean;
  readonly latestRun: RecordedDimension<{
    readonly resolved: string | null;
    readonly escalated: boolean;
    readonly usageCostUnits: number | null;
  }>;
}

export interface AalProjection {
  readonly roles: readonly RoutingRoleProjection[];
  readonly targets: readonly RoutingTargetProjection[];
  readonly fusion: FusionProjection;
}

export interface AdapterManifestProjection {
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly contextWindowTokens: number | null;
  readonly executionBackend: false;
  readonly determinism: 'none' | 'seed' | 'unknown';
  readonly lineage: string | null;
}

export interface AdapterModelMapping {
  readonly context: 'autonomous-loop' | 'pr-quality';
  readonly role: string;
  readonly model: string | null;
  readonly provenance: SourceStamp;
}

export interface AdapterProjection {
  readonly id: string;
  readonly transport: 'sdk' | 'cli' | 'fake' | 'unknown';
  readonly manifest: AdapterManifestProjection;
  readonly registrationEligibility: {
    readonly state: 'eligible' | 'ineligible' | 'unknown';
    readonly reasons: readonly string[];
    readonly provenance: SourceStamp | null;
  };
  readonly modelMappings: readonly AdapterModelMapping[];
  readonly health: RecordedDimension<{ readonly ok: boolean; readonly reason?: string }>;
  readonly calibration: RecordedDimension<{
    readonly recordType: string;
    readonly outcome: 'pass' | 'fail' | 'measured';
    readonly metrics: Readonly<Record<string, string | number | boolean | null>>;
  }>;
  readonly conformance: RecordedDimension<ConformanceSummary>;
}

export interface ConsoleServiceHealth {
  readonly console: 'available';
  readonly services: Readonly<Record<
    'terminal' | 'chat' | 'loop' | 'scheduler' | 'prQuality',
    { readonly status: 'available' | 'unavailable' | 'policy-disabled'; readonly reason: string | null }
  >>;
  readonly disclaimer: string;
}

export interface ControlCenterReadPort {
  listRuns(input: { readonly cursor: string | null; readonly limit: number }): ProjectionEnvelope<{
    readonly page: Page<CoreRunSummary>;
    readonly totals: CoreRunTotals;
  }>;
  readRun(runId: string): ProjectionEnvelope<CoreRunDetail> | null;
  readRunEvents(input: {
    readonly runId: string;
    readonly after: number;
    readonly limit: number;
  }): ProjectionEnvelope<Page<CoreEventProjection>> | null;
  readAal(): ProjectionEnvelope<AalProjection>;
  listAdapters(input: { readonly cursor: string | null; readonly limit: number }): ProjectionEnvelope<Page<AdapterProjection>>;
  readAdapter(id: string): ProjectionEnvelope<AdapterProjection> | null;
  readServiceHealth(): ProjectionEnvelope<ConsoleServiceHealth>;
}

export class InvalidControlCenterQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidControlCenterQueryError';
  }
}

export class ControlCenterSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlCenterSourceUnavailableError';
  }
}

interface EventRow {
  readonly seq: number;
  readonly ts: string;
  readonly run_id: string;
  readonly task_id: string | null;
  readonly type: string;
  readonly payload: string;
}

interface LocatedEvent extends EventRow {
  readonly sourceRunId: string;
}

interface RunRecord {
  readonly summary: CoreRunSummary;
  readonly createdAt: string | null;
  readonly issues: readonly ProjectionIssue[];
}

interface RunCursor {
  readonly v: 1;
  readonly createdAt: string | null;
  readonly runId: string;
}

interface AdapterCursor {
  readonly v: 1;
  readonly adapterId: string;
}

export interface AdapterModelEnvironment {
  readonly PR_GATE_CLAUDE_MODEL: string | null;
  readonly PR_GATE_CODEX_MODEL: string | null;
  readonly PR_GATE_GEMINI_MODEL: string | null;
  readonly PR_GATE_DEEPSEEK_MODEL: string | null;
}

export type ControlCenterServices = ConsoleServiceHealth['services'];

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const EVIDENCE_REF = /^blob:\/\/([0-9a-f]{64})$/u;
const TERMINAL_STATES = new Set([
  'COMPLETED',
  'BLOCKED',
  'ESCALATED',
  'CANCELLED',
  'ROLLED_BACK',
  'QUARANTINED',
  'CHANGES_REQUESTED',
]);
const MAX_FOLD_ROWS = 10_000;
const PASS_FAIL_PROBES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8'] as const;
const BREAKER_STATES = new Set(['closed', 'open', 'half_open']);
const AAL_EVENT_TYPES = [
  'SHADOW_ROUTE',
  'OUTCOME_ROUTE',
  'BREAKER_STATE_CHANGED',
  'QUOTA_PROBE',
  'RATE_LIMIT_OBSERVED',
  'FUSION_RESOLVED',
  'PLAN_RESOLVED',
] as const;

const EVENT_FIELD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  TASK_STATE: ['state', 'trigger'],
  GATE_RESULT: ['tier', 'pass'],
  ESCALATED: ['why', 'boundary', 'code'],
  APPROVAL_PACKAGE_CREATED: ['approvalId'],
  APPROVAL_RECORDED: ['approvalId', 'decision'],
  BUDGET_SNAPSHOT: ['phase'],
  RUN_DESCRIPTOR: ['contractHash', 'taskMode'],
  TASK_GRAPH_FROZEN: ['graphHash'],
  BREAKER_STATE_CHANGED: ['key', 'from', 'to', 'at'],
  RATE_LIMIT_OBSERVED: ['target', 'limited', 'availableTokens', 'policyKey'],
  SHADOW_ROUTE: ['live', 'wouldChoose', 'basis', 'frozen'],
  OUTCOME_ROUTE: ['role', 'decision'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeTechnicalIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u.test(value);
}

function parsePayload(row: EventRow): Record<string, unknown> | null {
  try {
    const value = JSON.parse(row.payload) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function validTimestamp(value: string): string | null {
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function stamp(runId: string, row?: EventRow): SourceStamp {
  const timestamp = row === undefined ? null : validTimestamp(row.ts);
  return {
    source: `run:${runId}/events.db`,
    sourceTimestamp: timestamp,
    sequence: row?.seq ?? null,
    freshness: timestamp === null ? 'unknown' : 'recorded',
  };
}

function known<T>(value: T, provenance: SourceStamp): RecordedDimension<T> {
  return { status: 'known', value, provenance };
}

function unknown<T>(reason: string, provenance?: SourceStamp): RecordedDimension<T> {
  return provenance === undefined ? { status: 'unknown', reason } : { status: 'unknown', reason, provenance };
}

function invalid<T>(reason: string, provenance: SourceStamp): RecordedDimension<T> {
  return { status: 'invalid-record', reason, provenance };
}

function validateRunId(runId: string): boolean {
  return RUN_ID.test(runId) && !runId.includes('..');
}

function readTextSourceNoFollow(path: string): { readonly text: string; readonly mtimeMs: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('source is not a regular file');
    return { text: readFileSync(fd, 'utf8'), mtimeMs: info.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function readFileNoFollow(path: string): string {
  return readTextSourceNoFollow(path).text;
}

function runDirectory(runsRoot: string, runId: string): string | null {
  if (!validateRunId(runId)) return null;
  const path = join(runsRoot, runId);
  try {
    const info = lstatSync(path);
    return !info.isSymbolicLink() && info.isDirectory() ? path : null;
  } catch {
    return null;
  }
}

function eventDatabase(runDir: string): string | null {
  const path = join(runDir, 'events.db');
  try {
    const info = lstatSync(path);
    return !info.isSymbolicLink() && info.isFile() ? path : null;
  } catch {
    return null;
  }
}

function withRunDatabase<T>(runDir: string, read: (db: DatabaseSync) => T): T {
  const path = eventDatabase(runDir);
  if (path === null) throw new Error('events.db is unavailable or not a regular file');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    return read(db);
  } finally {
    db.close();
  }
}

function isCoreRun(runDir: string): boolean {
  try {
    return withRunDatabase(runDir, (db) =>
      db.prepare("SELECT 1 AS present FROM events WHERE type = 'TASK_STATE' LIMIT 1").get() !== undefined,
    ) || existsSync(join(runDir, 'human-plane.json'));
  } catch {
    return existsSync(join(runDir, 'human-plane.json'));
  }
}

function lifecycle(runId: string, runDir: string): RecordedDimension<'active' | 'ended'> {
  const source: SourceStamp = {
    source: `run:${runId}/human-plane.json`,
    sourceTimestamp: null,
    sequence: null,
    freshness: 'unknown',
  };
  const path = join(runDir, 'human-plane.json');
  if (!existsSync(path)) return known('ended', source);
  try {
    const value = JSON.parse(readFileNoFollow(path)) as unknown;
    if (!isRecord(value)) return invalid('human-plane discovery is not an object', source);
    if (value['tombstoned'] === true) return known('ended', source);
    return typeof value['url'] === 'string' && typeof value['token'] === 'string'
      ? known('active', source)
      : invalid('human-plane discovery is malformed', source);
  } catch {
    return invalid('human-plane discovery is unreadable', source);
  }
}

function taskState(runId: string, row: EventRow): RecordedDimension<string> {
  const payload = parsePayload(row);
  return payload !== null && typeof payload['state'] === 'string' && payload['state'].length > 0
    ? known(payload['state'], stamp(runId, row))
    : invalid('TASK_STATE.state is missing or invalid', stamp(runId, row));
}

function unavailableSummary(runId: string, reason: string): CoreRunSummary {
  const provenance = stamp(runId);
  return {
    runId,
    lifecycle: unknown(reason),
    taskStates: [],
    currentTaskId: unknown(reason),
    pendingApprovals: unknown(reason),
    latestSequence: unknown(reason),
    provenance,
  };
}

function readSummary(runId: string, runDir: string): RunRecord {
  const issues: ProjectionIssue[] = [];
  return withRunDatabase(runDir, (db) => {
    const first = db
      .prepare('SELECT seq, ts, run_id, task_id, type, payload FROM events ORDER BY seq LIMIT 1')
      .get() as unknown as EventRow | undefined;
    const latest = db
      .prepare('SELECT seq, ts, run_id, task_id, type, payload FROM events ORDER BY seq DESC LIMIT 1')
      .get() as unknown as EventRow | undefined;
    const taskRows = db
      .prepare(`
        SELECT e.seq, e.ts, e.run_id, e.task_id, e.type, e.payload
        FROM events e
        JOIN (
          SELECT task_id, MAX(seq) AS seq
          FROM events
          WHERE type = 'TASK_STATE' AND task_id IS NOT NULL
          GROUP BY task_id
        ) latest ON latest.seq = e.seq
        ORDER BY e.task_id
      `)
      .all() as unknown as EventRow[];
    const latestTask = db
      .prepare("SELECT seq, ts, run_id, task_id, type, payload FROM events WHERE type = 'TASK_STATE' AND task_id IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .get() as unknown as EventRow | undefined;
    const approvalRows = db
      .prepare("SELECT seq, ts, run_id, task_id, type, payload FROM events WHERE type IN ('APPROVAL_PACKAGE_CREATED', 'APPROVAL_RECORDED') ORDER BY seq DESC LIMIT ?")
      .all(MAX_FOLD_ROWS + 1) as unknown as EventRow[];

    const taskStates = taskRows.map((row) => ({ taskId: row.task_id as string, currentState: taskState(runId, row) }));
    let currentTaskId: RecordedDimension<string | null>;
    if (latestTask === undefined) {
      currentTaskId = unknown('no TASK_STATE observation recorded', stamp(runId));
    } else {
      const state = taskState(runId, latestTask);
      currentTaskId =
        state.status === 'known'
          ? known(TERMINAL_STATES.has(state.value) ? null : latestTask.task_id, stamp(runId, latestTask))
          : invalid('latest TASK_STATE is invalid', stamp(runId, latestTask));
    }

    const pending = new Set<string>();
    const decided = new Set<string>();
    let invalidApproval: EventRow | null = null;
    for (const row of [...approvalRows].reverse()) {
      const payload = parsePayload(row);
      const approvalId = payload?.['approvalId'];
      if (typeof approvalId !== 'string' || approvalId.length === 0) {
        invalidApproval = row;
        continue;
      }
      if (row.type === 'APPROVAL_PACKAGE_CREATED') pending.add(approvalId);
      else decided.add(approvalId);
    }
    for (const id of decided) pending.delete(id);
    if (approvalRows.length > MAX_FOLD_ROWS) {
      invalidApproval = approvalRows[0] ?? null;
      issues.push({ field: 'pendingApprovals', code: 'source-unavailable', reason: 'approval fold limit exceeded' });
    }
    const pendingApprovals =
      invalidApproval === null
        ? known(pending.size, stamp(runId, latest))
        : invalid<number>('approval observation is malformed or truncated', stamp(runId, invalidApproval));

    const provenance = stamp(runId, first);
    return {
      createdAt: first === undefined ? null : validTimestamp(first.ts),
      issues,
      summary: {
        runId,
        lifecycle: lifecycle(runId, runDir),
        taskStates,
        currentTaskId,
        pendingApprovals,
        latestSequence: latest === undefined ? unknown('event log is empty', provenance) : known(latest.seq, stamp(runId, latest)),
        provenance,
      },
    };
  });
}

function compareRun(left: { readonly createdAt: string | null; readonly runId: string }, right: { readonly createdAt: string | null; readonly runId: string }): number {
  if (left.createdAt !== null && right.createdAt === null) return -1;
  if (left.createdAt === null && right.createdAt !== null) return 1;
  if (left.createdAt !== null && right.createdAt !== null && left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt);
  }
  return left.runId.localeCompare(right.runId);
}

function encodeRunCursor(record: RunRecord): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: record.createdAt, runId: record.summary.runId } satisfies RunCursor)).toString('base64url');
}

function decodeRunCursor(value: string): RunCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'createdAt,runId,v') throw new Error('shape');
    if (parsed['v'] !== 1 || typeof parsed['runId'] !== 'string' || !validateRunId(parsed['runId'])) throw new Error('value');
    if (parsed['createdAt'] !== null && (typeof parsed['createdAt'] !== 'string' || validTimestamp(parsed['createdAt']) === null)) {
      throw new Error('timestamp');
    }
    return { v: 1, createdAt: parsed['createdAt'] as string | null, runId: parsed['runId'] };
  } catch {
    throw new InvalidControlCenterQueryError('invalid run cursor');
  }
}

function readRunRecords(runsRoot: string): RunRecord[] {
  if (!existsSync(runsRoot)) return [];
  let entries;
  try {
    const info = lstatSync(runsRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('runs root is not a directory');
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    throw new ControlCenterSourceUnavailableError('runs root is unavailable');
  }
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validateRunId(entry.name)) continue;
    const dir = runDirectory(runsRoot, entry.name);
    if (dir === null || eventDatabase(dir) === null || !isCoreRun(dir)) continue;
    try {
      records.push(readSummary(entry.name, dir));
    } catch {
      const reason = 'events.db is unreadable';
      records.push({
        summary: unavailableSummary(entry.name, reason),
        createdAt: null,
        issues: [{ field: `runs.${entry.name}`, code: 'source-unavailable', reason, source: `run:${entry.name}/events.db` }],
      });
    }
  }
  return records.sort((left, right) => compareRun(
    { createdAt: left.createdAt, runId: left.summary.runId },
    { createdAt: right.createdAt, runId: right.summary.runId },
  ));
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}

function taskGraph(
  runId: string,
  rows: readonly EventRow[],
  summary: CoreRunSummary,
): RecordedDimension<{ readonly graphHash: string | null; readonly mode: 'multi-task' | 'single-task'; readonly tasks: readonly TaskNode[] }> {
  const graphRow = rows.find((row) => row.type === 'TASK_GRAPH_FROZEN');
  const descriptorRow = rows.find((row) => row.type === 'RUN_DESCRIPTOR');
  const states = new Map(summary.taskStates.map((state) => [state.taskId, state.currentState]));
  if (graphRow !== undefined) {
    const payload = parsePayload(graphRow);
    if (payload === null || !Array.isArray(payload['tasks'])) return invalid('TASK_GRAPH_FROZEN.tasks is unavailable', stamp(runId, graphRow));
    const tasks: TaskNode[] = [];
    for (const raw of payload['tasks']) {
      if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['title'] !== 'string') {
        return invalid('TASK_GRAPH_FROZEN task is malformed', stamp(runId, graphRow));
      }
      const dependsOn = stringArray(raw['dependsOn']);
      const satisfies = stringArray(raw['satisfies']);
      if (dependsOn === null || satisfies === null) return invalid('TASK_GRAPH_FROZEN task edges are malformed', stamp(runId, graphRow));
      const risk = raw['risk'];
      const diffBudget = raw['diffBudget'];
      tasks.push({
        id: raw['id'],
        title: raw['title'],
        dependsOn,
        satisfies,
        state: states.get(raw['id']) ?? unknown('no TASK_STATE observation recorded'),
        risk:
          risk === null || typeof risk === 'string'
            ? known(risk, stamp(runId, graphRow))
            : unknown('risk was not recorded', stamp(runId, graphRow)),
        diffBudget:
          diffBudget === null || (typeof diffBudget === 'number' && Number.isFinite(diffBudget))
            ? known(diffBudget, stamp(runId, graphRow))
            : unknown('diff budget was not recorded', stamp(runId, graphRow)),
      });
    }
    return known(
      {
        graphHash: typeof payload['graphHash'] === 'string' ? payload['graphHash'] : null,
        mode: 'multi-task',
        tasks,
      },
      stamp(runId, graphRow),
    );
  }
  if (descriptorRow === undefined) return unknown('RUN_DESCRIPTOR and TASK_GRAPH_FROZEN were not recorded', stamp(runId));
  const payload = parsePayload(descriptorRow);
  const goal = payload?.['goal'];
  const task = summary.taskStates[0];
  if (payload?.['taskMode'] !== 'single' || !isRecord(goal) || typeof goal['title'] !== 'string' || task === undefined) {
    return invalid('single-task RUN_DESCRIPTOR is malformed', stamp(runId, descriptorRow));
  }
  return known(
    {
      graphHash: null,
      mode: 'single-task',
      tasks: [{
        id: task.taskId,
        title: goal['title'],
        dependsOn: [],
        satisfies: [],
        state: task.currentState,
        risk: unknown('risk was not recorded for single-task mode', stamp(runId, descriptorRow)),
        diffBudget: unknown('diff budget was not recorded for single-task mode', stamp(runId, descriptorRow)),
      }],
    },
    stamp(runId, descriptorRow),
  );
}

function evidenceMetadata(
  runId: string,
  runDir: string,
  value: unknown,
  field: string,
  issues: ProjectionIssue[],
): EvidenceMetadata {
  if (typeof value !== 'string') {
    issues.push({ field, code: 'evidence-unavailable', reason: 'evidence reference is missing or invalid' });
    return { ref: 'unavailable', digest: null, available: false, byteLength: null };
  }
  const matched = EVIDENCE_REF.exec(value);
  if (matched === null) {
    issues.push({ field, code: 'redacted', reason: 'non-content-addressed evidence reference was removed' });
    return { ref: 'unavailable', digest: null, available: false, byteLength: null };
  }
  const digest = matched[1] as string;
  const path = join(runDir, 'evidence', digest);
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('not a regular file');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const byteLength = fstatSync(fd).size;
      const actualDigest = createHash('sha256').update(readFileSync(fd)).digest('hex');
      if (actualDigest !== digest) throw new Error('content digest mismatch');
      return { ref: value, digest, available: true, byteLength };
    } finally {
      closeSync(fd);
    }
  } catch {
    issues.push({
      field,
      code: 'evidence-unavailable',
      reason: 'evidence blob is missing or unreadable',
      source: `run:${runId}/evidence/${digest}`,
    });
    return { ref: value, digest, available: false, byteLength: null };
  }
}

function gates(
  runId: string,
  runDir: string,
  rows: readonly EventRow[],
  issues: ProjectionIssue[],
): Readonly<Record<string, readonly GateProjection[]>> {
  const latest = new Map<string, GateProjection>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.type !== 'GATE_RESULT' || row.task_id === null) continue;
    const payload = parsePayload(row);
    const tier = payload?.['tier'];
    const verdict = payload?.['pass'];
    if (!['T0', 'T1', 'T2', 'T3'].includes(String(tier))) {
      issues.push({ field: `gates.${row.task_id}`, code: 'invalid-record', reason: `invalid GATE_RESULT at seq ${row.seq}` });
      continue;
    }
    const key = `${row.task_id}:${String(tier)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(typeof verdict === 'boolean' || verdict === 'not_enabled')) {
      issues.push({ field: `gates.${row.task_id}.${String(tier)}`, code: 'invalid-record', reason: `invalid GATE_RESULT at seq ${row.seq}` });
      continue;
    }
    const checks = Array.isArray(payload?.['checks']) ? payload['checks'] : [];
    const evidence = checks.map((check, index) =>
      evidenceMetadata(runId, runDir, isRecord(check) ? check['evidenceRef'] : null, `gates.${row.task_id}.${String(tier)}.evidence.${index}`, issues),
    );
    latest.set(key, {
      tier: tier as GateProjection['tier'],
      verdict: verdict as GateProjection['verdict'],
      sequence: row.seq,
      evidence,
    });
  }
  const byTask: Record<string, GateProjection[]> = {};
  for (const [key, gate] of latest) {
    const taskId = key.slice(0, key.lastIndexOf(':'));
    (byTask[taskId] ??= []).push(gate);
  }
  for (const taskGates of Object.values(byTask)) taskGates.sort((left, right) => left.tier.localeCompare(right.tier));
  return byTask;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function budgets(
  runId: string,
  rows: readonly EventRow[],
  summary: CoreRunSummary,
  issues: ProjectionIssue[],
): Readonly<Record<string, RecordedDimension<BudgetProjection>>> {
  const descriptor = rows.find((row) => row.type === 'RUN_DESCRIPTOR');
  const descriptorPayload = descriptor === undefined ? null : parsePayload(descriptor);
  const cap = descriptorPayload?.['budget'];
  const capValid =
    isRecord(cap) && finiteNonNegative(cap['iterations']) && finiteNonNegative(cap['costUnits']) && finiteNonNegative(cap['wallclockMs']);
  const latest = new Map<string, EventRow>();
  for (const row of rows) {
    if (row.type === 'BUDGET_SNAPSHOT' && row.task_id !== null && !latest.has(row.task_id)) latest.set(row.task_id, row);
  }
  const taskIds = new Set([...summary.taskStates.map((task) => task.taskId), ...latest.keys()]);
  const result: Record<string, RecordedDimension<BudgetProjection>> = {};
  for (const taskId of taskIds) {
    if (descriptor === undefined) {
      result[taskId] = unknown('RUN_DESCRIPTOR budget cap was not recorded');
      continue;
    }
    if (!capValid) {
      result[taskId] = invalid('RUN_DESCRIPTOR budget cap is malformed', stamp(runId, descriptor));
      continue;
    }
    const row = latest.get(taskId);
    if (row === undefined) {
      result[taskId] = unknown('BUDGET_SNAPSHOT was not recorded', stamp(runId, descriptor));
      continue;
    }
    const payload = parsePayload(row);
    const used = payload?.['used'];
    const snapshotCap = payload?.['cap'];
    const valid =
      isRecord(used) &&
      finiteNonNegative(used['iterations']) &&
      finiteNonNegative(used['costUnits']) &&
      finiteNonNegative(used['activeWallclockMs']) &&
      isRecord(snapshotCap) &&
      snapshotCap['iterations'] === cap['iterations'] &&
      snapshotCap['costUnits'] === cap['costUnits'] &&
      snapshotCap['wallclockMs'] === cap['wallclockMs'];
    if (!valid) {
      result[taskId] = invalid('BUDGET_SNAPSHOT is malformed or cap does not match RUN_DESCRIPTOR', stamp(runId, row));
      issues.push({ field: `budgets.${taskId}`, code: 'invalid-record', reason: `invalid BUDGET_SNAPSHOT at seq ${row.seq}` });
      continue;
    }
    result[taskId] = known(
      {
        used: {
          iterations: used['iterations'] as number,
          costUnits: used['costUnits'] as number,
          wallclockMs: used['activeWallclockMs'] as number,
        },
        cap: {
          iterations: cap['iterations'] as number,
          costUnits: cap['costUnits'] as number,
          wallclockMs: cap['wallclockMs'] as number,
        },
        recordedAt: row.ts,
      },
      stamp(runId, row),
    );
  }
  return result;
}

function eventProjection(row: EventRow, issues: ProjectionIssue[]): CoreEventProjection {
  const payload = parsePayload(row);
  if (payload === null) {
    issues.push({ field: `events.${row.seq}.payload`, code: 'invalid-record', reason: 'event payload is not valid JSON object' });
    return { seq: row.seq, ts: row.ts, taskId: row.task_id, type: row.type, fields: {}, redactedFields: ['payload'] };
  }
  const allowed = new Set(EVENT_FIELD_ALLOWLIST[row.type] ?? []);
  const fields: Record<string, string | number | boolean | null> = {};
  const redactedFields: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (
      allowed.has(key) &&
      (value === null || typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 512))
    ) {
      fields[key] = value as string | number | boolean | null;
    } else {
      redactedFields.push(key);
    }
  }
  redactedFields.sort();
  return { seq: row.seq, ts: row.ts, taskId: row.task_id, type: row.type, fields, redactedFields };
}

function readDetail(runId: string, runDir: string): ProjectionEnvelope<CoreRunDetail> {
  const record = readSummary(runId, runDir);
  const issues = [...record.issues];
  return withRunDatabase(runDir, (db) => {
    const rows = db
      .prepare("SELECT seq, ts, run_id, task_id, type, payload FROM events WHERE type IN ('TASK_GRAPH_FROZEN', 'RUN_DESCRIPTOR', 'GATE_RESULT', 'BUDGET_SNAPSHOT') ORDER BY seq DESC LIMIT ?")
      .all(MAX_FOLD_ROWS + 1) as unknown as EventRow[];
    if (rows.length > MAX_FOLD_ROWS) {
      issues.push({ field: 'detail', code: 'source-unavailable', reason: 'detail fold limit exceeded' });
    }
    const bounded = rows.slice(0, MAX_FOLD_ROWS);
    return {
      data: {
        summary: record.summary,
        taskGraph: taskGraph(runId, bounded, record.summary),
        latestGatesByTask: gates(runId, runDir, bounded, issues),
        budgetsByTask: budgets(runId, bounded, record.summary, issues),
      },
      readAt: '',
      issues,
    };
  });
}

function fileStamp(source: string, mtimeMs: number): SourceStamp {
  const sourceTimestamp = Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : null;
  return { source, sourceTimestamp, sequence: null, freshness: sourceTimestamp === null ? 'unknown' : 'recorded' };
}

function loadRoutingPolicy(
  policiesDir: string | undefined,
  issues: ProjectionIssue[],
): RecordedDimension<ReturnType<typeof parseRoutingConfig>> {
  const source = '.ai/policies/routing.json';
  if (policiesDir === undefined) return unknown('routing policy source is not configured');
  const path = join(policiesDir, 'routing.json');
  try {
    const file = readTextSourceNoFollow(path);
    const raw = JSON.parse(file.text) as unknown;
    const provenance = fileStamp(source, file.mtimeMs);
    if (!isRecord(raw)) return invalid('routing policy is not an object', provenance);
    return known(parseRoutingConfig(raw), provenance);
  } catch {
    const provenance: SourceStamp = { source, sourceTimestamp: null, sequence: null, freshness: 'unknown' };
    const reason = existsSync(path) ? 'routing policy is unreadable or invalid' : 'routing policy is unavailable';
    issues.push({ field: 'aal.routingPolicy', code: existsSync(path) ? 'invalid-record' : 'source-unavailable', reason, source });
    return existsSync(path) ? invalid(reason, provenance) : unknown(reason, provenance);
  }
}

function loadFusionPolicy(
  policiesDir: string | undefined,
  issues: ProjectionIssue[],
): { readonly profiles: readonly FusionProfileProjection[]; readonly plannerRoleEnabled: boolean } {
  const source = '.ai/policies/fusion-profiles.json';
  if (policiesDir === undefined) return { profiles: [], plannerRoleEnabled: false };
  const path = join(policiesDir, 'fusion-profiles.json');
  try {
    const file = readTextSourceNoFollow(path);
    const provenance = fileStamp(source, file.mtimeMs);
    const parsed = parseFusionProfiles(JSON.parse(file.text) as unknown);
    return {
      profiles: [...parsed.profiles.values()].map((profile) => ({
        artifact: profile.artifact,
        panelSize: profile.panel.size,
        diversity:
          profile.panel.diversity.kind === 'self'
            ? `self:${profile.panel.diversity.seeds.join(',')}`
            : `cross_lineage:${profile.panel.diversity.lineages.join(',')}`,
        resolve: profile.resolve,
        budgetCapCostUnits: profile.budgetCapCostUnits,
        estimateCostUnitsPerCandidate: profile.estimateCostUnitsPerCandidate,
        provenance,
      })),
      plannerRoleEnabled: parsed.triggers.plannerRole,
    };
  } catch {
    const reason = existsSync(path) ? 'fusion policy is unreadable or invalid' : 'fusion policy is unavailable';
    issues.push({ field: 'aal.fusion.profiles', code: existsSync(path) ? 'invalid-record' : 'source-unavailable', reason, source });
    return { profiles: [], plannerRoleEnabled: false };
  }
}

function compareAalEvents(left: LocatedEvent, right: LocatedEvent): number {
  const leftTs = validTimestamp(left.ts);
  const rightTs = validTimestamp(right.ts);
  if (leftTs !== null && rightTs === null) return -1;
  if (leftTs === null && rightTs !== null) return 1;
  if (leftTs !== null && rightTs !== null && leftTs !== rightTs) return rightTs.localeCompare(leftTs);
  const run = right.sourceRunId.localeCompare(left.sourceRunId);
  return run !== 0 ? run : right.seq - left.seq;
}

function scanAalEvents(runsRoot: string, issues: ProjectionIssue[]): LocatedEvent[] {
  if (!existsSync(runsRoot)) return [];
  let entries;
  try {
    const info = lstatSync(runsRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('runs root is not a directory');
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    issues.push({ field: 'aal.events', code: 'source-unavailable', reason: 'runs root is unavailable' });
    return [];
  }
  const rows: LocatedEvent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validateRunId(entry.name)) continue;
    const dir = runDirectory(runsRoot, entry.name);
    if (dir === null || eventDatabase(dir) === null) continue;
    try {
      const found = withRunDatabase(dir, (db) => db
        .prepare(`SELECT seq, ts, run_id, task_id, type, payload FROM events WHERE type IN (${AAL_EVENT_TYPES.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT ?`)
        .all(...AAL_EVENT_TYPES, MAX_FOLD_ROWS + 1) as unknown as EventRow[]);
      if (found.length > MAX_FOLD_ROWS) {
        issues.push({ field: `aal.events.${entry.name}`, code: 'source-unavailable', reason: 'AAL event fold limit exceeded' });
      }
      rows.push(...found.slice(0, MAX_FOLD_ROWS).map((row) => ({ ...row, sourceRunId: entry.name })));
    } catch {
      issues.push({
        field: `aal.events.${entry.name}`,
        code: 'source-unavailable',
        reason: 'events.db is unreadable',
        source: `run:${entry.name}/events.db`,
      });
    }
  }
  return rows.sort(compareAalEvents);
}

function locatedStamp(row: LocatedEvent): SourceStamp {
  return stamp(row.sourceRunId, row);
}

function routeRoles(events: readonly LocatedEvent[], issues: ProjectionIssue[]): RoutingRoleProjection[] {
  const roles = new Map<string, RoutingRoleProjection>();
  for (const row of events) {
    if (row.type !== 'OUTCOME_ROUTE' && row.type !== 'SHADOW_ROUTE') continue;
    const payload = parsePayload(row);
    const role = payload?.['role'];
    if (typeof role !== 'string' || role.length === 0) {
      issues.push({ field: 'aal.roles', code: 'invalid-record', reason: `routing role is invalid at ${row.sourceRunId}:${row.seq}` });
      continue;
    }
    const rawContext = payload?.['context'];
    const context = rawContext === undefined || rawContext === 'autonomous-loop'
      ? 'autonomous-loop'
      : rawContext === 'pr-quality'
        ? 'pr-quality'
        : null;
    const key = `${context ?? 'autonomous-loop'}:${role}`;
    if (roles.has(key)) continue;
    const provenance = locatedStamp(row);
    const order = stringArray(payload?.['order']);
    const validOrder = order !== null && order.every((target) => target.length > 0) && new Set(order).size === order.length;
    if (context === null || !validOrder) {
      roles.set(key, {
        context: context ?? 'autonomous-loop',
        role,
        orderedTargets: [],
        fallbackOrder: [],
        basis: 'unknown',
        provenance,
      });
      issues.push({ field: `aal.roles.${key}`, code: 'invalid-record', reason: `latest routing order is invalid at ${row.sourceRunId}:${row.seq}` });
      continue;
    }
    roles.set(key, {
      context,
      role,
      orderedTargets: order,
      fallbackOrder: order.slice(1),
      basis: 'recorded',
      provenance,
    });
  }
  return [...roles.values()].sort((left, right) => `${left.context}:${left.role}`.localeCompare(`${right.context}:${right.role}`));
}

function latestBreakerStates(
  events: readonly LocatedEvent[],
  issues: ProjectionIssue[],
): Map<string, RecordedDimension<{ readonly state: 'closed' | 'open' | 'half_open' }>> {
  const result = new Map<string, RecordedDimension<{ readonly state: 'closed' | 'open' | 'half_open' }>>();
  for (const row of events) {
    if (row.type !== 'BREAKER_STATE_CHANGED') continue;
    const payload = parsePayload(row);
    const key = payload?.['key'];
    if (typeof key !== 'string' || key.length === 0) {
      issues.push({ field: 'aal.targets.breaker', code: 'invalid-record', reason: `breaker target is invalid at ${row.sourceRunId}:${row.seq}` });
      continue;
    }
    if (result.has(key)) continue;
    const state = payload?.['to'];
    const provenance = locatedStamp(row);
    if (typeof state !== 'string' || !BREAKER_STATES.has(state)) {
      result.set(key, invalid('latest breaker transition is invalid', provenance));
      issues.push({ field: `aal.targets.${key}.breaker`, code: 'invalid-record', reason: `breaker transition is invalid at ${row.sourceRunId}:${row.seq}` });
    } else {
      result.set(key, known({ state: state as 'closed' | 'open' | 'half_open' }, provenance));
    }
  }
  return result;
}

function latestRateStates(
  events: readonly LocatedEvent[],
  issues: ProjectionIssue[],
): Map<string, RecordedDimension<{ readonly limited: boolean; readonly availableTokens: number | null }>> {
  const result = new Map<string, RecordedDimension<{ readonly limited: boolean; readonly availableTokens: number | null }>>();
  for (const row of events) {
    if (row.type !== 'RATE_LIMIT_OBSERVED') continue;
    const payload = parsePayload(row);
    const target = payload?.['target'];
    if (typeof target !== 'string' || target.length === 0) {
      issues.push({ field: 'aal.targets.rate', code: 'invalid-record', reason: `rate target is invalid at ${row.sourceRunId}:${row.seq}` });
      continue;
    }
    if (result.has(target)) continue;
    const limited = payload?.['limited'];
    const availableTokens = payload?.['availableTokens'];
    const provenance = locatedStamp(row);
    const validAvailableTokens = availableTokens === null || finiteNonNegative(availableTokens)
      ? availableTokens
      : undefined;
    if (typeof limited !== 'boolean' || validAvailableTokens === undefined || (limited && validAvailableTokens === null)) {
      result.set(target, invalid('latest rate-limit observation is invalid', provenance));
      issues.push({ field: `aal.targets.${target}.recordedLimitState`, code: 'invalid-record', reason: `rate observation is invalid at ${row.sourceRunId}:${row.seq}` });
    } else {
      result.set(target, known({ limited, availableTokens: validAvailableTokens }, provenance));
    }
  }
  return result;
}

interface ConformanceSelection {
  readonly adapterId: string;
  readonly modelVersion: string | null;
  readonly dimension: RecordedDimension<ConformanceSummary>;
}

function calibrationStamp(name: string, raw: unknown): SourceStamp {
  const ranAt = isRecord(raw) && typeof raw['ranAt'] === 'string' ? validTimestamp(raw['ranAt']) : null;
  return {
    source: `.ai/calibration/${name}`,
    sourceTimestamp: ranAt,
    sequence: null,
    freshness: ranAt === null ? 'unknown' : 'recorded',
  };
}

function conformanceSummary(raw: unknown, adapterId: string): { readonly modelVersion: string; readonly value: ConformanceSummary } | null {
  if (!isRecord(raw) || raw['adapterId'] !== adapterId || !safeTechnicalIdentifier(raw['modelVersion'])) return null;
  if (typeof raw['ranAt'] !== 'string' || validTimestamp(raw['ranAt']) === null || !Array.isArray(raw['probes']) || raw['probes'].length !== PASS_FAIL_PROBES.length) return null;
  const probes = {} as Record<(typeof PASS_FAIL_PROBES)[number], boolean>;
  const seen = new Set<string>();
  for (const probe of raw['probes']) {
    if (!isRecord(probe) || !PASS_FAIL_PROBES.includes(probe['id'] as (typeof PASS_FAIL_PROBES)[number]) || seen.has(String(probe['id']))) return null;
    if (typeof probe['pass'] !== 'boolean' || typeof probe['evidenceRef'] !== 'string' || EVIDENCE_REF.exec(probe['evidenceRef']) === null) return null;
    seen.add(probe['id'] as string);
    probes[probe['id'] as (typeof PASS_FAIL_PROBES)[number]] = probe['pass'];
  }
  const p7 = raw['p7'];
  if (!isRecord(p7) || typeof p7['susceptibilityScore'] !== 'number' || !Number.isFinite(p7['susceptibilityScore']) || p7['susceptibilityScore'] < 0 || p7['susceptibilityScore'] > 1) return null;
  if (typeof p7['evidenceRef'] !== 'string' || EVIDENCE_REF.exec(p7['evidenceRef']) === null) return null;
  return {
    modelVersion: raw['modelVersion'],
    value: { modelVersion: raw['modelVersion'], probes, p7SusceptibilityScore: p7['susceptibilityScore'] },
  };
}

function loadConformanceSelections(calibrationDir: string | undefined, issues: ProjectionIssue[]): Map<string, ConformanceSelection> {
  const result = new Map<string, ConformanceSelection>();
  if (calibrationDir === undefined || !existsSync(calibrationDir)) return result;
  let names: string[];
  try {
    const info = lstatSync(calibrationDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('calibration source is not a directory');
    names = readdirSync(calibrationDir).sort();
  } catch {
    issues.push({ field: 'aal.conformance', code: 'source-unavailable', reason: 'calibration source is unavailable' });
    return result;
  }
  const candidates = new Map<string, string>();
  for (const name of names) {
    const match = /^conformance-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z)\.json$/u.exec(name);
    if (match !== null && match[1] !== undefined && match[1].length > 0) candidates.set(match[1], name);
  }
  for (const [adapterId, name] of candidates) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readTextSourceNoFollow(join(calibrationDir, name)).text) as unknown;
    } catch {
      // Newest candidate remains authoritative even when unreadable.
    }
    const provenance = calibrationStamp(name, raw);
    const parsed = conformanceSummary(raw, adapterId);
    if (parsed === null) {
      result.set(adapterId, { adapterId, modelVersion: null, dimension: invalid('newest conformance record is invalid', provenance) });
      issues.push({ field: `aal.conformance.${adapterId}`, code: 'invalid-record', reason: 'newest conformance record is invalid', source: provenance.source });
    } else {
      result.set(adapterId, { adapterId, modelVersion: parsed.modelVersion, dimension: known(parsed.value, provenance) });
    }
  }
  return result;
}

function targetParts(target: string): { readonly adapterId: string; readonly modelVersion: string | null } {
  const separator = target.indexOf('@');
  return separator < 0
    ? { adapterId: target, modelVersion: null }
    : { adapterId: target.slice(0, separator), modelVersion: target.slice(separator + 1) };
}

function conformanceForTarget(target: string, selections: ReadonlyMap<string, ConformanceSelection>): RecordedDimension<ConformanceSummary> {
  const { adapterId, modelVersion } = targetParts(target);
  const selected = selections.get(adapterId);
  if (selected === undefined) return unknown('no conformance record exists for target');
  if (selected.dimension.status !== 'known') return selected.dimension;
  if (modelVersion !== null && modelVersion !== selected.modelVersion) {
    return unknown(`newest conformance record is for model ${selected.modelVersion ?? 'unknown'}`, selected.dimension.provenance);
  }
  return selected.dimension;
}

function latestFusionRun(events: readonly LocatedEvent[], issues: ProjectionIssue[]): FusionProjection['latestRun'] {
  const row = events.find((event) => event.type === 'FUSION_RESOLVED');
  if (row === undefined) return unknown('no Fusion run was recorded');
  const payload = parsePayload(row);
  const resolved = payload?.['resolved'];
  const winner = payload?.['winner'];
  const provenance = locatedStamp(row);
  if (!((resolved === null || typeof resolved === 'string') && typeof winner === 'boolean')) {
    issues.push({ field: 'aal.fusion.latestRun', code: 'invalid-record', reason: `latest FUSION_RESOLVED is invalid at ${row.sourceRunId}:${row.seq}` });
    return invalid('latest Fusion record is invalid', provenance);
  }
  const plan = events
    .filter((event) => event.type === 'PLAN_RESOLVED' && event.sourceRunId === row.sourceRunId && event.task_id === row.task_id && event.seq > row.seq)
    .sort((left, right) => left.seq - right.seq)[0];
  const planPayload = plan === undefined ? null : parsePayload(plan);
  const planWinner = planPayload?.['winner'];
  const cost = planPayload?.['costUnits'];
  if (plan !== undefined && (planPayload === null || (planWinner !== undefined && typeof planWinner !== 'boolean') || (cost !== undefined && !finiteNonNegative(cost)))) {
    issues.push({ field: 'aal.fusion.latestRun', code: 'invalid-record', reason: `matching PLAN_RESOLVED is invalid at ${plan.sourceRunId}:${plan.seq}` });
    return invalid('latest Fusion plan record is invalid', locatedStamp(plan));
  }
  return known(
    {
      resolved,
      escalated: winner === false || planWinner === false || typeof payload?.['escalateReason'] === 'string',
      usageCostUnits: finiteNonNegative(cost) ? cost : null,
    },
    provenance,
  );
}

function projectAal(options: {
  readonly runsRoot: string;
  readonly policiesDir?: string;
  readonly calibrationDir?: string;
}): { readonly data: AalProjection; readonly issues: readonly ProjectionIssue[] } {
  const issues: ProjectionIssue[] = [];
  const routingPolicy = loadRoutingPolicy(options.policiesDir, issues);
  const fusionPolicy = loadFusionPolicy(options.policiesDir, issues);
  const events = scanAalEvents(options.runsRoot, issues);
  const roles = routeRoles(events, issues);
  const breakers = latestBreakerStates(events, issues);
  const rates = latestRateStates(events, issues);
  const conformance = loadConformanceSelections(options.calibrationDir, issues);
  const targetNames = new Set<string>();
  for (const role of roles) for (const target of role.orderedTargets) targetNames.add(target);
  for (const target of breakers.keys()) targetNames.add(target);
  for (const target of rates.keys()) targetNames.add(target);
  if (routingPolicy.status === 'known') for (const target of Object.keys(routingPolicy.value.tokenBuckets)) targetNames.add(target);
  for (const selected of conformance.values()) targetNames.add(selected.modelVersion === null ? selected.adapterId : `${selected.adapterId}@${selected.modelVersion}`);
  const exactAdapters = new Set([...targetNames].filter((target) => target.includes('@')).map((target) => targetParts(target).adapterId));
  const targets = [...targetNames]
    .filter((target) => target.includes('@') || !exactAdapters.has(target))
    .sort()
    .map((target): RoutingTargetProjection => {
      const { adapterId } = targetParts(target);
      const rateState = rates.get(target) ?? rates.get(adapterId);
      let rateLimitPolicy: RoutingTargetProjection['rateLimitPolicy'];
      if (routingPolicy.status !== 'known') {
        rateLimitPolicy = routingPolicy.status === 'invalid-record'
          ? invalid(routingPolicy.reason, routingPolicy.provenance)
          : unknown(routingPolicy.reason, routingPolicy.provenance);
      } else {
        const policy = routingPolicy.value.tokenBuckets[adapterId];
        rateLimitPolicy = policy === undefined
          ? unknown('no rate-limit policy is configured for target', routingPolicy.provenance)
          : known(policy, routingPolicy.provenance);
      }
      return {
        target,
        breaker: breakers.get(target) ?? unknown('no breaker transition was recorded'),
        rateLimitPolicy,
        recordedLimitState: rateState ?? unknown('no rate-limit observation was recorded'),
        conformance: conformanceForTarget(target, conformance),
      };
    });
  return {
    data: {
      roles,
      targets,
      fusion: {
        profiles: fusionPolicy.profiles,
        plannerRoleEnabled: fusionPolicy.plannerRoleEnabled,
        latestRun: latestFusionRun(events, issues),
      },
    },
    issues,
  };
}

function automationModel(
  policiesDir: string | undefined,
  issues: ProjectionIssue[],
): { readonly model: string | null; readonly provenance: SourceStamp } {
  const source = '.ai/policies/automation.json';
  const unknownStamp: SourceStamp = { source, sourceTimestamp: null, sequence: null, freshness: 'unknown' };
  if (policiesDir === undefined) return { model: null, provenance: unknownStamp };
  const path = join(policiesDir, 'automation.json');
  try {
    const file = readTextSourceNoFollow(path);
    const raw = JSON.parse(file.text) as unknown;
    const provenance = fileStamp(source, file.mtimeMs);
    const model = isRecord(raw) ? raw['autonomousModel'] : null;
    if (!safeTechnicalIdentifier(model)) {
      issues.push({ field: 'adapters.modelMappings.autonomous-loop', code: 'invalid-record', reason: 'automation model mapping is invalid', source });
      return { model: null, provenance };
    }
    return { model: model.trim(), provenance };
  } catch {
    issues.push({
      field: 'adapters.modelMappings.autonomous-loop',
      code: existsSync(path) ? 'invalid-record' : 'source-unavailable',
      reason: existsSync(path) ? 'automation model mapping is unreadable' : 'automation model mapping is unavailable',
      source,
    });
    return { model: null, provenance: unknownStamp };
  }
}

function latestAdapterHealth(
  events: readonly LocatedEvent[],
  issues: ProjectionIssue[],
): Map<string, RecordedDimension<{ readonly ok: boolean; readonly reason?: string }>> {
  const result = new Map<string, RecordedDimension<{ readonly ok: boolean; readonly reason?: string }>>();
  for (const row of events) {
    if (row.type !== 'QUOTA_PROBE') continue;
    const payload = parsePayload(row);
    const adapterId = payload?.['adapterId'];
    if (typeof adapterId !== 'string' || adapterId.length === 0) {
      issues.push({ field: 'adapters.health', code: 'invalid-record', reason: `health target is invalid at ${row.sourceRunId}:${row.seq}` });
      continue;
    }
    if (result.has(adapterId)) continue;
    const ok = payload?.['ok'];
    const reason = payload?.['reason'];
    const provenance = locatedStamp(row);
    if (typeof ok !== 'boolean' || !(reason === null || reason === undefined || reason === 'quota_threshold' || reason === 'probe_failed')) {
      result.set(adapterId, invalid('latest health record is invalid', provenance));
      issues.push({ field: `adapters.${adapterId}.health`, code: 'invalid-record', reason: `health record is invalid at ${row.sourceRunId}:${row.seq}` });
      continue;
    }
    result.set(adapterId, known({ ok, ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}) }, provenance));
  }
  return result;
}

interface AdapterCalibrationSummary {
  readonly recordType: string;
  readonly outcome: 'pass' | 'fail' | 'measured';
  readonly metrics: Readonly<Record<string, string | number | boolean | null>>;
}

interface AdapterCalibrationCandidate {
  readonly adapterId: string;
  readonly name: string;
  readonly raw: unknown;
  readonly rankTimestamp: string | null;
}

const SENSITIVE_CALIBRATION_FIELD = /(api.?key|token|password|secret|private.?key|connection.?string|credential)/iu;
const SENSITIVE_CALIBRATION_VALUE = /(bearer\s|-----BEGIN|\bsk-[A-Za-z0-9]|:\/\/[^/\s]+:[^@\s]+@)/iu;

function filenameTimestamp(name: string): string | null {
  const match = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z/u.exec(name);
  if (match === null) return null;
  return validTimestamp(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7] ?? '000'}Z`);
}

function parseAdapterCalibration(raw: unknown, adapterId: string): AdapterCalibrationSummary | null {
  if (!isRecord(raw) || raw['adapterId'] !== adapterId || !safeTechnicalIdentifier(raw['modelVersion'])) return null;
  if (typeof raw['ranAt'] !== 'string' || validTimestamp(raw['ranAt']) === null || !safeTechnicalIdentifier(raw['recordType'])) return null;
  if (raw['outcome'] !== 'pass' && raw['outcome'] !== 'fail' && raw['outcome'] !== 'measured') return null;
  const metrics = raw['metrics'];
  if (!isRecord(metrics)) return null;
  const safeMetrics: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (SENSITIVE_CALIBRATION_FIELD.test(key)) return null;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      safeMetrics[key] = value;
      continue;
    }
    if (typeof value !== 'string' || value.length > 256 || SENSITIVE_CALIBRATION_VALUE.test(value)) return null;
    safeMetrics[key] = value;
  }
  return { recordType: raw['recordType'], outcome: raw['outcome'], metrics: safeMetrics };
}

function loadAdapterCalibrations(
  calibrationDir: string | undefined,
  issues: ProjectionIssue[],
): Map<string, RecordedDimension<AdapterCalibrationSummary>> {
  const result = new Map<string, RecordedDimension<AdapterCalibrationSummary>>();
  if (calibrationDir === undefined || !existsSync(calibrationDir)) return result;
  let names: string[];
  try {
    const info = lstatSync(calibrationDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('calibration source is not a directory');
    names = readdirSync(calibrationDir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    issues.push({ field: 'adapters.calibration', code: 'source-unavailable', reason: 'calibration source is unavailable' });
    return result;
  }
  const candidates: AdapterCalibrationCandidate[] = [];
  for (const name of names) {
    if (name.startsWith('conformance-') || name.startsWith('fusion-uplift-')) continue;
    let raw: unknown = null;
    try {
      raw = JSON.parse(readTextSourceNoFollow(join(calibrationDir, name)).text) as unknown;
    } catch {
      // Filename identity can still make an unreadable newest candidate authoritative.
    }
    const filenameMatch = /^(?:adapter-)?calibration-(.+)-(\d{4}-\d{2}-\d{2}T.+Z)\.json$/u.exec(name);
    const adapterId = isRecord(raw) && typeof raw['adapterId'] === 'string' && raw['adapterId'].length > 0
      ? raw['adapterId']
      : filenameMatch?.[1];
    if (adapterId === undefined || adapterId.length === 0) continue;
    const rawTimestamp = isRecord(raw) && typeof raw['ranAt'] === 'string' ? validTimestamp(raw['ranAt']) : null;
    candidates.push({ adapterId, name, raw, rankTimestamp: rawTimestamp ?? filenameTimestamp(name) });
  }
  candidates.sort((left, right) => {
    if (left.rankTimestamp !== null && right.rankTimestamp === null) return -1;
    if (left.rankTimestamp === null && right.rankTimestamp !== null) return 1;
    if (left.rankTimestamp !== null && right.rankTimestamp !== null && left.rankTimestamp !== right.rankTimestamp) {
      return right.rankTimestamp.localeCompare(left.rankTimestamp);
    }
    return right.name.localeCompare(left.name);
  });
  for (const candidate of candidates) {
    if (result.has(candidate.adapterId)) continue;
    const provenance = calibrationStamp(candidate.name, candidate.raw);
    const parsed = parseAdapterCalibration(candidate.raw, candidate.adapterId);
    if (parsed === null) {
      result.set(candidate.adapterId, invalid('newest adapter calibration record is invalid', provenance));
      issues.push({ field: `adapters.${candidate.adapterId}.calibration`, code: 'invalid-record', reason: 'newest adapter calibration record is invalid', source: provenance.source });
    } else {
      result.set(candidate.adapterId, known(parsed, provenance));
    }
  }
  return result;
}

const MODEL_ENV_BY_ADAPTER = {
  claude: 'PR_GATE_CLAUDE_MODEL',
  codex: 'PR_GATE_CODEX_MODEL',
  'gemini-cli': 'PR_GATE_GEMINI_MODEL',
  'opencode-deepseek': 'PR_GATE_DEEPSEEK_MODEL',
} as const;

const AUTONOMOUS_ROLES = ['planner', 'test_designer', 'implementer', 'diagnostician', 'reviewer'] as const;

function adapterModelMappings(
  adapterId: string,
  autonomous: { readonly model: string | null; readonly provenance: SourceStamp },
  environment: AdapterModelEnvironment | undefined,
): AdapterModelMapping[] {
  const result: AdapterModelMapping[] = [];
  if (adapterId === 'claude') {
    result.push(...AUTONOMOUS_ROLES.map((role) => ({
      context: 'autonomous-loop' as const,
      role,
      model: autonomous.model,
      provenance: autonomous.provenance,
    })));
  }
  const envName = MODEL_ENV_BY_ADAPTER[adapterId as keyof typeof MODEL_ENV_BY_ADAPTER];
  if (envName !== undefined) {
    const raw = environment?.[envName] ?? null;
    const model = safeTechnicalIdentifier(raw) ? raw : null;
    result.push({
      context: 'pr-quality',
      role: 'reviewer',
      model,
      provenance: { source: `env:${envName}`, sourceTimestamp: null, sequence: null, freshness: 'unknown' },
    });
  }
  return result;
}

function projectAdapters(options: {
  readonly runsRoot: string;
  readonly policiesDir?: string;
  readonly calibrationDir?: string;
  readonly adapterDescriptors?: readonly StaticAdapterDescriptor[];
  readonly adapterModelEnvironment?: AdapterModelEnvironment;
}): { readonly items: readonly AdapterProjection[]; readonly issues: readonly ProjectionIssue[] } {
  const issues: ProjectionIssue[] = [];
  const events = scanAalEvents(options.runsRoot, issues);
  const health = latestAdapterHealth(events, issues);
  const calibrations = loadAdapterCalibrations(options.calibrationDir, issues);
  const conformance = loadConformanceSelections(options.calibrationDir, issues);
  const autonomous = automationModel(options.policiesDir, issues);
  const seen = new Set<string>();
  const items: AdapterProjection[] = [];
  for (const descriptor of [...(options.adapterDescriptors ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!safeTechnicalIdentifier(descriptor.id) || seen.has(descriptor.id) || descriptor.manifest.adapterId !== descriptor.id) {
      issues.push({ field: 'adapters.catalog', code: 'invalid-record', reason: `invalid or duplicate static descriptor: ${descriptor.id || 'empty'}` });
      continue;
    }
    seen.add(descriptor.id);
    const currentConformance = conformanceForTarget(descriptor.id, conformance);
    const conformancePasses = currentConformance.status === 'known'
      ? PASS_FAIL_PROBES.every((probe) => currentConformance.value.probes[probe])
      : null;
    const eligibility = evaluateEligibility({
      role: 'implementer',
      manifest: descriptor.manifest,
      conformancePasses,
      stale: currentConformance.status === 'known' ? false : null,
      breakerState: 'unconfigured',
      health: 'unconfigured',
      susceptibilityScore: currentConformance.status === 'known' ? currentConformance.value.p7SusceptibilityScore : null,
      lineage: descriptor.manifest.lineage ?? null,
    });
    items.push({
      id: descriptor.id,
      transport: descriptor.transport,
      manifest: {
        structuredOutput: descriptor.manifest.structuredOutput,
        toolCalling: descriptor.manifest.toolCalling,
        contextWindowTokens: descriptor.manifest.contextWindowTokens,
        executionBackend: false,
        determinism: descriptor.manifest.determinism,
        lineage: descriptor.manifest.lineage ?? null,
      },
      registrationEligibility: {
        state: eligibility.state,
        reasons: eligibility.reasons,
        provenance: currentConformance.status === 'known' ? currentConformance.provenance : null,
      },
      modelMappings: adapterModelMappings(descriptor.id, autonomous, options.adapterModelEnvironment),
      health: health.get(descriptor.id) ?? unknown('no recorded health status exists'),
      calibration: calibrations.get(descriptor.id) ?? unknown('no adapter calibration record exists'),
      conformance: currentConformance,
    });
  }
  return { items, issues };
}

function encodeAdapterCursor(adapterId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, adapterId } satisfies AdapterCursor)).toString('base64url');
}

function decodeAdapterCursor(value: string): AdapterCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'adapterId,v' || parsed['v'] !== 1) throw new Error('shape');
    if (typeof parsed['adapterId'] !== 'string' || parsed['adapterId'].length === 0 || parsed['adapterId'].length > 512) throw new Error('value');
    return { v: 1, adapterId: parsed['adapterId'] };
  } catch {
    throw new InvalidControlCenterQueryError('invalid adapter cursor');
  }
}

export function parseControlCenterLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^\d+$/u.test(value)) throw new InvalidControlCenterQueryError('limit must be an integer from 1 to 100');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidControlCenterQueryError('limit must be an integer from 1 to 100');
  }
  return limit;
}

export function parseControlCenterAfter(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/u.test(value)) throw new InvalidControlCenterQueryError('after must be a non-negative integer');
  const after = Number(value);
  if (!Number.isSafeInteger(after) || after < 0) throw new InvalidControlCenterQueryError('after must be a non-negative integer');
  return after;
}

export function createControlCenterReadPort(options: {
  readonly runsRoot: string;
  readonly policiesDir?: string;
  readonly calibrationDir?: string;
  readonly adapterDescriptors?: readonly StaticAdapterDescriptor[];
  readonly adapterModelEnvironment?: AdapterModelEnvironment;
  readonly services?: ControlCenterServices;
  readonly now: () => number;
}): ControlCenterReadPort {
  const readAt = (): string => new Date(options.now()).toISOString();
  return {
    listRuns({ cursor, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new InvalidControlCenterQueryError('invalid limit');
      const decoded = cursor === null ? null : decodeRunCursor(cursor);
      const records = readRunRecords(options.runsRoot);
      const eligible =
        decoded === null
          ? records
          : records.filter((record) => compareRun(
              { createdAt: record.createdAt, runId: record.summary.runId },
              decoded,
            ) > 0);
      const pageRecords = eligible.slice(0, limit);
      const nextCursor = eligible.length > limit && pageRecords.length > 0
        ? encodeRunCursor(pageRecords[pageRecords.length - 1] as RunRecord)
        : null;
      return {
        data: {
          page: { items: pageRecords.map((record) => record.summary), nextCursor, limit },
          totals: {
            activeRuns: records.filter((record) => record.summary.lifecycle.status === 'known' && record.summary.lifecycle.value === 'active').length,
            pendingApprovals: records.reduce(
              (total, record) => total + (record.summary.pendingApprovals.status === 'known' ? record.summary.pendingApprovals.value : 0),
              0,
            ),
          },
        },
        readAt: readAt(),
        issues: records.flatMap((record) => record.issues),
      };
    },

    readRun(runId) {
      const dir = runDirectory(options.runsRoot, runId);
      if (dir === null || eventDatabase(dir) === null || !isCoreRun(dir)) return null;
      try {
        const envelope = readDetail(runId, dir);
        return { ...envelope, readAt: readAt() };
      } catch {
        const reason = 'events.db is unreadable';
        return {
          data: {
            summary: unavailableSummary(runId, reason),
            taskGraph: unknown(reason),
            latestGatesByTask: {},
            budgetsByTask: {},
          },
          readAt: readAt(),
          issues: [{ field: 'run', code: 'source-unavailable', reason, source: `run:${runId}/events.db` }],
        };
      }
    },

    readRunEvents({ runId, after, limit }) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new InvalidControlCenterQueryError('invalid event pagination');
      }
      const dir = runDirectory(options.runsRoot, runId);
      if (dir === null || eventDatabase(dir) === null || !isCoreRun(dir)) return null;
      const issues: ProjectionIssue[] = [];
      try {
        return withRunDatabase(dir, (db) => {
          const rows = db
            .prepare('SELECT seq, ts, run_id, task_id, type, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
            .all(after, limit + 1) as unknown as EventRow[];
          const pageRows = rows.slice(0, limit);
          return {
            data: {
              items: pageRows.map((row) => eventProjection(row, issues)),
              nextCursor: rows.length > limit && pageRows.length > 0 ? String(pageRows[pageRows.length - 1]?.seq) : null,
              limit,
            },
            readAt: readAt(),
            issues,
          };
        });
      } catch {
        throw new ControlCenterSourceUnavailableError('run events are unavailable');
      }
    },

    readAal() {
      const projection = projectAal(options);
      return { ...projection, readAt: readAt() };
    },

    listAdapters({ cursor, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new InvalidControlCenterQueryError('invalid limit');
      const decoded = cursor === null ? null : decodeAdapterCursor(cursor);
      const projection = projectAdapters(options);
      const eligible = decoded === null
        ? projection.items
        : projection.items.filter((adapter) => adapter.id.localeCompare(decoded.adapterId) > 0);
      const pageItems = eligible.slice(0, limit);
      return {
        data: {
          items: pageItems,
          nextCursor: eligible.length > limit && pageItems.length > 0 ? encodeAdapterCursor(pageItems[pageItems.length - 1]?.id ?? '') : null,
          limit,
        },
        readAt: readAt(),
        issues: projection.issues,
      };
    },

    readAdapter(id) {
      const projection = projectAdapters(options);
      const adapter = projection.items.find((item) => item.id === id);
      return adapter === undefined ? null : { data: adapter, readAt: readAt(), issues: projection.issues };
    },

    readServiceHealth() {
      const unavailable = { status: 'unavailable' as const, reason: 'service is not configured' };
      return {
        data: {
          console: 'available',
          services: options.services ?? {
            terminal: unavailable,
            chat: unavailable,
            loop: unavailable,
            scheduler: unavailable,
            prQuality: unavailable,
          },
          disclaimer: 'Composition availability only; no command, process, provider, or network probe was run.',
        },
        readAt: readAt(),
        issues: [],
      };
    },
  };
}
