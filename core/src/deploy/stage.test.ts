// Deploy stage engine (REQ-5) — Loop 5 canary -> observe -> expand | rollback.
// Fault-injection fixtures force every path via inline exit-code shell commands
// (RUN_COMMAND already runs through `/bin/sh -c`, so `exit 0`/`exit 1` is enough —
// no script files needed). Needs the darwin deny-network sandbox (D-003), same as
// every other RUN_COMMAND-driving suite (fault-injection.test.ts, auto-merge.ts's
// gate re-runs are the one exception since those use /bin/sh directly).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDefaultPathPolicy } from '../executor/path-policy.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import { createExecutor } from '../executor/executor.ts';
import { openEventLog } from '../state/event-log.ts';
import { LeaseFenceError } from '../state/event-log.ts';
import { runDeployStage, type DeployClock, type DeployStageDeps } from './stage.ts';
import type { TaskContract } from '../contract/contract.ts';
import {
  makeFixture,
  PASSTHROUGH_TEST_SANDBOX,
  type Fixture,
} from '../../test/helpers/fixture.ts';

const logicOnly = { skip: false };

const RUN_ID = 'RUN-1';
const TASK_ID = 'T-1';

type DeployConfig = NonNullable<TaskContract['deploy']>;

/** Instant-resolving deploy clock — `wait` advances simulated time without a real delay. */
function makeDeployClock(startMs = 1_000_000): DeployClock & { tick(ms: number): void } {
  let t = startMs;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
    wait: async (ms: number) => {
      t += ms;
    },
  };
}

function baseConfig(observeOverrides?: Partial<DeployConfig['observe']>): DeployConfig {
  return {
    canaryCmd: 'exit 0',
    observeCmd: 'exit 0',
    expandCmd: 'exit 0',
    rollbackCmd: 'exit 0',
    observe: { probes: 3, failureThreshold: 1, intervalMs: 1000, ...observeOverrides },
  };
}

function buildDeps(fix: Fixture, config: DeployConfig, clock = makeDeployClock()): DeployStageDeps {
  const log = openEventLog(fix.dbPath, clock);
  const evidence = createEvidenceStore(fix.evidenceDir);
  const policy = createDefaultPathPolicy();
  const sandbox = PASSTHROUGH_TEST_SANDBOX;
  const executor = createExecutor({
    worktreeDir: fix.worktree,
    runId: RUN_ID,
    taskId: TASK_ID,
    log,
    evidence,
    policy,
    sandbox,
    clock,
  });
  return {
    runId: RUN_ID,
    taskId: TASK_ID,
    config,
    executor,
    log,
    evidence,
    clock,
    verifyApprovalEvidence: () => {},
  };
}

function stateSequence(deps: DeployStageDeps): string[] {
  return deps.log.all({ type: 'DEPLOY_STATE' }).map((e) => String(e.payload['state']));
}

test('happy path: canary ok, all probes pass, expand ok -> EXPANDED (REQ-5.6)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const deps = buildDeps(fix, baseConfig());
    const out = await runDeployStage(deps);

    assert.equal(out.finalState, 'EXPANDED');
    assert.equal(out.rootCause, undefined);
    assert.equal(out.probeResults.length, 3);
    assert.ok(out.probeResults.every((p) => p.pass));
    assert.deepEqual(stateSequence(deps), ['CANARY', 'OBSERVING', 'EXPANDED']);

    // Every deploy command ran network:'none' (REQ-5.2).
    const intents = deps.log
      .all({ type: 'ACTION_INTENT' })
      .filter((e) => String(e.payload['actionId']).startsWith('deploy-'));
    assert.equal(intents.length, 5, 'canary + 3 probes + expand');
    for (const e of intents) {
      assert.equal((e.payload['action'] as { network: string }).network, 'none');
    }
    // Every DEPLOY_STATE event is labeled a simulation (REQ-5.8).
    assert.ok(deps.log.all({ type: 'DEPLOY_STATE' }).every((e) => e.payload['simulation'] === true));
  } finally {
    fix.cleanup();
  }
});

test('P0-04 H2: deploy stage re-authenticates approval before the first CANARY command', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const deps = buildDeps(fix, baseConfig());
    let executorCalls = 0;
    deps.executor = {
      async execute() {
        executorCalls += 1;
        throw new Error('executor must remain unreachable');
      },
    };
    deps.verifyApprovalEvidence = () => {
      throw Object.assign(new Error('deploy report no longer matches main'), {
        reason: 'evidence_auth_mismatch',
        code: 'artifact_identity_mismatch',
      });
    };

    const out = await runDeployStage(deps);

    assert.equal(out.finalState, 'ESCALATED');
    assert.equal(executorCalls, 0);
    assert.deepEqual(stateSequence(deps), ['ESCALATED']);
    const escalation = deps.log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(escalation?.payload['boundary'], 'deploy_stage');
    assert.equal(escalation?.payload['code'], 'artifact_identity_mismatch');
  } finally {
    fix.cleanup();
  }
});

test('P0-06: lease loss before a deploy state transition publishes no stale DEPLOY_STATE', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const deps = buildDeps(fix, baseConfig());
    deps.assertOwnership = (boundary) => {
      if (boundary === 'deploy_state:OBSERVING:canary_ok') throw new LeaseFenceError('lease lost');
    };
    await assert.rejects(runDeployStage(deps), LeaseFenceError);
    assert.deepEqual(stateSequence(deps), ['CANARY'], 'the stale OBSERVING event was fenced');
  } finally {
    fix.cleanup();
  }
});

test('probes are spaced interval_ms apart via the injected clock (REQ-5.3)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const clock = makeDeployClock();
    const deps = buildDeps(fix, baseConfig({ probes: 4, intervalMs: 500 }), clock);
    const before = clock.now();
    await runDeployStage(deps);
    assert.equal(clock.now() - before, 3 * 500, '4 probes -> 3 gaps of intervalMs, none before the first');
  } finally {
    fix.cleanup();
  }
});

test('canary fails -> rollback WITHOUT running observe probes -> ROLLED_BACK (REQ-5.7)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const deps = buildDeps(fix, { ...baseConfig(), canaryCmd: 'exit 1' });
    const out = await runDeployStage(deps);

    assert.equal(out.finalState, 'ROLLED_BACK');
    assert.equal(out.probeResults.length, 0, 'observe never ran');
    assert.equal(out.rootCause?.trigger, 'canary_failed');
    assert.equal(out.rootCause?.failedProbes, 0);
    assert.deepEqual(stateSequence(deps), ['CANARY', 'ROLLING_BACK', 'ROLLED_BACK']);
    assert.equal(deps.log.all({ type: 'PROBE_RUN' }).length, 0);
  } finally {
    fix.cleanup();
  }
});

test('observe failures exceed threshold -> rollback ok -> ROLLED_BACK with root cause (REQ-5.4)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    // 3 probes, threshold 1: every probe fails -> 3 > 1 -> rollback.
    const deps = buildDeps(fix, { ...baseConfig(), observeCmd: 'exit 1' });
    const out = await runDeployStage(deps);

    assert.equal(out.finalState, 'ROLLED_BACK');
    assert.equal(out.probeResults.length, 3);
    assert.ok(out.probeResults.every((p) => !p.pass));
    assert.equal(out.rootCause?.trigger, 'observe_failed');
    assert.equal(out.rootCause?.failedProbes, 3);
    assert.equal(out.rootCause?.refs.length, 4, '3 failed-probe refs + the rollback command ref');
    assert.deepEqual(stateSequence(deps), ['CANARY', 'OBSERVING', 'ROLLING_BACK', 'ROLLED_BACK']);
    assert.equal(deps.log.all({ type: 'PROBE_RUN' }).length, 3);
  } finally {
    fix.cleanup();
  }
});

test('rollback itself fails -> ESCALATED(rollback_failed), no retry (REQ-5.5)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const deps = buildDeps(fix, { ...baseConfig(), observeCmd: 'exit 1', rollbackCmd: 'exit 1' });
    const out = await runDeployStage(deps);

    assert.equal(out.finalState, 'ESCALATED');
    assert.equal(out.rootCause?.trigger, 'rollback_failed');
    const rollbackIntents = deps.log
      .all({ type: 'ACTION_INTENT' })
      .filter((e) => e.payload['actionId'] === 'deploy-rollback');
    assert.equal(rollbackIntents.length, 1, 'rollback ran exactly once — no retry loop');
    assert.deepEqual(stateSequence(deps), ['CANARY', 'OBSERVING', 'ROLLING_BACK', 'ESCALATED']);
  } finally {
    fix.cleanup();
  }
});

test('expand fails after a healthy canary+observe -> rollback path, root cause expand_failed (REQ-5.6)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const deps = buildDeps(fix, { ...baseConfig(), expandCmd: 'exit 1' });
    const out = await runDeployStage(deps);

    assert.equal(out.finalState, 'ROLLED_BACK');
    assert.equal(out.probeResults.length, 3);
    assert.ok(out.probeResults.every((p) => p.pass), 'observe was healthy — expand is what failed');
    assert.equal(out.rootCause?.trigger, 'expand_failed');
    assert.equal(out.rootCause?.failedProbes, 0);
    assert.deepEqual(stateSequence(deps), ['CANARY', 'OBSERVING', 'ROLLING_BACK', 'ROLLED_BACK']);
  } finally {
    fix.cleanup();
  }
});

test('a failure count within threshold still expands (REQ-5.6 boundary, not >=)', logicOnly, async () => {
  const fix = makeFixture();
  try {
    const deps = buildDeps(fix, baseConfig());
    deps.executor = {
      async execute(action) {
        const exitCode = action.actionId === 'deploy-observe-1' ? 1 : 0;
        return {
          status: 'applied',
          actionId: action.actionId,
          resultHash: 'stage-threshold-fixture',
          exitCode,
          outputRef: deps.evidence.put(`exit:${exitCode}`),
        };
      },
    };
    const out = await runDeployStage(deps);

    assert.equal(out.finalState, 'EXPANDED', '1 failure <= threshold 1 -> still expands');
    assert.equal(out.probeResults.filter((p) => !p.pass).length, 1);
  } finally {
    fix.cleanup();
  }
});
