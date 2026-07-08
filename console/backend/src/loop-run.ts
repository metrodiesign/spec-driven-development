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
  runAutoMerge,
  runTaskLoop,
  transition,
  type CalibrationResult,
  type Clock,
  type HandlerDeps,
  type MappedAc,
  type RiskClass,
  type TaskContract,
  type TaskState,
  type ToolHandler,
} from 'core';
import {
  createAALProposalSource,
  createBreaker,
  createRegistry,
  createRouter,
  DEFAULT_BREAKER_OPTIONS,
  PASS_FAIL_PROBES,
  type AdapterHealth,
  type AdapterInterface,
  type ConformanceRecord,
} from 'aal';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Read the per-task risk class from the frozen contract; anything unrecognized → null (→ L2, REQ-7.6). */
function parseRisk(v: unknown): RiskClass | null {
  return v === 'L0' || v === 'L1' || v === 'L2' || v === 'L3' || v === 'L4' ? v : null;
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
   * still runs but a null/absent risk defaults to L2 → the approval-package path
   * (finalState stays REVIEWING), so existing single-task callers are unaffected.
   */
  autoMerge?: { auditSampleRate: number; depManifestPatterns: string[] };
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
      router: createRouter(reg),
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
    const onDecision: HandlerDeps['onDecision'] = (taskId, decision) => {
      const tr = transition(currentState(), decision === 'approve' ? 'human_approved' : 'changes_requested');
      if (!tr.ok) return { ok: false, detail: tr.reason };
      log.append({ runId: RUN_ID, taskId, type: 'TASK_STATE', payload: { state: tr.next, trigger: decision } });
      audit({ event: 'approval', taskId, decision, state: tr.next });
      return { ok: true, state: tr.next };
    };
    const onInject: HandlerDeps['onInject'] = (guidance) => {
      const evidenceRef = evidence.put(guidance);
      log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'GUIDANCE_INJECTED', payload: { evidenceRef } });
      guidanceQueue.push(guidance);
      audit({ event: 'steer_inject', taskId: TASK_ID, evidenceRef });
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
    const server = await createHumanPlaneServer({
      runDir: stateDir,
      deps: {
        runId: RUN_ID,
        approvals: new Map(),
        log,
        onDecision,
        onKill: () => {
          audit({ event: 'kill' });
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
        ...governance,
      },
    });
    try {
      const result = await runTaskLoop({
        runId: 'RUN-LIVE',
        taskId: 'T-1',
        role: 'implementer',
        source,
        executor: createExecutor({
          worktreeDir: fx.wt,
          runId: 'RUN-LIVE',
          taskId: 'T-1',
          log,
          evidence,
          policy: createDefaultPathPolicy(),
          sandbox: denyNetworkSandbox(process.platform),
          clock,
          ...(opts.toolHandlers !== undefined ? { toolHandlers: opts.toolHandlers } : {}),
        }),
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
      // dep-touching → approval package (state unchanged) so single-task callers that
      // pass no risk keep the Phase-1 REVIEWING terminal.
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
          originalReport: result.lastGateReport,
          gateConfigRelPath: 'gate-ladder.json',
          auditSampleRate: opts.autoMerge?.auditSampleRate ?? 0,
          log,
          evidence,
          clock,
        });
        finalState = merge.finalState;
      }
      return { finalState, iterations: result.iterations, calibration };
    } finally {
      await server.close();
    }
  } finally {
    log.close();
    fx.cleanup();
  }
}
