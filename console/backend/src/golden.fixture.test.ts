import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeFixtureRepo, runSupervisedLoop } from './loop-run.ts';
import { FakeAdapter } from 'aal';
import { openEventLog, type TaskContract } from 'core';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('composition provisions exact operator golden bytes and reports provenance (REQ-8.3/8.11)', () => {
  const source = mkdtempSync(join(tmpdir(), 'operator-golden-source-'));
  const root = mkdtempSync(join(tmpdir(), 'operator-golden-run-'));
  const golden = join(source, 'test', 'golden');
  mkdirSync(golden, { recursive: true });
  const bytes = Buffer.from([0, 10, 255]);
  writeFileSync(join(golden, 'expected.bin'), bytes);
  writeFileSync(join(golden, '_MANIFEST.sha256'), `${sha256(bytes)}  expected.bin\n`);
  try {
    const fixture = makeFixtureRepo({ operatorGoldenFixtureDir: golden });
    try {
      assert.equal(fixture.goldenFixture?.attribution, 'operator-supplied');
      assert.match(fixture.goldenFixture?.sourceHash ?? '', /^[0-9a-f]{64}$/);
      assert.deepEqual(readFileSync(join(fixture.wt, 'test', 'golden', 'expected.bin')), bytes);
      assert.deepEqual(
        readFileSync(join(fixture.wt, 'test', 'golden', '_MANIFEST.sha256')),
        readFileSync(join(golden, '_MANIFEST.sha256')),
      );
    } finally {
      fixture.cleanup();
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('composition does not invent bytes when the operator fixture is absent (REQ-8.6)', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'operator-golden-missing-')), 'test', 'golden');
  assert.throws(
    () => makeFixtureRepo({ operatorGoldenFixtureDir: missing }),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'operator_golden_fixture_missing',
  );
});

test('operational composition defaults to a missing-fixture blocker (REQ-8.4/8.6)', async () => {
  const contract: TaskContract = {
    hash: 'e'.repeat(64),
    goal: { id: 'GOLDEN-BLOCK-DEFAULT', title: 'fixture', objective: 'fixture' },
    acceptanceCriteria: [{ id: 'AC-1', description: 'fixture', golden: true }],
    budget: { maxIterations: 1, maxCostUnits: 1, maxWallclockMs: 1_000, maxHypothesesPerFailure: 1, maxTotalTasks: 1, maxParallelAgents: 1 },
    risk: 'L2',
    approvalPolicy: [],
    raw: {},
  };
  await assert.rejects(
    () => runSupervisedLoop({
      contract,
      adapterFactory: (put) => new FakeAdapter({ id: 'fixture', putContent: put }),
      clock: { now: () => 1_000 },
    }),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'operator_golden_fixture_missing',
  );
});

test('production composition carries golden provenance into result and event evidence (REQ-8.11)', async () => {
  const source = mkdtempSync(join(tmpdir(), 'operator-golden-provenance-'));
  const persistDir = mkdtempSync(join(tmpdir(), 'operator-golden-evidence-'));
  const golden = join(source, 'test', 'golden');
  mkdirSync(golden, { recursive: true });
  const bytes = Buffer.from('operator bytes\n');
  writeFileSync(join(golden, 'expected.txt'), bytes);
  writeFileSync(join(golden, '_MANIFEST.sha256'), `${sha256(bytes)}  expected.txt\n`);
  const contract: TaskContract = {
    hash: 'd'.repeat(64),
    goal: { id: 'GOLDEN-PROVENANCE', title: 'fixture', objective: 'fixture' },
    acceptanceCriteria: [{ id: 'AC-1', description: 'fixture', golden: true }],
    budget: { maxIterations: 1, maxCostUnits: 1, maxWallclockMs: 1_000, maxHypothesesPerFailure: 1, maxTotalTasks: 1, maxParallelAgents: 1 },
    risk: 'L2',
    approvalPolicy: [],
    raw: {},
  };
  try {
    const out = await runSupervisedLoop({
      contract,
      adapterFactory: (put) => new FakeAdapter({ id: 'fixture', putContent: put }),
      clock: { now: () => 1_000 },
      persistDir,
      operatorGoldenFixtureDir: golden,
      requireOperatorGoldenFixture: true,
      // Stop before adapter/task work while still producing the authenticated
      // provenance record and its evidence reference.
      leaseTtlMs: 1_001,
      maxAtomicDurationMs: 1_000,
    });
    assert.equal(out.goldenFixture?.source, golden);
    assert.match(out.goldenFixture?.sourceHash ?? '', /^[0-9a-f]{64}$/);
    assert.match(out.goldenFixture?.manifestHash ?? '', /^[0-9a-f]{64}$/);
    assert.match(out.goldenFixture?.evidenceRef ?? '', /^blob:\/\//);
    const log = openEventLog(join(persistDir, 'events.db'), { now: () => 1_000 });
    try {
      const event = log.all({ type: 'GOLDEN_FIXTURE_PROVISIONED' })[0];
      assert.equal(event?.payload['source'], golden);
      assert.equal(event?.payload['evidenceRef'], out.goldenFixture?.evidenceRef);
    } finally {
      log.close();
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('operational loop explicitly blocks before creating a fixture when operator bytes are absent (REQ-8.6)', async () => {
  const contract: TaskContract = {
    hash: 'f'.repeat(64),
    goal: { id: 'GOLDEN-BLOCK', title: 'fixture', objective: 'fixture' },
    acceptanceCriteria: [{ id: 'AC-1', description: 'fixture', golden: true }],
    budget: { maxIterations: 1, maxCostUnits: 1, maxWallclockMs: 1_000, maxHypothesesPerFailure: 1, maxTotalTasks: 1, maxParallelAgents: 1 },
    risk: 'L2',
    approvalPolicy: [],
    raw: {},
  };
  await assert.rejects(
    () => runSupervisedLoop({
      contract,
      adapterFactory: (put) => new FakeAdapter({ id: 'fixture', putContent: put }),
      clock: { now: () => 1_000 },
      requireOperatorGoldenFixture: true,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'operator_golden_fixture_missing',
  );
});
