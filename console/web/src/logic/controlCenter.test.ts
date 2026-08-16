import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  conformanceProbeRows,
  dimensionText,
  filterAdapters,
  filterAalTargets,
  filterCoreRuns,
  latestSequence,
  mergeCoreEvents,
  mergeAdapterPages,
  mergeRunPages,
  sourceTime,
  taskTransitions,
  type AdapterProjection,
  type ConformanceSummary,
  type CoreEventProjection,
  type CoreRunSummary,
  type RoutingTargetProjection,
  type SourceStamp,
} from './controlCenter.ts';

const stamp: SourceStamp = { source: 'run:RUN-1/events.db', sourceTimestamp: '2026-08-12T00:00:00Z', sequence: 1, freshness: 'recorded' };

function run(runId: string, lifecycle: 'active' | 'ended', taskId: string): CoreRunSummary {
  return {
    runId,
    lifecycle: { status: 'known', value: lifecycle, provenance: stamp },
    taskStates: [{ taskId, currentState: { status: 'known', value: 'RUNNING', provenance: stamp } }],
    currentTaskId: { status: 'known', value: taskId, provenance: stamp },
    pendingApprovals: { status: 'known', value: 0, provenance: stamp },
    latestSequence: { status: 'known', value: 1, provenance: stamp },
    provenance: stamp,
  };
}

function event(seq: number, type: string, state?: string): CoreEventProjection {
  return { seq, ts: `2026-08-12T00:00:0${seq}Z`, taskId: 'T-1', type, fields: state === undefined ? {} : { state }, redactedFields: [] };
}

test('Core events merge/dedupe by authoritative seq, never browser arrival order (REQ-3.6/8.25)', () => {
  const merged = mergeCoreEvents([event(2, 'TASK_STATE', 'OLD')], [event(3, 'GATE_RESULT'), event(1, 'TASK_STATE', 'FIRST'), event(2, 'TASK_STATE', 'CURRENT')]);
  assert.deepEqual(merged.map((item) => item.seq), [1, 2, 3]);
  assert.equal(merged[1]?.fields['state'], 'CURRENT');
  assert.equal(latestSequence(merged), 3);
  assert.deepEqual(taskTransitions(merged).map((item) => item.seq), [1, 2]);
});

test('run pages dedupe by id; search/filter cover run and task identifiers', () => {
  const active = run('RUN-A', 'active', 'T-1');
  const ended = run('RUN-B', 'ended', 'BUILD');
  assert.deepEqual(mergeRunPages([active], [active, ended]).map((item) => item.runId), ['RUN-A', 'RUN-B']);
  assert.deepEqual(filterCoreRuns([active, ended], 'build', 'all').map((item) => item.runId), ['RUN-B']);
  assert.deepEqual(filterCoreRuns([active, ended], '', 'active').map((item) => item.runId), ['RUN-A']);
});

test('unknown/invalid dimensions keep server reason visible instead of guessing health (REQ-3.8)', () => {
  assert.equal(dimensionText({ status: 'unknown', reason: 'record missing' }), 'unavailable: record missing');
  assert.equal(dimensionText({ status: 'invalid-record', reason: 'bad payload', provenance: stamp }), 'unavailable: bad payload');
  assert.equal(dimensionText({ status: 'known', value: 3, provenance: stamp }), '3');
});

test('AAL filters recorded targets and renders P1-P8 without treating missing freshness as live', () => {
  const summary: ConformanceSummary = {
    modelVersion: 'model-1',
    probes: { P1: true, P2: true, P3: true, P4: true, P5: true, P6: true, P8: false },
    p7SusceptibilityScore: 0.2,
  };
  const target = (name: string, conformance: RoutingTargetProjection['conformance']): RoutingTargetProjection => ({
    target: name,
    breaker: { status: 'unknown', reason: 'missing' },
    rateLimitPolicy: { status: 'unknown', reason: 'missing' },
    recordedLimitState: { status: 'unknown', reason: 'missing' },
    conformance,
  });
  const targets = [
    target('claude@model-1', { status: 'known', value: summary, provenance: stamp }),
    target('codex@model-2', { status: 'invalid-record', reason: 'bad record', provenance: stamp }),
  ];
  assert.deepEqual(filterAalTargets(targets, 'CLAUDE', 'all').map((item) => item.target), ['claude@model-1']);
  assert.deepEqual(filterAalTargets(targets, '', 'invalid-record').map((item) => item.target), ['codex@model-2']);
  assert.deepEqual(conformanceProbeRows(summary).map((probe) => probe.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
  assert.equal(sourceTime({ ...stamp, sourceTimestamp: null, freshness: 'unknown' }), 'unknown freshness');
});

test('Adapter pages dedupe/sort and filters use identifier, lineage, and explicit eligibility only', () => {
  const adapter = (id: string, lineage: string, state: AdapterProjection['registrationEligibility']['state']): AdapterProjection => ({
    id,
    transport: 'cli',
    manifest: { structuredOutput: true, toolCalling: false, contextWindowTokens: 100, executionBackend: false, determinism: 'none', lineage },
    registrationEligibility: { state, reasons: [], provenance: null },
    modelMappings: [],
    health: { status: 'unknown', reason: 'missing' },
    calibration: { status: 'unknown', reason: 'missing' },
    conformance: { status: 'unknown', reason: 'missing' },
  });
  const claude = adapter('claude', 'anthropic', 'eligible');
  const codex = adapter('codex', 'openai', 'unknown');
  assert.deepEqual(mergeAdapterPages([codex], [claude, codex]).map((item) => item.id), ['claude', 'codex']);
  assert.deepEqual(filterAdapters([claude, codex], 'OPENAI', 'all').map((item) => item.id), ['codex']);
  assert.deepEqual(filterAdapters([claude, codex], '', 'eligible').map((item) => item.id), ['claude']);
});
