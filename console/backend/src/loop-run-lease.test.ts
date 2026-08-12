import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeAdapter } from 'aal';
import { openEventLog, type TaskContract } from 'core';

import { syntheticLoopSandbox } from '../test/helpers/synthetic-loop-sandbox.ts';
import { runSupervisedLoop } from './loop-run.ts';

const clock = { now: () => 1_000_000 };
// Explicit test-only synthetic golden seam; operational callers pass operator bytes.
const runSyntheticLoop = (opts: Parameters<typeof runSupervisedLoop>[0]) =>
  runSupervisedLoop({
    ...opts,
    syntheticGoldenFixtureForTests: true,
    syntheticSandboxForTests: syntheticLoopSandbox,
  });
const CONTRACT: TaskContract = {
  hash: 'a'.repeat(64),
  goal: { id: 'LEASE-1', title: 'lease', objective: 'validate lease' },
  acceptanceCriteria: [{ id: 'AC-1', description: 'fixture', golden: true }],
  budget: {
    maxIterations: 2,
    maxCostUnits: 20,
    maxWallclockMs: 10_000,
    maxHypothesesPerFailure: 1,
    maxTotalTasks: 1,
    maxParallelAgents: 1,
  },
  risk: 'L1',
  approvalPolicy: [],
  raw: {},
};

test('P0-06: invalid TTL refuses the run before adapter/lease/task events', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-lease-invalid-'));
  let adapterBuilt = false;
  try {
    const out = await runSyntheticLoop({
      contract: CONTRACT,
      clock,
      persistDir,
      leaseTtlMs: 11_000,
      maxAtomicDurationMs: 10_000,
      adapterFactory: () => {
        adapterBuilt = true;
        return new FakeAdapter({ id: 'unexpected', putContent: () => 'unused' });
      },
    });
    assert.equal(out.finalState, 'ESCALATED');
    assert.equal(out.iterations, 0);
    assert.equal(adapterBuilt, false);
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'LEASE_CLAIMED' }).length, 0);
      assert.equal(log.all({ type: 'CLAIM_RECORDED' }).length, 0);
      assert.equal(log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'invalid_lease_ttl');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});
