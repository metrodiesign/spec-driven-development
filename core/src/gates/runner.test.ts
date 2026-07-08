// GateReport must bind to the TESTED tree, not just HEAD: gates run against a
// dirty worktree mid-loop (WRITE_FILE stages files without committing), so a
// report whose only tree binding is `git rev-parse HEAD` would name code that
// cannot reproduce the pass (REQ-4.2). The report therefore also carries
// worktreeHash — the git tree hash of the tracked+untracked content the gate
// actually ran on.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { createGateRunner } from './runner.ts';
import { openEventLog } from '../state/event-log.ts';
import { git, makeClock, makeFixture } from '../../test/helpers/fixture.ts';

test('GateReport.worktreeHash binds the tested (dirty) tree; commitHash alone cannot', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const gates = createGateRunner({
      worktreeDir: fix.worktree,
      configPath: fix.gateConfigPath,
      runId: 'RUN-1',
      taskId: 'T-1',
      log,
      evidence,
      clock,
    });

    const before = await gates.run('T0');

    // Dirty the tree WITHOUT committing — exactly what a WRITE_FILE action does.
    writeFileSync(join(fix.worktree, 'src', 'impl.txt'), 'correct\n');
    const after = await gates.run('T0');

    assert.equal(
      after.commitHash,
      before.commitHash,
      'HEAD did not move — commitHash cannot distinguish the two tested trees',
    );
    assert.match(
      String(before.worktreeHash ?? ''),
      /^[0-9a-f]{40}$/,
      'report carries a real git tree hash',
    );
    assert.notEqual(
      after.worktreeHash,
      before.worktreeHash,
      'worktreeHash reflects the tree the gate actually ran on',
    );

    // Independently recompute: the report hash IS the tree hash of the dirty tree.
    git(fix.worktree, 'add', '-A');
    const expected = git(fix.worktree, 'write-tree').trim();
    assert.equal(
      after.worktreeHash,
      expected,
      'worktreeHash = git write-tree over tracked+untracked content',
    );
  } finally {
    fix.cleanup();
  }
});

function runnerFor(fix: ReturnType<typeof makeFixture>, clock: ReturnType<typeof makeClock>) {
  const log = openEventLog(fix.dbPath, clock);
  const evidence = createEvidenceStore(fix.evidenceDir);
  return createGateRunner({
    worktreeDir: fix.worktree,
    configPath: fix.gateConfigPath,
    runId: 'RUN-1',
    taskId: 'T-1',
    log,
    evidence,
    clock,
  });
}

function setT2(fix: ReturnType<typeof makeFixture>, t2: Record<string, unknown>): void {
  const ladder = JSON.parse(readFileSync(fix.gateConfigPath, 'utf8')) as Record<string, unknown>;
  ladder['t2'] = t2;
  writeFileSync(fix.gateConfigPath, JSON.stringify(ladder));
}

test('T2 {status} config stays not_enabled — the explicit stub (REQ-12.1)', async () => {
  const fix = makeFixture();
  try {
    const report = await runnerFor(fix, makeClock()).run('T2');
    assert.equal(report.pass, 'not_enabled');
    assert.deepEqual(report.checks, []);
  } finally {
    fix.cleanup();
  }
});

test('T2 real config executes build/scopedE2e/secretScan via the shared spawn+retry machinery (REQ-12.2)', async () => {
  const fix = makeFixture();
  try {
    setT2(fix, { build: 'true', scopedE2e: 'true', secretScan: 'false' });
    const report = await runnerFor(fix, makeClock()).run('T2');
    assert.equal(report.pass, false, 'secretScan (false) fails the tier');
    assert.deepEqual(report.checks.map((c) => c.name), ['build', 'scopedE2e', 'secretScan']);
    assert.equal(report.checks.find((c) => c.name === 'build')?.pass, true);
    assert.equal(report.checks.find((c) => c.name === 'secretScan')?.pass, false);
  } finally {
    fix.cleanup();
  }
});

test('T2 fullGolden:builtin verifies through verifyGoldenManifest (REQ-12.4)', async () => {
  const fix = makeFixture();
  try {
    setT2(fix, { fullGolden: 'builtin' });
    const report = await runnerFor(fix, makeClock()).run('T2');
    assert.equal(report.pass, true);
    assert.equal(report.checks[0]?.name, 'fullGolden');
  } finally {
    fix.cleanup();
  }
});

test('T2 GATE_RESULT is core-logged like every other tier', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    setT2(fix, { build: 'true' });
    await createGateRunner({
      worktreeDir: fix.worktree,
      configPath: fix.gateConfigPath,
      runId: 'RUN-1',
      taskId: 'T-1',
      log,
      evidence: createEvidenceStore(fix.evidenceDir),
      clock,
    }).run('T2');
    const events = log.all({ type: 'GATE_RESULT' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload['tier'], 'T2');
  } finally {
    fix.cleanup();
  }
});

test('gateConfigHash changes when the ladder file changes — governance-coupled (REQ-12.3)', async () => {
  const fix = makeFixture();
  try {
    const before = await runnerFor(fix, makeClock()).run('T2');
    setT2(fix, { build: 'true' });
    const after = await runnerFor(fix, makeClock()).run('T2');
    assert.notEqual(after.gateConfigHash, before.gateConfigHash);
  } finally {
    fix.cleanup();
  }
});
