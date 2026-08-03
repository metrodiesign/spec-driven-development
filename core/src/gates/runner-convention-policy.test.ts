import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { createGateRunner } from './runner.ts';
import { openEventLog } from '../state/event-log.ts';
import { makeClock, makeFixture, makeReportIntegrity } from '../../test/helpers/fixture.ts';

test('versioned convention policy bytes are part of gate-config identity', async () => {
  const fix = makeFixture();
  try {
    const policyPath = join(fix.root, 'convention.json');
    const policy = JSON.stringify({
      version: 1,
      roots: ['test'],
      rules: [{ id: 'focus', pattern: '\\.\\s*(?:only|skip)\\s*\\(' }],
    });
    writeFileSync(policyPath, policy);
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const makeRunner = () => createGateRunner({
      worktreeDir: fix.worktree,
      configPath: fix.gateConfigPath,
      conventionPolicyPath: policyPath,
      runId: 'RUN-CONVENTION',
      taskId: 'TASK-CONVENTION',
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
    });
    const before = await makeRunner().run('T3');
    writeFileSync(policyPath, readFileSync(policyPath, 'utf8') + '\n');
    const after = await makeRunner().run('T3');
    assert.notEqual(before.gateConfigHash, after.gateConfigHash);
    log.close();
  } finally {
    fix.cleanup();
  }
});

