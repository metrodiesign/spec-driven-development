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
  computeCalibration,
  createBudget,
  createDefaultPathPolicy,
  createEvidenceStore,
  createExecutor,
  createGateRunner,
  denyNetworkSandbox,
  openEventLog,
  runTaskLoop,
  type CalibrationResult,
  type TaskContract,
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
  nowMs: number;
  /** Keep events.db + evidence here (a live run's record, REQ-11.4/4.5) — default is inside the throwaway fixture root. */
  persistDir?: string;
}): Promise<LoopRunResult> {
  const fx = makeFixtureRepo();
  const clock = { now: () => opts.nowMs };
  const stateDir = opts.persistDir ?? fx.root; // fixture root is rm'd in finally; persistDir survives
  const log = openEventLog(join(stateDir, 'events.db'), clock);
  const evidence = createEvidenceStore(join(stateDir, 'evidence'));
  try {
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
      }),
      gates: createGateRunner({ worktreeDir: fx.wt, configPath: fx.gateConfigPath, runId: 'RUN-LIVE', taskId: 'T-1', log, evidence, clock }),
      log,
      budget,
      clock,
      // Repair engine deps: a DIAGNOSING round runs its probes through the executor
      // and reads their output from the evidence store (REQ-5).
      evidence,
      ids: { next: (prefix) => `${prefix}-${randomUUID()}` },
    });
    // Held-out (golden) verification passed iff the loop reached REVIEWING.
    const heldOut = result.finalState === 'REVIEWING';
    const calibration = computeCalibration({ heldOut: [heldOut], reruns: heldOut ? [true] : [] });
    return { finalState: result.finalState, iterations: result.iterations, calibration };
  } finally {
    log.close();
    fx.cleanup();
  }
}
