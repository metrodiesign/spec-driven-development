// Loop-path tests for hypothesis-driven repair (REQ-5) + budget honesty (REQ-6.7).
// Drives the REAL runTaskLoop over the fixture with a stub ProposalSource that
// returns hypotheses on the diagnostician round — the exact Proposal.hypotheses
// contract the AAL fills in a live run. Probe-executing paths need the darwin
// sandbox (D-003); the REQ-6.7 path uses no probes and runs everywhere.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBudget } from '../src/budget/budget.ts';
import { createDefaultPathPolicy } from '../src/executor/path-policy.ts';
import { createEvidenceStore } from '../src/evidence/store.ts';
import { createExecutor } from '../src/executor/executor.ts';
import { createGateRunner } from '../src/gates/runner.ts';
import { openEventLog } from '../src/state/event-log.ts';
import { runTaskLoop } from '../src/orchestrator/loop.ts';
import type { Proposal, ProposalInput, ProposalSource } from '../src/ports.ts';
import type { BudgetLimits } from '../src/types.ts';
import {
  makeClock,
  makeFixture,
  makeIds,
  makeReportIntegrity,
  PASSTHROUGH_TEST_SANDBOX,
  makeTestLeaseSession,
  type Fixture,
} from './helpers/fixture.ts';

const RUN_ID = 'RUN-1';
const TASK_ID = 'T-1';
const logicOnly = { skip: false };

function build(fix: Fixture, limits: BudgetLimits) {
  const clock = makeClock();
  const log = openEventLog(fix.dbPath, clock);
  const evidence = createEvidenceStore(fix.evidenceDir);
  const executor = createExecutor({
    worktreeDir: fix.worktree,
    runId: RUN_ID,
    taskId: TASK_ID,
    log,
    evidence,
    policy: createDefaultPathPolicy(),
    sandbox: PASSTHROUGH_TEST_SANDBOX,
    clock,
  });
  const gates = createGateRunner({
    worktreeDir: fix.worktree,
    configPath: fix.gateConfigPath,
    runId: RUN_ID,
    taskId: TASK_ID,
    log,
    evidence,
    reportIntegrity: makeReportIntegrity(fix, evidence),
    clock,
    sandbox: PASSTHROUGH_TEST_SANDBOX,
  });
  const run = (source: ProposalSource, budget = createBudget(limits, clock)) =>
    runTaskLoop({
      runId: RUN_ID,
      taskId: TASK_ID,
      role: 'implementer',
      source,
      executor,
      gates,
      log,
      budget,
      clock,
      evidence,
      ids: makeIds(),
      lease: makeTestLeaseSession(TASK_ID),
    });
  return { log, evidence, run };
}

const LIMITS: BudgetLimits = { maxIterations: 8, maxCostUnits: 500, maxWallclockMs: 60_000 };

test('confirmed hypothesis -> REPAIRING, patch plan folded as marked feedback, reaches REVIEWING (REQ-5.4)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const c = build(fix, LIMITS);
    const seen: ProposalInput[] = [];
    const source: ProposalSource = {
      async propose(input): Promise<Proposal> {
        seen.push(input);
        if (input.role === 'diagnostician') {
          return {
            claim: 'WORKING',
            actions: [],
            hypotheses: [
              {
                statement: 'impl.txt still reads "wrong"',
                probes: [{ cmd: 'grep wrong src/impl.txt', expected: 'wrong' }],
                ifConfirmed: { patchPlan: 'write "correct" to src/impl.txt', estimatedBlastRadius: '1 file' },
              },
            ],
            costUnits: 1,
          };
        }
        if (input.state === 'REPAIRING') {
          return {
            claim: 'READY_FOR_VERIFICATION',
            actions: [{ type: 'WRITE_FILE', actionId: 'fix', path: 'src/impl.txt', contentRef: c.evidence.put('correct\n') }],
            costUnits: 1,
          };
        }
        // First implementer round: claim done, change nothing -> gate fails.
        return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
      },
    };
    const result = await c.run(source);

    assert.equal(result.finalState, 'REVIEWING', 'the confirmed fix passed the gates');
    assert.equal(readFileSync(join(fix.worktree, 'src/impl.txt'), 'utf8'), 'correct\n');
    const states = c.log.all({ type: 'TASK_STATE' }).map((e) => String(e.payload['state']));
    assert.ok(states.includes('DIAGNOSING') && states.includes('REPAIRING'), 'went through the diagnose/repair path');
    assert.equal(c.log.all({ type: 'HYPOTHESIS_CONFIRMED' }).length, 1);

    const repairRound = seen.find((i) => i.state === 'REPAIRING' && i.role === 'implementer');
    assert.ok(repairRound, 'an implementer round ran from REPAIRING');
    const fb = repairRound?.feedback;
    assert.ok(fb && !Array.isArray(fb) && 'kind' in fb && fb.kind === 'patch_plan', 'patch plan folded as marked feedback (REQ-5.4)');
  } finally {
    fix.cleanup();
  }
});

test('all hypotheses refuted -> ESCALATED hypotheses_exhausted with an ordered, dump-free log (REQ-5.6)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const c = build(fix, LIMITS);
    const source: ProposalSource = {
      async propose(input): Promise<Proposal> {
        if (input.role === 'diagnostician') {
          return {
            claim: 'WORKING',
            actions: [],
            hypotheses: [
              {
                statement: 'a wrong guess',
                probes: [{ cmd: 'true', expected: 'THIS-NEVER-APPEARS' }],
                ifConfirmed: { patchPlan: 'noop', estimatedBlastRadius: 'none' },
              },
            ],
            costUnits: 1,
          };
        }
        return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
      },
    };
    const result = await c.run(source);

    assert.equal(result.finalState, 'ESCALATED');
    assert.equal(c.log.all({ type: 'HYPOTHESIS_REFUTED' }).length, 1, 'refuted hypothesis persisted');
    const esc = c.log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(esc?.payload['why'], 'hypotheses_exhausted');
    const hlog = esc?.payload['hypotheses'] as { statement: string; verdict: string; probeRefs: string[] }[];
    assert.equal(hlog.length, 1);
    assert.equal(hlog[0]?.verdict, 'refuted');
    assert.equal(hlog[0]?.statement, 'a wrong guess');
    assert.ok(Array.isArray(hlog[0]?.probeRefs) && hlog[0].probeRefs.every((r) => r.startsWith('blob://')), 'carries evidence refs, not a raw dump');
  } finally {
    fix.cleanup();
  }
});

test('REQ-6.7: charging a round to exactly zero escalates budget_exhausted before the next request', async () => {
  const fix = makeFixture();
  try {
    const c = build(fix, { maxIterations: 8, maxCostUnits: 5, maxWallclockMs: 60_000 });
    let proposeCalls = 0;
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        proposeCalls += 1;
        return { claim: 'WORKING', actions: [], costUnits: 5 }; // spends the whole budget in one round
      },
    };
    const result = await c.run(source);

    assert.equal(result.finalState, 'ESCALATED');
    assert.equal(proposeCalls, 1, 'no further AgentRequest built once the budget is spent (REQ-6.7)');
    const esc = c.log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(esc?.payload['why'], 'budget_exhausted');
    assert.equal(c.log.all({ type: 'BUDGET_EXCEEDED' }).at(-1)?.payload['limit'], 'costUnits');
  } finally {
    fix.cleanup();
  }
});
