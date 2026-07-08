// Merge queue (REQ-13). The pure decision/labeling behavior is proven directly
// against a real fixture git — same style as auto-merge.test.ts (gate re-runs
// use /bin/sh, no darwin-only sandbox involved).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { createGateRunner } from '../gates/runner.ts';
import { createLeaseManager, type LeaseManager } from '../state/lease.ts';
import { openEventLog, type EventLog } from '../state/event-log.ts';
import { createMergeQueue, type MergeCandidate } from './queue.ts';
import type { GateReport } from '../types.ts';
import { git, makeClock, makeFixture, type Fixture } from '../../test/helpers/fixture.ts';

const RUN_ID = 'RUN-1';
const MAIN = 'main';

const FAKE_ORIGINAL_REPORT: GateReport = {
  tier: 'T1',
  pass: true,
  gateConfigHash: 'x',
  commitHash: 'x',
  worktreeHash: 'x',
  envHash: 'x',
  checks: [],
  scopeNote: 'x',
};

function candidate(taskId: string, taskBranch: string): MergeCandidate {
  return { taskId, taskBranch, approvalBasis: 'auto_approved', originalReport: FAKE_ORIGINAL_REPORT };
}

function setupTaskBranch(fix: Fixture, branch: string, files: Record<string, string>): void {
  git(fix.worktree, 'checkout', '-q', MAIN);
  git(fix.worktree, 'checkout', '-q', '-b', branch);
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(fix.worktree, rel), content);
  git(fix.worktree, 'add', '-A');
  git(fix.worktree, 'commit', '-q', '-m', `${branch} work`);
}

/** Real T2 config committed to main BEFORE the integration worktree is created off it. */
function setT2(fix: Fixture, t2: Record<string, unknown>): void {
  git(fix.worktree, 'checkout', '-q', MAIN);
  const ladder = JSON.parse(readFileSync(fix.gateConfigPath, 'utf8')) as Record<string, unknown>;
  ladder['t2'] = t2;
  writeFileSync(fix.gateConfigPath, JSON.stringify(ladder));
  git(fix.worktree, 'add', '-A');
  git(fix.worktree, 'commit', '-q', '-m', 'set t2 config');
}

function setupIntegrationWorktree(fix: Fixture): string {
  const dir = join(fix.root, 'integration');
  git(fix.worktree, 'worktree', 'add', '--detach', dir, MAIN);
  return dir;
}

function queueFor(
  fix: Fixture,
  integrationDir: string,
  log: EventLog,
  lease: LeaseManager,
  clock: ReturnType<typeof makeClock>,
  taskId: string,
) {
  const gates = createGateRunner({
    worktreeDir: integrationDir,
    configPath: join(integrationDir, 'gate-ladder.json'),
    runId: RUN_ID,
    taskId,
    log,
    evidence: createEvidenceStore(fix.evidenceDir),
    clock,
  });
  return createMergeQueue({
    runId: RUN_ID,
    repoDir: fix.worktree,
    mainBranch: MAIN,
    worktreeDir: integrationDir,
    gates,
    log,
    lease,
  });
}

test('T2 not_enabled ({status}) -> merges, advances main, labels MERGE_RESULT tier t1_only (REQ-13.2/13.3/13.9)', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const integrationDir = setupIntegrationWorktree(fix);
    setupTaskBranch(fix, 'task/A', { 'src/feature.txt': 'ship\n' });

    const result = await queueFor(fix, integrationDir, log, lease, clock, 'A').process(candidate('A', 'task/A'));

    assert.equal(result.outcome, 'merged');
    assert.ok(result.mergeCommit);
    assert.equal(result.t2Report?.pass, 'not_enabled');
    assert.equal(git(fix.worktree, 'rev-parse', MAIN).trim(), result.mergeCommit, 'main advanced to the merge commit');
    const mr = log.all({ type: 'MERGE_RESULT' }).at(-1);
    assert.equal(mr?.payload['outcome'], 'merged');
    assert.equal(mr?.payload['tier'], 't1_only');
  } finally {
    fix.cleanup();
  }
});

test('T2 real config that passes -> merges, labels MERGE_RESULT tier t2 (REQ-13.2/13.3)', async () => {
  const fix = makeFixture();
  try {
    setT2(fix, { build: 'true' });
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const integrationDir = setupIntegrationWorktree(fix);
    setupTaskBranch(fix, 'task/A', { 'src/feature.txt': 'ship\n' });

    const result = await queueFor(fix, integrationDir, log, lease, clock, 'A').process(candidate('A', 'task/A'));

    assert.equal(result.outcome, 'merged');
    assert.equal(result.t2Report?.pass, true);
    assert.equal(git(fix.worktree, 'rev-parse', MAIN).trim(), result.mergeCommit);
    assert.equal(log.all({ type: 'MERGE_RESULT' }).at(-1)?.payload['tier'], 't2');
  } finally {
    fix.cleanup();
  }
});

test('T2 real config that fails -> rejected_t2, main untouched (REQ-13.4)', async () => {
  const fix = makeFixture();
  try {
    setT2(fix, { secretScan: 'false' });
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const integrationDir = setupIntegrationWorktree(fix);
    setupTaskBranch(fix, 'task/A', { 'src/feature.txt': 'ship\n' });
    const mainTipBefore = git(fix.worktree, 'rev-parse', MAIN).trim();

    const result = await queueFor(fix, integrationDir, log, lease, clock, 'A').process(candidate('A', 'task/A'));

    assert.equal(result.outcome, 'rejected_t2');
    assert.equal(result.mergeCommit, null);
    assert.equal(result.t2Report?.pass, false);
    assert.equal(git(fix.worktree, 'rev-parse', MAIN).trim(), mainTipBefore, 'T2 failure never advances main');
    const mr = log.all({ type: 'MERGE_RESULT' }).at(-1);
    assert.equal(mr?.payload['outcome'], 'rejected_t2');
    assert.equal(mr?.payload['tier'], 't2');
  } finally {
    fix.cleanup();
  }
});

test('merge conflict -> merge_conflict, main untouched; next candidate still gets a clean reset (REQ-13.5, REQ-13.10)', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const integrationDir = setupIntegrationWorktree(fix);

    setupTaskBranch(fix, 'task/A', { 'src/impl.txt': 'task-side\n' });
    git(fix.worktree, 'checkout', '-q', MAIN);
    writeFileSync(join(fix.worktree, 'src/impl.txt'), 'main-side\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'main diverges');
    const mainTipBefore = git(fix.worktree, 'rev-parse', MAIN).trim();

    const resultA = await queueFor(fix, integrationDir, log, lease, clock, 'A').process(candidate('A', 'task/A'));
    assert.equal(resultA.outcome, 'merge_conflict');
    assert.equal(resultA.mergeCommit, null);
    assert.equal(git(fix.worktree, 'rev-parse', MAIN).trim(), mainTipBefore, 'main untouched by the aborted merge');
    assert.equal(log.all({ type: 'MERGE_RESULT' }).at(-1)?.payload['outcome'], 'merge_conflict');

    // Independent change merges cleanly — proves the integration worktree was
    // reset+cleaned after the aborted conflict, not left half-merged (REQ-13.10).
    setupTaskBranch(fix, 'task/B', { 'src/other.txt': 'ok\n' });
    const resultB = await queueFor(fix, integrationDir, log, lease, clock, 'B').process(candidate('B', 'task/B'));
    assert.equal(resultB.outcome, 'merged');
    assert.ok(resultB.mergeCommit);
  } finally {
    fix.cleanup();
  }
});

test('entering the queue appends MERGE_ENQUEUED (REQ-13.7)', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const integrationDir = setupIntegrationWorktree(fix);
    setupTaskBranch(fix, 'task/A', { 'src/feature.txt': 'ship\n' });

    await queueFor(fix, integrationDir, log, lease, clock, 'A').process(candidate('A', 'task/A'));

    const enq = log.all({ type: 'MERGE_ENQUEUED' });
    assert.equal(enq.length, 1);
    assert.equal(enq[0]?.payload['taskBranch'], 'task/A');
  } finally {
    fix.cleanup();
  }
});

test('lease contention: a candidate is rejected while another holds the merge-queue lease (REQ-13.1)', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const integrationDir = setupIntegrationWorktree(fix);
    setupTaskBranch(fix, 'task/A', { 'src/feature.txt': 'ship\n' });

    assert.equal(lease.claim('merge-queue', 'OTHER', 60_000), true, 'another in-flight candidate holds the lease');

    await assert.rejects(
      () => queueFor(fix, integrationDir, log, lease, clock, 'A').process(candidate('A', 'task/A')),
      /lease contention/,
    );
  } finally {
    fix.cleanup();
  }
});
