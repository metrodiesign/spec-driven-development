// Supervised-loop composition (spec §14 Phase 1). Wires core (log/evidence/
// executor/gates/budget) + AAL (context source + registry/router) + an adapter
// into runTaskLoop against a synthetic fixture target repo. The adapter is a
// factory: the CI/stub path uses the FakeAdapter (no quota); `--live` passes the
// real Claude adapter over the SDK. This is the capstone that produces the first
// calibration numbers when a human triggers a live run (task 11).

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  applyGovernanceApproval,
  attestationsFor,
  buildApprovalPackage,
  computeCalibration,
  computeLessonHitRate,
  createBudget,
  createDefaultPathPolicy,
  createEvidenceStore,
  createExecutor,
  createGateRunner,
  createHumanPlaneServer,
  createLoopController,
  denyNetworkSandbox,
  foldConfirmedHypotheses,
  listPendingProposals,
  openEventLog,
  pendingQuarantines,
  promoteLesson,
  proposeLessonFromHypothesis,
  readGovernanceLog,
  runApprovedMerge,
  runAutoMerge,
  runDeployStage,
  runManualRollback,
  runTaskLoop,
  transition,
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
  type RiskClass,
  type Role,
  type TaskContract,
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
  type ShadowProofReport,
} from 'aal';
import { runPlannerFusion } from './fusion.ts';

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

/** Read the per-task risk class from the frozen contract; anything unrecognized → null (→ L2, REQ-7.6). */
function parseRisk(v: unknown): RiskClass | null {
  return v === 'L0' || v === 'L1' || v === 'L2' || v === 'L3' || v === 'L4' ? v : null;
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
  deps: { registry: Registry; log: EventLog; runId: string; taskId: string },
): Router {
  return {
    ...router,
    eligibleAdapters(role: Role, hints?: RouteHints) {
      const eligible = router.eligibleAdapters(role, hints);
      const live = eligible[0];
      if (live !== undefined && !shadowFrozen(deps.registry.all())) {
        const liveKey = breakerKey(live.record.adapterId, live.record.modelVersion);
        const { wouldChoose, basis } = shadowWouldChoose({
          role,
          liveChoice: liveKey,
          eligible: eligible.map((r) => breakerKey(r.record.adapterId, r.record.modelVersion)),
          outcomeStats: computeShadowOutcomeStats(deps.log.all()),
        });
        try {
          deps.log.append({
            runId: deps.runId,
            taskId: deps.taskId,
            type: 'SHADOW_ROUTE',
            payload: { role, live: liveKey, wouldChoose, basis, frozen: false },
          });
        } catch (err) {
          deps.log.append({
            runId: deps.runId,
            taskId: deps.taskId,
            type: 'ERROR',
            payload: { reason: 'shadow_append_failed', detail: (err as Error).message },
          });
        }
      }
      return eligible;
    },
  };
}

/** A synthetic target repo whose tests pass iff src/impl.txt contains `correct`. */
export function makeFixtureRepo(): { root: string; wt: string; gateConfigPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'loop-fixture-'));
  const wt = join(root, 'target');
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(join(wt, 'test', 'golden'), { recursive: true });
  git(wt, 'init', '-q', '-b', 'main');
  git(wt, 'config', 'user.email', 'fixture@example.invalid');
  git(wt, 'config', 'user.name', 'fixture');
  writeFileSync(join(wt, 'src', 'impl.txt'), 'wrong\n');
  const goldenFile = join(wt, 'test', 'golden', 'expected.txt');
  writeFileSync(goldenFile, 'golden truth\n');
  writeFileSync(
    join(wt, 'test', 'golden', '_MANIFEST.sha256'),
    `${sha256(readFileSync(goldenFile))}  ${relative(join(wt, 'test', 'golden'), goldenFile)}\n`,
  );
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
  return { root, wt, gateConfigPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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
  /** REQ-24.1: lesson injection count + hit-rate PROXY, folded from this run's own log. */
  lessonHitRate: LessonHitRateStats;
  /** REQ-24.2: a shadowProven snapshot over this run's own log — evidence for a human's
   *  activation decision only (INV-16); nothing here ever gates routing automatically. */
  shadowProven: ShadowProofReport;
  /** REQ-24.3: fusion-uplift interval slot. This composition never runs a paired
   *  single-vs-fused corpus, so it is always empty-but-labeled — filled only by the
   *  task-12 LIVE pass, never fabricated. */
  fusionUplift: { available: false };
}

/** REQ-24.1/24.2: the calibration-report extras beyond computeCalibration's own
 *  shape (design.md "I. Security sweep + calibration wiring" — extend, not replace).
 *  minSamples 20 mirrors routing.json's own outcomeRouting default (design.md "Data
 *  Models" E); this snapshot is read by a human only, same as shadowProven itself. */
function calibrationExtras(log: EventLog): Pick<LoopRunResult, 'lessonHitRate' | 'shadowProven' | 'fusionUplift'> {
  const events = log.all();
  return {
    lessonHitRate: computeLessonHitRate(events),
    shadowProven: shadowProven(events, { minSamples: 20 }),
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
   * Approval-package tuning (REQ-2.4/3.4) for the path above when auto-merge does
   * NOT fire. Both default when omitted: `maxDiffBudget` 400 (§11.2), `timeoutMs` 30
   * minutes — past it the run escalates `approval_timeout` instead of waiting forever.
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
  outcomeRouting?: { mode: 'off' | 'shadow' | 'active'; epsilon: number };
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
}): Promise<LoopRunResult> {
  const fx = makeFixtureRepo();
  const clock = opts.clock;
  const stateDir = opts.persistDir ?? fx.root; // fixture root is rm'd in finally; persistDir survives
  const log = openEventLog(join(stateDir, 'events.db'), clock);
  const evidence = createEvidenceStore(join(stateDir, 'evidence'));
  const RUN_ID = 'RUN-LIVE';
  const TASK_ID = 'T-1';
  const TASK_BRANCH = `task/${TASK_ID}`;
  try {
    // Deferred quarantine (REQ-9.5): a flaky_quarantine approved via the CLI while no
    // run was live takes effect when the next run LOADS that task — never runs it.
    if (opts.governanceLogPath !== undefined) {
      const deferred = pendingQuarantines(readGovernanceLog(opts.governanceLogPath));
      if (deferred.includes(TASK_ID)) {
        log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'TASK_STATE', payload: { state: 'QUARANTINED', trigger: 'quarantine', deferred: true } });
        return {
          finalState: 'QUARANTINED',
          iterations: 0,
          calibration: computeCalibration({ heldOut: [false], reruns: [] }),
          ...calibrationExtras(log),
        };
      }
    }
    // Merge topology (REQ-7.1): each task runs on its own `task/<taskId>` branch,
    // created from the fixture main BEFORE the loop so the executor's snapshot commits
    // land on it; auto-merge merges it into main with --no-ff (one revert target).
    git(fx.wt, 'checkout', '-q', '-b', TASK_BRANCH);
    const adapter = opts.adapterFactory((s) => evidence.put(s));
    // Breaker + quota-aware routing (REQ-1/2/3): transitions become events; a live
    // adapter may expose a health probe (REQ-2.5), the Fake has none (always-ok).
    const breaker = createBreaker(DEFAULT_BREAKER_OPTIONS, () => clock.now(), (t) =>
      log.append({ runId: 'RUN-LIVE', taskId: 'T-1', type: 'BREAKER_STATE_CHANGED', payload: { ...t } }),
    );
    const reg = createRegistry({ breaker });
    const healthProbe = (adapter as { healthProbe?: () => Promise<AdapterHealth> }).healthProbe;
    reg.register(adapter, opts.conformanceRecord ?? passingRecord(adapter.manifest().adapterId), healthProbe);
    const budget = createBudget(opts.contract.budget, clock);
    // Outcome-routing mode wiring (REQ-14.3). Absent -> 'shadow', preserving the
    // Phase-3 unconditional-recorder behavior byte-identical for every existing
    // caller. 'active' wraps the outcome reorder FIRST, then shadow OUTSIDE it,
    // so shadow observes the already-reordered live choice.
    const outcomeMode = opts.outcomeRouting?.mode ?? 'shadow';
    let router: Router = createRouter(reg);
    if (outcomeMode === 'active') {
      router = wrapRouterForOutcome(router, {
        registry: reg,
        stats: () => computeShadowOutcomeStats(log.all()),
        epsilonPercent: opts.outcomeRouting?.epsilon ?? 0,
        // Durable round count (OUTCOME_ROUTE events so far this run+task) so a
        // process restart mid-run never repeats an already-explored round (REQ-15.3).
        exploreKey: () => `${RUN_ID}:${TASK_ID}:${log.all({ type: 'OUTCOME_ROUTE', taskId: TASK_ID }).length}`,
        log,
        runId: RUN_ID,
        taskId: TASK_ID,
      });
    }
    if (outcomeMode !== 'off') {
      router = wrapRouterForShadow(router, { registry: reg, log, runId: RUN_ID, taskId: TASK_ID });
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
    // instance the task loop uses below, whatever mode governance pinned (AZ-13).
    let resolvedPlan: { id: string; content: string } | null = null;
    if (opts.planning?.enabled === true && opts.planning.plannerRoleTrigger === true) {
      const planned = await runPlannerFusion({
        runId: RUN_ID,
        taskId: TASK_ID,
        router,
        dispatcher: opts.planning.dispatcher,
        profile: opts.planning.profile,
        evidence,
        log,
        ids,
        taskContract: taskContractExcerpt,
      });
      resolvedPlan = planned.plan;
    }
    const source = createAALProposalSource({
      runId: 'RUN-LIVE',
      taskId: 'T-1',
      // Shadow routing (REQ-7) + outcome routing ACTIVE (REQ-14/15): observes
      // each round's live choice; 'active' mode additionally reorders it above.
      router,
      breaker,
      worktreeDir: fx.wt,
      taskContract: taskContractExcerpt,
      seedPaths: ['src/impl.txt'],
      evidence,
      log,
      ids,
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
    const currentState = (): TaskState =>
      (log.all({ type: 'TASK_STATE' }).at(-1)?.payload['state'] as TaskState) ?? 'PROPOSED';
    // Approval decision wait (REQ-3.1/3.6): `onDecision`/`onKill` resolve this from the
    // HTTP thread; `waitForApprovalDecision` races it against a real timeout (REQ-3.4).
    // Single resolver in a closure var, same shape as `createLoopController`'s
    // `resumeResolve` (control.ts) — at most one package is ever pending at a time in
    // this single-task loop.
    let pendingApprovalResolve: ((outcome: 'approve' | 'reject' | 'killed') => void) | null = null;
    const waitForApprovalDecision = (timeoutMs: number): Promise<'approve' | 'reject' | 'timeout' | 'killed'> =>
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
      const tr = transition(currentState(), decision === 'approve' ? 'human_approved' : 'changes_requested');
      if (!tr.ok) return { ok: false, detail: tr.reason };
      log.append({ runId: RUN_ID, taskId, type: 'TASK_STATE', payload: { state: tr.next, trigger: decision } });
      audit({ event: 'approval', taskId, decision, state: tr.next });
      pendingApprovalResolve?.(decision);
      return { ok: true, state: tr.next };
    };
    const onInject: HandlerDeps['onInject'] = (guidance, opts) => {
      // REQ-17.3: mode is purely an observability label — both paths feed the SAME
      // guidanceQueue that runTaskLoop's takeGuidance() drains at its next boundary
      // (REQ-17.2); PAUSED-immediate already sits at that boundary, so there is no
      // separate delivery mechanism to build.
      const mode = opts.atNextBoundary ? 'next_boundary' : 'immediate';
      const evidenceRef = evidence.put(guidance);
      log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'GUIDANCE_INJECTED', payload: { evidenceRef, mode } });
      guidanceQueue.push(guidance);
      audit({ event: 'steer_inject', taskId: TASK_ID, evidenceRef, mode });
      return { ok: true, evidenceRef };
    };
    const govLog = opts.governanceLogPath;
    const lessonsOpt = opts.lessons;
    const governance: Partial<HandlerDeps> = govLog === undefined ? {} : {
      governanceProposals: () => listPendingProposals(readGovernanceLog(govLog)),
      onGovernanceApprove: (id) => {
        const res = applyGovernanceApproval({ logPath: govLog, id, clock }, {
          fireQuarantine: (tid) => {
            const tr = transition(currentState(), 'quarantine');
            if (tr.ok) log.append({ runId: RUN_ID, taskId: tid, type: 'TASK_STATE', payload: { state: tr.next, trigger: 'quarantine' } });
          },
          // REQ-11.2: a lesson_promote approved LIVE (through THIS run's own Human
          // Plane server) moves pending/ -> approved/ immediately. The offline case
          // (approved via the CLI while no run was live) is reconciled separately,
          // at the NEXT run's `loadApprovedLessons` (aal/src/source.ts, REQ-11.3).
          ...(lessonsOpt !== undefined
            ? { promoteLesson: (lessonId: string) => {
                promoteLesson({ dir: lessonsOpt.dir, lessonId, approvedAt: new Date(clock.now()).toISOString(), log, runId: RUN_ID, taskId: TASK_ID });
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
    let pendingDeployResolve: ((outcome: 'approve' | 'reject' | 'killed') => void) | null = null;
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
    const waitForDeployDecision = (timeoutMs: number): Promise<'approve' | 'reject' | 'timeout' | 'killed'> =>
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
      audit({ event: 'deploy_decision', taskId: TASK_ID, decision });
      pendingDeployResolve?.(decision);
      return { ok: true };
    };
    const onDeployRollback: HandlerDeps['onDeployRollback'] = () => {
      if (deployDeps === null) return { ok: false, detail: 'not_expanded' };
      audit({ event: 'deploy_manual_rollback', taskId: TASK_ID });
      manualRollback = runManualRollback(deployDeps);
      // Mark handled immediately: a rollback can be triggered mid-EXPANDED-window and
      // reject before the `await manualRollback` below observes it, which would
      // otherwise be an unhandledRejection (Phase-4 review finding). The real outcome
      // still surfaces at that later await.
      manualRollback.catch(() => {});
      return { ok: true };
    };

    // REQ-2.2: the same Map instance the Human Plane server reads GET /approvals from —
    // populated below once a task actually needs a human decision.
    const approvals = new Map<string, ApprovalPackage>();
    const server = await createHumanPlaneServer({
      runDir: stateDir,
      deps: {
        runId: RUN_ID,
        approvals,
        log,
        onDecision,
        onKill: () => {
          audit({ event: 'kill' });
          // REQ-3.6: a pending approval wait ends via the same kill path as a mid-loop
          // kill (control.ts's `requestKill` — harmless no-op if the loop already ended).
          pendingApprovalResolve?.('killed');
          controller.requestKill();
          killDeployWaits();
        },
        rateOk: () => true,
        steeringState: currentState,
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
    try {
      // Hoisted (not inlined) so the deploy stage (REQ-6, post-COMPLETED) can run every
      // deploy command through this SAME executor instance.
      const executor = createExecutor({
        worktreeDir: fx.wt,
        runId: 'RUN-LIVE',
        taskId: 'T-1',
        log,
        evidence,
        policy: createDefaultPathPolicy(),
        sandbox: denyNetworkSandbox(process.platform),
        clock,
        ...(opts.toolHandlers !== undefined ? { toolHandlers: opts.toolHandlers } : {}),
      });
      const result = await runTaskLoop({
        runId: 'RUN-LIVE',
        taskId: 'T-1',
        role: 'implementer',
        source,
        executor,
        gates: createGateRunner({ worktreeDir: fx.wt, configPath: fx.gateConfigPath, runId: 'RUN-LIVE', taskId: 'T-1', log, evidence, clock }),
        log,
        budget,
        clock,
        // Repair engine deps: a DIAGNOSING round runs its probes through the executor
        // and reads their output from the evidence store (REQ-5).
        evidence,
        ids: { next: (prefix) => `${prefix}-${randomUUID()}` },
        // Steering (REQ-10): the loop polls the control port at each boundary and
        // folds guidance injected while paused into the next round as marked data.
        control: controller.port,
        takeGuidance: () => guidanceQueue.splice(0),
      });
      // Held-out (golden) verification passed iff the loop reached REVIEWING —
      // captured BEFORE auto-merge, which may carry the state on to COMPLETED.
      const reachedReviewing = result.finalState === 'REVIEWING';
      const calibration = computeCalibration({ heldOut: [reachedReviewing], reruns: reachedReviewing ? [true] : [] });

      // Post-REVIEWING auto-merge L0/L1 (REQ-7/8). The pure gate ignores the agent
      // claim by construction; risk comes from the frozen contract, gatesGreen from
      // the loop's own T1, ACs (golden flags) from the contract. L2+/non-golden/
      // dep-touching → the human approval package below (REQ-2/3).
      let finalState: string = result.finalState;
      if (reachedReviewing && result.lastGateReport !== undefined) {
        // Commit the work (review #6): the executor snapshots BEFORE each write for
        // rollback, so the final write is still uncommitted in the worktree at
        // REVIEWING. Commit it onto task/<taskId> so auto-merge has a real branch tip
        // to merge (and `git checkout main` is not blocked by the dirty worktree).
        git(fx.wt, 'add', '-A');
        git(fx.wt, 'commit', '-q', '--allow-empty', '-m', `task ${TASK_ID} work`);
        const acceptanceCriteria: MappedAc[] = opts.contract.acceptanceCriteria.map((a) => ({
          id: a.id,
          ...(a.golden !== undefined ? { golden: a.golden } : {}),
        }));
        const gateReport = result.lastGateReport;
        const merge = await runAutoMerge({
          runId: RUN_ID,
          taskId: TASK_ID,
          state: 'REVIEWING',
          repoDir: fx.wt,
          taskBranch: TASK_BRANCH,
          mainBranch: 'main',
          decision: {
            riskClass: parseRisk(opts.contract.raw['risk']),
            gatesGreen: true,
            acceptanceCriteria,
            depManifestPatterns: opts.autoMerge?.depManifestPatterns ?? [],
          },
          originalReport: gateReport,
          gateConfigRelPath: 'gate-ladder.json',
          auditSampleRate: opts.autoMerge?.auditSampleRate ?? 0,
          log,
          evidence,
          clock,
        });

        if (merge.decision !== 'approval_package') {
          finalState = merge.finalState;
        } else {
          // REQ-2: build a real package for a human to decide instead of leaving the
          // run stuck at REVIEWING with nothing in the approvals Map (Phase-3 gap #1).
          const diff = gitOut(fx.wt, 'diff', '--no-color', `main...${TASK_BRANCH}`);
          const diffLineCount = diff.length === 0 ? 0 : diff.replace(/\n$/, '').split('\n').length;
          const built = buildApprovalPackage({
            id: TASK_ID,
            taskId: TASK_ID,
            runId: RUN_ID,
            goalExcerpt: opts.contract.goal.objective,
            acIds: opts.contract.acceptanceCriteria.map((a) => a.id),
            diffRef: evidence.put(diff),
            diffLineCount,
            maxDiffBudget: opts.approval?.maxDiffBudget ?? 400,
            gateReports: [evidence.put(JSON.stringify(gateReport))],
            worktreeHash: gateReport.worktreeHash,
            assumptions: [],
            unresolvedRisks: [],
            riskClass: merge.effectiveRisk,
            createdAt: clock.now(),
          });

          const escalateTask = (why: string, extra?: Record<string, unknown>): void => {
            const tr = transition(currentState(), 'escalate');
            if (tr.ok) log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'TASK_STATE', payload: { state: tr.next, trigger: 'escalate' } });
            log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'ESCALATED', payload: { why, ...extra } });
          };

          if (built.kind === 'escalate') {
            // REQ-2.3: over the diff budget — split the task, no package.
            escalateTask('split_required', { detail: built.detail });
            finalState = 'ESCALATED';
          } else {
            approvals.set(built.package.id, built.package);
            log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'APPROVAL_PACKAGE_CREATED', payload: { approvalId: built.package.id } });
            audit({ event: 'approval_package_created', taskId: TASK_ID, approvalId: built.package.id });

            const timeoutMs = opts.approval?.timeoutMs ?? 30 * 60_000;
            const outcome = await waitForApprovalDecision(timeoutMs);
            if (outcome === 'approve') {
              const approvedMerge = await runApprovedMerge({
                runId: RUN_ID,
                taskId: TASK_ID,
                state: currentState(),
                repoDir: fx.wt,
                taskBranch: TASK_BRANCH,
                mainBranch: 'main',
                originalReport: gateReport,
                gateConfigRelPath: 'gate-ladder.json',
                auditSampleRate: opts.autoMerge?.auditSampleRate ?? 0,
                log,
                evidence,
                clock,
              });
              finalState = approvedMerge.finalState;
            } else if (outcome === 'reject') {
              // REQ-3.3: terminal for this run — no silent retry.
              finalState = 'CHANGES_REQUESTED';
            } else if (outcome === 'timeout') {
              approvals.delete(built.package.id);
              escalateTask('approval_timeout', { approvalId: built.package.id });
              finalState = 'ESCALATED';
            } else {
              // REQ-3.6: kill while pending — the same terminal state a mid-loop kill
              // reaches (loop.ts's `move('cancel')`).
              const tr = transition(currentState(), 'cancel');
              if (tr.ok) log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'TASK_STATE', payload: { state: tr.next, trigger: 'cancel' } });
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
          const deployConfig = opts.contract.deploy;
          currentDeployApproval = {
            id: `deploy-${TASK_ID}`,
            taskId: TASK_ID,
            runId: RUN_ID,
            goalExcerpt: opts.contract.goal.objective,
            acIds: opts.contract.acceptanceCriteria.map((a) => a.id),
            diffRef: gitOut(fx.wt, 'rev-parse', 'main').trim(),
            evidence: { gateReports: [evidence.put(JSON.stringify(gateReport))], worktreeHash: gateReport.worktreeHash },
            assumptions: ['network: none (simulation)'],
            unresolvedRisks: [],
            // Architect finding #7: L4 is the only risk class attesting recoverability/
            // rollback+backup — exactly what a deploy approver must attest.
            attestations: attestationsFor('L4'),
            riskClass: 'L4',
            createdAt: clock.now(),
          };
          audit({ event: 'deploy_package_created', taskId: TASK_ID, approvalId: currentDeployApproval.id });

          // REQ-6: deploy decision shares the task approval's timeout knob.
          const deployTimeoutMs = opts.approval?.timeoutMs ?? 30 * 60_000;
          const deployDecision = await waitForDeployDecision(deployTimeoutMs);
          if (deployDecision === 'timeout' || deployDecision === 'killed') {
            // No HTTP call happened, so (unlike approve/reject, recorded by api.ts) the
            // timeout/kill event + audit is composition's own job (mirrors escalateTask above).
            log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'DEPLOY_DECISION', payload: { approvalId: currentDeployApproval.id, decision: deployDecision } });
            audit({ event: 'deploy_decision', taskId: TASK_ID, decision: deployDecision });
          }
          currentDeployApproval = null;

          if (deployDecision === 'approve') {
            // No production wait exists anywhere in core yet (task 2 finding) — real here,
            // tests just configure small interval_ms/expandedWindowMs.
            const deployClock: DeployClock = { now: () => clock.now(), wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
            deployDeps = { runId: RUN_ID, taskId: TASK_ID, config: deployConfig, executor, log, evidence, clock: deployClock };
            const deployOutcome = await runDeployStage(deployDeps);
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
              log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'DEPLOY_WINDOW_CLOSED', payload: {} });
            }
          }
        }
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
            taskId: TASK_ID,
          });
        }
      }
      return { finalState, iterations: result.iterations, calibration, ...calibrationExtras(log) };
    } finally {
      await server.close();
    }
  } finally {
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
