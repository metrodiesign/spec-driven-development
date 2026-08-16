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

export interface ProjectionEnvelope<T> {
  readonly data: T;
  readonly readAt: string;
  readonly issues: readonly ProjectionIssue[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export type RecordedDimension<T> =
  | { readonly status: 'known'; readonly value: T; readonly provenance: SourceStamp }
  | { readonly status: 'unknown'; readonly reason: string; readonly provenance?: SourceStamp }
  | { readonly status: 'invalid-record'; readonly reason: string; readonly provenance: SourceStamp };

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

export interface CoreRunList {
  readonly page: Page<CoreRunSummary>;
  readonly totals: { readonly activeRuns: number; readonly pendingApprovals: number };
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

export interface CoreEventProjection {
  readonly seq: number;
  readonly ts: string;
  readonly taskId: string | null;
  readonly type: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
  readonly redactedFields: readonly string[];
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

export interface AalProjection {
  readonly roles: readonly RoutingRoleProjection[];
  readonly targets: readonly RoutingTargetProjection[];
  readonly fusion: {
    readonly profiles: readonly FusionProfileProjection[];
    readonly plannerRoleEnabled: boolean;
    readonly latestRun: RecordedDimension<{
      readonly resolved: string | null;
      readonly escalated: boolean;
      readonly usageCostUnits: number | null;
    }>;
  };
}

export interface AdapterManifestProjection {
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly contextWindowTokens: number | null;
  readonly executionBackend: false;
  readonly determinism: 'none' | 'seed' | 'unknown';
  readonly lineage: string | null;
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
  readonly modelMappings: readonly {
    readonly context: 'autonomous-loop' | 'pr-quality';
    readonly role: string;
    readonly model: string | null;
    readonly provenance: SourceStamp;
  }[];
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

export interface ConformanceProbeRow {
  readonly id: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8';
  readonly value: boolean | number;
}

export function dimensionText<T>(dimension: RecordedDimension<T>, format: (value: T) => string = String): string {
  return dimension.status === 'known' ? format(dimension.value) : `unavailable: ${dimension.reason}`;
}

export function mergeRunPages(current: readonly CoreRunSummary[], incoming: readonly CoreRunSummary[]): readonly CoreRunSummary[] {
  const byId = new Map(current.map((run) => [run.runId, run]));
  for (const run of incoming) byId.set(run.runId, run);
  return [...byId.values()];
}

export function filterCoreRuns(
  runs: readonly CoreRunSummary[],
  query: string,
  lifecycle: 'all' | 'active' | 'ended',
): readonly CoreRunSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return runs.filter((run) => {
    const lifecycleMatches = lifecycle === 'all' || (run.lifecycle.status === 'known' && run.lifecycle.value === lifecycle);
    const queryMatches =
      needle.length === 0 ||
      run.runId.toLocaleLowerCase().includes(needle) ||
      run.taskStates.some((task) => task.taskId.toLocaleLowerCase().includes(needle));
    return lifecycleMatches && queryMatches;
  });
}

export function mergeCoreEvents(
  current: readonly CoreEventProjection[],
  incoming: readonly CoreEventProjection[],
): readonly CoreEventProjection[] {
  const bySequence = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

export function taskTransitions(events: readonly CoreEventProjection[]): readonly CoreEventProjection[] {
  return mergeCoreEvents([], events).filter(
    (event) => event.type === 'TASK_STATE' && typeof event.fields['state'] === 'string',
  );
}

export function latestSequence(events: readonly CoreEventProjection[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.seq), 0);
}

export function filterAalTargets(
  targets: readonly RoutingTargetProjection[],
  query: string,
  conformance: 'all' | RecordedDimension<ConformanceSummary>['status'],
): readonly RoutingTargetProjection[] {
  const needle = query.trim().toLocaleLowerCase();
  return targets.filter((target) =>
    (needle.length === 0 || target.target.toLocaleLowerCase().includes(needle)) &&
    (conformance === 'all' || target.conformance.status === conformance),
  );
}

export function conformanceProbeRows(summary: ConformanceSummary): readonly ConformanceProbeRow[] {
  return [
    { id: 'P1', value: summary.probes.P1 },
    { id: 'P2', value: summary.probes.P2 },
    { id: 'P3', value: summary.probes.P3 },
    { id: 'P4', value: summary.probes.P4 },
    { id: 'P5', value: summary.probes.P5 },
    { id: 'P6', value: summary.probes.P6 },
    { id: 'P7', value: summary.p7SusceptibilityScore },
    { id: 'P8', value: summary.probes.P8 },
  ];
}

export function sourceTime(stamp: SourceStamp): string {
  return stamp.freshness === 'recorded' && stamp.sourceTimestamp !== null ? stamp.sourceTimestamp : 'unknown freshness';
}

export function mergeAdapterPages(
  current: readonly AdapterProjection[],
  incoming: readonly AdapterProjection[],
): readonly AdapterProjection[] {
  const byId = new Map(current.map((adapter) => [adapter.id, adapter]));
  for (const adapter of incoming) byId.set(adapter.id, adapter);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function filterAdapters(
  adapters: readonly AdapterProjection[],
  query: string,
  eligibility: 'all' | AdapterProjection['registrationEligibility']['state'],
): readonly AdapterProjection[] {
  const needle = query.trim().toLocaleLowerCase();
  return adapters.filter((adapter) =>
    (needle.length === 0 || adapter.id.toLocaleLowerCase().includes(needle) || (adapter.manifest.lineage ?? '').toLocaleLowerCase().includes(needle)) &&
    (eligibility === 'all' || adapter.registrationEligibility.state === eligibility),
  );
}
