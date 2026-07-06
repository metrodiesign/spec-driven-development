// GateReport must bind to the TESTED tree, not just HEAD: gates run against a
// dirty worktree mid-loop (WRITE_FILE stages files without committing), so a
// report whose only tree binding is `git rev-parse HEAD` would name code that
// cannot reproduce the pass (REQ-4.2). The report therefore also carries
// worktreeHash — the git tree hash of the tracked+untracked content the gate
// actually ran on.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
