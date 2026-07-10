// Fusion pipeline integration (REQ-9.1..9.8, 10.7, 10.8). Real registry + router +
// bounded dispatcher + FakeAdapters (neutral 'familyA/familyB' lineages, INV-7); the
// gate evidence port and the event log/evidence store are in-memory fakes. Proves:
// distinct panel requestIds, gate-first code_diff resolution, panel_degraded fail-fast,
// the pre-panel budget cap, and the FUSION_* event trail.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeAdapter } from '../fake-adapter.ts';
import { createRegistry } from '../registry.ts';
import { createRouter } from '../router.ts';
import { createDispatcher } from '../dispatch.ts';
import { PASS_FAIL_PROBES } from '../protocol.ts';
import type { AgentRequest, ConformanceRecord } from '../protocol.ts';
import { runFusion, type CandidateEvidenceRunner, type FusionDeps } from './run.ts';
import type { FusionProfile } from './profiles.ts';
import type { EventLog, EvidenceStore, GateReport, PlatformEvent } from 'core';

function passRecord(id: string): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'v',
    ranAt: new Date(0).toISOString(),
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: 'blob://p' })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

function memEvidence(): EvidenceStore {
  const store = new Map<string, string>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    put(content) {
      const s = typeof content === 'string' ? content : dec.decode(content);
      const ref = `blob://${store.size}-${s.length}`;
      store.set(ref, s);
      return ref;
    },
    get(ref) { return enc.encode(store.get(ref) ?? ''); },
    getText(ref) { return store.get(ref) ?? ''; },
    has(ref) { return store.has(ref); },
  };
}

function memLog(): EventLog & { events: PlatformEvent[] } {
  const events: PlatformEvent[] = [];
  return {
    events,
    append(e) {
      const ev: PlatformEvent = { seq: events.length, ts: '', runId: e.runId, taskId: e.taskId, type: e.type, payload: e.payload };
      events.push(ev);
      return ev;
    },
    all(filter) {
      return events.filter((e) => (filter?.type === undefined || e.type === filter.type) && (filter?.taskId === undefined || e.taskId === filter.taskId));
    },
    exportJsonl: () => '',
    projection: () => ({ tasks: {}, eventCount: events.length }),
    close: () => undefined,
  };
}

function gate(pass: boolean): GateReport {
  return { tier: 'T1', pass, gateConfigHash: 'h', commitHash: 'c', worktreeHash: 'w', envHash: 'e', checks: [], scopeNote: '' };
}

/** Gate a candidate by the content it wrote: passes iff the written body contains 'correct'. */
function contentRunner(evidence: EvidenceStore): CandidateEvidenceRunner {
  return {
    async run({ actions }) {
      const w = actions.find((a) => a.type === 'WRITE_FILE');
      const body = w !== undefined && w.type === 'WRITE_FILE' ? evidence.getText(w.contentRef) : '';
      return gate(body.includes('correct'));
    },
  };
}

function profile(over: Partial<FusionProfile> = {}): FusionProfile {
  return {
    artifact: 'code_diff',
    panel: { size: 2, diversity: { kind: 'cross_lineage', lineages: ['familyA', 'familyB'] } },
    resolve: 'evidence_tournament',
    budgetCapCostUnits: 100,
    estimateCostUnitsPerCandidate: 4,
    ...over,
  };
}

function baseRequest(costUnits = 500): AgentRequest {
  return {
    requestId: 'REQ-base',
    agentRole: 'implementer',
    taskContract: { goalId: 'G', title: 't', objective: 'o', acceptanceCriteria: [] },
    contextBundle: { pieces: [], canaryToken: 'CANARY', stats: { bytes: 0, pieceCount: 0 } },
    manifestRef: 'blob://m',
    outputSchema: {},
    toolDefs: [],
    budget: { costUnits },
  };
}

interface Setup {
  deps: FusionDeps;
  log: EventLog & { events: PlatformEvent[] };
  evidence: EvidenceStore;
}

function fakesWithStore(evidence: EvidenceStore, specs: { id: string; lineage: string; content?: string; fault?: 'throw_transport' }[]): FakeAdapter[] {
  return specs.map((s) => new FakeAdapter({
    id: s.id,
    lineage: s.lineage,
    ...(s.fault !== undefined ? { fault: s.fault } : {}),
    writeContent: s.content ?? 'correct\n',
    putContent: (str) => evidence.put(str),
  }));
}

function setupWith(specs: { id: string; lineage: string; content?: string; fault?: 'throw_transport' }[], baseCost = 500): Setup & { base: AgentRequest } {
  const evidence = memEvidence();
  const log = memLog();
  const reg = createRegistry();
  for (const f of fakesWithStore(evidence, specs)) reg.register(f, passRecord(f.manifest().adapterId));
  const deps: FusionDeps = {
    runId: 'RUN',
    taskId: 'T-1',
    router: createRouter(reg),
    dispatcher: createDispatcher({ buckets: new Map(), maxParallel: 2 }),
    evidenceRunner: contentRunner(evidence),
    evidence,
    log,
    ids: { requestId: () => 'REQ-judge' },
  };
  return { deps, log, evidence, base: baseRequest(baseCost) };
}

test('panel fans out N candidates with distinct requestIds derived from the base (REQ-9.1)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA' }, { id: 'B', lineage: 'familyB' }]);
  await runFusion(s.deps, profile(), s.base);
  const panel = s.log.events.find((e) => e.type === 'FUSION_PANEL');
  assert.ok(panel !== undefined, 'FUSION_PANEL emitted');
  const ids = panel.payload['requestIds'] as string[];
  assert.deepEqual(ids, ['REQ-base#fp0', 'REQ-base#fp1']);
  assert.equal(new Set(ids).size, 2, 'requestIds are distinct');
});

test('code_diff resolves to the gate-green candidate and emits the FUSION_* trail (REQ-9.6/10.1)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA', content: 'wrong\n' }, { id: 'B', lineage: 'familyB', content: 'correct\n' }]);
  const out = await runFusion(s.deps, profile(), s.base);
  assert.ok(out.winner !== null, 'a gate-green candidate won');
  const w = out.winner.actions.find((a) => a.type === 'WRITE_FILE');
  assert.ok(w !== undefined && w.type === 'WRITE_FILE');
  assert.equal(s.evidence.getText(w.contentRef), 'correct\n', 'winner is the gate-green (correct) candidate');
  const types = s.log.events.map((e) => e.type);
  assert.ok(types.includes('FUSION_PANEL'));
  assert.equal(types.filter((t) => t === 'FUSION_CANDIDATE').length, 2, 'one FUSION_CANDIDATE per candidate');
  assert.ok(types.includes('FUSION_RESOLVED'));
});

test('all candidates gate-red -> winner null, escalate no_gate_survivor', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA', content: 'wrong\n' }, { id: 'B', lineage: 'familyB', content: 'nope\n' }]);
  const out = await runFusion(s.deps, profile(), s.base);
  assert.equal(out.winner, null);
  assert.equal(out.escalateReason, 'no_gate_survivor');
});

test('cross_lineage naming an unavailable lineage fails fast panel_degraded, no dispatch (REQ-9.7)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA' }]); // no familyB registered
  const out = await runFusion(s.deps, profile(), s.base);
  assert.equal(out.escalateReason, 'panel_degraded');
  assert.equal(s.log.events.find((e) => e.type === 'FUSION_PANEL'), undefined, 'never dispatched a partial panel');
});

test('self diversity with enough seeds fans out one candidate per seed, no dispatch skipped (PR #50 review)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA' }]);
  const out = await runFusion(s.deps, profile({ panel: { size: 2, diversity: { kind: 'self', seeds: [1, 2] } } }), s.base);
  assert.notEqual(out.escalateReason, 'panel_degraded');
  const panel = s.log.events.find((e) => e.type === 'FUSION_PANEL');
  assert.equal(panel?.payload['size'], 2);
});

test('self diversity with fewer seeds than the panel size fails fast panel_degraded instead of cycling seeds (PR #50 review)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA' }]);
  const out = await runFusion(s.deps, profile({ panel: { size: 2, diversity: { kind: 'self', seeds: [1] } } }), s.base);
  assert.equal(out.escalateReason, 'panel_degraded');
  assert.equal(s.log.events.find((e) => e.type === 'FUSION_PANEL'), undefined, 'never dispatched a degenerate (seed-reusing) panel');
});

test('fewer than two surviving candidates after an AdapterError escalates panel_degraded (REQ-9.8)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA', fault: 'throw_transport' }, { id: 'B', lineage: 'familyB' }]);
  const out = await runFusion(s.deps, profile(), s.base);
  assert.equal(out.escalateReason, 'panel_degraded');
  const cand = s.log.events.filter((e) => e.type === 'FUSION_CANDIDATE');
  assert.equal(cand.length, 2, 'both attempts recorded (one ok:false)');
  assert.ok(cand.some((e) => e.payload['ok'] === false), 'the failed candidate is recorded');
});

test('pre-panel budget cap: N x estimate over the cap and unable to seat 2 -> escalate budget_cap (REQ-10.7)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA' }, { id: 'B', lineage: 'familyB' }]);
  const out = await runFusion(s.deps, profile({ estimateCostUnitsPerCandidate: 100, budgetCapCostUnits: 50 }), s.base);
  assert.equal(out.escalateReason, 'budget_cap');
  assert.equal(s.log.events.find((e) => e.type === 'FUSION_PANEL'), undefined, 'never dispatched');
});

test('hypotheses fusion unions candidates and ranks by probe count — resolves without a load-bearing judge (REQ-10.4)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA' }, { id: 'B', lineage: 'familyB' }]);
  // diagnostician role makes the FakeAdapter return hypotheses as its candidate output.
  const base = { ...s.base, agentRole: 'diagnostician' as const };
  const out = await runFusion(s.deps, profile({ artifact: 'hypotheses', resolve: 'union_rank_probe_cost', panel: { size: 2, diversity: { kind: 'cross_lineage', lineages: ['familyA', 'familyB'] } } }), base);
  assert.ok(out.winner !== null, 'hypotheses resolve mechanically');
  const hyps = (out.winner.structuredResult as { hypotheses: unknown[] }).hypotheses;
  assert.ok(Array.isArray(hyps) && hyps.length >= 1);
});

test('plan escalates judge_invalid when the blind judge cannot produce a valid deliberation (REQ-9.5)', async () => {
  const evidence = memEvidence();
  const log = memLog();
  const reg = createRegistry();
  // familyA is the first eligible reviewer -> the judge; prose_only sabotages its
  // reviewer output (invalid deliberation) while leaving its planner candidate valid.
  const jFail = new FakeAdapter({ id: 'A', lineage: 'familyA', behavior: 'prose_only', putContent: (s) => evidence.put(s) });
  const ok = new FakeAdapter({ id: 'B', lineage: 'familyB', putContent: (s) => evidence.put(s) });
  reg.register(jFail, passRecord('A'));
  reg.register(ok, passRecord('B'));
  const deps: FusionDeps = {
    runId: 'RUN', taskId: 'T-1', router: createRouter(reg),
    dispatcher: createDispatcher({ buckets: new Map(), maxParallel: 2 }),
    evidenceRunner: contentRunner(evidence), evidence, log, ids: { requestId: () => 'REQ-judge' },
  };
  const base = { ...baseRequest(), agentRole: 'planner' as const };
  const out = await runFusion(deps, profile({ artifact: 'plan', resolve: 'deliberate_synthesis' }), base);
  assert.equal(out.winner, null);
  assert.equal(out.escalateReason, 'judge_invalid');
});

test('a valid judge round is referenced by its OWN real analysis blob, not a bare marker (PR #47 review)', async () => {
  const s = setupWith([{ id: 'A', lineage: 'familyA' }, { id: 'B', lineage: 'familyB' }]);
  const base = { ...s.base, agentRole: 'planner' as const };
  const out = await runFusion(s.deps, profile({ artifact: 'plan', resolve: 'deliberate_synthesis' }), base);
  assert.ok(out.winner !== null, 'judge was valid, plan resolves');
  const stored = JSON.parse(s.evidence.getText(out.deliberationRef)) as Record<string, unknown>;
  assert.ok(
    Array.isArray(stored['consensus']),
    'deliberationRef dereferences to the real DeliberationAnalysis (has a consensus array), not a {judge:...} marker',
  );
});

test('pre-judge budget shortfall: a load-bearing plan escalates budget_cap (REQ-10.8)', async () => {
  // panel usage (2 x 2) leaves < estimate budget for the judge round -> judge skipped.
  const s = setupWith([{ id: 'A', lineage: 'familyA' }, { id: 'B', lineage: 'familyB' }], 5);
  const base = { ...s.base, agentRole: 'planner' as const };
  const out = await runFusion(s.deps, profile({ artifact: 'plan', resolve: 'deliberate_synthesis', estimateCostUnitsPerCandidate: 6, budgetCapCostUnits: 100 }), base);
  assert.equal(out.winner, null);
  assert.equal(out.escalateReason, 'budget_cap');
});
