// Task-graph fault injection, COMPOSITION halves (phase5-stage4 REQ-6.1/6.2/6.3/6.4,
// design D6/D8) — the driver lives here, so these scenarios go through the real
// `runSupervisedLoop` on the production path rather than calling the gate directly
// (the pure-gate halves TG#1a/2a are in core/test/task-graph.fault-injection.test.ts).
//
// Everything is asserted from the EVENT LOG, the filesystem, or the result object —
// never from what a stub agent claimed. That distinction is the whole point of the
// DoD: an agent that says "done" and an agent that IS done must look different here.
//
// The FakeAdapter is the honest control; the misbehaving scenarios wrap it so that
// exactly one task in the graph lies.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeAdapter, type AdapterInterface, type AgentRequest, type AgentResponse } from 'aal';
import { openEventLog, type TaskContract } from 'core';
import type { Action } from 'core/types';

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

/** A contract whose ACs a graph can split one per task; all golden, risk L2. */
function contractOf(acIds: string[]): TaskContract {
  return {
    hash: 'c'.repeat(64),
    goal: { id: 'GRAPH-FI', title: 'fault injection graph', objective: 'edit src/impl.txt so the tests pass' },
    acceptanceCriteria: acIds.map((id) => ({ id, description: `${id}: src/impl.txt contains correct`, golden: true })),
    budget: {
      maxIterations: 4,
      maxCostUnits: 500,
      maxWallclockMs: 60_000,
      maxHypothesesPerFailure: 3,
      maxTotalTasks: 30,
      maxParallelAgents: 3,
    },
    risk: 'L2',
    approvalPolicy: [],
    raw: {},
  };
}

/** What the CLI hands the run (REQ-4.2): raw bytes + the parsed object, no freeze. */
function graphOption(graph: unknown): { rawBytes: Uint8Array; parsed: unknown } {
  const json = JSON.stringify(graph);
  return { rawBytes: Buffer.from(json, 'utf8'), parsed: JSON.parse(json) as unknown };
}

/**
 * An adapter whose implementer rounds propose exactly `files` (path -> content) and
 * then claim READY_FOR_VERIFICATION — the claim is a claim, the gate decides.
 *
 * The first round only ASKS to read the files it is about to create, because the AAL
 * source rejects a WRITE to a path that was neither seeded into the context bundle
 * nor previously READ_FILE-requested (`context_violation`). A per-task target file
 * does not exist yet, so the read is refused as `file not found` — which is fine and
 * is the point: what the write needs is the provenance record, not the bytes.
 *
 * Every other role (the repair diagnostician) falls through to the Fake, so a
 * scenario only has to script the part it is actually about.
 */
function writesFiles(put: (s: string) => string, files: Record<string, string>): AdapterInterface {
  const inner = new FakeAdapter({ id: 'fake', putContent: put });
  let round = 0;
  return {
    manifest: () => inner.manifest(),
    send: async (req: AgentRequest): Promise<AgentResponse> => {
      if (req.agentRole !== 'implementer') return inner.send(req);
      round += 1;
      const paths = Object.keys(files);
      const actionRequests: Action[] =
        round === 1
          ? paths.map((path, i) => ({ type: 'READ_FILE', actionId: `read-${i}-${round}`, path }))
          : Object.entries(files).map(([path, content]) => ({
              type: 'WRITE_FILE',
              actionId: `write-${path}-${round}`,
              path,
              contentRef: put(content),
            }));
      const claim = round === 1 ? 'WORKING' : 'READY_FOR_VERIFICATION';
      return {
        structuredResult: { claim, summary: 'proposed fix', actionRequests, costUnits: 2 },
        actionRequests,
        usage: { costUnits: 2, raw: { round } },
        rawTranscriptRef: null,
        adapterMeta: { adapterId: 'fake', modelVersion: 'fake-1.0', interactive: false, toolUseCount: 0 },
      };
    },
  };
}

/**
 * One adapter per graph task, keyed by the single AC that task maps. Multi-task mode
 * narrows the agent-facing excerpt to `task.satisfies` (REQ-4.13), so the mapped AC id
 * is the only task-shaped thing a Ring-2 adapter can see — which is exactly what makes
 * "task 2 of the graph misbehaves" expressible without reaching into the composition.
 */
function perTask(byAc: Record<string, AdapterInterface>): AdapterInterface {
  const fallback = Object.values(byAc)[0] as AdapterInterface;
  const pick = (req: AgentRequest): AdapterInterface =>
    byAc[req.taskContract.acceptanceCriteria[0]?.id ?? ''] ?? fallback;
  return { manifest: () => fallback.manifest(), send: (req) => pick(req).send(req) };
}

/**
 * Run a graph the planning gate must refuse, and assert the ENTIRE no-dispatch
 * surface: BLOCKED before anything was built, a row per declared task, and a log
 * holding the rejection and nothing else (REQ-4.8's "before any dispatch"). Returns
 * the structured reasons so each scenario can assert what it caught.
 */
async function expectRejected(contract: TaskContract, graph: unknown): Promise<string[]> {
  const persistDir = mkdtempSync(join(tmpdir(), 'graph-fi-reject-'));
  let adapterBuilt = false;
  try {
    const out = await runSyntheticLoop({
      contract,
      adapterFactory: (put) => {
        adapterBuilt = true;
        return new FakeAdapter({ id: 'fake', putContent: put });
      },
      clock,
      persistDir,
      taskGraph: graphOption(graph),
    });
    assert.equal(out.finalState, 'BLOCKED', 'a refused plan ends the run BLOCKED');
    assert.equal(out.iterations, 0, 'no task ever ran a round');
    assert.deepStrictEqual(
      out.tasks?.map((t) => t.finalState),
      out.tasks?.map(() => 'NOT_STARTED'),
      'every declared task is reported NOT_STARTED',
    );
    assert.equal(adapterBuilt, false, 'the adapter factory was never called — nothing could be dispatched');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const rejected = log.all({ type: 'TASK_GRAPH_REJECTED' });
      assert.equal(rejected.length, 1, 'exactly one rejection, appended on the production path');
      assert.equal(log.all({ type: 'TASK_GRAPH_FROZEN' }).length, 0, 'a refused graph is never frozen');
      // The no-dispatch surface, spelled out: no task state moved, no action was
      // proposed or applied, no lease was taken.
      assert.equal(log.all({ type: 'TASK_STATE' }).length, 0, 'no task state was ever recorded');
      assert.equal(log.all({ type: 'ACTION_INTENT' }).length, 0, 'no action was ever proposed');
      assert.equal(log.all({ type: 'ACTION_APPLIED' }).length, 0, 'no action was ever applied');
      assert.equal(log.all({ type: 'PROPOSAL_INTENT' }).length, 0, 'no agent was ever asked for a proposal');
      assert.equal(log.all({ type: 'LEASE_CLAIMED' }).length, 0, 'no lease was claimed');
      return rejected[0]?.payload['reasons'] as string[];
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
}

test('TG#1b: an uncovered AC blocks the run at the planning gate, before any dispatch (REQ-6.1)', async () => {
  const reasons = await expectRejected(contractOf(['AC-1', 'AC-2']), {
    goal_id: 'GRAPH-FI',
    tasks: [
      { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
      { id: 'T-2', title: 'second', satisfies: ['AC-1'], depends_on: ['T-1'] },
    ],
    checks: { max_diff_budget_per_task: 400 },
  });
  assert.ok(
    reasons.some((r) => r.includes('uncovered acceptance criteria') && r.includes('AC-2')),
    `the logged reasons name the uncovered AC (got ${JSON.stringify(reasons)})`,
  );
});

test('TG#2b: an orphan task blocks the run at the planning gate, before any dispatch (REQ-6.2)', async () => {
  const reasons = await expectRejected(contractOf(['AC-1', 'AC-2']), {
    goal_id: 'GRAPH-FI',
    tasks: [
      { id: 'T-1', title: 'covers everything', satisfies: ['AC-1', 'AC-2'] },
      { id: 'T-2', title: 'orphan', satisfies: [] },
    ],
    checks: { max_diff_budget_per_task: 400 },
  });
  assert.ok(
    reasons.some((r) => r.includes('orphan tasks') && r.includes('T-2')),
    `the logged reasons name the orphan task (got ${JSON.stringify(reasons)})`,
  );
});

test('TG#3: with A <- B, B is never dispatched before A reaches PASSED — asserted from the log (REQ-6.3)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'graph-fi-order-'));
  try {
    const out = await runSyntheticLoop({
      contract: contractOf(['AC-1', 'AC-2']),
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      taskGraph: graphOption({
        goal_id: 'GRAPH-FI',
        tasks: [
          { id: 'T-A', title: 'the dependency', satisfies: ['AC-1'] },
          { id: 'T-B', title: 'the dependent', satisfies: ['AC-2'], depends_on: ['T-A'] },
        ],
        checks: { max_diff_budget_per_task: 400 },
      }),
    });
    assert.deepStrictEqual(
      out.tasks?.map((t) => [t.id, t.finalState]),
      [
        ['T-A', 'REVIEWING'],
        ['T-B', 'REVIEWING'],
      ],
      'both tasks ran (an ordering proof over a run where B never ran would be vacuous)',
    );

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const statesOf = (taskId: string) => log.all({ type: 'TASK_STATE', taskId });
      const aPassed = statesOf('T-A').find((e) => e.payload['state'] === 'PASSED')?.seq;
      const bFirst = statesOf('T-B')[0]?.seq;
      assert.ok(aPassed !== undefined, 'the dependency reached PASSED — core measured it, not the agent');
      assert.ok(bFirst !== undefined, 'the dependent recorded a state at all');
      assert.ok(
        bFirst > aPassed,
        `the dependent's first state (seq ${bFirst}) comes after the dependency PASSED (seq ${aPassed})`,
      );
      // Nothing of B's exists before that point either — not just its states.
      const bEvents = log.all({ taskId: 'T-B' });
      assert.ok(
        bEvents.every((e) => e.type === 'LEASE_CLAIMED' || e.seq > aPassed),
        'no work was recorded against the dependent before its dependency passed',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('TG#4: a task lying READY_FOR_VERIFICATION never reaches PASSED and its dependents are skipped (REQ-6.4)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'graph-fi-fakegreen-'));
  try {
    const out = await runSyntheticLoop({
      contract: contractOf(['AC-1', 'AC-2', 'AC-3']),
      // Task 2 of the chain claims READY_FOR_VERIFICATION every round while writing
      // the pre-fix marker, and diagnoses with causes that never confirm — DoD#1's
      // lying agent, scoped to ONE task of a graph.
      adapterFactory: (put) =>
        perTask({
          'AC-1': new FakeAdapter({ id: 'fake', putContent: put }),
          'AC-2': new FakeAdapter({ id: 'fake', behavior: 'exhaust_hypotheses', putContent: put }),
          'AC-3': new FakeAdapter({ id: 'fake', putContent: put }),
        }),
      clock,
      persistDir,
      taskGraph: graphOption({
        goal_id: 'GRAPH-FI',
        tasks: [
          { id: 'T-1', title: 'honest', satisfies: ['AC-1'] },
          { id: 'T-2', title: 'liar', satisfies: ['AC-2'], depends_on: ['T-1'] },
          { id: 'T-3', title: 'downstream of the liar', satisfies: ['AC-3'], depends_on: ['T-2'] },
        ],
        checks: { max_diff_budget_per_task: 400 },
      }),
    });
    assert.deepStrictEqual(
      out.tasks?.map((t) => [t.id, t.finalState]),
      [
        ['T-1', 'REVIEWING'],
        ['T-2', 'ESCALATED'],
        ['T-3', 'SKIPPED'],
      ],
      'the liar ends outside the dep-satisfied set and poisons only what depends on it',
    );
    assert.equal(out.finalState, 'ESCALATED', 'run precedence follows the state the liar actually ended in');

    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const t2States = log.all({ type: 'TASK_STATE', taskId: 'T-2' }).map((e) => String(e.payload['state']));
      assert.ok(t2States.length > 0, 'the liar really did run');
      assert.ok(
        !t2States.includes('PASSED'),
        `a claim never yields PASSED — core ran the gate itself (states: ${t2States.join(' -> ')})`,
      );
      assert.equal(
        log.all({ taskId: 'T-3' }).length,
        0,
        'the dependent of a task that never passed is not dispatched at all',
      );
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('branch isolation: a task\'s approval diff carries its own work only, never the previous task\'s (design D1)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'graph-fi-branch-'));
  try {
    const out = await runSyntheticLoop({
      contract: contractOf(['AC-1', 'AC-2']),
      // Each task writes the marker the gate greps for PLUS a file only it touches,
      // so a leaked branch would be visible in the next task's diff. Same-file writes
      // could not prove this: a later overwrite hides the earlier one in a range diff.
      adapterFactory: (put) =>
        perTask({
          'AC-1': writesFiles(put, { 'src/impl.txt': 'correct\n', 'src/only-task-one.txt': 'from task one\n' }),
          'AC-2': writesFiles(put, { 'src/impl.txt': 'correct\n', 'src/only-task-two.txt': 'from task two\n' }),
        }),
      clock,
      persistDir,
      taskGraph: graphOption({
        goal_id: 'GRAPH-FI',
        tasks: [
          { id: 'T-1', title: 'first', satisfies: ['AC-1'] },
          { id: 'T-2', title: 'second', satisfies: ['AC-2'], depends_on: ['T-1'] },
        ],
        checks: { max_diff_budget_per_task: 400 },
      }),
    });
    assert.deepStrictEqual(
      out.tasks?.map((t) => t.finalState),
      ['REVIEWING', 'REVIEWING'],
      'both tasks reached the approval-package path, so both diffs were really built',
    );

    // The diffs as the approval packages saw them: the bytes the composition put into
    // the evidence store, not a diff this test re-derives afterwards.
    const evidenceDir = join(persistDir, 'evidence');
    const diffs = readdirSync(evidenceDir)
      .map((name) => readFileSync(join(evidenceDir, name), 'utf8'))
      .filter((body) => body.startsWith('diff --git'));
    const secondDiff = diffs.find((d) => d.includes('only-task-two.txt'));
    assert.ok(secondDiff !== undefined, `the second task's diff is in the store (${diffs.length} diffs found)`);
    assert.ok(
      !secondDiff.includes('only-task-one.txt'),
      'the second task\'s diff — and therefore its diff budget and approval package — carries no file of the first',
    );
    assert.ok(
      diffs.some((d) => d.includes('only-task-one.txt') && !d.includes('only-task-two.txt')),
      'and the first task\'s diff is the mirror image: its own file only',
    );
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});
