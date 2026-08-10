// Supervised-loop composition (spec §14 Phase 1). Wires core (log/evidence/
// executor/gates/budget) + AAL (context source + registry/router) + an adapter
// into runTaskLoop against a fixture target repo. Operational runs copy an explicit
// operator-supplied golden directory; only named test seams use synthetic bytes. The adapter is a
// factory: the CI/stub path uses the FakeAdapter (no quota); `--live` passes the
// real Claude adapter over the SDK. This is the capstone that produces the first
// calibration numbers when a human triggers a live run (task 11).

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyGovernanceApproval,
  acquireTaskLease,
  attestationsFor,
  buildApprovalPackage,
  computeCalibration,
  computeLessonHitRate,
  createBudget,
  createDefaultPathPolicy,
  createEvidenceStore,
  createExecutor,
  createGateRunner,
  createRedArtifactStore,
  createReportIntegrity,
  createHumanPlaneServer,
  createLeaseManager,
  isLeaseTtlValid,
  createLoopController,
  foldConfirmedHypotheses,
  freezeTaskGraph,
  selectNextTask,
  DEP_SATISFIED_STATES,
  TaskGraphGateError,
  listPendingProposals,
  openEventLog,
  openEvidenceAuthenticator,
  pendingQuarantines,
  promoteLesson,
  proposeLessonFromHypothesis,
  readGovernanceLog,
  ReportIntegrityError,
  runApprovedMerge,
  runAutoMerge,
  runDeployStage,
  runManualRollback,
  runTaskLoop,
  LeaseFenceError,
  DEFAULT_REPAIR_POLICY,
  transition,
  verifyMergedArtifactBinding,
  verifyTaskArtifactBinding,
  copyOperatorGoldenFixture,
  GoldenFixtureError,
  type ApprovalPackage,
  type CalibrationResult,
  type Clock,
  type DeployClock,
  type DeployState,
  type DeployStageDeps,
  type EventLog,
  type HandlerDeps,
  type LessonHitRateStats,
  type MappedAc,
  type OfflineDependencyPolicy,
  type Role,
  type ReportIntegrity,
  type TaskContract,
  type TaskLeaseSession,
  type TaskGraph,
  type TaskGraphTask,
  type TaskProjection,
  type TaskState,
  type ToolHandler,
} from 'core';
import {
  breakerKey,
  computeShadowOutcomeStats,
  createAALProposalSource,
  createBreaker,
  createRegistry,
  createRouter,
  DEFAULT_BREAKER_OPTIONS,
  PASS_FAIL_PROBES,
  shadowFrozen,
  shadowProven,
  shadowWouldChoose,
  wrapRouterForOutcome,
  type AdapterHealth,
  type AdapterInterface,
  type ConformanceRecord,
  type createDispatcher,
  type FusionProfile,
  type Registry,
  type RouteHints,
  type Router,
  type ShadowOutcomeStats,
  type ShadowProofReport,
} from 'aal';
import { runPlannerFusion } from './fusion.ts';

const PHASE0_OFFLINE_FIXTURE_LOCKFILE = [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '  excludeLinksFromLockfile: false',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      phase0-offline-dependency:',
  '        specifier: file:.phase0-offline-sources/phase0-offline-dependency',
  '        version: file:.phase0-offline-sources/phase0-offline-dependency',
  '',
  'packages:',
  '',
  '  phase0-offline-dependency@file:.phase0-offline-sources/phase0-offline-dependency:',
  '    resolution: {directory: .phase0-offline-sources/phase0-offline-dependency, type: directory}',
  '',
  'snapshots:',
  '',
  '  phase0-offline-dependency@file:.phase0-offline-sources/phase0-offline-dependency: {}',
  '',
].join('\n');

const PHASE0_OFFLINE_FIXTURE_MANIFEST =
  '{"name":"phase0-offline-fixture","version":"0.0.0","private":true,"dependencies":{"phase0-offline-dependency":"file:.phase0-offline-sources/phase0-offline-dependency"}}\n';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
/** Same as `git()` but returns stdout — for reading a diff into the evidence store (REQ-2.1). */
function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * Lines actually changed (REQ-2.3's diff budget) — a raw `git diff` also carries
 * file/hunk headers and unchanged context lines, which used to inflate the count
 * against unrelated diff shape rather than the change size itself (PR #50 review).
 */
function countChangedLines(diff: string): number {
  if (diff.length === 0) return 0;
  return diff
    .split('\n')
    .filter((l) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---')))
    .length;
}

/**
 * Task ids straight off the UNFROZEN graph object — the only source left when the
 * planning gate rejects (REQ-4.8 still owes a row per task). Anything unparseable
 * yields no rows rather than throwing over an already-failing run.
 */
function declaredTaskIds(parsed: unknown): string[] {
  const raw = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => (t as { id?: unknown }).id).filter((id): id is string => typeof id === 'string');
}

/**
 * REQ-4.11 run-level precedence, low to high: CANCELLED > ESCALATED > BLOCKED >
 * REVIEWING > COMPLETED. Every other per-task end state (SKIPPED, NOT_STARTED,
 * CHANGES_REQUESTED, QUARANTINED, …) counts as BLOCKED (D10).
 */
const RUN_STATE_PRECEDENCE = ['COMPLETED', 'REVIEWING', 'BLOCKED', 'ESCALATED', 'CANCELLED'];

function runStateRank(state: string): number {
  const i = RUN_STATE_PRECEDENCE.indexOf(state);
  return i === -1 ? RUN_STATE_PRECEDENCE.indexOf('BLOCKED') : i;
}

/**
 * A round's `computeShadowOutcomeStats(log.all())` fold, shared between
 * wrapRouterForOutcome and wrapRouterForShadow when both wrap the same round —
 * each independently re-reading and re-folding the whole log was a real,
 * byte-identical double cost every round outcome routing was active (PR #50
 * review). `invalidate` is called at the top of every round (by the outermost
 * wrapper) so a later round still sees its own new events.
 */
function createRoundStatsCache(log: EventLog): {
  get: () => Record<string, ShadowOutcomeStats>;
  invalidate: () => void;
} {
  let cached: Record<string, ShadowOutcomeStats> | null = null;
  return {
    get: () => (cached ??= computeShadowOutcomeStats(log.all())),
    invalidate: () => {
      cached = null;
    },
  };
}

/**
 * SHADOW_ROUTE recording from the composition root (REQ-7.1/7.3/7.4/7.5). Wraps
 * only `eligibleAdapters` — the one router method the main proposal flow
 * (`source.ts`) actually calls each round to pick its live choice (`eligible[0]`).
 * The wrapper NEVER changes the returned list (REQ-7.4: route(x) identical with
 * and without the recorder attached) — it only observes, then best-effort
 * appends a SHADOW_ROUTE event as a side channel. Frozen (any registered adapter
 * stale, REQ-7.3) skips recording entirely; a failed append never blocks the
 * round — it logs ERROR and continues (REQ-7.5).
 */
export function wrapRouterForShadow(
  router: Router,
  deps: {
    registry: Registry;
    log: EventLog;
    runId: string;
    taskId: string;
    /** Shared per-round fold (see createRoundStatsCache) — absent for every
     *  pre-existing caller/test, which falls back to computing it directly here,
     *  byte-identical to the old always-independent behavior. */
    stats?: { get: () => Record<string, ShadowOutcomeStats>; invalidate: () => void };
  },
): Router {
  return {
    ...router,
    eligibleAdapters(role: Role, hints?: RouteHints, opts?: { record?: boolean }) {
      deps.stats?.invalidate();
      const eligible = router.eligibleAdapters(role, hints, opts);
      const live = eligible[0];
      // record:false is a non-recording peek (fusion panel fan-out) — same order, no
      // SHADOW_ROUTE (REQ-16.2 same-router without stats pollution, PR #64 review).
      if (opts?.record !== false && live !== undefined && !shadowFrozen(deps.registry.all())) {
        const liveKey = breakerKey(live.record.adapterId, live.record.modelVersion);
        const { wouldChoose, basis } = shadowWouldChoose({
          role,
          liveChoice: liveKey,
          eligible: eligible.map((r) => breakerKey(r.record.adapterId, r.record.modelVersion)),
          outcomeStats: deps.stats?.get() ?? computeShadowOutcomeStats(deps.log.all()),
        });
        try {
          deps.log.append({
            runId: deps.runId,
            taskId: deps.taskId,
            type: 'SHADOW_ROUTE',
            payload: { role, live: liveKey, wouldChoose, basis, frozen: false },
          });
        } catch (err) {
          try {
            deps.log.append({
              runId: deps.runId,
              taskId: deps.taskId,
              type: 'ERROR',
              payload: { reason: 'shadow_append_failed', detail: (err as Error).message },
            });
          } catch {
            // A persistently-failing log must never escape and block the round — the
            // recorder is a side channel, the route result is already returned below
            // (REQ-7.5, same guard as router.ts's safeAppend — PR #50 review).
          }
        }
      }
      return eligible;
    },
  };
}

/** Internal fixture shape shared by the operator and test-only seams. */
type FixtureRepo = {
  root: string;
  wt: string;
  gateConfigPath: string;
  conventionPolicyPath: string;
  goldenFixture?: ReturnType<typeof copyOperatorGoldenFixture>;
  cleanup: () => void;
};

/**
 * Operational target fixture. Golden bytes are accepted only from an explicit
 * operator directory; callers cannot fall back to generated truth.
 */
export function makeFixtureRepo(options: { operatorGoldenFixtureDir: string }): FixtureRepo {
  return createFixtureRepo(options);
}

/**
 * Explicit test-only synthetic seam. This helper is intentionally named and
 * scoped for tests so production/CLI composition cannot accidentally mint truth.
 */
export function makeSyntheticFixtureRepoForTests(): FixtureRepo {
  return createFixtureRepo({ syntheticTestOnly: true });
}

function createFixtureRepo(options: { operatorGoldenFixtureDir?: string; syntheticTestOnly?: true }): FixtureRepo {
  if (options.operatorGoldenFixtureDir === undefined && options.syntheticTestOnly !== true) {
    throw new GoldenFixtureError('operator_golden_fixture_missing', 'operator_golden_fixture_missing');
  }
  const root = mkdtempSync(join(tmpdir(), 'loop-fixture-'));
  const wt = join(root, 'target');
  mkdirSync(join(wt, 'src'), { recursive: true });
  const conventionPolicyPath = join(wt, '.ai', 'policies', 'convention.json');
  mkdirSync(join(wt, '.ai', 'policies'), { recursive: true });
  const sourceConventionPolicy = fileURLToPath(new URL('../../../.ai/policies/convention.json', import.meta.url));
  writeFileSync(conventionPolicyPath, readFileSync(sourceConventionPolicy));
  mkdirSync(join(wt, 'test', 'golden'), { recursive: true });
  git(wt, 'init', '-q', '-b', 'main');
  git(wt, 'config', 'user.email', 'fixture@example.invalid');
  git(wt, 'config', 'user.name', 'fixture');
  writeFileSync(join(wt, 'src', 'impl.txt'), 'wrong\n');
  writeFileSync(
    join(wt, 'package.json'),
    PHASE0_OFFLINE_FIXTURE_MANIFEST,
  );
  writeFileSync(join(wt, 'pnpm-lock.yaml'), PHASE0_OFFLINE_FIXTURE_LOCKFILE);
  writeFileSync(join(wt, '.gitignore'), 'node_modules/\n');
  let goldenFixture: ReturnType<typeof copyOperatorGoldenFixture> | undefined;
  if (options.operatorGoldenFixtureDir !== undefined) {
    // Operational path: copy the operator's exact bytes and manifest. The
    // provisioner refuses missing/tampered input and never regenerates truth.
    goldenFixture = copyOperatorGoldenFixture(options.operatorGoldenFixtureDir, join(wt, 'test', 'golden'));
  } else {
    // Explicit test-only seam; this branch is unreachable from operational
    // composition because createFixtureRepo refuses absent operator bytes above.
    const goldenFile = join(wt, 'test', 'golden', 'expected.txt');
    writeFileSync(goldenFile, 'golden truth\n');
    writeFileSync(
      join(wt, 'test', 'golden', '_MANIFEST.sha256'),
      `${sha256(readFileSync(goldenFile))}  ${relative(join(wt, 'test', 'golden'), goldenFile)}\n`,
    );
  }
  writeFileSync(join(wt, 'run-tests.sh'), '#!/bin/sh\ngrep -q correct src/impl.txt\n');
  const gateConfigPath = join(wt, 'gate-ladder.json');
  writeFileSync(
    gateConfigPath,
    JSON.stringify({
      t0: { lint: 'true', typecheck: 'true', targetedTests: 'fallback:full_unit' },
      t1: { fullTests: 'sh run-tests.sh', convention: 'builtin', golden: 'builtin' },
      t2: { status: 'not_enabled_phase1' },
      t3: { status: 'not_enabled_phase1' },
    }) + '\n',
  );
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'fixture');
  return { root, wt, gateConfigPath, conventionPolicyPath, ...(goldenFixture !== undefined ? { goldenFixture } : {}), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function passingRecord(adapterId: string): ConformanceRecord {
  return {
    adapterId,
    modelVersion: 'unknown',
    ranAt: new Date(0).toISOString(),
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: `blob://${p}` })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

export interface LoopRunResult {
  finalState: string;
  iterations: number;
  calibration: CalibrationResult;
  /** REQ-8.11: authenticated provenance for operator-supplied golden bytes. */
  goldenFixture?: ReturnType<typeof copyOperatorGoldenFixture> & { evidenceRef: string };
  /** REQ-24.1: lesson injection count + hit-rate PROXY, folded from this run's own log. */
  lessonHitRate: LessonHitRateStats;
  /** REQ-24.2: a shadowProven snapshot over this run's own log — evidence for a human's
   *  activation decision only (INV-16); nothing here ever gates routing automatically. */
  shadowProven: ShadowProofReport;
  /** REQ-24.3: fusion-uplift interval slot. This composition never runs a paired
   *  single-vs-fused corpus, so it is always empty-but-labeled — filled only by the
   *  task-12 LIVE pass, never fabricated. */
  fusionUplift: { available: false };
  /**
   * phase5-stage4 REQ-4.11: one row per graph task, in graph order — ADDITIVE and
   * present ONLY in multi-task mode, so a single-task result stays byte-identical.
   * `finalState` is the task's own end state, or the label `SKIPPED` (a dependency
   * ended outside the dep-satisfied set) / `NOT_STARTED` (never selected: a failed
   * lease claim, the kill switch, or the run ending first).
   */
  tasks?: { id: string; finalState: string; iterations: number }[];
}

/** REQ-24.1/24.2: the calibration-report extras beyond computeCalibration's own
 *  shape (design.md "I. Security sweep + calibration wiring" — extend, not replace).
 *  `proof` carries the shadowProven thresholds threaded from opts.outcomeRouting
 *  (minSamples/minDivergences from routing.json — previously parsed but dropped at the
 *  composition seam, so shadowProven hard-coded minSamples 20; PR #50 review). This
 *  snapshot is read by a human only, same as shadowProven itself. */
function calibrationExtras(
  log: EventLog,
  proof: { minSamples: number; minDivergences: number },
): Pick<LoopRunResult, 'lessonHitRate' | 'shadowProven' | 'fusionUplift'> {
  const events = log.all();
  return {
    lessonHitRate: computeLessonHitRate(events),
    shadowProven: shadowProven(events, proof),
    fusionUplift: { available: false },
  };
}

/**
 * Run one supervised loop on the fixture. `adapterFactory` receives the evidence
 * putter so an adapter can mint resolvable content refs. `conformanceRecord` is
 * the REAL record for a live adapter (REQ-12.4 gate); the stub passes a synthetic
 * pass. Returns the loop outcome plus the calibration math (REQ-11).
 */
export async function runSupervisedLoop(opts: {
  contract: TaskContract;
  adapterFactory: (putEvidence: (s: string) => string) => AdapterInterface;
  conformanceRecord?: ConformanceRecord;
  /** Injected time source (REQ-6.4): production `{ now: () => Date.now() }`, tickable in tests. */
  clock: Clock;
  /** Keep events.db + evidence here (a live run's record, REQ-11.4/4.5) — default is inside the throwaway fixture root. */
  persistDir?: string;
  /**
   * Durable governance log (`.ai/governance/events.jsonl`, REQ-9.1). When set, the
   * Human Plane lists/handles governance proposals and a deferred flaky_quarantine
   * approved via the CLI takes effect on load (REQ-9.4/9.5). Absent → no governance
   * plane (governance preflight ordering itself is Task 9).
   */
  governanceLogPath?: string;
  /**
   * Auto-merge policy (REQ-7/8). When present, a task that reaches REVIEWING with an
   * L0/L1 risk (from the frozen contract's `risk`) + golden-backed ACs + no
   * dependency-touching diff auto-merges `task/<taskId>` into the fixture main and a
   * deterministic sample is re-audited from a clean checkout. Absent → auto-merge
   * still runs but a null/absent risk defaults to L2 → the human approval package
   * below (REQ-2/3), same as any other non-qualifying decision.
   */
  autoMerge?: { auditSampleRate: number; depManifestPatterns: string[] };
  /**
   * Governance-loaded Phase 0 dependency policy. The composition root validates
   * this object before constructing an adapter, then binds it to the sole command
   * orchestrator. It never widens network beyond `none`.
   */
  offlineDependencyPolicy?: OfflineDependencyPolicy;
  /**
   * Approval-package tuning (REQ-2.4/3.4) for the path above when auto-merge does
   * NOT fire. `maxDiffBudget` defaults to 400 (§11.2). `timeoutMs` is OPT-IN and gates
   * the blocking human wait for BOTH the task-approval and deploy decisions: present ->
   * the run holds open until a human decides or the timeout elapses (then
   * `approval_timeout` -> ESCALATED); ABSENT (the default) -> no wait at all, the task
   * package is left in the approvals Map and the run returns REVIEWING immediately, and
   * a configured deploy stage is skipped. A non-interactive caller (CI/stub) omits it so
   * it never hangs; the live CLI passes it to keep the human gate (PR #50 review).
   */
  approval?: { maxDiffBudget?: number; timeoutMs?: number };
  /**
   * Deploy-stage tuning (REQ-6.12). `expandedWindowMs` is the manual-rollback window the
   * Human Plane server stays open for once a deploy reaches EXPANDED — default 10 minutes.
   * Irrelevant when the frozen contract has no `deploy:` section.
   */
  deploy?: { expandedWindowMs?: number };
  /**
   * Outcome routing (REQ-14/15). Absent -> `mode: 'shadow'` (today's Phase-3
   * behavior, byte-identical: SHADOW_ROUTE always records, nothing reorders).
   * `off` stops shadow recording too; `active` additionally reorders the
   * eligible set by outcome BEFORE shadow observes the (now-reordered) live
   * choice — REQ-14.3's "recorder wrapped OUTSIDE the outcome wrapper".
   */
  outcomeRouting?: {
    mode: 'off' | 'shadow' | 'active';
    epsilon: number;
    /** shadowProven thresholds (REQ-13.3), threaded into the calibration snapshot.
     *  From routing.json's outcomeRouting block; default minSamples 20 / minDivergences 1. */
    minSamples?: number;
    minDivergences?: number;
  };
  /**
   * Lessons pipeline (REQ-10/11/12). Absent -> no lessons pipeline (Phase-1
   * parity, byte-identical): confirmed hypotheses are never folded into pending
   * lessons, and none is ever injected. Also requires `governanceLogPath` (a
   * lesson can never be approved without a governance plane) — set without it
   * is treated as absent.
   */
  lessons?: { dir: string; maxLessons?: number; maxBytes?: number };
  /**
   * Planner-role fusion auto-routing (REQ-16), before the task loop. BOTH switches
   * must be on (REQ-16.3, "a test SHALL prove both offs"): `plannerRoleTrigger` is
   * the governance-hashed policy flag (`triggers.plannerRole` in
   * fusion-profiles.json — this composition never reads that file itself, same
   * separation as `outcomeRouting`/`lessons`) and `enabled` is this composition's
   * own option. `profile`/`dispatcher` are caller-supplied (mirrors `toolHandlers`'
   * precedent — fusion wiring is entirely the caller's to assemble). Absent ->
   * no dispatch (Phase-3 parity: role stays hardcoded 'implementer' for the task
   * loop below regardless). A resolved plan is injected into the SAME source's
   * context every round as MARKed data; an escalated/invalid resolution never
   * blocks the task loop — it simply proceeds without a plan piece.
   */
  planning?: {
    enabled: boolean;
    plannerRoleTrigger: boolean;
    profile: FusionProfile;
    dispatcher: ReturnType<typeof createDispatcher>;
  };
  /**
   * Console audit mirror (REQ-18.3): every approval, steering (pause/inject/resume),
   * kill, and governance decision is echoed here in addition to the durable core
   * event log. Absent → no mirror (the core event log remains authoritative).
   */
  auditSink?: (entry: Record<string, unknown>) => void;
  /**
   * Composition-root REQUEST_TOOL handlers (fusion.deliberate, REQ-10.9). The live
   * path builds these with `console/backend/src/fusion.ts` (createFusionToolHandler +
   * createCandidateEvidenceRunner + runFusion) behind the `fusionActive` gate so
   * fusion never activates under CI (REQ-10.10). Absent → the executor keeps its
   * propose-only REQUEST_TOOL rejection, so the CI/stub path is byte-identical.
   */
  toolHandlers?: Record<string, ToolHandler>;
  /**
   * phase5-stage4 REQ-4.2: the promoted task graph, already shape-validated at the
   * edge (`loadTaskGraphOption` in loop-cli.ts). PRESENT -> multi-task mode; absent
   * -> the single-task path, unchanged to the byte (REQ-4.3). Mode keys on this
   * option alone: the loop never probes the filesystem for a graph, so a draft
   * (`task-graph.draft.json`) can never start a run (REQ-4.7). The SEMANTIC gate
   * (freeze) runs inside this function, not at the edge (REQ-4.8/D5).
   */
  taskGraph?: { rawBytes: Uint8Array; parsed: unknown };
  /**
   * REQ-6.3: per-task lease TTL. Default = the contract's max_wallclock_per_task_min
   * plus 5 minutes of slack, so a lease this run never renews still outlives any
   * legal task (D6). Both single-task and graph modes claim this lease.
   */
  leaseTtlMs?: number;
  /** Maximum duration of one executor/gate atomic operation; defaults to task wallclock. */
  maxAtomicDurationMs?: number;
  /**
   * Operator-supplied `test/golden` directory. When present, fixture provisioning
   * is copy-only and returns source/hash provenance; no manifest is generated.
   */
  operatorGoldenFixtureDir?: string;
  /** Require the operator fixture for an operational run (missing => explicit blocker). */
  requireOperatorGoldenFixture?: boolean;
  /** Explicit test-only seam; never set by console/CLI production callers. */
  syntheticGoldenFixtureForTests?: boolean;
  /** Explicit test-only command sandbox; valid only with syntheticGoldenFixtureForTests. */
  syntheticSandboxForTests?: NonNullable<Parameters<typeof createExecutor>[0]['sandbox']>;
}): Promise<LoopRunResult> {
  if (opts.syntheticSandboxForTests !== undefined && opts.syntheticGoldenFixtureForTests !== true) {
    throw new Error('synthetic_sandbox_requires_synthetic_golden_fixture');
  }
  // Operational composition must name immutable operator bytes before any other
  // planning/setup path can run. Only the explicit test seam may omit this input.
  if (opts.syntheticGoldenFixtureForTests !== true && opts.operatorGoldenFixtureDir === undefined) {
    throw new GoldenFixtureError('operator_golden_fixture_missing', 'operator_golden_fixture_missing');
  }
  if (opts.requireOperatorGoldenFixture === true && opts.operatorGoldenFixtureDir === undefined) {
    throw new GoldenFixtureError('operator_golden_fixture_missing', 'operator_golden_fixture_missing');
  }
  // Fail-closed BEFORE any state is created: a planning dispatcher assembled wider
  // than the contract's governance ceiling is a composition bug, refused up front —
  // the dispatcher is opaque after construction, so it cannot be clamped here
  // (phase5-stage2 REQ-4.2; the composed rule is createDispatcher's `ceiling`).
  // Both flags, mirroring the dispatch condition below: with the planner trigger
  // off this run performs no concurrent dispatch, so there is nothing to bound —
  // REQ-4.2 is WHILE-dispatching (Codex review PR #110); a later run that flips
  // the trigger on re-enters this guard at its own start.
  if (opts.planning?.enabled === true && opts.planning.plannerRoleTrigger === true) {
    const eff = opts.planning.dispatcher.effectiveMaxParallel;
    const cap = opts.contract.budget.maxParallelAgents;
    if (eff > cap) {
      throw new Error(`planning dispatcher parallelism ${eff} exceeds contract max_parallel_agents ${cap}`);
    }
  }
  // Keep held-out pass rate paired with the unique AC denominator.  Coverage is
  // computed from the frozen contract/task graph, never inferred from the number
  // of loop outcomes (an unexecuted or duplicate AC must not inflate coverage).
  const calibrationFor = (
    heldOut: boolean[],
    reruns: boolean[],
    acceptanceCriteria: readonly { id: string; golden?: boolean }[] = opts.contract.acceptanceCriteria,
  ): CalibrationResult => computeCalibration({
    heldOut,
    reruns,
    inScopeAcIds: acceptanceCriteria.map((ac) => ac.id),
    goldenAcIds: acceptanceCriteria.filter((ac) => ac.golden === true).map((ac) => ac.id),
  });
  const useSyntheticFixture = opts.syntheticGoldenFixtureForTests === true && opts.operatorGoldenFixtureDir === undefined;
  const fx = useSyntheticFixture
    ? makeSyntheticFixtureRepoForTests()
    : makeFixtureRepo({ operatorGoldenFixtureDir: opts.operatorGoldenFixtureDir as string });
  const clock = opts.clock;
  const stateDir = opts.persistDir ?? fx.root; // fixture root is rm'd in finally; persistDir survives
  const eventsPath = join(stateDir, 'events.db');
  // A pre-existing event DB may contain only a foreign/concurrent lease written
  // before this invocation. Recovery starts from the frozen run trust root, not
  // from SQLite-file existence; once metadata exists, a missing key still fails
  // closed inside openEvidenceAuthenticator.
  const recovering = existsSync(join(stateDir, 'run-metadata.json'));
  const log = openEventLog(eventsPath, clock);
  const evidence = createEvidenceStore(join(stateDir, 'evidence'));
  const RUN_ID = 'RUN-LIVE';
  const TASK_ID = 'T-1';
  const leaseTtlMs = opts.leaseTtlMs ?? opts.contract.budget.maxWallclockMs + 5 * 60_000;
  const maxAtomicDurationMs = opts.maxAtomicDurationMs ?? opts.contract.budget.maxWallclockMs;
  const leaseOwner = `${RUN_ID}#${randomUUID()}`;
  const lease = createLeaseManager(join(stateDir, 'events.db'), clock, RUN_ID);
  const goldenFixture = fx.goldenFixture;
  const goldenFixtureProvenance = goldenFixture === undefined
    ? undefined
    : {
        ...goldenFixture,
        evidenceRef: evidence.put(JSON.stringify(goldenFixture)),
      };
  if (goldenFixtureProvenance !== undefined) {
    log.append({
      runId: RUN_ID,
      taskId: null,
      type: 'GOLDEN_FIXTURE_PROVISIONED',
      payload: { ...goldenFixtureProvenance },
    });
  }
  const goldenResult = goldenFixtureProvenance === undefined
    ? {}
    : { goldenFixture: goldenFixtureProvenance };
  // Run-level closures (breaker callback, router wrappers, human-plane handlers, the
  // post-run lesson fold) outlive any single task, so they read the CURRENTLY executing
  // task id instead of binding one at construction (design D4 layer 1). `executeTask`
  // sets it; the single-task path never moves it off T-1.
  let activeTask: string = TASK_ID;
  let activeTaskLease: TaskLeaseSession | null = null;
  const activeTaskId = (): string => activeTask;
  const activeLeaseOwns = (): boolean => activeTaskLease === null || activeTaskLease.verifyOwnership();
  // shadowProven thresholds for the calibration snapshot (REQ-24.2) — threaded from
  // routing.json's outcomeRouting block via opts, not hard-coded (PR #50 review).
  const shadowProof = {
    minSamples: opts.outcomeRouting?.minSamples ?? 20,
    minDivergences: opts.outcomeRouting?.minDivergences ?? 1,
  };
  try {
    // Refuse unsafe leases before any adapter, executor, or task branch is created.
    // This is a composition error, not a task failure, so the event is explicit and
    // the result remains non-executing.
    if (!isLeaseTtlValid(leaseTtlMs, maxAtomicDurationMs)) {
      log.append({
        runId: RUN_ID,
        taskId: null,
        type: 'ESCALATED',
        payload: { why: 'invalid_lease_ttl', ttlMs: leaseTtlMs, maxAtomicDurationMs },
      });
      return {
        finalState: 'ESCALATED',
        iterations: 0,
        calibration: calibrationFor([], []),
        ...goldenResult,
        ...calibrationExtras(log, shadowProof),
      };
    }
    let reportIntegrity: ReportIntegrity;
    try {
      reportIntegrity = createReportIntegrity({
        evidence,
        authenticator: openEvidenceAuthenticator({
          runStateDir: stateDir,
          runId: RUN_ID,
          recovering,
          worktreeDirs: [fx.wt],
        }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'evidence_auth_failed';
      const why =
        typeof error === 'object' && error !== null && 'reason' in error &&
        (error.reason === 'evidence_auth_unavailable' || error.reason === 'evidence_auth_mismatch')
          ? error.reason
          : 'evidence_auth_mismatch';
      log.append({ runId: RUN_ID, taskId: null, type: 'ESCALATED', payload: { why, boundary: 'run_recovery', code, detail } });
      return {
        finalState: 'ESCALATED',
        iterations: 0,
        calibration: calibrationFor([], []),
        ...goldenResult,
        ...calibrationExtras(log, shadowProof),
      };
    }
    // Planning gate (REQ-4.8/D5): freeze the graph EXACTLY ONCE, here — after the
    // event log opens (both outcomes must be recorded) and before any adapter or
    // agent is constructed (a rejected graph must reach nothing). The edge validated
    // the file's shape; every SEMANTIC check lives in freezeTaskGraph.
    let graph: TaskGraph | null = null;
    let frozenSeq = 0;
    if (opts.taskGraph !== undefined) {
      try {
        const frozen = freezeTaskGraph(opts.taskGraph.rawBytes, opts.taskGraph.parsed, opts.contract);
        graph = frozen.graph;
        frozenSeq = log.append({
          runId: RUN_ID,
          taskId: null,
          type: 'TASK_GRAPH_FROZEN',
          payload: { graphHash: frozen.gate.graphHash, taskIds: frozen.gate.taskIds },
        }).seq;
      } catch (err) {
        if (!(err instanceof TaskGraphGateError)) throw err;
        log.append({ runId: RUN_ID, taskId: null, type: 'TASK_GRAPH_REJECTED', payload: { reasons: err.reasons } });
        return {
          finalState: 'BLOCKED',
          iterations: 0,
          calibration: calibrationFor([], []),
          ...goldenResult,
          ...calibrationExtras(log, shadowProof),
          tasks: declaredTaskIds(opts.taskGraph.parsed).map((id) => ({ id, finalState: 'NOT_STARTED', iterations: 0 })),
        };
      }
    }
    const adapter = opts.adapterFactory((s) => evidence.put(s));
    // Breaker + quota-aware routing (REQ-1/2/3): transitions become events; a live
    // adapter may expose a health probe (REQ-2.5), the Fake has none (always-ok).
    const breaker = createBreaker(DEFAULT_BREAKER_OPTIONS, () => clock.now(), (t) =>
      log.append({ runId: RUN_ID, taskId: activeTaskId(), type: 'BREAKER_STATE_CHANGED', payload: { ...t } }),
    );
    const reg = createRegistry({ breaker });
    const healthProbe = (adapter as { healthProbe?: () => Promise<AdapterHealth> }).healthProbe;
    reg.register(adapter, opts.conformanceRecord ?? passingRecord(adapter.manifest().adapterId), healthProbe);
    // Outcome-routing mode wiring (REQ-14.3). Absent -> 'shadow', preserving the
    // Phase-3 unconditional-recorder behavior byte-identical for every existing
    // caller. 'active' wraps the outcome reorder FIRST, then shadow OUTSIDE it,
    // so shadow observes the already-reordered live choice.
    const outcomeMode = opts.outcomeRouting?.mode ?? 'shadow';
    let router: Router = createRouter(reg);
    const roundStats = createRoundStatsCache(log);
    if (outcomeMode === 'active') {
      router = wrapRouterForOutcome(router, {
        registry: reg,
        stats: roundStats.get,
        epsilonPercent: opts.outcomeRouting?.epsilon ?? 0,
        // Durable round count (OUTCOME_ROUTE events so far this run+task) so a
        // process restart mid-run never repeats an already-explored round (REQ-15.3).
        exploreKey: () => `${RUN_ID}:${activeTaskId()}:${log.all({ type: 'OUTCOME_ROUTE', taskId: activeTaskId() }).length}`,
        log,
        runId: RUN_ID,
        // Both wrappers read `deps.taskId` at call time, so a getter property keeps the
        // per-run router recording against whatever task is executing (design D4 layer 1)
        // without widening either wrapper's signature.
        get taskId(): string { return activeTaskId(); },
      });
    }
    if (outcomeMode !== 'off') {
      router = wrapRouterForShadow(router, { registry: reg, log, runId: RUN_ID, get taskId(): string { return activeTaskId(); }, stats: roundStats });
    }
    const taskContractExcerpt = {
      goalId: opts.contract.goal.id,
      title: opts.contract.goal.title,
      objective: opts.contract.goal.objective,
      acceptanceCriteria: opts.contract.acceptanceCriteria.map((a) => ({ id: a.id, description: a.description })),
    };
    const ids = { requestId: () => `req-${randomUUID()}`, canary: () => `CANARY-${randomUUID()}` };
    // Planner-role fusion auto-routing (REQ-16), BEFORE the task loop. BOTH the
    // governance-hashed policy trigger and this composition's own option gate
    // dispatch (REQ-16.3) — the caller assembles opts.planning from both; this
    // composition never reads fusion-profiles.json itself (same separation as
    // outcomeRouting/lessons). Dispatches role 'planner' through the SAME router
    // instance the task loop uses below, whatever mode governance pinned (REQ-16.2/
    // AZ-13). Panel fan-out reads it with a non-recording peek (eligibleAdapters
    // record:false) so the governed reorder still applies but no SHADOW_ROUTE/
    // OUTCOME_ROUTE is recorded against the panel (PR #64 review).
    let resolvedPlan: { id: string; content: string } | null = null;
    if (opts.planning?.enabled === true && opts.planning.plannerRoleTrigger === true) {
      const planned = await runPlannerFusion({
        runId: RUN_ID,
        // This block is per-RUN: it resolves one plan before any task is selected.
        // In multi-task mode `T-1` is a REAL graph task id, so stamping it here would
        // file the planning events under a task that has not started (and may never
        // run); a run-scoped event carries no task id instead (same shape as
        // KILL_REQUESTED). Single-task keeps 'T-1' — its events are unchanged.
        taskId: graph === null ? TASK_ID : null,
        router,
        dispatcher: opts.planning.dispatcher,
        profile: opts.planning.profile,
        evidence,
        log,
        ids,
        taskContract: taskContractExcerpt,
        // REQ-5.1: the panel finally has a task structure to plan over. Single-task
        // sends no graph, so its bundle stays empty exactly as before (REQ-5.2).
        ...(graph !== null ? { taskGraphJson: JSON.stringify(graph) } : {}),
      });
      resolvedPlan = planned.plan;
    }
    // Operability (REQ-18.1): a live Human Plane server makes the loop steerable and
    // killable while it runs. onDecision → machine transitions (task approvals);
    // steering/kill → the loop control port; governance approvals append to the
    // durable log only (never a task transition, REQ-9.4). The current task state is
    // read from the event log's last TASK_STATE — the single source both sides share.
    const controller = createLoopController();
    const guidanceQueue: string[] = [];
    // REQ-18.3: mirror every operability call into the console audit trail (the core
    // event log stays authoritative; this is the §13.3 audit JSONL the console owns).
    const audit = (entry: Record<string, unknown>): void => opts.auditSink?.({ at: clock.now(), ...entry });
    // REQ-4.14: every task-state read is scoped to an explicit task id — a whole-log
    // read would hand one task's state to another once more than one runs per log.
    const currentState = (taskId: string): TaskState =>
      (log.all({ type: 'TASK_STATE', taskId }).at(-1)?.payload['state'] as TaskState) ?? 'PROPOSED';
    // Approval decision wait (REQ-3.1/3.6): `onDecision`/`onKill` resolve this from the
    // HTTP thread; `waitForApprovalDecision` races it against a real timeout (REQ-3.4).
    // Single resolver in a closure var, same shape as `createLoopController`'s
    // `resumeResolve` (control.ts) — at most one package is ever pending at a time in
    // this single-task loop.
    let pendingApprovalResolve: ((outcome: 'approve' | 'reject' | 'killed' | 'evidence_invalid') => void) | null = null;
    const waitForApprovalDecision = (timeoutMs: number): Promise<'approve' | 'reject' | 'timeout' | 'killed' | 'evidence_invalid'> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingApprovalResolve = null;
          resolve('timeout');
        }, timeoutMs);
        pendingApprovalResolve = (outcome) => {
          clearTimeout(timer);
          pendingApprovalResolve = null;
          resolve(outcome);
        };
      });
    const onDecision: HandlerDeps['onDecision'] = (taskId, decision) => {
      if (!activeLeaseOwns()) return { ok: false, reason: 'lease_lost' };
      // REQ-4.14: with several tasks per run a decision must NAME a task that actually
      // has a package pending, or it would land on whatever state the named task
      // happens to be in. Multi-task only — the single-task path has exactly one task,
      // so adding the check there would change today's refusal detail for no gain.
      if (graph !== null && ![...approvals.values()].some((p) => p.taskId === taskId)) {
        return { ok: false, detail: 'unknown_task' };
      }
      const tr = transition(currentState(taskId), decision === 'approve' ? 'human_approved' : 'changes_requested');
      if (!tr.ok) return { ok: false, detail: tr.reason };
      log.append({ runId: RUN_ID, taskId, type: 'TASK_STATE', payload: { state: tr.next, trigger: decision } });
      audit({ event: 'approval', taskId, decision, state: tr.next });
      pendingApprovalResolve?.(decision);
      return { ok: true, state: tr.next };
    };
    const onInject: HandlerDeps['onInject'] = (guidance, opts) => {
      if (!activeLeaseOwns()) return { ok: false, reason: 'lease_lost' };
      // REQ-17.3: mode is purely an observability label — both paths feed the SAME
      // guidanceQueue that runTaskLoop's takeGuidance() drains at its next boundary
      // (REQ-17.2); PAUSED-immediate already sits at that boundary, so there is no
      // separate delivery mechanism to build.
      const mode = opts.atNextBoundary ? 'next_boundary' : 'immediate';
      const evidenceRef = evidence.put(guidance);
      log.append({ runId: RUN_ID, taskId: activeTaskId(), type: 'GUIDANCE_INJECTED', payload: { evidenceRef, mode } });
      guidanceQueue.push(guidance);
      audit({ event: 'steer_inject', taskId: activeTaskId(), evidenceRef, mode });
      return { ok: true, evidenceRef };
    };
    const govLog = opts.governanceLogPath;
    const lessonsOpt = opts.lessons;
    const governance: Partial<HandlerDeps> = govLog === undefined ? {} : {
      governanceProposals: () => listPendingProposals(readGovernanceLog(govLog)),
      onGovernanceApprove: (id) => {
        const res = applyGovernanceApproval({ logPath: govLog, id, clock }, {
          fireQuarantine: (tid) => {
            const tr = transition(currentState(tid), 'quarantine');
            if (tr.ok) log.append({ runId: RUN_ID, taskId: tid, type: 'TASK_STATE', payload: { state: tr.next, trigger: 'quarantine' } });
          },
          // REQ-11.2: a lesson_promote approved LIVE (through THIS run's own Human
          // Plane server) moves pending/ -> approved/ immediately. The offline case
          // (approved via the CLI while no run was live) is reconciled separately,
          // at the NEXT run's `loadApprovedLessons` (aal/src/source.ts, REQ-11.3).
          ...(lessonsOpt !== undefined
            ? { promoteLesson: (lessonId: string) => {
                promoteLesson({ dir: lessonsOpt.dir, lessonId, approvedAt: new Date(clock.now()).toISOString(), log, runId: RUN_ID, taskId: activeTaskId() });
              } }
            : {}),
        });
        if (res.ok) audit({ event: 'governance_decision', id, kind: res.kind });
        return res.ok ? { ok: true, kind: res.kind } : { ok: false, detail: res.reason };
      },
    };
    // Deploy plane (REQ-6): a SEPARATE surface from the task approvals Map/onDecision —
    // deploy never touches the task state machine (COMPLETED stays terminal for tasks;
    // architect finding #1). `deployState` derives from the log so it stays correct
    // across the async gap between a decision and the stage's first recorded event.
    let currentDeployApproval: ApprovalPackage | null = null;
    let pendingDeployResolve: ((outcome: 'approve' | 'reject' | 'killed' | 'evidence_invalid') => void) | null = null;
    let deployDeps: DeployStageDeps | null = null;
    let manualRollback: Promise<unknown> | null = null;
    // REQ-3.5/3.6 + design.md "kill switch covers interruption": kill must end the
    // deploy-approval wait AND the post-EXPANDED window wait, not just the task-approval
    // wait (Phase-4 review gap — onKill previously only resolved pendingApprovalResolve).
    const deployKillResolvers: Array<() => void> = [];
    const killDeployWaits = (): void => {
      pendingDeployResolve?.('killed');
      for (const r of deployKillResolvers.splice(0)) r();
    };
    const deployState = (): DeployState | null => {
      if (opts.contract.deploy === undefined) return null;
      const last = log.all({ type: 'DEPLOY_STATE' }).at(-1);
      if (last !== undefined) return last.payload['state'] as DeployState;
      return currentDeployApproval !== null ? 'PENDING_APPROVAL' : null;
    };
    const waitForDeployDecision = (timeoutMs: number): Promise<'approve' | 'reject' | 'timeout' | 'killed' | 'evidence_invalid'> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingDeployResolve = null;
          resolve('timeout');
        }, timeoutMs);
        pendingDeployResolve = (outcome) => {
          clearTimeout(timer);
          pendingDeployResolve = null;
          resolve(outcome);
        };
      });
    const onDeployDecision: HandlerDeps['onDeployDecision'] = (decision) => {
      if (!activeLeaseOwns()) return { ok: false, detail: 'lease_lost' };
      audit({ event: 'deploy_decision', taskId: activeTaskId(), decision });
      pendingDeployResolve?.(decision);
      return { ok: true };
    };
    const onDeployRollback: HandlerDeps['onDeployRollback'] = () => {
      if (deployDeps === null) return { ok: false, detail: 'not_expanded' };
      audit({ event: 'deploy_manual_rollback', taskId: activeTaskId() });
      // Capture any rejection HERE, on the single promise the `await manualRollback`
      // below reads. A clean non-zero rollback already resolves as ESCALATED via
      // runRollback; this only covers the rollback COMMAND execution itself throwing
      // (executor error) — which would otherwise reject runSupervisedLoop, skip
      // DEPLOY_WINDOW_CLOSED, and leave a dangling ROLLING_BACK as the last deploy
      // state (PR #50 review). Record a terminal ESCALATED/rollback_failed event so
      // the window still closes cleanly and deployState never hangs at ROLLING_BACK.
      manualRollback = runManualRollback(deployDeps).catch((err) => {
        // A stale owner must not publish a deploy terminal event after its lease
        // generation has been replaced. The deploy command path is fenced by the
        // executor; suppress this side-channel catch for that structured loss and
        // keep the outer task outcome fail-closed.
        if (err instanceof LeaseFenceError) return;
        log.append({
          runId: RUN_ID,
          taskId: activeTaskId(),
          type: 'DEPLOY_STATE',
          payload: { state: 'ESCALATED', trigger: 'rollback_failed', simulation: true, detail: (err as Error).message },
        });
      });
      return { ok: true };
    };

    // REQ-2.2: the same Map instance the Human Plane server reads GET /approvals from —
    // populated below once a task actually needs a human decision.
    const approvals = new Map<string, ApprovalPackage>();
    const verifyApprovalEvidence = (
      pkg: ApprovalPackage,
      boundary: 'human_approval' | 'deploy_approval',
    ): void => {
      const reviewedDiff = new TextDecoder().decode(reportIntegrity.verifyEvidenceRef(pkg.diffRef));
      for (const ref of pkg.evidence.gateReports) {
        const report = reportIntegrity.verifyGateReportRef(ref, { runId: pkg.runId, taskId: pkg.taskId });
        if (report.worktreeHash !== pkg.evidence.worktreeHash) {
          throw new ReportIntegrityError(
            'artifact_identity_mismatch',
            `approval worktree ${pkg.evidence.worktreeHash} does not match signed report ${report.worktreeHash}`,
          );
        }
        if (boundary === 'deploy_approval') {
          if (typeof report.mergedCommitHash !== 'string') {
            throw new ReportIntegrityError('artifact_identity_missing', 'deploy report is missing its merge commit binding');
          }
          verifyMergedArtifactBinding(report, reportIntegrity, {
            runId: pkg.runId,
            taskId: pkg.taskId,
            repoDir: fx.wt,
            taskBranch: `task/${pkg.taskId}`,
            mainBranch: 'main',
          }, report.mergedCommitHash, 'main');
          const actualDiff = gitOut(
            fx.wt,
            'diff',
            '--no-color',
            `${report.mergedCommitHash}^1`,
            report.mergedCommitHash,
          );
          if (reviewedDiff !== actualDiff) {
            throw new ReportIntegrityError('artifact_identity_mismatch', 'deploy diff evidence does not match the signed merge commit');
          }
        } else {
          verifyTaskArtifactBinding(report, reportIntegrity, {
            runId: pkg.runId,
            taskId: pkg.taskId,
            repoDir: fx.wt,
            taskBranch: `task/${pkg.taskId}`,
            mainBranch: 'main',
          });
          const actualDiff = gitOut(
            fx.wt,
            'diff',
            '--no-color',
            `${report.baseCommitHash as string}...${report.artifactCommitHash as string}`,
          );
          if (reviewedDiff !== actualDiff) {
            throw new ReportIntegrityError('artifact_identity_mismatch', 'approval diff evidence does not match the signed task artifact');
          }
        }
      }
    };
    const server = await createHumanPlaneServer({
      runDir: stateDir,
      deps: {
        runId: RUN_ID,
        approvals,
        log,
        onDecision,
        verifyApprovalEvidence,
        onEvidenceInvalid: (taskId, error, boundary) => {
          if (!activeLeaseOwns()) {
            pendingApprovalResolve?.('evidence_invalid');
            pendingDeployResolve?.('evidence_invalid');
            return;
          }
          if (boundary === 'human_approval') {
            const tr = transition(currentState(taskId), 'escalate');
            if (tr.ok) {
              log.append({ runId: RUN_ID, taskId, type: 'TASK_STATE', payload: { state: tr.next, trigger: 'escalate' } });
            }
            pendingApprovalResolve?.('evidence_invalid');
          } else {
            log.append({
              runId: RUN_ID,
              taskId,
              type: 'DEPLOY_STATE',
              payload: { state: 'ESCALATED', trigger: 'evidence_invalid', simulation: true },
            });
            pendingDeployResolve?.('evidence_invalid');
          }
          const detail = error instanceof Error ? error.message : String(error);
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'evidence_auth_failed';
          const why =
            typeof error === 'object' && error !== null && 'reason' in error &&
            (error.reason === 'evidence_auth_unavailable' || error.reason === 'evidence_auth_mismatch')
              ? error.reason
              : 'evidence_auth_mismatch';
          log.append({ runId: RUN_ID, taskId, type: 'ESCALATED', payload: { why, boundary, code, detail } });
        },
        onKill: () => {
          audit({ event: 'kill' });
          // REQ-3.6: a pending approval wait ends via the same kill path as a mid-loop
          // kill (control.ts's `requestKill` — harmless no-op if the loop already ended).
          pendingApprovalResolve?.('killed');
          controller.requestKill();
          killDeployWaits();
        },
        rateOk: () => true,
        steeringState: () => currentState(activeTaskId()),
        onPause: () => {
          audit({ event: 'steer_pause' });
          controller.requestPause();
        },
        onResume: () => {
          audit({ event: 'steer_resume' });
          controller.requestResume();
        },
        onInject,
        deployState,
        deployApproval: () => currentDeployApproval,
        onDeployDecision,
        onDeployRollback,
        ...governance,
      },
    });
    /**
     * One task's machinery end to end (design D4 layer 1): its own branch, budget,
     * proposal source, executor, gate runner, task loop, and the auto-merge/approval/
     * deploy decision that follows. Everything ABOVE this point is per-run and shared;
     * everything inside is rebuilt per task, so a multi-task driver (task 4) can call
     * it once per graph task. The single-task path calls it exactly once with T-1 —
     * every value below then resolves to what it was before this became a closure.
     */
    const executeTask = async (
      taskId: string,
      graphTask: TaskGraphTask | undefined,
      taskLease: TaskLeaseSession,
    ): Promise<{ finalState: string; iterations: number; reachedReviewing: boolean }> => {
      activeTask = taskId;
      activeTaskLease = taskLease;
      if (!taskLease.verifyOwnership()) {
        log.append({ runId: RUN_ID, taskId, type: 'ESCALATED', payload: { why: 'lease_lost', boundary: 'task_start' } });
        return { finalState: 'ESCALATED', iterations: 0, reachedReviewing: false };
      }
      const taskBranch = `task/${taskId}`;
      // Deferred quarantine (REQ-9.5): a flaky_quarantine approved via the CLI while no
      // run was live takes effect when the next run LOADS that task — never runs it.
      if (opts.governanceLogPath !== undefined) {
        const deferred = pendingQuarantines(readGovernanceLog(opts.governanceLogPath));
        if (deferred.includes(taskId)) {
          log.append({ runId: RUN_ID, taskId, type: 'TASK_STATE', payload: { state: 'QUARANTINED', trigger: 'quarantine', deferred: true } });
          return { finalState: 'QUARANTINED', iterations: 0, reachedReviewing: false };
        }
      }
      // Merge topology (REQ-7.1): each task runs on its own `task/<taskId>` branch,
      // created from the fixture main BEFORE the loop so the executor's snapshot commits
      // land on it; auto-merge merges it into main with --no-ff (one revert target).
      if (!taskLease.verifyOwnership()) {
        log.append({ runId: RUN_ID, taskId, type: 'ESCALATED', payload: { why: 'lease_lost', boundary: 'branch_create', fencingToken: taskLease.claim.fencingToken } });
        return { finalState: 'ESCALATED', iterations: 0, reachedReviewing: false };
      }
      git(fx.wt, 'checkout', '-q', '-b', taskBranch);
      // REQ-4.12: a fresh tracker per task — task N's spend never depletes task N+1's.
      // Single-task calls this exactly once, where the run used to.
      const budget = createBudget(opts.contract.budget, clock);
      // The ACs this task maps. Single-task maps the whole contract (Phase-2 REQ-7.2);
      // a graph task maps ONLY its own `satisfies` (REQ-4.13, superseding "maps ALL"
      // for this mode) — the one narrow point every downstream reader shares, so the
      // agent-facing excerpt, the auto-merge decision and the approval package all
      // narrow together. An `enabling` task maps zero ACs and therefore can never
      // auto-merge on another task's goldens: it always takes the approval path.
      const taskAcs =
        graphTask === undefined
          ? opts.contract.acceptanceCriteria
          : opts.contract.acceptanceCriteria.filter((a) => graphTask.satisfies.includes(a.id));
      const taskExcerpt = { ...taskContractExcerpt, acceptanceCriteria: taskAcs.map((a) => ({ id: a.id, description: a.description })) };
      const source = createAALProposalSource({
        runId: RUN_ID,
        taskId,
        // Shadow routing (REQ-7) + outcome routing ACTIVE (REQ-14/15): observes
        // each round's live choice; 'active' mode additionally reorders it above.
        router,
        breaker,
        worktreeDir: fx.wt,
        taskContract: taskExcerpt,
        seedPaths: ['src/impl.txt'],
        evidence,
        log,
        ids,
        fence: () => taskLease.claim,
        outputSchema: { type: 'object', required: ['claim', 'actionRequests'], properties: { claim: { type: 'string', enum: ['WORKING', 'READY_FOR_VERIFICATION', 'BLOCKED'] }, actionRequests: { type: 'array' } } },
        maxRepairRounds: 2,
        budgetRemaining: () => budget.remaining(),
        // REQ-16.5: a resolved plan is injected into every implementer round's context
        // as MARKed data, same treatment as lessons below. Absent (no trigger fired,
        // or fusion escalated/produced a structurally invalid plan) -> byte-identical
        // to pre-Phase-4 behavior.
        ...(resolvedPlan !== null ? { plan: resolvedPlan } : {}),
        ...(opts.lessons !== undefined && opts.governanceLogPath !== undefined
          ? { lessons: { dir: opts.lessons.dir, governanceLogPath: opts.governanceLogPath, ...(opts.lessons.maxLessons !== undefined ? { maxLessons: opts.lessons.maxLessons } : {}), ...(opts.lessons.maxBytes !== undefined ? { maxBytes: opts.lessons.maxBytes } : {}) } }
          : {}),
      });
      // Hoisted (not inlined) so the deploy stage (REQ-6, post-COMPLETED) can run every
      // deploy command through this SAME executor instance.
      // RED provenance is rehydrated from the core event log for this task and is
      // threaded through the same policy object used by WRITE_FILE/APPLY_PATCH/
      // RUN_COMMAND, so no production mutator can bypass frozen artifacts.
      const redArtifacts = createRedArtifactStore({
        evidence,
        log,
        reportIntegrity,
        worktreeDir: fx.wt,
        runId: RUN_ID,
        taskId,
      });
      const executor = createExecutor({
        worktreeDir: fx.wt,
        runId: RUN_ID,
        taskId,
        log,
        evidence,
        policy: createDefaultPathPolicy({ frozenRedArtifacts: redArtifacts }),
        clock,
        ...(opts.offlineDependencyPolicy === undefined
          ? {}
          : { offlineDependencyPolicy: opts.offlineDependencyPolicy }),
        ...(opts.toolHandlers !== undefined ? { toolHandlers: opts.toolHandlers } : {}),
        ...(opts.syntheticSandboxForTests === undefined
          ? {}
          : { sandbox: opts.syntheticSandboxForTests }),
        redArtifacts,
        fence: () => taskLease.claim,
      });
      const result = await runTaskLoop({
        runId: RUN_ID,
        taskId,
        role: 'implementer',
        source,
        executor,
        gates: createGateRunner({
          worktreeDir: fx.wt,
          configPath: fx.gateConfigPath,
          conventionPolicyPath: fx.conventionPolicyPath,
          runId: RUN_ID,
          taskId,
          log,
          evidence,
          reportIntegrity,
          clock,
          ...(opts.syntheticSandboxForTests === undefined
            ? {}
            : { sandbox: opts.syntheticSandboxForTests }),
          fence: () => taskLease.claim,
        }),
        log,
        budget,
        clock,
        // Repair engine deps: a DIAGNOSING round runs its probes through the executor
        // and reads their output from the evidence store (REQ-5).
        evidence,
        ids: { next: (prefix) => `${prefix}-${randomUUID()}` },
        // The frozen contract's max_hypotheses_per_failure bounds the repair cycle
        // (phase5-stage2 REQ-4.1) — the other two policy fields keep core defaults.
        repairPolicy: { ...DEFAULT_REPAIR_POLICY, maxHypotheses: opts.contract.budget.maxHypothesesPerFailure },
        // Steering (REQ-10): the loop polls the control port at each boundary and
        // folds guidance injected while paused into the next round as marked data.
        control: controller.port,
        takeGuidance: () => guidanceQueue.splice(0),
        lease: taskLease,
        releaseLease: false,
      });
      // Held-out (golden) verification passed iff the loop reached REVIEWING —
      // captured BEFORE auto-merge, which may carry the state on to COMPLETED.
      const reachedReviewing = result.finalState === 'REVIEWING';

      // Every post-loop side effect is fenced independently. The lease heartbeat
      // remains active while this composition waits for a human decision; a
      // replacement owner can therefore stop this invocation before commit,
      // merge, audit-gate, or deploy begins.
      const requireTaskLease = (boundary: string): boolean => {
        if (taskLease.verifyOwnership()) return true;
        log.append({ runId: RUN_ID, taskId, type: 'ESCALATED', payload: { why: 'lease_lost', boundary, fencingToken: taskLease.claim.fencingToken } });
        return false;
      };

      // Post-REVIEWING auto-merge L0/L1 (REQ-7/8). The pure gate ignores the agent
      // claim by construction; risk comes from the frozen contract, gatesGreen from
      // the loop's own T1, ACs (golden flags) from the contract. L2+/non-golden/
      // dep-touching → the human approval package below (REQ-2/3).
      let finalState: string = result.finalState;
      if (reachedReviewing && result.lastGateReport !== undefined) {
        if (!requireTaskLease('post_loop')) {
          return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
        }
        // Commit the work (review #6): the executor snapshots BEFORE each write for
        // rollback, so the final write is still uncommitted in the worktree at
        // REVIEWING. Commit it onto task/<taskId> so auto-merge has a real branch tip
        // to merge (and `git checkout main` is not blocked by the dirty worktree).
        if (!requireTaskLease('commit')) return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
        git(fx.wt, 'add', '-A');
        git(fx.wt, 'commit', '-q', '--allow-empty', '-m', `task ${taskId} work`);
        const acceptanceCriteria: MappedAc[] = taskAcs.map((a) => ({
          id: a.id,
          ...(a.golden !== undefined ? { golden: a.golden } : {}),
        }));
        const gateReport = result.lastGateReport;
        if (!requireTaskLease('auto_merge')) return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
        let merge: Awaited<ReturnType<typeof runAutoMerge>>;
        try {
          merge = await runAutoMerge({
          runId: RUN_ID,
          taskId,
          state: 'REVIEWING',
          repoDir: fx.wt,
          taskBranch,
          mainBranch: 'main',
          decision: {
            riskClass: opts.contract.risk,
            gatesGreen: true,
            acceptanceCriteria,
            depManifestPatterns: opts.autoMerge?.depManifestPatterns ?? [],
          },
          originalReport: gateReport,
          gateConfigRelPath: 'gate-ladder.json',
          conventionPolicyRelPath: '.ai/policies/convention.json',
          auditSampleRate: opts.autoMerge?.auditSampleRate ?? 0,
          log,
          evidence,
        reportIntegrity,
        clock,
        ...(opts.syntheticSandboxForTests === undefined
          ? {}
          : { sandbox: opts.syntheticSandboxForTests }),
        assertOwnership: (boundary) => {
          if (!requireTaskLease(`merge:${boundary}`)) throw new Error('lease_lost');
        },
        fence: () => taskLease.claim,
          });
        } catch (error) {
          if (error instanceof LeaseFenceError) {
            return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
          }
          throw error;
        }
        let authorizedReport = merge.authorizedReport;

        if (merge.decision !== 'approval_package') {
          finalState = merge.finalState;
        } else {
          if (authorizedReport === null) {
            throw new Error('approval package cannot be built without an artifact-bound gate report');
          }
          // REQ-2: build a real package for a human to decide instead of leaving the
          // run stuck at REVIEWING with nothing in the approvals Map (Phase-3 gap #1).
          const diff = gitOut(
            fx.wt,
            'diff',
            '--no-color',
            `${authorizedReport.baseCommitHash as string}...${authorizedReport.artifactCommitHash as string}`,
          );
          const diffLineCount = countChangedLines(diff);
          const built = buildApprovalPackage({
            id: taskId,
            taskId,
            runId: RUN_ID,
            goalExcerpt: opts.contract.goal.objective,
            acIds: taskAcs.map((a) => a.id),
            diffRef: evidence.put(diff),
            diffLineCount,
            // REQ-4.5: a graph task's EFFECTIVE diff budget (its own `diff_budget`, else
            // checks.max_diff_budget_per_task — resolved at freeze) replaces the
            // composition default for this mode only.
            maxDiffBudget: graphTask?.diffBudget ?? opts.approval?.maxDiffBudget ?? 400,
            gateReports: [evidence.put(JSON.stringify(authorizedReport))],
            worktreeHash: authorizedReport.worktreeHash,
            assumptions: [],
            unresolvedRisks: [],
            riskClass: merge.effectiveRisk,
            createdAt: clock.now(),
            // phase5-stage3 REQ-6.2: conditional spread — exactOptionalPropertyTypes
            // rejects an explicit `provenance: undefined`.
            ...(opts.contract.provenance !== undefined ? { provenance: opts.contract.provenance } : {}),
          });

          const escalateTask = (why: string, extra?: Record<string, unknown>): void => {
            const tr = transition(currentState(taskId), 'escalate');
            if (tr.ok) log.append({ runId: RUN_ID, taskId, type: 'TASK_STATE', payload: { state: tr.next, trigger: 'escalate' } });
            log.append({ runId: RUN_ID, taskId, type: 'ESCALATED', payload: { why, ...extra } });
          };

          if (built.kind === 'escalate') {
            // REQ-2.3: over the diff budget — split the task, no package.
            escalateTask('split_required', { detail: built.detail });
            finalState = 'ESCALATED';
          } else {
            if (!requireTaskLease('approval_package')) return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
            approvals.set(built.package.id, built.package);
            log.append({ runId: RUN_ID, taskId, type: 'APPROVAL_PACKAGE_CREATED', payload: { approvalId: built.package.id } });
            audit({ event: 'approval_package_created', taskId, approvalId: built.package.id });

            // The blocking wait is OPT-IN (REQ-2/3): a non-interactive caller (CI/stub,
            // bin/platform.ts's default path) passes no timeout, so the package is left
            // in the approvals Map for a live Human Plane client and the run returns
            // REVIEWING immediately — never a 30-minute hang then ESCALATED (PR #50
            // review; Phase-3 parity). A caller that wants to hold the run open for a
            // human decision passes approval.timeoutMs explicitly (the live CLI does).
            const timeoutMs = opts.approval?.timeoutMs;
            const outcome = timeoutMs === undefined ? 'reviewing' : await waitForApprovalDecision(timeoutMs);
            if (!requireTaskLease('approval_decision')) return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
            if (outcome === 'reviewing') {
              finalState = 'REVIEWING';
            } else if (outcome === 'approve') {
              if (!requireTaskLease('approved_merge')) return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
              let approvedMerge: Awaited<ReturnType<typeof runApprovedMerge>>;
              try {
                approvedMerge = await runApprovedMerge({
                runId: RUN_ID,
                taskId,
                state: currentState(taskId),
                approvalBasis: 'human_approved',
                repoDir: fx.wt,
                taskBranch,
                mainBranch: 'main',
                originalReport: authorizedReport,
                gateConfigRelPath: 'gate-ladder.json',
                conventionPolicyRelPath: '.ai/policies/convention.json',
                auditSampleRate: opts.autoMerge?.auditSampleRate ?? 0,
                log,
                evidence,
                reportIntegrity,
                clock,
                ...(opts.syntheticSandboxForTests === undefined
                  ? {}
                  : { sandbox: opts.syntheticSandboxForTests }),
                assertOwnership: (boundary) => {
                  if (!requireTaskLease(`merge:${boundary}`)) throw new Error('lease_lost');
                },
                fence: () => taskLease.claim,
                });
              } catch (error) {
                if (error instanceof LeaseFenceError) {
                  return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
                }
                throw error;
              }
              authorizedReport = approvedMerge.authorizedReport;
              finalState = approvedMerge.finalState;
            } else if (outcome === 'reject') {
              // REQ-3.3: terminal for this run — no silent retry.
              finalState = 'CHANGES_REQUESTED';
            } else if (outcome === 'timeout') {
              approvals.delete(built.package.id);
              escalateTask('approval_timeout', { approvalId: built.package.id });
              finalState = 'ESCALATED';
            } else if (outcome === 'evidence_invalid') {
              approvals.delete(built.package.id);
              finalState = 'ESCALATED';
            } else {
              // REQ-3.6: kill while pending — the same terminal state a mid-loop kill
              // reaches (loop.ts's `move('cancel')`).
              const tr = transition(currentState(taskId), 'cancel');
              if (tr.ok) log.append({ runId: RUN_ID, taskId, type: 'TASK_STATE', payload: { state: tr.next, trigger: 'cancel' } });
              finalState = 'CANCELLED';
            }
          }
        }

        // Deploy gate (REQ-6): built ALWAYS once the task is COMPLETED and the frozen
        // contract has deploy: configured — regardless of approvalPolicy content (hard
        // human floor) and NEVER through the task approvals Map/onDecision (architect
        // finding #1). Deploy has its own state machine and never changes finalState:
        // the task stays COMPLETED whatever the deploy outcome.
        if (finalState === 'COMPLETED' && opts.contract.deploy !== undefined) {
          if (authorizedReport === null || typeof authorizedReport.mergedCommitHash !== 'string') {
            throw new Error('deploy package cannot be built without a merge-bound gate report');
          }
          const deployConfig = opts.contract.deploy;
          const deployDiff = gitOut(
            fx.wt,
            'diff',
            '--no-color',
            `${authorizedReport.mergedCommitHash}^1`,
            authorizedReport.mergedCommitHash,
          );
          currentDeployApproval = {
            id: `deploy-${taskId}`,
            taskId,
            runId: RUN_ID,
            goalExcerpt: opts.contract.goal.objective,
            acIds: opts.contract.acceptanceCriteria.map((a) => a.id),
            diffRef: evidence.put(deployDiff),
            evidence: {
              gateReports: [evidence.put(JSON.stringify(authorizedReport))],
              worktreeHash: authorizedReport.worktreeHash,
            },
            assumptions: ['network: none (simulation)'],
            unresolvedRisks: [],
            // Architect finding #7: L4 is the only risk class attesting recoverability/
            // rollback+backup — exactly what a deploy approver must attest.
            attestations: attestationsFor('L4'),
            riskClass: 'L4',
            createdAt: clock.now(),
            // phase5-stage3 REQ-6.2 (critique D3 — this site builds the ApprovalPackage
            // literal directly, not via ApprovalInput, so the spread target differs from
            // the task-approval site above).
            ...(opts.contract.provenance !== undefined ? { provenance: opts.contract.provenance } : {}),
          };
          audit({ event: 'deploy_package_created', taskId, approvalId: currentDeployApproval.id });

          // REQ-6: deploy decision shares the task approval's timeout knob, and its
          // opt-in semantics — no explicit timeout means no human present (CI/stub), so
          // skip the deploy decision entirely rather than hang 30 minutes (PR #50 review).
          // The task stays COMPLETED regardless; deploy never changes finalState.
          const deployTimeoutMs = opts.approval?.timeoutMs;
          const deployDecision = deployTimeoutMs === undefined ? 'skip' : await waitForDeployDecision(deployTimeoutMs);
          if (!requireTaskLease('deploy_decision')) return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
          if (deployDecision === 'timeout' || deployDecision === 'killed') {
            // No HTTP call happened, so (unlike approve/reject, recorded by api.ts) the
            // timeout/kill event + audit is composition's own job (mirrors escalateTask above).
            log.append({ runId: RUN_ID, taskId, type: 'DEPLOY_DECISION', payload: { approvalId: currentDeployApproval.id, decision: deployDecision } });
            audit({ event: 'deploy_decision', taskId, decision: deployDecision });
          }
          const approvedDeployPackage = currentDeployApproval;
          currentDeployApproval = null;

          if (deployDecision === 'approve') {
            if (!requireTaskLease('deploy')) return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
            if (approvedDeployPackage === null) {
              throw new Error('approved deploy package disappeared before stage verification');
            }
            // No production wait exists anywhere in core yet (task 2 finding) — real here,
            // tests just configure small interval_ms/expandedWindowMs.
            // .unref() the wait timer so a kill during the EXPANDED window (which wins
            // the race below via deployKillResolvers) does not leave a live ~10-min
            // timer pinning the CLI process alive after the server closes (PR #50
            // review). The Human Plane server keeps the loop alive while the stage runs,
            // so an unref'd inter-probe wait still fires normally.
            const deployClock: DeployClock = { now: () => clock.now(), wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); }) };
            deployDeps = {
              runId: RUN_ID,
              taskId,
              config: deployConfig,
              executor,
              log,
              evidence,
              clock: deployClock,
              verifyApprovalEvidence: () => verifyApprovalEvidence(approvedDeployPackage, 'deploy_approval'),
              assertOwnership: (boundary) => {
                if (!requireTaskLease(`deploy:${boundary}`)) throw new LeaseFenceError('lease_lost');
              },
            };
            let deployOutcome: Awaited<ReturnType<typeof runDeployStage>>;
            try {
              deployOutcome = await runDeployStage(deployDeps);
            } catch (error) {
              if (error instanceof LeaseFenceError) {
                return { finalState: 'ESCALATED', iterations: result.iterations, reachedReviewing: false };
              }
              throw error;
            }
            if (deployOutcome.finalState === 'EXPANDED') {
              const expandedWindowMs = opts.deploy?.expandedWindowMs ?? 10 * 60_000;
              // REQ-3.5/3.6: kill must also end this wait, not just the elapsed timer
              // (design.md "kill switch covers interruption").
              await Promise.race([
                deployClock.wait(expandedWindowMs),
                new Promise<void>((resolve) => { deployKillResolvers.push(resolve); }),
              ]);
              // A manual rollback triggered during the window must finish before the
              // server (and this run) tears down — REQ-6.12's "remain open" scope.
              await manualRollback;
              log.append({ runId: RUN_ID, taskId, type: 'DEPLOY_WINDOW_CLOSED', payload: {} });
            }
          }
        }
      }
      return { finalState, iterations: result.iterations, reachedReviewing };
    };

    /**
     * Multi-task driver (REQ-4.9): kill-poll -> select -> claim -> branch hygiene ->
     * executeTask -> release, sequentially, until nothing is eligible. Everything the
     * loop decides with comes from the frozen graph plus THIS run's slice of the event
     * log — a reused log's earlier runs are invisible (projection scoped at frozenSeq).
     */
    const runTaskGraph = async (
      frozen: TaskGraph,
      frozenAt: number,
    ): Promise<{ finalState: string; iterations: number; calibration: CalibrationResult; tasks: NonNullable<LoopRunResult['tasks']> }> => {
      const ttlMs = leaseTtlMs;
      // Closed = never selectable again this run: a lease held by someone else (D4)
      // and, defensively, any task already executed — a task that somehow recorded no
      // TASK_STATE would otherwise be re-selected forever.
      const closed = new Set<string>();
      const statesOf = (taskId: string): string[] =>
        log.all({ type: 'TASK_STATE', taskId }).filter((e) => e.seq >= frozenAt).map((e) => String(e.payload['state']));
      const projection: TaskProjection = {
        latestState: (taskId) => statesOf(taskId).at(-1),
        started: (taskId) => closed.has(taskId) || statesOf(taskId).length > 0,
      };
      const outcomes = new Map<string, { finalState: string; iterations: number }>();
      const heldOut: boolean[] = [];
      let killed = false;
      try {
        for (;;) {
          // REQ-4.15: kill is polled BEFORE each selection, so it stops the run — it can
          // never degrade into "skip this task and carry on with the next".
          if (controller.port.poll() === 'kill') {
            killed = true;
            break;
          }
          const task = selectNextTask(frozen, projection);
          if (task === null) break;
          const taskLease = acquireTaskLease(lease, task.id, leaseOwner, ttlMs);
          if (taskLease === null) {
            closed.add(task.id);
            continue;
          }
          if (!taskLease.verifyOwnership()) {
            closed.add(task.id);
            taskLease.release();
            continue;
          }
          try {
            // Branch hygiene (D1): return the worktree to main and drop everything the
            // previous task left behind, so `git diff main...task/<id>` — and therefore the
            // diff budget and the approval package — covers THIS task only. executeTask
            // cuts the `task/<id>` branch itself, which completes the sequence.
            if (!taskLease.verifyOwnership()) {
              closed.add(task.id);
              continue;
            }
            git(fx.wt, 'checkout', '-q', 'main');
            git(fx.wt, 'reset', '-q', '--hard', 'main');
            git(fx.wt, 'clean', '-qfd');
            const outcome = await executeTask(task.id, task, taskLease);
            outcomes.set(task.id, { finalState: outcome.finalState, iterations: outcome.iterations });
            heldOut.push(outcome.reachedReviewing);
          } finally {
            closed.add(task.id);
            taskLease.release();
          }
        }
      } finally {
        // The invocation-scoped lease manager is closed by the outer run finally;
        // keep it open here so post-graph bookkeeping cannot double-close SQLite.
      }
      // REQ-4.4/4.11: a task whose dependency ended outside the dep-satisfied set was
      // never selectable and is labeled SKIPPED — transitively, since its own
      // dependents are just as unreachable. Iterate to a fixpoint: graph file order is
      // not guaranteed to be topological.
      const skipped = new Set<string>();
      for (let changed = true; changed; ) {
        changed = false;
        for (const t of frozen.tasks) {
          if (outcomes.has(t.id) || skipped.has(t.id)) continue;
          const dead = t.dependsOn.some((dep) => {
            if (skipped.has(dep)) return true;
            if (!outcomes.has(dep)) return false;
            const state = projection.latestState(dep);
            return state === undefined || !DEP_SATISFIED_STATES.has(state);
          });
          if (dead) {
            skipped.add(t.id);
            changed = true;
          }
        }
      }
      const tasks = frozen.tasks.map((t) => {
        const done = outcomes.get(t.id);
        return done !== undefined
          ? { id: t.id, finalState: done.finalState, iterations: done.iterations }
          : { id: t.id, finalState: skipped.has(t.id) ? 'SKIPPED' : 'NOT_STARTED', iterations: 0 };
      });
      // Kill outranks every per-task state (REQ-4.15); otherwise the run reports the
      // most severe end state any task reached.
      const rank = tasks.reduce((worst, t) => Math.max(worst, runStateRank(t.finalState)), killed ? runStateRank('CANCELLED') : 0);
      return {
        finalState: RUN_STATE_PRECEDENCE[rank] as string,
        iterations: tasks.reduce((sum, t) => sum + t.iterations, 0),
        // Held-out (golden) verification per EXECUTED task — never-run tasks are not
        // evidence either way, so they contribute no sample (D9).
        calibration: calibrationFor(
          heldOut,
          heldOut.filter(Boolean).map(() => true),
          frozen.tasks.flatMap((task) => opts.contract.acceptanceCriteria.filter((ac) => task.satisfies.includes(ac.id))),
        ),
        tasks,
      };
    };

    try {
      let outcome: {
        finalState: string;
        iterations: number;
        calibration: CalibrationResult;
        tasks?: NonNullable<LoopRunResult['tasks']>;
      };
      if (graph === null) {
        const taskLease = acquireTaskLease(lease, TASK_ID, leaseOwner, leaseTtlMs);
        if (taskLease === null) {
          log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'ESCALATED', payload: { why: 'lease_held', boundary: 'claim' } });
          outcome = {
            finalState: 'BLOCKED',
            iterations: 0,
            calibration: calibrationFor([], []),
          };
        } else {
          try {
            const single = await executeTask(TASK_ID, undefined, taskLease);
            outcome = {
              finalState: single.finalState,
              iterations: single.iterations,
              calibration: calibrationFor(
                [single.reachedReviewing],
                single.reachedReviewing ? [true] : [],
              ),
            };
          } finally {
            // Covers composition exceptions after the core loop (approval, merge,
            // deploy) as well as the ordinary terminal path.
            taskLease.release();
          }
        }
      } else {
        outcome = await runTaskGraph(graph, frozenSeq);
      }
      // REQ-10.1: post-run, fold this run's confirmed-hypothesis verdicts into
      // pending lessons — the core orchestrator/hypothesis engine never see this;
      // it is folded here, in the composition, from the run's OWN event log,
      // regardless of how the run ended (a confirmed hypothesis mid-repair does
      // not imply the run went on to succeed).
      if (lessonsOpt !== undefined && govLog !== undefined) {
        for (const c of foldConfirmedHypotheses(log.all({ type: 'HYPOTHESIS_CONFIRMED' }))) {
          proposeLessonFromHypothesis({
            dir: lessonsOpt.dir,
            governanceLogPath: govLog,
            statement: c.statement,
            sourceRunId: c.runId,
            sourceTaskId: c.taskId,
            evidenceRefs: c.evidenceRefs,
            clock,
            log,
            runId: RUN_ID,
            taskId: activeTaskId(),
          });
        }
      }
      return {
        finalState: outcome.finalState,
        iterations: outcome.iterations,
        calibration: outcome.calibration,
        ...goldenResult,
        ...calibrationExtras(log, shadowProof),
        // Additive and multi-task only — the single-task result keeps its exact shape
        // and key order (REQ-4.3/4.11).
        ...(outcome.tasks !== undefined ? { tasks: outcome.tasks } : {}),
      };
    } finally {
      await server.close();
    }
  } finally {
    lease.close();
    log.close();
    // AZ-4/REQ-15.9: F-Loop defines "ended" as discovery-file-absent-or-tombstoned
    // (REQ-15.6) — never a stale {url,token} that LOOKS live after the server that
    // owned it has already closed. Best-effort: an already-vanished stateDir (the
    // ephemeral fixture-root case, cleaned up below) still reads as "ended" (absent).
    try {
      writeFileSync(join(stateDir, 'human-plane.json'), JSON.stringify({ tombstoned: true }), { mode: 0o600 });
    } catch {
      // best-effort, see above
    }
    // The fixture repo (fx.root/fx.wt) is ALWAYS ephemeral, live run or not (comment
    // above stateDir's assignment) — but a persisted run with nothing to point
    // `platform auditor run --repo` at defeats REQ-14.7's real-sample DoD item (live
    // task 13 residual). A real `git clone` (not a raw file copy — fx.wt is a linked
    // worktree, whose .git depends on fx.root's metadata) leaves a fully independent,
    // cloneable repo behind, post-merge, best-effort so it never masks the real result.
    if (opts.persistDir !== undefined) {
      try {
        git(process.cwd(), 'clone', '-q', fx.wt, join(stateDir, 'repo'));
      } catch {
        // best-effort — an already-failed/aborted run's worktree may be gone or dirty
      }
    }
    fx.cleanup();
  }
}
