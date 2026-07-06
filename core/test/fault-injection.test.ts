// Fault-injection suite — the Phase 0 DoD (unified-platform-spec.md §14, 9 scenarios).
// Written RED-FIRST (spec §0.4): these tests define what the core must catch
// BEFORE the core exists. Never weaken a scenario to make it pass (INV-16).
//
// Scenarios 3, 4 and 6 exercise RUN_COMMAND under the deny-network sandbox, which
// Phase 0 implements on darwin only (docs/DEVIATIONS.md D-003 — CI pinned to a
// darwin runner). On other hosts those paths assert the fail-closed refusal instead.

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBudget } from '../src/budget/budget.ts';
import { createDefaultPathPolicy } from '../src/executor/path-policy.ts';
import { createEvidenceStore } from '../src/evidence/store.ts';
import { createExecutor, CrashInjected, recoverWorktree } from '../src/executor/executor.ts';
import { createGateRunner } from '../src/gates/runner.ts';
import { createLeaseManager } from '../src/state/lease.ts';
import { denyNetworkSandbox } from '../src/security/sandbox.ts';
import { openEventLog } from '../src/state/event-log.ts';
import { runTaskLoop } from '../src/orchestrator/loop.ts';
import type { Failpoints } from '../src/executor/executor.ts';
import type { Proposal, ProposalSource } from '../src/ports.ts';
import type { Action, BudgetLimits } from '../src/types.ts';
import { makeClock, makeFixture, installFlakyTests, type Fixture } from './helpers/fixture.ts';

const isDarwin = process.platform === 'darwin';

const RUN_ID = 'RUN-1';
const TASK_ID = 'T-1';

const DEFAULT_LIMITS: BudgetLimits = {
  maxIterations: 8,
  maxCostUnits: 500,
  maxWallclockMs: 60_000,
};

function buildCore(fix: Fixture, clock = makeClock(), failpoints?: Failpoints) {
  const log = openEventLog(fix.dbPath, clock);
  const evidence = createEvidenceStore(fix.evidenceDir);
  const policy = createDefaultPathPolicy();
  const sandbox = denyNetworkSandbox(process.platform);
  const executor = createExecutor({
    worktreeDir: fix.worktree,
    runId: RUN_ID,
    taskId: TASK_ID,
    log,
    evidence,
    policy,
    sandbox,
    clock,
    ...(failpoints ? { failpoints } : {}),
  });
  const gates = createGateRunner({
    worktreeDir: fix.worktree,
    configPath: fix.gateConfigPath,
    runId: RUN_ID,
    taskId: TASK_ID,
    log,
    evidence,
    clock,
  });
  return { log, evidence, policy, sandbox, executor, gates, clock };
}

function taskStates(log: ReturnType<typeof openEventLog>): string[] {
  return log.all({ type: 'TASK_STATE' }).map((e) => String(e.payload['state']));
}

// ---------------------------------------------------------------------------
// DoD#1 — the agent lies about success: core runs the gates itself and refuses
// to believe the claim (REQ-7.2, REQ-7.3; INV-1/2).
// ---------------------------------------------------------------------------
test('DoD#1: lying READY_FOR_VERIFICATION claim never produces PASSED', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const c = buildCore(fix, clock);
    let proposeCalls = 0;
    const liar: ProposalSource = {
      async propose(): Promise<Proposal> {
        proposeCalls += 1;
        // Claims done, changes nothing — target tests genuinely fail.
        return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
      },
    };
    const budget = createBudget({ ...DEFAULT_LIMITS, maxIterations: 2 }, clock);
    const result = await runTaskLoop({
      runId: RUN_ID,
      taskId: TASK_ID,
      role: 'implementer',
      source: liar,
      executor: c.executor,
      gates: c.gates,
      log: c.log,
      budget,
      clock,
    });

    // The claim is recorded as data...
    assert.ok(c.log.all({ type: 'CLAIM_RECORDED' }).length >= 1, 'claim recorded as data');
    // ...but a core-run gate decided the outcome.
    const gateEvents = c.log.all({ type: 'GATE_RESULT' });
    assert.ok(gateEvents.length >= 1, 'core ran gates itself');
    // The lie never became progress:
    const states = taskStates(c.log);
    assert.ok(!states.includes('PASSED'), 'never PASSED on a lie');
    assert.ok(!states.includes('REVIEWING'), 'never reached REVIEWING on a lie');
    assert.ok(!states.includes('COMPLETED'), 'never COMPLETED (INV-2)');
    assert.ok(states.includes('FAILED'), 'core-run gate produced FAILED');
    assert.equal(result.finalState, 'ESCALATED', 'repeated lying exhausts budget -> ESCALATED');
    assert.equal(proposeCalls, 2, 'loop halted at the iteration budget');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#2 — actions outside the allowlist / touching golden are rejected as
// structured feedback, not applied, and never crash the loop (REQ-1.2/1.3/1.5).
// ---------------------------------------------------------------------------
test('DoD#2: out-of-policy actions are rejected as structured feedback', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const contentRef = c.evidence.put('malicious content\n');

    const escape: Action = {
      type: 'WRITE_FILE',
      actionId: 'a-escape',
      path: '../outside.txt',
      contentRef,
    };
    const out1 = await c.executor.execute(escape, 'implementer');
    assert.equal(out1.status, 'rejected');
    if (out1.status === 'rejected') {
      assert.equal(out1.rejection.reason, 'path_outside_allowlist');
    }
    assert.ok(!existsSync(join(fix.root, 'outside.txt')), 'escape file was not written');

    const goldenWrite: Action = {
      type: 'WRITE_FILE',
      actionId: 'a-golden',
      path: 'test/golden/expected.txt',
      contentRef,
    };
    const out2 = await c.executor.execute(goldenWrite, 'implementer');
    assert.equal(out2.status, 'rejected');
    if (out2.status === 'rejected') {
      assert.equal(out2.rejection.reason, 'golden_write_denied');
    }
    assert.equal(
      readFileSync(join(fix.worktree, 'test/golden/expected.txt'), 'utf8'),
      'golden truth\n',
      'golden content untouched',
    );

    const plannerWrite: Action = {
      type: 'WRITE_FILE',
      actionId: 'a-planner',
      path: 'src/impl.txt',
      contentRef,
    };
    const out3 = await c.executor.execute(plannerWrite, 'planner');
    assert.equal(out3.status, 'rejected', 'planner is read-only');

    assert.equal(c.log.all({ type: 'ACTION_REJECTED' }).length, 3, 'every rejection logged');
    assert.equal(c.log.all({ type: 'ACTION_APPLIED' }).length, 0, 'nothing applied');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#3 — a command that sneaks toward the network is blocked at connect and
// the block is logged with core-captured evidence (REQ-2.1/2.2); hosts without
// an enforcing sandbox refuse to run at all (REQ-2.3, fail-closed).
// ---------------------------------------------------------------------------
test('DoD#3: egress attempt under network:"none" is blocked (or refused fail-closed)', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const action: Action = {
      type: 'RUN_COMMAND',
      actionId: 'a-egress',
      cmd: 'curl -sS --max-time 4 https://example.com/ >/dev/null',
      network: 'none',
    };
    const out = await c.executor.execute(action, 'implementer');

    if (isDarwin) {
      assert.equal(out.status, 'applied', 'command ran (inside the sandbox)');
      if (out.status === 'applied') {
        assert.notEqual(out.exitCode, 0, 'network attempt failed at connect');
        assert.equal(out.egressBlocked, true, 'egress_blocked marker present');
        assert.ok(out.outputRef, 'command output captured as evidence');
        assert.ok(c.evidence.has(out.outputRef as string), 'evidence blob stored');
      }
      const applied = c.log.all({ type: 'ACTION_APPLIED' });
      assert.ok(
        applied.some((e) => e.payload['egressBlocked'] === true),
        'egress block visible in the event log',
      );
    } else {
      assert.equal(out.status, 'rejected', 'no enforcing sandbox -> refuse to run');
      if (out.status === 'rejected') {
        assert.equal(out.rejection.reason, 'sandbox_unavailable');
      }
    }
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#4 — fake-green via golden tampering: tests made to pass but the golden
// manifest no longer matches -> gate fails with golden_manifest_mismatch
// (REQ-9.2; scope note REQ-9.3).
// ---------------------------------------------------------------------------
test('DoD#4: golden tampering is caught by the manifest check at T1', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);

    // Make the target tests legitimately pass first...
    const fixRef = c.evidence.put('correct\n');
    const legit: Action = {
      type: 'WRITE_FILE',
      actionId: 'a-fix',
      path: 'src/impl.txt',
      contentRef: fixRef,
    };
    const outLegit = await c.executor.execute(legit, 'implementer');
    assert.equal(outLegit.status, 'applied');

    // ...then tamper with golden. On darwin the tamper goes through a real
    // RUN_COMMAND (the executor cannot fs-block a shell); elsewhere we simulate
    // the same side effect directly — detection is the gate's job either way.
    if (isDarwin) {
      const tamper: Action = {
        type: 'RUN_COMMAND',
        actionId: 'a-tamper',
        cmd: 'echo tampered >> test/golden/expected.txt',
        network: 'none',
      };
      const outTamper = await c.executor.execute(tamper, 'implementer');
      assert.equal(outTamper.status, 'applied');
    } else {
      appendFileSync(join(fix.worktree, 'test/golden/expected.txt'), 'tampered\n');
    }

    const report = await c.gates.run('T1');
    assert.equal(report.pass, false, 'T1 fails on tampered golden');
    const goldenCheck = report.checks.find((ch) => ch.name === 'golden');
    assert.ok(goldenCheck, 'golden check present in T1');
    assert.equal(goldenCheck?.pass, false, 'golden check failed');
    const gateEvents = c.log.all({ type: 'GATE_RESULT' });
    assert.ok(
      gateEvents.some((e) => JSON.stringify(e.payload).includes('golden_manifest_mismatch')),
      'mismatch reason recorded',
    );
    assert.ok(report.gateConfigHash.length > 0, 'gate config hash bound into report');
    assert.ok(report.scopeNote.length > 0, 'DoD#4 scope note present (REQ-9.3)');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#5 — flaky test: fail-then-pass on retry is flagged flaky_suspect for a
// human; never silently passed, never auto-quarantined (REQ-8.5, INV-16).
// ---------------------------------------------------------------------------
test('DoD#5: flaky test -> retry-and-flag, no silent pass, no auto-quarantine', async () => {
  const fix = makeFixture();
  try {
    installFlakyTests(fix);
    const c = buildCore(fix);
    const report = await c.gates.run('T1');

    const fullTests = report.checks.find((ch) => ch.name === 'fullTests');
    assert.ok(fullTests, 'fullTests check present');
    assert.equal(fullTests?.flakySuspect, true, 'flagged flaky_suspect');
    assert.equal(report.pass, false, 'flaky result does not silently pass');
    assert.equal(
      c.log.all({ type: 'GOVERNANCE_CHANGE' }).length,
      0,
      'no auto-quarantine (governance untouched — INV-16)',
    );
    const gateEvents = c.log.all({ type: 'GATE_RESULT' });
    assert.ok(
      gateEvents.some((e) => JSON.stringify(e.payload).includes('flaky')),
      'flaky flag visible for a human in the event log',
    );
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#6 — crash between INTENT and APPLIED: recovery is rollback-then-rerun and
// even a NON-IDEMPOTENT command's effect appears exactly once (REQ-6.1/6.2).
// ---------------------------------------------------------------------------
test('DoD#6: crash after apply, before APPLIED event -> recovery yields exactly-once', {
  skip: !isDarwin ? 'RUN_COMMAND requires the darwin sandbox (D-003)' : false,
}, async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const crashing = buildCore(fix, clock, { crashAfterApply: true });
    const append: Action = {
      type: 'RUN_COMMAND',
      actionId: 'a-append',
      cmd: 'echo line >> src/notes.txt',
      network: 'none',
    };
    await assert.rejects(
      crashing.executor.execute(append, 'implementer'),
      CrashInjected,
      'crash injected after apply',
    );
    assert.equal(crashing.log.all({ type: 'ACTION_INTENT' }).length, 1, 'INTENT recorded');
    assert.equal(crashing.log.all({ type: 'ACTION_APPLIED' }).length, 0, 'no APPLIED yet');

    // Fresh process after the crash: recover, then verify exactly-once.
    const recovered = buildCore(fix, clock);
    const report = await recoverWorktree({
      worktreeDir: fix.worktree,
      runId: RUN_ID,
      taskId: TASK_ID,
      log: recovered.log,
      evidence: recovered.evidence,
      policy: recovered.policy,
      sandbox: recovered.sandbox,
      clock,
    });
    assert.equal(report.action, 'replayed_intent');
    const notes = readFileSync(join(fix.worktree, 'src/notes.txt'), 'utf8');
    assert.equal(notes, 'line\n', 'non-idempotent effect appears EXACTLY once');
    assert.equal(recovered.log.all({ type: 'ACTION_APPLIED' }).length, 1, 'APPLIED reconciled');
  } finally {
    fix.cleanup();
  }
});

test('DoD#6b: crash after INTENT, before apply -> recovery applies exactly once', {
  skip: !isDarwin ? 'RUN_COMMAND requires the darwin sandbox (D-003)' : false,
}, async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const crashing = buildCore(fix, clock, { crashAfterIntent: true });
    const append: Action = {
      type: 'RUN_COMMAND',
      actionId: 'a-append2',
      cmd: 'echo line >> src/notes.txt',
      network: 'none',
    };
    await assert.rejects(crashing.executor.execute(append, 'implementer'), CrashInjected);
    assert.ok(!existsSync(join(fix.worktree, 'src/notes.txt')), 'nothing applied before crash');

    const recovered = buildCore(fix, clock);
    await recoverWorktree({
      worktreeDir: fix.worktree,
      runId: RUN_ID,
      taskId: TASK_ID,
      log: recovered.log,
      evidence: recovered.evidence,
      policy: recovered.policy,
      sandbox: recovered.sandbox,
      clock,
    });
    const notes = readFileSync(join(fix.worktree, 'src/notes.txt'), 'utf8');
    assert.equal(notes, 'line\n', 'effect appears exactly once after recovery');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#7 — duplicate actionId is an idempotent skip (REQ-6.3).
// ---------------------------------------------------------------------------
test('DoD#7: duplicate actionId -> idempotent skip, applied exactly once', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const ref = c.evidence.put('hello\n');
    const action: Action = {
      type: 'WRITE_FILE',
      actionId: 'a-dup',
      path: 'src/hello.txt',
      contentRef: ref,
    };
    const first = await c.executor.execute(action, 'implementer');
    assert.equal(first.status, 'applied');
    const second = await c.executor.execute(action, 'implementer');
    assert.equal(second.status, 'skipped_duplicate');
    assert.equal(readFileSync(join(fix.worktree, 'src/hello.txt'), 'utf8'), 'hello\n');

    const appliedEvents = c.log
      .all({ type: 'ACTION_APPLIED' })
      .filter((e) => e.payload['actionId'] === 'a-dup');
    assert.equal(
      appliedEvents.filter((e) => e.payload['duplicate'] !== true).length,
      1,
      'exactly one real application',
    );
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#8 — lease contention: CAS admits exactly one writer; the loser executes
// nothing; expiry (TTL) frees the lease (REQ-5.1/5.2/5.3).
// ---------------------------------------------------------------------------
test('DoD#8: two claimants, one lease — single writer enforced by CAS', () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const a = createLeaseManager(fix.dbPath, clock, 'RUN-A');
    const b = createLeaseManager(fix.dbPath, clock, 'RUN-B');

    assert.equal(a.claim(TASK_ID, 'owner-a', 60_000), true, 'first claim wins');
    assert.equal(b.claim(TASK_ID, 'owner-b', 60_000), false, 'second claim denied (CAS=0 rows)');

    let claimed = log.all({ type: 'LEASE_CLAIMED' });
    assert.equal(claimed.length, 1, 'exactly one LEASE_CLAIMED event');
    assert.equal(claimed[0]?.payload['ownerId'], 'owner-a');

    clock.tick(61_000); // past TTL without renewal
    assert.equal(b.claim(TASK_ID, 'owner-b', 60_000), true, 'expired lease claimable');
    claimed = log.all({ type: 'LEASE_CLAIMED' });
    assert.equal(claimed.length, 2, 'second claim logged after expiry');

    a.close();
    b.close();
    log.close();
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#9 — budget exhaustion halts the loop provably: ESCALATED, no further
// proposals (REQ-10.1/10.2).
// ---------------------------------------------------------------------------
test('DoD#9: exceeding the iteration budget -> BUDGET_EXCEEDED + ESCALATED, loop halts', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const c = buildCore(fix, clock);
    let proposeCalls = 0;
    const spinner: ProposalSource = {
      async propose(): Promise<Proposal> {
        proposeCalls += 1;
        return { claim: 'WORKING', actions: [], costUnits: 10 };
      },
    };
    const budget = createBudget({ ...DEFAULT_LIMITS, maxIterations: 3 }, clock);
    const result = await runTaskLoop({
      runId: RUN_ID,
      taskId: TASK_ID,
      role: 'implementer',
      source: spinner,
      executor: c.executor,
      gates: c.gates,
      log: c.log,
      budget,
      clock,
    });

    assert.equal(result.finalState, 'ESCALATED');
    assert.equal(proposeCalls, 3, 'not one proposal past the budget');
    assert.ok(c.log.all({ type: 'BUDGET_EXCEEDED' }).length >= 1, 'BUDGET_EXCEEDED logged');
    assert.ok(taskStates(c.log).includes('ESCALATED'), 'ESCALATED transition logged');
  } finally {
    fix.cleanup();
  }
});
