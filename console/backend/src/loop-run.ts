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
  createBudget,
  createDefaultPathPolicy,
  createEvidenceStore,
  createExecutor,
  createGateRunner,
  createHumanPlaneServer,
  createLoopController,
  denyNetworkSandbox,
  listPendingProposals,
  openEventLog,
  pendingQuarantines,
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
  type MappedAc,
  type PlatformEvent,
  type RiskClass,
  type Role,
  type TaskContract,
  type TaskState,
  type ToolHandler,
} from 'core';
import {
  breakerKey,
  createAALProposalSource,
  createBreaker,
  createRegistry,
  createRouter,
  DEFAULT_BREAKER_OPTIONS,
  PASS_FAIL_PROBES,
  shadowFrozen,
  shadowWouldChoose,
  type AdapterHealth,
  type AdapterInterface,
  type ConformanceRecord,
  type Registry,
  type RouteHints,
  type Router,
} from 'aal';

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
 * Per-adapter reviewing-reached stats (REQ-7.2), the cheapest outcome signal
 * that exists today: replay every prior SHADOW_ROUTE this log has recorded and
 * check whether ITS task ever reached REVIEWING. A task still in flight (the
 * common case for its own most-recent round) simply contributes 0 so far —
 * stats sharpen as a shared log accumulates across many tasks (e.g. the
 * calibration corpus), never from this round's own not-yet-known outcome.
 */
function computeShadowOutcomeStats(events: PlatformEvent[]): Record<string, { attempts: number; reviewingReached: number }> {
  const stats: Record<string, { attempts: number; reviewingReached: number }> = {};
  for (const e of events) {
    if (e.type !== 'SHADOW_ROUTE') continue;
    const live = e.payload['live'] as string;
    const s = (stats[live] ??= { attempts: 0, reviewingReached: 0 });
    s.attempts += 1;
    const reachedReviewing = events.some(
      (e2) => e2.type === 'TASK_STATE' && e2.taskId === e.taskId && e2.payload['state'] === 'REVIEWING',
    );
    if (reachedReviewing) s.reviewingReached += 1;
  }
  return stats;
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
        return { finalState: 'QUARANTINED', iterations: 0, calibration: computeCalibration({ heldOut: [false], reruns: [] }) };
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
    const source = createAALProposalSource({
      runId: 'RUN-LIVE',
      taskId: 'T-1',
      // Shadow routing (REQ-7): observes each round's live choice in shadow only,
      // never influences it (REQ-7.4).
      router: wrapRouterForShadow(createRouter(reg), { registry: reg, log, runId: 'RUN-LIVE', taskId: 'T-1' }),
      breaker,
      worktreeDir: fx.wt,
      taskContract: {
        goalId: opts.contract.goal.id,
        title: opts.contract.goal.title,
        objective: opts.contract.goal.objective,
        acceptanceCriteria: opts.contract.acceptanceCriteria.map((a) => ({ id: a.id, description: a.description })),
      },
      seedPaths: ['src/impl.txt'],
      evidence,
      log,
      ids: { requestId: () => `req-${randomUUID()}`, canary: () => `CANARY-${randomUUID()}` },
      outputSchema: { type: 'object', required: ['claim', 'actionRequests'], properties: { claim: { type: 'string', enum: ['WORKING', 'READY_FOR_VERIFICATION', 'BLOCKED'] }, actionRequests: { type: 'array' } } },
      maxRepairRounds: 2,
      budgetRemaining: () => budget.remaining(),
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
    const governance: Partial<HandlerDeps> = govLog === undefined ? {} : {
      governanceProposals: () => listPendingProposals(readGovernanceLog(govLog)),
      onGovernanceApprove: (id) => {
        const res = applyGovernanceApproval({ logPath: govLog, id, clock }, {
          fireQuarantine: (tid) => {
            const tr = transition(currentState(), 'quarantine');
            if (tr.ok) log.append({ runId: RUN_ID, taskId: tid, type: 'TASK_STATE', payload: { state: tr.next, trigger: 'quarantine' } });
          },
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
    let pendingDeployResolve: ((outcome: 'approve' | 'reject') => void) | null = null;
    let deployDeps: DeployStageDeps | null = null;
    let manualRollback: Promise<unknown> | null = null;
    const deployState = (): DeployState | null => {
      if (opts.contract.deploy === undefined) return null;
      const last = log.all({ type: 'DEPLOY_STATE' }).at(-1);
      if (last !== undefined) return last.payload['state'] as DeployState;
      return currentDeployApproval !== null ? 'PENDING_APPROVAL' : null;
    };
    const waitForDeployDecision = (timeoutMs: number): Promise<'approve' | 'reject' | 'timeout'> =>
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
          if (deployDecision === 'timeout') {
            // No HTTP call happened, so (unlike approve/reject, recorded by api.ts) the
            // timeout event + audit is composition's own job (mirrors escalateTask above).
            log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'DEPLOY_DECISION', payload: { approvalId: currentDeployApproval.id, decision: 'timeout' } });
            audit({ event: 'deploy_decision', taskId: TASK_ID, decision: 'timeout' });
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
              await deployClock.wait(expandedWindowMs);
              // A manual rollback triggered during the window must finish before the
              // server (and this run) tears down — REQ-6.12's "remain open" scope.
              await manualRollback;
              log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'DEPLOY_WINDOW_CLOSED', payload: {} });
            }
          }
        }
      }
      return { finalState, iterations: result.iterations, calibration };
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
