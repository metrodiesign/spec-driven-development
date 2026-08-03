import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBudget } from '../budget/budget.ts';
import { createEvidenceStore, type EvidenceStore } from '../evidence/store.ts';
import type { Executor } from '../executor/executor.ts';
import type { GateRunner } from '../gates/runner.ts';
import { openEventLog, type EventLog } from '../state/event-log.ts';
import { acquireTaskLease, createLeaseManager, type TaskLeaseSession } from '../state/lease.ts';
import { runTaskLoop } from './loop.ts';
import type { Proposal, ProposalInput, ProposalSource } from '../ports.ts';
import type { BudgetLimits, Clock, GateReport, GateTier } from '../types.ts';

const RUN_ID = 'RUN-P0-05';
const TASK_ID = 'TASK-P0-05';
const LIMITS: BudgetLimits = { maxIterations: 12, maxCostUnits: 100, maxWallclockMs: 60_000 };

function makeClock(): Clock {
  return { now: () => 1_000_000 };
}

function report(tier: GateTier, pass: boolean, worktreeHash = 'tree-a'): GateReport {
  return {
    tier,
    pass,
    gateConfigHash: 'config-a',
    commitHash: 'commit-a',
    worktreeHash,
    envHash: 'env-a',
    checks: [],
    scopeNote: 'test',
  };
}

function makeEventLog(): { log: EventLog; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'p0-05-loop-'));
  const clock = makeClock();
  const log = openEventLog(join(root, 'events.db'), clock);
  return { log, cleanup: () => { log.close(); rmSync(root, { recursive: true, force: true }); } };
}

function makeExecutor(evidence: EvidenceStore): Executor {
  return {
    async execute(action) {
      const outputRef = action.type === 'RUN_COMMAND' ? evidence.put('confirmed') : undefined;
      return { status: 'applied', actionId: action.actionId, resultHash: 'result-a', ...(outputRef ? { outputRef, exitCode: 0 } : {}) };
    },
  };
}

function makeGates(sequence: GateReport[]): { gates: GateRunner; calls: GateTier[]; verified: GateTier[] } {
  const calls: GateTier[] = [];
  const verified: GateTier[] = [];
  let index = 0;
  const gates: GateRunner = {
    async run(tier) {
      calls.push(tier);
      const next = sequence[index++];
      assert.ok(next, `unexpected gate call ${tier}`);
      assert.equal(next.tier, tier);
      return next;
    },
    verify(gateReport) {
      verified.push(gateReport.tier);
      return gateReport;
    },
  };
  return { gates, calls, verified };
}

async function runLoop(
  source: ProposalSource,
  gates: GateRunner,
  log: EventLog,
  evidence?: EvidenceStore,
  executor?: Executor,
  lease?: TaskLeaseSession,
) {
  const clock = makeClock();
  return runTaskLoop({
    runId: RUN_ID,
    taskId: TASK_ID,
    role: 'implementer',
    source,
    executor: executor ?? makeExecutor(evidence ?? createEvidenceStore(mkdtempSync(join(tmpdir(), 'p0-05-evidence-')))),
    gates,
    log,
    budget: createBudget(LIMITS, clock),
    clock,
    ...(evidence ? { evidence } : {}),
    ...(evidence ? { ids: { next: (prefix: string) => `${prefix}-1` } } : {}),
    lease: lease ?? {
      claim: { taskId: TASK_ID, ownerId: 'unit-owner', fencingToken: 1, leaseUntil: Number.MAX_SAFE_INTEGER },
      heartbeat: async () => true,
      verifyOwnership: () => true,
      reacquireAfterPause: async () => true,
      startHeartbeat: () => {},
      stopHeartbeat: () => {},
      release: () => {},
      ownershipLost: false,
    },
  });
}

test('P0-05: T0 runs once after every WORKING/BLOCKED action batch, including zero actions', async () => {
  const { log, cleanup } = makeEventLog();
  try {
    const gate = makeGates([report('T0', true), report('T0', true)]);
    let calls = 0;
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        calls += 1;
        return calls === 1
          ? { claim: 'WORKING', actions: [], costUnits: 1 }
          : { claim: 'BLOCKED', actions: [], costUnits: 1 };
      },
    };

    const result = await runLoop(source, gate.gates, log);

    assert.equal(result.finalState, 'BLOCKED');
    assert.deepEqual(gate.calls, ['T0', 'T0']);
    assert.deepEqual(gate.verified, ['T0', 'T0']);
  } finally {
    cleanup();
  }
});

test('P0-07: invalid proposal usage escalates before action/gate and preserves prior cost', async () => {
  const { log, cleanup } = makeEventLog();
  try {
    const clock = makeClock();
    const budget = createBudget({ maxIterations: 10, maxCostUnits: 100, maxWallclockMs: 60_000 }, clock);
    let actions = 0;
    let gates = 0;
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        return { claim: 'WORKING', actions: [], costUnits: Number.NaN };
      },
    };
    const result = await runTaskLoop({
      runId: RUN_ID,
      taskId: TASK_ID,
      role: 'implementer',
      source,
      executor: { async execute() { actions += 1; return { status: 'applied', actionId: 'never', resultHash: 'never' }; } },
      gates: { async run() { gates += 1; return report('T0', true); }, verify: (r) => r },
      log,
      budget,
      clock,
      lease: {
        claim: { taskId: TASK_ID, ownerId: 'unit-owner', fencingToken: 1, leaseUntil: Number.MAX_SAFE_INTEGER },
        heartbeat: async () => true,
        verifyOwnership: () => true,
        reacquireAfterPause: async () => true,
        startHeartbeat: () => {},
        stopHeartbeat: () => {},
        release: () => {},
        ownershipLost: false,
      },
    });
    assert.equal(result.finalState, 'ESCALATED');
    assert.equal(actions, 0);
    assert.equal(gates, 0);
    assert.equal(budget.remaining(), 100);
    const escalation = log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(escalation?.payload['why'], 'invalid_response');
  } finally {
    cleanup();
  }
});

test('P0-07: normal loop exact-zero cost backstop emits BUDGET_EXCEEDED before legacy escalation', async () => {
  const { log, cleanup } = makeEventLog();
  try {
    const clock = makeClock();
    const budget = createBudget({ maxIterations: 10, maxCostUnits: 0, maxWallclockMs: 60_000 }, clock);
    let proposals = 0;
    const result = await runTaskLoop({
      runId: RUN_ID,
      taskId: TASK_ID,
      role: 'implementer',
      source: {
        async propose(): Promise<Proposal> {
          proposals += 1;
          return { claim: 'WORKING', actions: [], costUnits: 0 };
        },
      },
      executor: { async execute() { throw new Error('proposal must not reach executor'); } },
      gates: { async run() { throw new Error('proposal must not reach gates'); }, verify: (r) => r },
      log,
      budget,
      clock,
      lease: {
        claim: { taskId: TASK_ID, ownerId: 'unit-owner', fencingToken: 1, leaseUntil: Number.MAX_SAFE_INTEGER },
        heartbeat: async () => true,
        verifyOwnership: () => true,
        reacquireAfterPause: async () => true,
        startHeartbeat: () => {},
        stopHeartbeat: () => {},
        release: () => {},
        ownershipLost: false,
      },
    });

    assert.equal(result.finalState, 'ESCALATED');
    assert.equal(proposals, 0, 'the normal loop does not request a proposal with no cost remaining');
    const events = log.all();
    const budgetEvent = events.find((event) => event.type === 'BUDGET_EXCEEDED');
    const escalationIndex = events.findIndex((event) => event.type === 'ESCALATED');
    const budgetIndex = events.findIndex((event) => event.type === 'BUDGET_EXCEEDED');
    assert.equal(budgetEvent?.payload['limit'], 'costUnits');
    assert.ok(budgetIndex >= 0 && escalationIndex > budgetIndex, 'budget event precedes escalation');
    assert.equal(events[escalationIndex]?.payload['why'], 'budget_exhausted');
  } finally {
    cleanup();
  }
});

test('P0-05: READY runs T1 exactly once only after the same-artifact passing T0', async () => {
  const { log, cleanup } = makeEventLog();
  try {
    const gate = makeGates([report('T0', true, 'same-tree'), report('T1', true, 'same-tree')]);
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
      },
    };

    const result = await runLoop(source, gate.gates, log);

    assert.equal(result.finalState, 'REVIEWING');
    assert.deepEqual(gate.calls, ['T0', 'T1']);
    assert.deepEqual(gate.verified, ['T0', 'T1']);
  } finally {
    cleanup();
  }
});

test('P0-05: READY rejects a passing T1 report bound to a different artifact', async () => {
  const { log, cleanup } = makeEventLog();
  try {
    const gate = makeGates([report('T0', true, 'tree-a'), report('T1', true, 'tree-b')]);
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
      },
    };

    const result = await runLoop(source, gate.gates, log);

    assert.equal(result.finalState, 'ESCALATED');
    assert.deepEqual(gate.calls, ['T0', 'T1']);
    assert.deepEqual(gate.verified, ['T0', 'T1']);
    const escalated = log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(escalated?.payload['why'], 'artifact_identity_mismatch');
    assert.equal(escalated?.payload['boundary'], 'state_advancement');
    const states = log.all({ type: 'TASK_STATE' }).map((event) => event.payload['state']);
    assert.equal(states.includes('REVIEWING'), false);
    assert.equal(states.includes('PASSED'), false);
  } finally {
    cleanup();
  }
});

test('P0-05: a fail-then-pass/flaky T1 report remains a failure and enters diagnosis', async () => {
  const { log, cleanup } = makeEventLog();
  try {
    const gate = makeGates([
      report('T0', true, 'same-tree'),
      {
        ...report('T1', false, 'same-tree'),
        checks: [{
          name: 'fullTests',
          pass: false,
          flakySuspect: true,
          evidenceRef: 'blob://flaky',
          detail: 'fail-then-pass on one retry',
        }],
      },
    ]);
    let calls = 0;
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        calls += 1;
        return calls === 1
          ? { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 }
          : { claim: 'WORKING', actions: [], hypotheses: [], costUnits: 1 };
      },
    };

    const result = await runLoop(source, gate.gates, log);

    assert.equal(result.finalState, 'ESCALATED');
    assert.deepEqual(gate.calls, ['T0', 'T1']);
    assert.equal(log.all({ type: 'TASK_STATE' }).some((event) => event.payload['state'] === 'REVIEWING'), false);
  } finally {
    cleanup();
  }
});

test('P0-05: a T0 failure enters deterministic diagnosis and never runs T1', async () => {
  const { log, cleanup } = makeEventLog();
  try {
    const gate = makeGates([report('T0', false)]);
    const roles: string[] = [];
    let proposals = 0;
    const source: ProposalSource = {
      async propose(input: ProposalInput): Promise<Proposal> {
        roles.push(input.role);
        proposals += 1;
        return proposals === 1
          ? { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 }
          : { claim: 'WORKING', actions: [], hypotheses: [], costUnits: 1 };
      },
    };

    const result = await runLoop(source, gate.gates, log);

    assert.equal(result.finalState, 'ESCALATED');
    assert.deepEqual(gate.calls, ['T0']);
    assert.deepEqual(roles, ['implementer', 'diagnostician']);
    assert.ok(log.all({ type: 'TASK_STATE' }).some((event) => event.payload['state'] === 'FAILED'));
  } finally {
    cleanup();
  }
});

test('P0-05: diagnostician/probe rounds do not add T0 calls; repair gets one T0 before T1', async () => {
  const { log, cleanup } = makeEventLog();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'p0-05-evidence-'));
  try {
    const evidence = createEvidenceStore(evidenceRoot);
    const gate = makeGates([
      report('T0', false, 'tree-before'),
      report('T0', true, 'tree-after'),
      report('T1', true, 'tree-after'),
    ]);
    const roles: string[] = [];
    let implementerRounds = 0;
    const source: ProposalSource = {
      async propose(input: ProposalInput): Promise<Proposal> {
        roles.push(input.role);
        if (input.role === 'diagnostician') {
          return {
            claim: 'WORKING',
            actions: [],
            hypotheses: [{
              statement: 'known repair',
              probes: [{ cmd: 'printf confirmed', expected: 'confirmed' }],
              ifConfirmed: { patchPlan: 'apply repair', estimatedBlastRadius: 'one file' },
            }],
            costUnits: 1,
          };
        }
        implementerRounds += 1;
        return implementerRounds === 1
          ? { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 }
          : { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
      },
    };

    const result = await runLoop(source, gate.gates, log, evidence, makeExecutor(evidence));

    assert.equal(result.finalState, 'REVIEWING');
    assert.deepEqual(gate.calls, ['T0', 'T0', 'T1']);
    assert.deepEqual(roles, ['implementer', 'diagnostician', 'implementer']);
    assert.equal(log.all({ type: 'PROBE_RUN' }).length, 1);
  } finally {
    cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('P0-06: two loops sharing one database leave the losing loop non-executing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p0-06-two-loop-'));
  const dbPath = join(root, 'events.db');
  const clock = { now: (() => { const t = 1_000_000; return () => t; })() };
  const managerA = createLeaseManager(dbPath, clock, 'RUN-A');
  const managerB = createLeaseManager(dbPath, clock, 'RUN-B');
  const logA = openEventLog(dbPath, clock);
  const logB = openEventLog(dbPath, clock);
  let releaseProposal!: () => void;
  const proposalReady = new Promise<void>((resolve) => { releaseProposal = resolve; });
  try {
    const owner = acquireTaskLease(managerA, TASK_ID, 'owner-a', 60_000);
    assert.ok(owner);
    const winner = runTaskLoop({
      runId: RUN_ID,
      taskId: TASK_ID,
      role: 'implementer',
      source: { async propose() { await proposalReady; return { claim: 'BLOCKED', actions: [], costUnits: 1 }; } },
      executor: makeExecutor(createEvidenceStore(mkdtempSync(join(tmpdir(), 'p0-06-evidence-')))),
      gates: makeGates([report('T0', true)]).gates,
      log: logA,
      budget: createBudget(LIMITS, clock),
      clock,
      lease: owner,
    });
    let loserProposals = 0;
    let loserActions = 0;
    let loserGates = 0;
    const loser = runTaskLoop({
      runId: 'RUN-B',
      taskId: TASK_ID,
      role: 'implementer',
      source: { async propose() { loserProposals += 1; return { claim: 'BLOCKED', actions: [], costUnits: 1 }; } },
      executor: { async execute() { loserActions += 1; return { status: 'applied', actionId: 'loser', resultHash: 'never' }; } },
      gates: { async run() { loserGates += 1; return report('T0', true); }, verify: (r) => r },
      log: logB,
      budget: createBudget(LIMITS, clock),
      clock,
      lease: {
        claim: { taskId: TASK_ID, ownerId: 'owner-b', fencingToken: 2, leaseUntil: Number.MAX_SAFE_INTEGER },
        heartbeat: async () => false,
        verifyOwnership: () => false,
        reacquireAfterPause: async () => false,
        startHeartbeat: () => {},
        stopHeartbeat: () => {},
        release: () => {},
        ownershipLost: true,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const loserLease = acquireTaskLease(managerB, TASK_ID, 'owner-b', 60_000);
    assert.equal(loserLease, null, 'the live owner wins CAS');
    // A contender must not even call the proposal source, let alone emit core events.
    releaseProposal();
    const result = await winner;
    const loserResult = await loser;
    assert.equal(result.finalState, 'BLOCKED');
    assert.equal(logB.all({ type: 'CLAIM_RECORDED' }).length, 1, 'only the winning loop emitted a claim');
    assert.equal(logB.all({ type: 'ACTION_APPLIED' }).length, 0);
    assert.equal(logB.all({ type: 'GATE_RESULT' }).length, 0);
    assert.equal(loserResult.finalState, 'ESCALATED');
    assert.equal(loserProposals, 0, 'loser never requests a proposal');
    assert.equal(loserActions, 0, 'loser never executes an action');
    assert.equal(loserGates, 0, 'loser never starts a gate');
    assert.equal(logB.all().filter((e) => e.runId === 'RUN-B' && ['CLAIM_RECORDED', 'ACTION_INTENT', 'ACTION_APPLIED', 'GATE_RESULT'].includes(e.type)).length, 0);
    owner.release();
  } finally {
    managerA.close();
    managerB.close();
    logA.close();
    logB.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-06: ownership loss during an async proposal stops T0 and fences the old token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p0-06-loss-'));
  const dbPath = join(root, 'events.db');
  let now = 1_000_000;
  const clock = { now: () => now };
  const oldManager = createLeaseManager(dbPath, clock, 'RUN-A');
  const newManager = createLeaseManager(dbPath, clock, 'RUN-B');
  const log = openEventLog(dbPath, clock);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  try {
    const session = acquireTaskLease(oldManager, TASK_ID, 'owner-a', 1_000, 60_000);
    assert.ok(session);
    const gates = makeGates([report('T0', true)]);
    const pending = runTaskLoop({
      runId: RUN_ID,
      taskId: TASK_ID,
      role: 'implementer',
      source: { async propose() { await waiting; return { claim: 'BLOCKED', actions: [], costUnits: 1 }; } },
      executor: makeExecutor(createEvidenceStore(mkdtempSync(join(tmpdir(), 'p0-06-loss-evidence-')))),
      gates: gates.gates,
      log,
      budget: createBudget(LIMITS, clock),
      clock,
      lease: session,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    now += 1_001;
    const replacement = newManager.claimLease(TASK_ID, 'owner-b', 60_000);
    assert.ok(replacement);
    release();
    const result = await pending;
    assert.equal(result.finalState, 'ESCALATED');
    assert.deepEqual(gates.calls, [], 'no gate starts after fenced ownership is lost');
    assert.equal(oldManager.verify(TASK_ID, 'owner-a', session.claim.fencingToken), false);
    assert.equal(newManager.verify(TASK_ID, 'owner-b', replacement.fencingToken), true, 'stale release cannot clear replacement');
  } finally {
    oldManager.close();
    newManager.close();
    log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-06: pause past TTL reacquires a new fencing generation before the next proposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p0-06-pause-'));
  const dbPath = join(root, 'events.db');
  let now = 1_000_000;
  const clock = { now: () => now };
  const manager = createLeaseManager(dbPath, clock, 'RUN');
  const log = openEventLog(dbPath, clock);
  const controller = (await import('./control.ts')).createLoopController();
  let rounds = 0;
  try {
    const session = acquireTaskLease(manager, TASK_ID, 'owner', 1_000, 60_000);
    assert.ok(session);
    const gate = makeGates([report('T0', true), report('T0', true)]);
    const pending = runTaskLoop({
      runId: RUN_ID,
      taskId: TASK_ID,
      role: 'implementer',
      source: {
        async propose() {
          rounds += 1;
          if (rounds === 1) {
            controller.requestPause();
            return { claim: 'WORKING', actions: [], costUnits: 1 };
          }
          return { claim: 'BLOCKED', actions: [], costUnits: 1 };
        },
      },
      executor: makeExecutor(createEvidenceStore(mkdtempSync(join(tmpdir(), 'p0-06-pause-evidence-')))),
      gates: gate.gates,
      log,
      budget: createBudget(LIMITS, clock),
      clock,
      control: controller.port,
      lease: session,
    });
    for (let i = 0; i < 100 && log.all({ type: 'PAUSE_REQUESTED' }).length === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(log.all({ type: 'PAUSE_REQUESTED' }).length, 1);
    now += 1_001;
    controller.requestResume();
    const result = await pending;
    assert.equal(result.finalState, 'BLOCKED');
    assert.deepEqual(gate.calls, ['T0', 'T0']);
    assert.equal(log.all({ type: 'LEASE_CLAIMED' }).length, 2, 'resume reacquires after expiry');
  } finally {
    manager.close();
    log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-06: proposal error releases the terminal lease so a replacement owner can reclaim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p0-06-error-release-'));
  const dbPath = join(root, 'events.db');
  const clock = makeClock();
  const ownerManager = createLeaseManager(dbPath, clock, 'RUN-A');
  const replacementManager = createLeaseManager(dbPath, clock, 'RUN-B');
  const log = openEventLog(dbPath, clock);
  const session = acquireTaskLease(ownerManager, TASK_ID, 'owner-a', 60_000);
  assert.ok(session);
  try {
    await assert.rejects(
      runTaskLoop({
        runId: 'RUN-A', taskId: TASK_ID, role: 'implementer',
        source: { async propose() { throw new Error('proposal exploded'); } },
        executor: makeExecutor(createEvidenceStore(mkdtempSync(join(tmpdir(), 'p0-06-error-evidence-')))),
        gates: makeGates([]).gates,
        log,
        budget: createBudget(LIMITS, clock),
        clock,
        lease: session,
      }),
      /proposal exploded/,
    );
    assert.ok(replacementManager.claimLease(TASK_ID, 'owner-b', 60_000), 'terminal error released the old lease');
  } finally {
    ownerManager.close();
    replacementManager.close();
    log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-06: executor error releases the terminal lease so a replacement owner can reclaim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p0-06-executor-error-'));
  const dbPath = join(root, 'events.db');
  const clock = makeClock();
  const ownerManager = createLeaseManager(dbPath, clock, 'RUN-A');
  const replacementManager = createLeaseManager(dbPath, clock, 'RUN-B');
  const log = openEventLog(dbPath, clock);
  const session = acquireTaskLease(ownerManager, TASK_ID, 'owner-a', 60_000);
  assert.ok(session);
  try {
    await assert.rejects(runTaskLoop({
      runId: 'RUN-A', taskId: TASK_ID, role: 'implementer',
      source: { async propose() { return { claim: 'WORKING', actions: [{ type: 'WRITE_FILE', actionId: 'boom', path: 'src/x', contentRef: 'missing' }], costUnits: 1 }; } },
      executor: { async execute() { throw new Error('executor exploded'); } },
      gates: makeGates([]).gates,
      log, budget: createBudget(LIMITS, clock), clock, lease: session,
    }), /executor exploded/);
    assert.ok(replacementManager.claimLease(TASK_ID, 'owner-b', 60_000));
  } finally {
    ownerManager.close(); replacementManager.close(); log.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('P0-06: gate error releases the terminal lease so a replacement owner can reclaim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p0-06-gate-error-'));
  const dbPath = join(root, 'events.db');
  const clock = makeClock();
  const ownerManager = createLeaseManager(dbPath, clock, 'RUN-A');
  const replacementManager = createLeaseManager(dbPath, clock, 'RUN-B');
  const log = openEventLog(dbPath, clock);
  const session = acquireTaskLease(ownerManager, TASK_ID, 'owner-a', 60_000);
  assert.ok(session);
  try {
    const result = await runTaskLoop({
      runId: 'RUN-A', taskId: TASK_ID, role: 'implementer',
      source: { async propose() { return { claim: 'BLOCKED', actions: [], costUnits: 1 }; } },
      executor: makeExecutor(createEvidenceStore(mkdtempSync(join(tmpdir(), 'p0-06-gate-error-evidence-')))),
      gates: { async run() { throw new Error('gate exploded'); }, verify: (r) => r },
      log, budget: createBudget(LIMITS, clock), clock, lease: session,
    });
    assert.equal(result.finalState, 'ESCALATED');
    assert.ok(replacementManager.claimLease(TASK_ID, 'owner-b', 60_000));
  } finally {
    ownerManager.close(); replacementManager.close(); log.close(); rmSync(root, { recursive: true, force: true });
  }
});
