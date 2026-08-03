// Steering + operability over the REAL runTaskLoop (REQ-10, REQ-6.4-6.6). Pause is
// honored at the iteration boundary, guidance injected while paused folds into the
// next round as marked data, kill terminates cleanly, and the ACTIVE wallclock
// trips under a tickable clock (impossible under the old frozen nowMs).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBudget } from '../src/budget/budget.ts';
import { createLoopController } from '../src/orchestrator/control.ts';
import { createDefaultPathPolicy } from '../src/executor/path-policy.ts';
import { createEvidenceStore } from '../src/evidence/store.ts';
import { createExecutor } from '../src/executor/executor.ts';
import { createGateRunner } from '../src/gates/runner.ts';
import { openEventLog } from '../src/state/event-log.ts';
import { runTaskLoop, type LoopOptions } from '../src/orchestrator/loop.ts';
import type { LoopControl, Proposal, ProposalInput, ProposalSource } from '../src/ports.ts';
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

function build(fix: Fixture, limits: BudgetLimits, clock = makeClock()) {
  const log = openEventLog(fix.dbPath, clock);
  const evidence = createEvidenceStore(fix.evidenceDir);
  const budget = createBudget(limits, clock);
  const executor = createExecutor({
    worktreeDir: fix.worktree, runId: RUN_ID, taskId: TASK_ID, log, evidence,
    policy: createDefaultPathPolicy(), sandbox: PASSTHROUGH_TEST_SANDBOX, clock,
  });
  const gates = createGateRunner({
    worktreeDir: fix.worktree, configPath: fix.gateConfigPath, runId: RUN_ID, taskId: TASK_ID, log, evidence,
    reportIntegrity: makeReportIntegrity(fix, evidence), clock,
    sandbox: PASSTHROUGH_TEST_SANDBOX,
  });
  const run = (source: ProposalSource, extra?: Partial<LoopOptions>) =>
    runTaskLoop({
      runId: RUN_ID, taskId: TASK_ID, role: 'implementer', source, executor, gates,
      log, budget, clock, evidence, ids: makeIds(), ...extra,
      lease: extra?.lease ?? makeTestLeaseSession(TASK_ID),
    });
  return { log, evidence, clock, run };
}

test('pause at the boundary -> PAUSED{prePauseState}; guidance while paused folds into the resumed round; RESUMED{resumedTo} (REQ-10.2/10.3/10.5)', async () => {
  const fix = makeFixture();
  try {
    const c = build(fix, { maxIterations: 8, maxCostUnits: 500, maxWallclockMs: 60_000 });
    const seen: ProposalInput[] = [];
    const source: ProposalSource = {
      async propose(input): Promise<Proposal> {
        seen.push(input);
        return {
          claim: 'READY_FOR_VERIFICATION',
          actions: [{ type: 'WRITE_FILE', actionId: 'fix', path: 'src/impl.txt', contentRef: c.evidence.put('correct\n') }],
          costUnits: 1,
        };
      },
    };
    const controller = createLoopController();
    const guidance: string[] = [];
    controller.requestPause(); // pause requested before the first boundary
    const p = c.run(source, {
      control: controller.port,
      takeGuidance: () => guidance.splice(0),
    });
    // The loop is now parked at waitResume (PAUSED). Inject guidance, then resume.
    guidance.push('prefer the minimal edit');
    controller.requestResume();
    const result = await p;

    assert.equal(result.finalState, 'REVIEWING', 'resumed and finished the work');
    const pause = c.log.all({ type: 'PAUSE_REQUESTED' }).at(0);
    assert.equal(pause?.payload['prePauseState'], 'IMPLEMENTING', 'pre-pause state recorded in the event (REQ-10.2)');
    const resumed = c.log.all({ type: 'RESUMED' }).at(0);
    assert.equal(resumed?.payload['resumedTo'], 'IMPLEMENTING', 'resume restored the recorded state (REQ-10.3)');

    const fb = seen[0]?.feedback;
    assert.ok(fb && !Array.isArray(fb) && 'kind' in fb && fb.kind === 'guidance', 'guidance folded as marked feedback (REQ-10.5)');
    assert.match((fb as { guidance: string }).guidance, /minimal edit/);
  } finally {
    fix.cleanup();
  }
});

test('kill at the boundary terminates cleanly -> CANCELLED (REQ-10.7)', async () => {
  const fix = makeFixture();
  try {
    const c = build(fix, { maxIterations: 8, maxCostUnits: 500, maxWallclockMs: 60_000 });
    let calls = 0;
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        calls += 1;
        return { claim: 'WORKING', actions: [], costUnits: 0 };
      },
    };
    const controller = createLoopController();
    controller.requestKill();
    const result = await c.run(source, { control: controller.port });
    assert.equal(result.finalState, 'CANCELLED');
    assert.equal(calls, 0, 'killed at the boundary before any proposal');
  } finally {
    fix.cleanup();
  }
});

test('kill WHILE paused resolves the resume wait and terminates cleanly (REQ-10.7)', async () => {
  const fix = makeFixture();
  try {
    const c = build(fix, { maxIterations: 8, maxCostUnits: 500, maxWallclockMs: 60_000 });
    const source: ProposalSource = { async propose(): Promise<Proposal> { return { claim: 'WORKING', actions: [], costUnits: 0 }; } };
    const controller = createLoopController();
    controller.requestPause();
    const p = c.run(source, { control: controller.port });
    controller.requestKill(); // resolves waitResume with kill
    const result = await p;
    assert.equal(result.finalState, 'CANCELLED');
  } finally {
    fix.cleanup();
  }
});

test('ACTIVE wallclock trips under a tickable clock — the trip impossible under a frozen clock (REQ-6.4/6.5)', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const c = build(fix, { maxIterations: 100, maxCostUnits: 1000, maxWallclockMs: 100 }, clock);
    let calls = 0;
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        calls += 1;
        clock.tick(40); // each round of "real" work advances the wall clock
        if (calls === 1) {
          return {
            claim: 'WORKING',
            actions: [{
              type: 'WRITE_FILE',
              actionId: 'wallclock-seed',
              path: 'src/impl.txt',
              contentRef: c.evidence.put('correct\n'),
            }],
            costUnits: 0,
          };
        }
        return { claim: 'WORKING', actions: [], costUnits: 0 };
      },
    };
    const result = await c.run(source);
    assert.equal(result.finalState, 'ESCALATED');
    const esc = c.log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(esc?.payload['why'], 'budget:wallclock');
    assert.equal(c.log.all({ type: 'BUDGET_EXCEEDED' }).at(-1)?.payload['limit'], 'wallclock');
  } finally {
    fix.cleanup();
  }
});

// A no-op control that never signals — proves the added boundary poll is inert
// when the operator does nothing (unsteered runs are unchanged, append-only).
const inertControl: LoopControl = { poll: () => 'none', waitResume: () => Promise.resolve('resume') };
test('an idle control port changes nothing — the loop still reaches REVIEWING', async () => {
  const fix = makeFixture();
  try {
    const c = build(fix, { maxIterations: 8, maxCostUnits: 500, maxWallclockMs: 60_000 });
    const source: ProposalSource = {
      async propose(): Promise<Proposal> {
        return { claim: 'READY_FOR_VERIFICATION', actions: [{ type: 'WRITE_FILE', actionId: 'w', path: 'src/impl.txt', contentRef: c.evidence.put('correct\n') }], costUnits: 1 };
      },
    };
    const result = await c.run(source, { control: inertControl });
    assert.equal(result.finalState, 'REVIEWING');
  } finally {
    fix.cleanup();
  }
});
