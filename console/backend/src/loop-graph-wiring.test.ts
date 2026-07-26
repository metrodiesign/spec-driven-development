// The two unit-level wiring proofs the stage-4 assembly trace found implemented but
// unexercised (unified-platform-spec.md §17 v1.7): the CLI edge ignores a task-graph
// DRAFT (REQ-4.7), and the planner-fusion base request carries the frozen graph as
// exactly one context piece (REQ-5.1) while its absence keeps the empty single-task
// bundle (REQ-5.2). Neither needs a supervised run, so neither pays for one.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createDispatcher,
  createRegistry,
  createRouter,
  FakeAdapter,
  PASS_FAIL_PROBES,
  type AdapterInterface,
  type AgentRequest,
  type ConformanceRecord,
  type FusionProfile,
} from 'aal';
import { createEvidenceStore, openEventLog } from 'core';

import { runPlannerFusion } from './fusion.ts';
import { loadTaskGraphOption } from './loop-cli.ts';

const clock = { now: () => 1_000_000 };

const DECLARED_GRAPH = {
  goal_id: 'DEMO-1',
  tasks: [{ id: 'T-1', title: 'first', satisfies: ['AC-1'] }],
  checks: { max_diff_budget_per_task: 400 },
};

test('REQ-4.7: a task-graph DRAFT next to the goal is invisible — only the promoted file loads', () => {
  // `loadTaskGraphOption` keys off the goal's DIRECTORY, so goal.yaml itself is never
  // read here and never written.
  const dir = mkdtempSync(join(tmpdir(), 'graph-promote-'));
  const goalPath = join(dir, 'goal.yaml');
  const json = JSON.stringify(DECLARED_GRAPH);
  try {
    writeFileSync(join(dir, 'task-graph.draft.json'), json);
    assert.equal(
      loadTaskGraphOption(goalPath),
      undefined,
      'a shape-VALID draft is still a pre-human artifact — promotion stays a human rename (INV-3/INV-16)',
    );

    writeFileSync(join(dir, 'task-graph.json'), json);
    const loaded = loadTaskGraphOption(goalPath);
    assert.ok(loaded !== undefined, 'the promoted file loads');
    assert.equal(
      Buffer.from(loaded.rawBytes).toString('utf8'),
      json,
      'the raw bytes are the promoted file verbatim — the freeze hashes THESE (INV-10)',
    );
    assert.deepEqual(loaded.parsed, DECLARED_GRAPH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TASK_CONTRACT = {
  goalId: 'DEMO-1',
  title: 'demo goal',
  objective: 'fix the impl',
  acceptanceCriteria: [{ id: 'AC-1', description: 'impl says correct' }],
};

const CANARY = 'CANARY-1';

function passRecord(id: string): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'v',
    ranAt: new Date(0).toISOString(),
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: 'blob://p' })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

/** `self` diversity: one adapter seats both panel slots, so one capture sees the whole panel. */
function planProfile(): FusionProfile {
  return {
    artifact: 'plan',
    panel: { size: 2, diversity: { kind: 'self', seeds: [1, 2] } },
    resolve: 'deliberate_synthesis',
    budgetCapCostUnits: 40,
    estimateCostUnitsPerCandidate: 8,
  };
}

/** Records what actually reaches an adapter — a panel slot spreads the base request, so this IS the base's bundle. */
function capturing(inner: FakeAdapter, seen: AgentRequest[]): AdapterInterface {
  return {
    manifest: () => inner.manifest(),
    send: async (req) => {
      seen.push(req);
      return inner.send(req);
    },
  };
}

/** Run one planner fusion and return the requests its PANEL saw (the judge round is role reviewer). */
async function plannerRequests(taskGraphJson: string | undefined): Promise<AgentRequest[]> {
  const dir = mkdtempSync(join(tmpdir(), 'planner-graph-piece-'));
  const log = openEventLog(join(dir, 'events.db'), clock);
  const seen: AgentRequest[] = [];
  try {
    const reg = createRegistry({});
    reg.register(capturing(new FakeAdapter({ id: 'a-1' }), seen), passRecord('a-1'));
    let n = 0;
    await runPlannerFusion({
      runId: 'RUN',
      // null, as multi-task mode passes it: this dispatch precedes any task selection.
      taskId: null,
      router: createRouter(reg),
      dispatcher: createDispatcher({ buckets: new Map(), maxParallel: 2 }),
      profile: planProfile(),
      evidence: createEvidenceStore(join(dir, 'evidence')),
      log,
      ids: { requestId: () => `req-${++n}`, canary: () => CANARY },
      taskContract: TASK_CONTRACT,
      ...(taskGraphJson !== undefined ? { taskGraphJson } : {}),
    });
    return seen.filter((r) => r.agentRole === 'planner');
  } finally {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('REQ-5.1/5.2: the frozen graph is EXACTLY one planner context piece; without it the bundle stays empty', async () => {
  const graphJson = JSON.stringify({
    goalId: 'DEMO-1',
    tasks: [{ id: 'T-1', title: 'first', satisfies: ['AC-1'], dependsOn: [], enabling: false, risk: 'L2', diffBudget: 400 }],
    checks: { maxDiffBudgetPerTask: 400 },
    graphHash: 'a'.repeat(64),
  });

  const withGraph = await plannerRequests(graphJson);
  assert.equal(withGraph.length, 2, 'both panel slots dispatched role planner');
  for (const req of withGraph) {
    assert.deepStrictEqual(
      req.contextBundle,
      {
        pieces: [{ id: 'task-graph', kind: 'contract', content: graphJson, reason: 'task_graph' }],
        canaryToken: CANARY,
        stats: { bytes: graphJson.length, pieceCount: 1 },
      },
      "one piece, MARKed as data under this request's canary, with real stats — nothing else joins the pinned goal view",
    );
  }

  const withoutGraph = await plannerRequests(undefined);
  assert.equal(withoutGraph.length, 2);
  for (const req of withoutGraph) {
    assert.deepStrictEqual(
      req.contextBundle,
      { pieces: [], canaryToken: CANARY, stats: { bytes: 0, pieceCount: 0 } },
      'REQ-5.2: single-task keeps Phase-4 REQ-16.2 exactly — empty pieces, zero stats, canary still present',
    );
  }
});
