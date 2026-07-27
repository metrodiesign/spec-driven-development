// Fusion composition root (REQ-9.2, REQ-10.9, REQ-10.10). Proves the two machine-
// touching pieces aal/fusion cannot own: candidate gate evidence in an ISOLATED
// worktree (the live repo stays untouched) and the fusion.deliberate depth<=1 counter
// wired through the executor's toolHandlers seam. All on the fixture repo — no quota.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createCandidateEvidenceRunner, createFusionToolHandler, fusionActive, runPlannerFusion, PLAN_SCHEMA } from './fusion.ts';
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
import {
  createDispatcher,
  createRegistry,
  createRouter,
  FakeAdapter,
  PASS_FAIL_PROBES,
  type ConformanceRecord,
  type FusionOutcome,
  type FusionProfile,
} from 'aal';

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

// --- runPlannerFusion (REQ-16.2/16.5). The GATING (whether this ever gets called —
// REQ-16.3's "policy flag + composition option" trigger contract, and REQ-16.4's
// fusionActive live gate) is the CALLER's job — proven at the composition level in
// loop-run.test.ts, same separation createFusionToolHandler/fusionActive already
// establish above. These tests prove runPlannerFusion ITSELF: it dispatches role
// planner through the given router, resolves per the plan profile, structurally
// validates the winner, and always appends PLAN_RESOLVED. ---

const TASK_CONTRACT = {
  goalId: 'G-1',
  title: 'demo goal',
  objective: 'fix the impl',
  acceptanceCriteria: [{ id: 'AC-1', description: 'impl says correct' }],
};

function passRecord(id: string): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'v',
    ranAt: new Date(0).toISOString(),
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: 'blob://p' })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

/** The real shipped `plan` profile shape (cross_lineage anthropic/openai, deliberate_synthesis). */
function planProfile(): FusionProfile {
  return {
    artifact: 'plan',
    panel: { size: 2, diversity: { kind: 'cross_lineage', lineages: ['anthropic', 'openai'] } },
    resolve: 'deliberate_synthesis',
    budgetCapCostUnits: 40,
    estimateCostUnitsPerCandidate: 8,
  };
}

function plannerHarness(adapters: FakeAdapter[]) {
  const fx = makeFixtureRepo();
  const log = openEventLog(join(fx.root, 'events.db'), clock);
  const evidence = createEvidenceStore(join(fx.root, 'evidence'));
  const reg = createRegistry({});
  for (const a of adapters) reg.register(a, passRecord(a.manifest().adapterId));
  const router = createRouter(reg);
  const dispatcher = createDispatcher({ buckets: new Map(), maxParallel: 2 });
  let n = 0;
  const ids = { requestId: () => `req-${++n}`, canary: () => `CANARY-${n}` };
  return { log, evidence, router, dispatcher, ids, cleanup: () => { log.close(); fx.cleanup(); } };
}

test('REQ-16.2/16.5: dispatches role planner through the given router, resolves a valid plan, appends PLAN_RESOLVED', async () => {
  const h = plannerHarness([
    new FakeAdapter({ id: 'a-anthropic', lineage: 'anthropic' }),
    new FakeAdapter({ id: 'a-openai', lineage: 'openai' }),
  ]);
  try {
    const result = await runPlannerFusion({
      runId: 'RUN',
      taskId: 'T-1',
      router: h.router,
      dispatcher: h.dispatcher,
      profile: planProfile(),
      evidence: h.evidence,
      log: h.log,
      ids: h.ids,
      taskContract: TASK_CONTRACT,
    });
    assert.ok(result.plan !== null, 'a valid plan was resolved');
    const parsed = JSON.parse(result.plan?.content ?? '{}') as { approach: unknown; steps: unknown };
    assert.equal(typeof parsed.approach, 'string');
    assert.ok(Array.isArray(parsed.steps));
    assert.equal(result.plan?.id, 'plan-T-1');

    const resolved = h.log.all({ type: 'PLAN_RESOLVED' });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.payload['winner'], true);
    assert.equal(resolved[0]?.payload['panelSize'], 2);
    assert.equal(typeof resolved[0]?.payload['costUnits'], 'number');
    assert.equal(h.log.all({ type: 'FUSION_PANEL' })[0]?.payload['artifact'], 'plan');
  } finally {
    h.cleanup();
  }
});

test('an unresolvable panel (a required lineage never registered) escalates — PLAN_RESOLVED{winner:false}, plan stays null, never throws', async () => {
  const h = plannerHarness([new FakeAdapter({ id: 'a-anthropic', lineage: 'anthropic' })]); // 'openai' lineage never registered
  try {
    const result = await runPlannerFusion({
      runId: 'RUN',
      taskId: 'T-1',
      router: h.router,
      dispatcher: h.dispatcher,
      profile: planProfile(),
      evidence: h.evidence,
      log: h.log,
      ids: h.ids,
      taskContract: TASK_CONTRACT,
    });
    assert.equal(result.plan, null);
    assert.equal(result.outcome.escalateReason, 'panel_degraded');
    const resolved = h.log.all({ type: 'PLAN_RESOLVED' })[0];
    assert.equal(resolved?.payload['winner'], false);
    assert.equal(resolved?.payload['panelSize'], 0, 'no panel ever formed before the escalate');
  } finally {
    h.cleanup();
  }
});

test('a structurally invalid winner (fails PLAN_SCHEMA) is discarded even though fusion itself resolved one — never handed to the caller', async () => {
  // Registered FIRST -> becomes the judge (route('reviewer') = first eligible, registry
  // insertion order); compliant, so the judge round is valid and 'plan' (judge-load-
  // bearing) is NOT judge_invalid-escalated. Lineage 'openai' -> panel candidate[1].
  const judge = new FakeAdapter({ id: 'a-openai', lineage: 'openai' });
  // Lineage 'anthropic' -> panel candidate[0], which resolvePlan picks as the winner
  // (deterministic first-candidate pick) — sabotaged so the winner's structuredResult
  // fails PLAN_SCHEMA (missing approach/steps).
  const sabotagedCandidate0 = new FakeAdapter({ id: 'a-anthropic', lineage: 'anthropic', behavior: 'ignore_schema' });
  const h = plannerHarness([judge, sabotagedCandidate0]);
  try {
    const result = await runPlannerFusion({
      runId: 'RUN',
      taskId: 'T-1',
      router: h.router,
      dispatcher: h.dispatcher,
      profile: planProfile(),
      evidence: h.evidence,
      log: h.log,
      ids: h.ids,
      taskContract: TASK_CONTRACT,
    });
    assert.equal(result.outcome.winner !== null, true, 'fusion itself DID resolve a winner');
    assert.equal(result.plan, null, 'but it failed PLAN_SCHEMA, so no plan is handed to the caller');
    const resolved = h.log.all({ type: 'PLAN_RESOLVED' })[0];
    assert.equal(resolved?.payload['winner'], false, 'PLAN_RESOLVED.winner reflects usability, not raw fusion resolution');
  } finally {
    h.cleanup();
  }
});

test('PLAN_SCHEMA (runtime, validateAgainstSchema-compatible) required-property set stays byte-equivalent to the governance copy at .ai/schemas/plan.schema.json', () => {
  const governance = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', '.ai', 'schemas', 'plan.schema.json'), 'utf8'),
  ) as { required: string[] };
  assert.deepEqual([...(PLAN_SCHEMA['required'] as string[])].sort(), [...governance.required].sort());
});

test('PLAN_RESOLVED.panelSize reports THIS call, never an earlier one still in the log (Codex P2, PR #124)', async () => {
  const h = plannerHarness([
    new FakeAdapter({ id: 'a-anthropic', lineage: 'anthropic' }),
    new FakeAdapter({ id: 'a-openai', lineage: 'openai' }),
  ]);
  try {
    // First call forms a real 2-candidate panel and leaves FUSION_PANEL in the log.
    // taskId null is the multi-task shape, where the old lookup had no filter at all.
    const base = {
      runId: 'RUN',
      taskId: null,
      router: h.router,
      dispatcher: h.dispatcher,
      evidence: h.evidence,
      log: h.log,
      ids: h.ids,
      taskContract: TASK_CONTRACT,
    };
    await runPlannerFusion({ ...base, profile: planProfile() });
    assert.equal(h.log.all({ type: 'FUSION_PANEL' }).length, 1, 'the earlier panel is on the log');

    // Second call cannot seat two candidates -> budget_cap, before any panel forms.
    const result = await runPlannerFusion({
      ...base,
      profile: { ...planProfile(), budgetCapCostUnits: 8, estimateCostUnitsPerCandidate: 8 },
    });
    assert.equal(result.outcome.escalateReason, 'budget_cap');
    assert.equal(result.outcome.panelSize, 0, 'runFusion reports the panel IT formed');
    assert.equal(h.log.all({ type: 'FUSION_PANEL' }).length, 1, 'and it appended none');
    assert.equal(
      h.log.all({ type: 'PLAN_RESOLVED' }).at(-1)?.payload['panelSize'],
      0,
      'the audit event records 0, not the stale panel size 2',
    );
  } finally {
    h.cleanup();
  }
});
