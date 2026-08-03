import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { createExecutor } from './executor.ts';
import { createDefaultPathPolicy } from './path-policy.ts';
import { createCoreRedObservation, createRedArtifactStore } from '../gates/red-provenance.ts';
import { openEventLog } from '../state/event-log.ts';
import { makeClock, makeFixture, makeReportIntegrity, PASSTHROUGH_TEST_SANDBOX } from '../../test/helpers/fixture.ts';

test('implementer WRITE_FILE, APPLY_PATCH, and RUN_COMMAND cannot mutate a frozen RED test', async () => {
  const fix = makeFixture();
  const path = 'test/ai-generated/frozen-red.test.ts';
  const absolute = join(fix.worktree, path);
  writeFileSync(absolute, 'test("red", () => { throw new Error("expected"); });\n');
  try {
    const evidence = createEvidenceStore(fix.evidenceDir);
    const integrity = makeReportIntegrity(fix, evidence, 'RUN-RED');
    const report = integrity.signGateReport({
      tier: 'T1', pass: false, gateConfigHash: 'config', commitHash: 'commit',
      worktreeHash: 'tree', envHash: 'env',
      checks: [{ name: 'tests', pass: false, evidenceRef: evidence.put('expected failure') }],
      scopeNote: 'syntactic test',
    }, { runId: 'RUN-RED', taskId: 'TASK-RED' });
    const observation = createCoreRedObservation({
      worktreeDir: fix.worktree,
      path,
      report,
      reportIntegrity: integrity,
      evidence,
      runId: 'RUN-RED',
      taskId: 'TASK-RED',
    });
    const red = createRedArtifactStore({ evidence, reportIntegrity: integrity });
    red.freeze(fix.worktree, path, observation);
    const log = openEventLog(fix.dbPath, makeClock());
    const executor = createExecutor({
      worktreeDir: fix.worktree,
      runId: 'RUN-RED',
      taskId: 'TASK-RED',
      log,
      evidence,
      policy: createDefaultPathPolicy(),
      redArtifacts: red,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
      clock: makeClock(),
    });

    const write = await executor.execute(
      { type: 'WRITE_FILE', actionId: 'red-write', path, contentRef: evidence.put('weakened\n') },
      'implementer',
    );
    assert.equal(write.status, 'rejected');
    if (write.status === 'rejected') assert.equal(write.rejection.reason, 'red_artifact_frozen');

    const diffRef = evidence.put([
      `diff --git a/${path} b/${path}`,
      '--- a/' + path,
      '+++ b/' + path,
      '@@ -1 +1 @@',
      '-test("red", () => { throw new Error("expected"); });',
      '+test("red", () => {});',
      '',
    ].join('\n'));
    const patch = await executor.execute(
      { type: 'APPLY_PATCH', actionId: 'red-patch', diffRef },
      'implementer',
    );
    assert.equal(patch.status, 'rejected');
    if (patch.status === 'rejected') assert.equal(patch.rejection.reason, 'red_artifact_frozen');

    const deleteDiffRef = evidence.put([
      `diff --git a/${path} b/${path}`,
      'deleted file mode 100644',
      `--- a/${path}`,
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-test("red", () => { throw new Error("expected"); });',
      '',
    ].join('\n'));
    const patchDelete = await executor.execute(
      { type: 'APPLY_PATCH', actionId: 'red-patch-delete', diffRef: deleteDiffRef },
      'implementer',
    );
    assert.equal(patchDelete.status, 'rejected');
    if (patchDelete.status === 'rejected') assert.equal(patchDelete.rejection.reason, 'red_artifact_frozen');

    const command = await executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'red-command',
        cmd: `printf weakened > ${path}`,
        network: 'none',
      },
      'implementer',
    );
    assert.equal(command.status, 'rejected');
    if (command.status === 'rejected') assert.equal(command.rejection.reason, 'red_artifact_frozen');

    const commandDelete = await executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'red-command-delete',
        cmd: `rm -f ${path}`,
        network: 'none',
      },
      'implementer',
    );
    assert.equal(commandDelete.status, 'rejected');
    if (commandDelete.status === 'rejected') assert.equal(commandDelete.rejection.reason, 'red_artifact_frozen');
    const aliasPath = 'test/ai-generated/dir/../frozen-red.test.ts';
    const aliasWrite = await executor.execute(
      { type: 'WRITE_FILE', actionId: 'red-write-alias', path: aliasPath, contentRef: evidence.put('weakened\n') },
      'implementer',
    );
    assert.equal(aliasWrite.status, 'rejected');
    if (aliasWrite.status === 'rejected') assert.equal(aliasWrite.rejection.reason, 'red_artifact_frozen');
    const aliasCommand = await executor.execute(
      { type: 'RUN_COMMAND', actionId: 'red-command-alias', cmd: `printf weakened > ${aliasPath}`, network: 'none' },
      'implementer',
    );
    assert.equal(aliasCommand.status, 'rejected');
    if (aliasCommand.status === 'rejected') assert.notEqual(aliasCommand.rejection.reason, 'path_outside_allowlist');
    assert.match(readFileSync(absolute, 'utf8'), /expected/);
  } finally {
    fix.cleanup();
  }
});
