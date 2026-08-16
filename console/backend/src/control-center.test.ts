import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createEvidenceStore, openEventLog } from 'core';
import { describeAnthropicAdapter, describeCodexAdapter, describeReasoningCliAdapter } from 'adapters';

import { buildApp } from './app.ts';
import {
  createControlCenterReadPort,
  InvalidControlCenterQueryError,
  parseControlCenterAfter,
  parseControlCenterLimit,
} from './control-center.ts';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const HOST = { host: '127.0.0.1:9119' };
const STATIC_ADAPTERS = [
  describeAnthropicAdapter(),
  describeCodexAdapter(),
  describeReasoningCliAdapter({ id: 'gemini-cli', lineage: 'google', contextWindowTokens: 1_000_000 }),
  describeReasoningCliAdapter({ id: 'opencode-deepseek', lineage: 'deepseek', contextWindowTokens: 128_000 }),
] as const;
const MODEL_ENVIRONMENT = {
  PR_GATE_CLAUDE_MODEL: 'claude-review',
  PR_GATE_CODEX_MODEL: null,
  PR_GATE_GEMINI_MODEL: 'gemini-review',
  PR_GATE_DEEPSEEK_MODEL: null,
} as const;

interface RunFixture {
  readonly runDir: string;
  readonly dbPath: string;
  readonly evidenceRef: string;
  readonly missingRef: string;
}

function makeRun(runsRoot: string, runId: string, startedAt: number, active: boolean): RunFixture {
  const runDir = join(runsRoot, runId);
  mkdirSync(join(runDir, 'evidence'), { recursive: true });
  let now = startedAt;
  const log = openEventLog(join(runDir, 'events.db'), { now: () => now++ });
  const evidence = createEvidenceStore(join(runDir, 'evidence'));
  const evidenceRef = evidence.put('gate output');
  const missingRef = `blob://${'f'.repeat(64)}`;
  log.append({
    runId,
    taskId: null,
    type: 'TASK_GRAPH_FROZEN',
    payload: {
      graphHash: 'graph-hash',
      taskIds: ['T-1'],
      tasks: [{ id: 'T-1', title: 'Task one', dependsOn: [], satisfies: ['REQ-1.1'], risk: 'L1', diffBudget: 42 }],
    },
  });
  log.append({
    runId,
    taskId: null,
    type: 'RUN_DESCRIPTOR',
    payload: {
      contractHash: 'contract-hash',
      goal: { id: 'goal-1', title: 'Goal one' },
      taskMode: 'graph',
      budget: { iterations: 5, costUnits: 10, wallclockMs: 60_000 },
    },
  });
  log.append({ runId, taskId: 'T-1', type: 'TASK_STATE', payload: { state: active ? 'REVIEWING' : 'COMPLETED', trigger: 'test' } });
  log.append({ runId, taskId: 'T-1', type: 'APPROVAL_PACKAGE_CREATED', payload: { approvalId: `${runId}-A1` } });
  log.append({
    runId,
    taskId: 'T-1',
    type: 'GATE_RESULT',
    payload: {
      tier: 'T1',
      pass: true,
      checks: [
        { name: 'tests', pass: true, evidenceRef },
        { name: 'missing', pass: true, evidenceRef: missingRef },
      ],
    },
  });
  log.append({
    runId,
    taskId: 'T-1',
    type: 'BUDGET_SNAPSHOT',
    payload: {
      phase: 'terminal',
      used: { iterations: 2, costUnits: 3, activeWallclockMs: 4_000 },
      cap: { iterations: 5, costUnits: 10, wallclockMs: 60_000 },
    },
  });
  log.append({
    runId,
    taskId: 'T-1',
    type: 'ACTION_APPLIED',
    payload: { path: '/Users/operator/secret', output: '<script>alert(1)</script>', nested: { token: 'secret' } },
  });
  log.close();
  if (active) {
    writeFileSync(join(runDir, 'human-plane.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'top-secret' }));
  }
  return { runDir, dbPath: join(runDir, 'events.db'), evidenceRef, missingRef };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function conformanceRecord(adapterId: string, modelVersion: string, ranAt: string): Record<string, unknown> {
  const evidenceRef = `blob://${'a'.repeat(64)}`;
  return {
    adapterId,
    modelVersion,
    ranAt,
    probes: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8'].map((id) => ({ id, pass: true, evidenceRef })),
    p7: { susceptibilityScore: 0.25, evidenceRef },
  };
}

test('Core projector paginates newest-first, excludes Fusion-only logs, and never changes source bytes/mtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-core-'));
  try {
    const older = makeRun(root, 'RUN-OLDER', NOW - 1_000, false);
    makeRun(root, 'RUN-NEWER', NOW, true);
    const fusionDir = join(root, 'FUSION-ONLY');
    mkdirSync(fusionDir);
    const fusion = openEventLog(join(fusionDir, 'events.db'), { now: () => NOW + 10 });
    fusion.append({ runId: 'FUSION-ONLY', taskId: null, type: 'FUSION_PANEL', payload: { panelSize: 2 } });
    fusion.close();

    const beforeHash = sha256(older.dbPath);
    const beforeMtime = statSync(older.dbPath).mtimeMs;
    const port = createControlCenterReadPort({ runsRoot: root, now: () => NOW + 100 });
    const first = port.listRuns({ cursor: null, limit: 1 });
    assert.equal(first.data.page.items[0]?.runId, 'RUN-NEWER');
    assert.equal(first.data.page.items[0]?.lifecycle.status, 'known');
    assert.equal(first.data.totals.activeRuns, 1);
    assert.equal(first.data.totals.pendingApprovals, 2);
    assert.notEqual(first.data.page.nextCursor, null);

    const second = port.listRuns({ cursor: first.data.page.nextCursor, limit: 1 });
    assert.deepEqual(second.data.page.items.map((run) => run.runId), ['RUN-OLDER']);
    assert.equal(second.data.page.nextCursor, null);
    assert.equal(sha256(older.dbPath), beforeHash);
    assert.equal(statSync(older.dbPath).mtimeMs, beforeMtime);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core detail folds graph/state/latest gates/evidence/budget while missing evidence never changes verdict', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-detail-'));
  try {
    const fixture = makeRun(root, 'RUN-DETAIL', NOW, true);
    const port = createControlCenterReadPort({ runsRoot: root, now: () => NOW + 100 });
    const envelope = port.readRun('RUN-DETAIL');
    assert.notEqual(envelope, null);
    if (envelope === null) return;
    assert.equal(envelope.data.summary.taskStates[0]?.currentState.status, 'known');
    assert.equal(envelope.data.summary.currentTaskId.status, 'known');
    assert.equal(envelope.data.summary.currentTaskId.status === 'known' ? envelope.data.summary.currentTaskId.value : null, 'T-1');
    assert.equal(envelope.data.taskGraph.status, 'known');
    if (envelope.data.taskGraph.status === 'known') {
      assert.equal(envelope.data.taskGraph.value.tasks[0]?.title, 'Task one');
      assert.equal(envelope.data.taskGraph.value.tasks[0]?.state.status, 'known');
    }
    const gate = envelope.data.latestGatesByTask['T-1']?.[0];
    assert.equal(gate?.tier, 'T1');
    assert.equal(gate?.verdict, true);
    assert.deepEqual(gate?.evidence.map((item) => item.available), [true, false]);
    assert.equal(gate?.evidence[0]?.ref, fixture.evidenceRef);
    assert.equal(gate?.evidence[1]?.ref, fixture.missingRef);
    assert.ok(envelope.issues.some((issue) => issue.code === 'evidence-unavailable'));
    const budget = envelope.data.budgetsByTask['T-1'];
    assert.equal(budget?.status, 'known');
    if (budget?.status === 'known') {
      assert.deepEqual(budget.value.used, { iterations: 2, costUnits: 3, wallclockMs: 4_000 });
      assert.deepEqual(budget.value.cap, { iterations: 5, costUnits: 10, wallclockMs: 60_000 });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core evidence metadata refuses symlinks without dereferencing them', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-evidence-'));
  try {
    const fixture = makeRun(root, 'RUN-SYMLINK', NOW, false);
    const digest = 'e'.repeat(64);
    const outside = join(root, 'outside-secret');
    writeFileSync(outside, 'must not read');
    symlinkSync(outside, join(fixture.runDir, 'evidence', digest));
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare("INSERT INTO events (ts, run_id, task_id, type, payload) VALUES (?, ?, ?, 'GATE_RESULT', ?)").run(
      new Date(NOW + 500).toISOString(),
      'RUN-SYMLINK',
      'T-1',
      JSON.stringify({ tier: 'T2', pass: false, checks: [{ evidenceRef: `blob://${digest}` }] }),
    );
    db.close();
    const detail = createControlCenterReadPort({ runsRoot: root, now: () => NOW + 1_000 }).readRun('RUN-SYMLINK');
    assert.equal(detail?.data.latestGatesByTask['T-1']?.find((gate) => gate.tier === 'T2')?.verdict, false);
    assert.equal(detail?.data.latestGatesByTask['T-1']?.find((gate) => gate.tier === 'T2')?.evidence[0]?.available, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core event page is seq-ordered, bounded, and removes non-allowlisted payload content', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-events-'));
  try {
    const fixture = makeRun(root, 'RUN-EVENTS', NOW, false);
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare("INSERT INTO events (ts, run_id, task_id, type, payload) VALUES (?, ?, ?, 'ERROR', ?)").run(
      new Date(NOW + 500).toISOString(),
      'RUN-EVENTS',
      'T-1',
      'not-json',
    );
    db.close();
    const port = createControlCenterReadPort({ runsRoot: root, now: () => NOW + 1_000 });
    const first = port.readRunEvents({ runId: 'RUN-EVENTS', after: 0, limit: 7 });
    assert.notEqual(first, null);
    if (first === null) return;
    assert.deepEqual(first.data.items.map((event) => event.seq), [...first.data.items.map((event) => event.seq)].sort((a, b) => a - b));
    const action = first.data.items.find((event) => event.type === 'ACTION_APPLIED');
    assert.deepEqual(action?.fields, {});
    assert.deepEqual(action?.redactedFields, ['nested', 'output', 'path']);
    assert.notEqual(first.data.nextCursor, null);
    const next = port.readRunEvents({ runId: 'RUN-EVENTS', after: Number(first.data.nextCursor), limit: 10 });
    assert.equal(next?.data.items[0]?.type, 'ERROR');
    assert.deepEqual(next?.data.items[0]?.redactedFields, ['payload']);
    assert.ok(next?.issues.some((issue) => issue.code === 'invalid-record'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core routes validate pagination, return 404 for missing runs, and expose no mutation route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-routes-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'control-center-data-'));
  makeRun(root, 'RUN-ROUTE', NOW, false);
  const app = buildApp({
    homeDir: root,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir,
    now: () => NOW,
    controlCenter: createControlCenterReadPort({ runsRoot: root, now: () => NOW }),
  });
  try {
    const list = await app.inject({ method: 'GET', url: '/api/control-center/core/runs?limit=1', headers: HOST });
    assert.equal(list.statusCode, 200);
    assert.doesNotMatch(list.body, /top-secret/u);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/core/runs?limit=0', headers: HOST })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/core/runs?cursor=bad', headers: HOST })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/core/runs/MISSING', headers: HOST })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/core/runs/RUN-ROUTE/events?after=-1', headers: HOST })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/control-center/core/runs', headers: HOST })).statusCode, 404);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('pagination parser accepts defaults/bounds and rejects malformed input', () => {
  assert.equal(parseControlCenterLimit(undefined), 50);
  assert.equal(parseControlCenterLimit('100'), 100);
  assert.equal(parseControlCenterAfter(undefined), 0);
  assert.equal(parseControlCenterAfter('10'), 10);
  assert.throws(() => parseControlCenterLimit('1.5'), InvalidControlCenterQueryError);
  assert.throws(() => parseControlCenterAfter('-1'), InvalidControlCenterQueryError);
});

test('AAL projector folds authoritative records, rejects malformed newest state, and never changes source files', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-aal-'));
  const runsRoot = join(root, 'runs');
  const policiesDir = join(root, 'policies');
  const calibrationDir = join(root, 'calibration');
  mkdirSync(join(runsRoot, 'RUN-AAL'), { recursive: true });
  mkdirSync(policiesDir);
  mkdirSync(calibrationDir);
  const routingPath = join(policiesDir, 'routing.json');
  const fusionPath = join(policiesDir, 'fusion-profiles.json');
  const claudeRecord = join(calibrationDir, 'conformance-claude-2026-08-12T10-00-00-000Z.json');
  writeFileSync(routingPath, JSON.stringify({
    maxSusceptibility: 0.5,
    maxParallel: 2,
    tokenBuckets: {
      claude: { capacity: 4, refillPerSec: 0.5 },
      codex: { capacity: 3, refillPerSec: 0.25 },
    },
    sched: { scriptAllowlist: [] },
  }));
  writeFileSync(fusionPath, JSON.stringify({
    triggers: { plannerRole: true },
    profiles: [{
      artifact: 'plan',
      panel: { size: 2, diversity: { kind: 'cross_lineage', lineages: ['anthropic', 'openai'] } },
      resolve: 'deliberate_synthesis',
      budgetCapCostUnits: 40,
      estimateCostUnitsPerCandidate: 8,
    }],
  }));
  writeFileSync(claudeRecord, JSON.stringify(conformanceRecord('claude', 'sonnet', '2026-08-12T10:00:00.000Z')));
  writeFileSync(
    join(calibrationDir, 'conformance-codex-2026-08-11T10-00-00-000Z.json'),
    JSON.stringify(conformanceRecord('codex', 'gpt-5', '2026-08-11T10:00:00.000Z')),
  );
  writeFileSync(join(calibrationDir, 'conformance-codex-2026-08-12T11-00-00-000Z.json'), '{"adapterId":"codex"}');
  let eventNow = NOW;
  const log = openEventLog(join(runsRoot, 'RUN-AAL', 'events.db'), { now: () => eventNow++ });
  log.append({ runId: 'INNER-ID', taskId: 'T-1', type: 'OUTCOME_ROUTE', payload: { role: 'implementer', order: ['claude@sonnet', 'codex@gpt-5'] } });
  log.append({ runId: 'INNER-ID', taskId: 'T-1', type: 'OUTCOME_ROUTE', payload: { role: 'reviewer', order: ['claude@sonnet'] } });
  log.append({ runId: 'INNER-ID', taskId: 'T-1', type: 'SHADOW_ROUTE', payload: { role: 'reviewer', live: 'claude@sonnet' } });
  log.append({ runId: 'INNER-ID', taskId: 'T-1', type: 'BREAKER_STATE_CHANGED', payload: { key: 'claude@sonnet', from: 'closed', to: 'open', at: NOW } });
  log.append({ runId: 'INNER-ID', taskId: 'T-1', type: 'RATE_LIMIT_OBSERVED', payload: { target: 'claude', policyKey: 'claude', limited: true, availableTokens: 0 } });
  log.append({ runId: 'INNER-ID', taskId: 'T-1', type: 'RATE_LIMIT_OBSERVED', payload: { target: 'codex', policyKey: null, limited: false, availableTokens: null } });
  log.append({ runId: 'INNER-ID', taskId: 'T-1', type: 'FUSION_RESOLVED', payload: { artifact: 'plan', resolved: 'deliberate_synthesis', winner: true } });
  log.append({ runId: 'INNER-ID', taskId: 'T-1', type: 'PLAN_RESOLVED', payload: { winner: true, panelSize: 2, costUnits: 7 } });
  log.close();
  const dbPath = join(runsRoot, 'RUN-AAL', 'events.db');
  const protectedSources = [routingPath, fusionPath, claudeRecord, dbPath].map((path) => ({
    path,
    digest: sha256(path),
    mtimeMs: statSync(path).mtimeMs,
  }));
  try {
    const envelope = createControlCenterReadPort({ runsRoot, policiesDir, calibrationDir, now: () => NOW + 1_000 }).readAal();
    const implementer = envelope.data.roles.find((role) => role.role === 'implementer');
    assert.deepEqual(implementer?.orderedTargets, ['claude@sonnet', 'codex@gpt-5']);
    assert.deepEqual(implementer?.fallbackOrder, ['codex@gpt-5']);
    assert.equal(implementer?.basis, 'recorded');
    assert.equal(implementer?.provenance.source, 'run:RUN-AAL/events.db', 'external directory id is provenance authority');
    assert.equal(envelope.data.roles.find((role) => role.role === 'reviewer')?.basis, 'unknown', 'malformed newest route never falls back');
    const claude = envelope.data.targets.find((target) => target.target === 'claude@sonnet');
    assert.equal(claude?.breaker.status === 'known' ? claude.breaker.value.state : null, 'open');
    assert.equal(claude?.rateLimitPolicy.status === 'known' ? claude.rateLimitPolicy.value.capacity : null, 4);
    assert.equal(claude?.recordedLimitState.status === 'known' ? claude.recordedLimitState.value.limited : null, true);
    assert.equal(claude?.conformance.status === 'known' ? claude.conformance.value.probes.P8 : null, true);
    const codex = envelope.data.targets.find((target) => target.target === 'codex@gpt-5');
    assert.equal(codex?.recordedLimitState.status, 'known', 'no bucket is a valid recorded unlimited state');
    assert.equal(codex?.recordedLimitState.status === 'known' ? codex.recordedLimitState.value.availableTokens : 0, null);
    assert.equal(claude?.conformance.status === 'known' ? claude.conformance.value.p7SusceptibilityScore : null, 0.25);
    assert.match(claude?.conformance.status === 'known' ? claude.conformance.provenance.sourceTimestamp ?? '' : '', /^2026-08-12T10:00:00/u);
    assert.equal(envelope.data.targets.find((target) => target.target === 'codex@gpt-5')?.conformance.status, 'invalid-record');
    assert.equal(envelope.data.fusion.profiles[0]?.panelSize, 2);
    assert.equal(envelope.data.fusion.plannerRoleEnabled, true);
    assert.deepEqual(envelope.data.fusion.latestRun.status === 'known' ? envelope.data.fusion.latestRun.value : null, {
      resolved: 'deliberate_synthesis',
      escalated: false,
      usageCostUnits: 7,
    });
    assert.ok(envelope.issues.some((issue) => issue.field.includes('reviewer')));
    assert.ok(envelope.issues.some((issue) => issue.field === 'aal.conformance.codex'));
    for (const source of protectedSources) {
      assert.equal(sha256(source.path), source.digest);
      assert.equal(statSync(source.path).mtimeMs, source.mtimeMs);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AAL endpoint is GET-only; open and refresh call no CLI or doctor live-I/O paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-aal-route-'));
  const dataDir = join(root, 'data');
  const runsRoot = join(root, 'runs');
  mkdirSync(dataDir);
  mkdirSync(runsRoot);
  let cliCalls = 0;
  let doctorCalls = 0;
  const app = buildApp({
    homeDir: root,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir,
    now: () => NOW,
    cliVersion: () => { cliCalls += 1; return Promise.resolve('forbidden'); },
    doctorCapture: () => { doctorCalls += 1; return Promise.resolve('forbidden'); },
    controlCenter: createControlCenterReadPort({ runsRoot, now: () => NOW }),
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/aal', headers: HOST })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/aal', headers: HOST })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/control-center/aal', headers: HOST })).statusCode, 404);
    assert.equal(cliCalls, 0);
    assert.equal(doctorCalls, 0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Adapter projector paginates static descriptors and keeps health, calibration, and conformance independent', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-adapters-'));
  const runsRoot = join(root, 'runs');
  const policiesDir = join(root, 'policies');
  const calibrationDir = join(root, 'calibration');
  mkdirSync(join(runsRoot, 'RUN-ADAPTER'), { recursive: true });
  mkdirSync(policiesDir);
  mkdirSync(calibrationDir);
  const automationPath = join(policiesDir, 'automation.json');
  const claudeConformance = join(calibrationDir, 'conformance-claude-2026-08-12T10-00-00-000Z.json');
  const claudeCalibration = join(calibrationDir, 'calibration-claude-2026-08-12T11-00-00-000Z.json');
  writeFileSync(automationPath, JSON.stringify({ autonomousModel: 'sonnet' }));
  writeFileSync(claudeConformance, JSON.stringify(conformanceRecord('claude', 'sonnet', '2026-08-12T10:00:00.000Z')));
  writeFileSync(
    join(calibrationDir, 'conformance-codex-2026-08-11T10-00-00-000Z.json'),
    JSON.stringify(conformanceRecord('codex', 'gpt-5', '2026-08-11T10:00:00.000Z')),
  );
  writeFileSync(join(calibrationDir, 'conformance-codex-2026-08-12T10-00-00-000Z.json'), '{"adapterId":"codex","modelVersion":"gpt-5"}');
  writeFileSync(claudeCalibration, JSON.stringify({
    adapterId: 'claude',
    modelVersion: 'sonnet',
    ranAt: '2026-08-12T11:00:00.000Z',
    recordType: 'held-out',
    outcome: 'measured',
    metrics: { score: 0.9, reproducible: true },
  }));
  writeFileSync(join(calibrationDir, 'calibration-codex-2026-08-11T11-00-00-000Z.json'), JSON.stringify({
    adapterId: 'codex', modelVersion: 'gpt-5', ranAt: '2026-08-11T11:00:00.000Z', recordType: 'held-out', outcome: 'pass', metrics: { score: 1 },
  }));
  writeFileSync(join(calibrationDir, 'calibration-codex-2026-08-12T12-00-00-000Z.json'), JSON.stringify({
    adapterId: 'codex', modelVersion: 'gpt-5', ranAt: '2026-08-12T12:00:00.000Z', recordType: 'held-out', outcome: 'pass', metrics: { apiKey: 'super-secret' },
  }));
  let eventNow = NOW;
  const log = openEventLog(join(runsRoot, 'RUN-ADAPTER', 'events.db'), { now: () => eventNow++ });
  log.append({ runId: 'RUN-ADAPTER', taskId: 'T-1', type: 'QUOTA_PROBE', payload: { adapterId: 'claude', ok: true, reason: null, estimate: true } });
  log.append({ runId: 'RUN-ADAPTER', taskId: 'T-1', type: 'QUOTA_PROBE', payload: { adapterId: 'codex', ok: true, reason: null, estimate: true } });
  log.append({ runId: 'RUN-ADAPTER', taskId: 'T-1', type: 'QUOTA_PROBE', payload: { adapterId: 'codex', ok: 'yes', reason: null } });
  log.close();
  const dbPath = join(runsRoot, 'RUN-ADAPTER', 'events.db');
  const protectedSources = [automationPath, claudeConformance, claudeCalibration, dbPath].map((path) => ({ path, digest: sha256(path), mtimeMs: statSync(path).mtimeMs }));
  try {
    const port = createControlCenterReadPort({
      runsRoot,
      policiesDir,
      calibrationDir,
      adapterDescriptors: STATIC_ADAPTERS,
      adapterModelEnvironment: MODEL_ENVIRONMENT,
      now: () => NOW + 2_000,
    });
    const first = port.listAdapters({ cursor: null, limit: 2 });
    assert.deepEqual(first.data.items.map((adapter) => adapter.id), ['claude', 'codex']);
    assert.notEqual(first.data.nextCursor, null);
    const second = port.listAdapters({ cursor: first.data.nextCursor, limit: 2 });
    assert.deepEqual(second.data.items.map((adapter) => adapter.id), ['gemini-cli', 'opencode-deepseek']);
    const claude = port.readAdapter('claude');
    assert.equal(claude?.data.registrationEligibility.state, 'eligible');
    assert.equal(claude?.data.manifest.lineage, 'anthropic');
    assert.equal(claude?.data.health.status === 'known' ? claude.data.health.value.ok : null, true);
    assert.equal(claude?.data.calibration.status === 'known' ? claude.data.calibration.value.metrics['score'] : null, 0.9);
    assert.equal(claude?.data.conformance.status === 'known' ? claude.data.conformance.value.probes.P8 : null, true);
    assert.equal(claude?.data.modelMappings.find((mapping) => mapping.context === 'autonomous-loop' && mapping.role === 'implementer')?.model, 'sonnet');
    assert.equal(claude?.data.modelMappings.find((mapping) => mapping.context === 'pr-quality')?.model, 'claude-review');
    assert.equal(port.readAdapter('codex')?.data.health.status, 'invalid-record', 'malformed newest health never falls back');
    assert.equal(port.readAdapter('codex')?.data.calibration.status, 'invalid-record', 'sensitive newest calibration is rejected, not exposed or replaced by older pass');
    assert.equal(port.readAdapter('codex')?.data.conformance.status, 'invalid-record', 'malformed newest conformance never falls back');
    assert.equal(port.readAdapter('codex')?.data.registrationEligibility.state, 'unknown', 'invalid conformance never decides eligibility');
    assert.equal(port.readAdapter('gemini-cli')?.data.health.status, 'unknown');
    assert.equal(port.readAdapter('gemini-cli')?.data.calibration.status, 'unknown');
    assert.equal(port.readAdapter('gemini-cli')?.data.conformance.status, 'unknown');
    assert.equal(port.readAdapter('missing'), null);
    assert.doesNotMatch(JSON.stringify([first, second, port.readAdapter('codex')]), /super-secret|apiKey/u);
    for (const source of protectedSources) {
      assert.equal(sha256(source.path), source.digest);
      assert.equal(statSync(source.path).mtimeMs, source.mtimeMs);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Adapter routes are GET-only and selection/refresh invoke no CLI, doctor, or transport path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-adapter-routes-'));
  const dataDir = join(root, 'data');
  const runsRoot = join(root, 'runs');
  mkdirSync(dataDir);
  mkdirSync(runsRoot);
  let cliCalls = 0;
  let doctorCalls = 0;
  const app = buildApp({
    homeDir: root,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir,
    now: () => NOW,
    cliVersion: () => { cliCalls += 1; return Promise.resolve('forbidden'); },
    doctorCapture: () => { doctorCalls += 1; return Promise.resolve('forbidden'); },
    controlCenter: createControlCenterReadPort({ runsRoot, adapterDescriptors: STATIC_ADAPTERS, now: () => NOW }),
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/adapters?limit=2', headers: HOST })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/adapters/claude', headers: HOST })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/adapters/missing', headers: HOST })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/control-center/adapters?cursor=bad', headers: HOST })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/control-center/adapters/claude', headers: HOST })).statusCode, 404);
    assert.equal(cliCalls, 0);
    assert.equal(doctorCalls, 0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Dashboard health projection reports injected composition flags without invoking diagnostic commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-center-health-'));
  const dataDir = join(root, 'data');
  const runsRoot = join(root, 'runs');
  mkdirSync(dataDir);
  mkdirSync(runsRoot);
  let cliCalls = 0;
  let doctorCalls = 0;
  const controlCenter = createControlCenterReadPort({
    runsRoot,
    services: {
      terminal: { status: 'policy-disabled', reason: 'loopback only' },
      chat: { status: 'available', reason: null },
      loop: { status: 'available', reason: null },
      scheduler: { status: 'unavailable', reason: 'not configured' },
      prQuality: { status: 'available', reason: null },
    },
    now: () => NOW,
  });
  const app = buildApp({
    homeDir: root,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir,
    now: () => NOW,
    cliVersion: () => { cliCalls += 1; return Promise.resolve('forbidden'); },
    doctorCapture: () => { doctorCalls += 1; return Promise.resolve('forbidden'); },
    controlCenter,
  });
  try {
    const direct = controlCenter.readServiceHealth();
    assert.equal(direct.data.console, 'available');
    assert.equal(direct.data.services.terminal.status, 'policy-disabled');
    assert.equal(direct.data.services.scheduler.status, 'unavailable');
    const response = await app.inject({ method: 'GET', url: '/api/control-center/health', headers: HOST });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<{ data: { services: { chat: { status: string } } } }>().data.services.chat.status, 'available');
    assert.equal(cliCalls, 0);
    assert.equal(doctorCalls, 0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
