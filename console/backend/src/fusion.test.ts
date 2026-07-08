// Fusion composition root (REQ-9.2, REQ-10.9, REQ-10.10). Proves the two machine-
// touching pieces aal/fusion cannot own: candidate gate evidence in an ISOLATED
// worktree (the live repo stays untouched) and the fusion.deliberate depth<=1 counter
// wired through the executor's toolHandlers seam. All on the fixture repo — no quota.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createCandidateEvidenceRunner, createFusionToolHandler, fusionActive } from './fusion.ts';
import { makeFixtureRepo } from './loop-run.ts';
import { decideLiveRun } from './loop-cli.ts';
import {
  createDefaultPathPolicy,
  createEvidenceStore,
  createExecutor,
  denyNetworkSandbox,
  openEventLog,
} from 'core';
import type { Action } from 'core';
import type { FusionOutcome } from 'aal';

const clock = { now: () => 1_000_000 };

function write(path: string, contentRef: string): Action {
  return { type: 'WRITE_FILE', actionId: `w-${contentRef}`, path, contentRef };
}

test('CandidateEvidenceRunner produces a core GateReport per candidate in an isolated worktree; live repo untouched (REQ-9.2)', async () => {
  const fx = makeFixtureRepo();
  const log = openEventLog(join(fx.root, 'events.db'), clock);
  const evidence = createEvidenceStore(join(fx.root, 'evidence'));
  try {
    const runner = createCandidateEvidenceRunner({
      repoDir: fx.wt,
      configRelPath: 'gate-ladder.json',
      runId: 'RUN',
      taskId: 'T-1',
      log,
      evidence,
      clock,
    });
    const correctRef = evidence.put('correct\n');
    const wrongRef = evidence.put('wrong\n');

    const green = await runner.run({ actions: [write('src/impl.txt', correctRef)] });
    assert.equal(green.pass, true, 'a candidate writing the correct marker gates green');

    const red = await runner.run({ actions: [write('src/impl.txt', wrongRef)] });
    assert.equal(red.pass, false, 'a candidate writing the wrong marker gates red');

    // Isolation: the live repo still holds the pre-fix marker — candidates ran in
    // throwaway worktrees, never mutating fx.wt (REQ-9.2).
    assert.equal(readFileSync(join(fx.wt, 'src', 'impl.txt'), 'utf8'), 'wrong\n', 'live repo untouched');
  } finally {
    log.close();
    fx.cleanup();
  }
});

function stubOutcome(): FusionOutcome {
  return { winner: null, deliberationRef: 'blob://d', dissentRefs: [], usage: { costUnits: 8 }, resolved: 'evidence_tournament', escalateReason: 'no_gate_survivor' };
}

test('fusion.deliberate: first activation applies, a second for the same task is rejected depth_exceeded (REQ-10.9)', async () => {
  const fx = makeFixtureRepo();
  const log = openEventLog(join(fx.root, 'events.db'), clock);
  const evidence = createEvidenceStore(join(fx.root, 'evidence'));
  try {
    let activations = 0;
    const handler = createFusionToolHandler({
      runId: 'RUN',
      taskId: 'T-1',
      log,
      evidence,
      activate: async () => { activations += 1; return stubOutcome(); },
    });
    const call = (id: string): Action => ({ type: 'REQUEST_TOOL', actionId: id, name: 'fusion.deliberate', args: {} });

    const first = await handler(call('a1') as Extract<Action, { type: 'REQUEST_TOOL' }>, 'implementer');
    assert.equal(first.status, 'applied');

    const second = await handler(call('a2') as Extract<Action, { type: 'REQUEST_TOOL' }>, 'implementer');
    assert.equal(second.status, 'rejected');
    if (second.status === 'rejected') assert.equal(second.rejection.reason, 'depth_exceeded');

    assert.equal(activations, 1, 'fusion ran exactly once — the second call never re-activates');
  } finally {
    log.close();
    fx.cleanup();
  }
});

test('the executor routes REQUEST_TOOL fusion.deliberate to the composition handler; unknown tools still reject (REQ-10.9)', async () => {
  const fx = makeFixtureRepo();
  const log = openEventLog(join(fx.root, 'events.db'), clock);
  const evidence = createEvidenceStore(join(fx.root, 'evidence'));
  try {
    const handler = createFusionToolHandler({ runId: 'RUN', taskId: 'T-1', log, evidence, activate: async () => stubOutcome() });
    const executor = createExecutor({
      worktreeDir: fx.wt,
      runId: 'RUN',
      taskId: 'T-1',
      log,
      evidence,
      policy: createDefaultPathPolicy(),
      sandbox: denyNetworkSandbox(process.platform),
      clock,
      toolHandlers: { 'fusion.deliberate': handler },
    });

    const applied = await executor.execute({ type: 'REQUEST_TOOL', actionId: 'x1', name: 'fusion.deliberate', args: {} }, 'implementer');
    assert.equal(applied.status, 'applied', 'the handler took over the REQUEST_TOOL');

    const rejected = await executor.execute({ type: 'REQUEST_TOOL', actionId: 'x2', name: 'fusion.deliberate', args: {} }, 'implementer');
    assert.equal(rejected.status, 'rejected');
    if (rejected.status === 'rejected') assert.equal(rejected.rejection.reason, 'depth_exceeded');

    // An unhandled tool name keeps the propose-only rejection (backward-compatible).
    const other = await executor.execute({ type: 'REQUEST_TOOL', actionId: 'x3', name: 'some.other.tool', args: {} }, 'implementer');
    assert.equal(other.status, 'rejected');
    if (other.status === 'rejected') assert.equal(other.rejection.reason, 'unsupported_action_phase0');
  } finally {
    log.close();
    fx.cleanup();
  }
});

test('fusion activates ONLY on a confirmed live run — never on the CI stub or a --live CI refusal (REQ-10.10)', () => {
  assert.equal(fusionActive(decideLiveRun({ live: true, ciEnv: false, isTTY: true })), true, 'confirmed live run may fuse');
  assert.equal(fusionActive(decideLiveRun({ live: false, ciEnv: false, isTTY: true })), false, 'CI-safe stub never fuses');
  assert.equal(fusionActive(decideLiveRun({ live: true, ciEnv: true, isTTY: true })), false, 'CI refuses --live -> no fusion');
});
