// F-Loop REST routes (REQ-15): discovery + Human Plane proxy. Runs a REAL
// createHumanPlaneServer per "live" run (from `core`) so the proxy is proven
// against the actual upstream contract, not a hand-rolled stub.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { makeHome } from '../test/helpers/home-fixture.ts';
import { createHumanPlaneServer, openEventLog, type ApprovalPackage, type EventLog, type HandlerDeps, type HumanPlaneServer } from 'core';

const NOW = Date.parse('2026-01-05T12:00:00Z');
const GOOD_HOST = { host: '127.0.0.1:9119' };

function pkg(id: string): ApprovalPackage {
  return {
    id,
    taskId: 'T-1',
    runId: 'RUN-1',
    goalExcerpt: 'g',
    acIds: ['AC-1'],
    diffRef: 'blob://d',
    evidence: { gateReports: ['blob://g'], worktreeHash: 'h' },
    assumptions: [],
    unresolvedRisks: [],
    attestations: ['I reviewed the diff', 'Tests cover the change'],
    riskClass: 'L2',
    createdAt: 1,
  };
}

function deps(runsRoot: string, over?: Partial<AppDeps>): AppDeps {
  const fix = makeHome();
  const audited: Record<string, unknown>[] = [];
  const d: AppDeps = {
    homeDir: fix.homeDir,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
    loopRunsRoot: runsRoot,
    audit: (e) => audited.push(e),
    ...over,
  };
  return Object.assign(d, { __audited: audited }) as AppDeps & { __audited: typeof audited };
}

interface LiveRun {
  server: HumanPlaneServer;
  log: EventLog;
  approvals: Map<string, ApprovalPackage>;
  calls: string[];
  close(): Promise<void>;
}

async function makeLiveRun(runsRoot: string, runId: string, over?: Partial<HandlerDeps>): Promise<LiveRun> {
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const log = openEventLog(join(runDir, 'e.db'), { now: () => 1 });
  const approvals = new Map<string, ApprovalPackage>([[`${runId}-A1`, pkg(`${runId}-A1`)]]);
  const calls: string[] = [];
  const server = await createHumanPlaneServer({
    runDir,
    deps: {
      runId,
      approvals,
      log,
      onDecision: (taskId, decision) => {
        calls.push(`decision:${taskId}:${decision}`);
        return { ok: true, state: decision === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED' };
      },
      onKill: () => calls.push('kill'),
      rateOk: () => true,
      // A steerable-but-not-PAUSED state: lets an approve decision through (REQ-10.9
      // only blocks while PAUSED) and exercises the REQ-17.1 queue-at-boundary inject
      // path below (immediate-mode inject needs literal PAUSED, proven in core's own
      // api.test.ts — this fixture is about the PROXY forwarding, not re-proving that).
      steeringState: () => 'IMPLEMENTING',
      onPause: () => calls.push('pause'),
      onResume: () => calls.push('resume'),
      onInject: (g) => { calls.push(`inject:${g}`); return { ok: true, evidenceRef: 'blob://guid' }; },
      // Deploy plane (REQ-6) — a SEPARATE surface from approvals/onDecision above; a
      // package is always "pending" in this fixture so the happy-path proxy tests
      // below don't need per-test overrides (mirrors the approvals Map fixture).
      deployState: () => 'PENDING_APPROVAL',
      deployApproval: () => pkg(`${runId}-D1`),
      onDeployDecision: (decision) => {
        calls.push(`deploy_decision:${decision}`);
        return { ok: true };
      },
      onDeployRollback: () => {
        calls.push('deploy_rollback');
        return { ok: true };
      },
      ...over,
    },
  });
  return { server, log, approvals, calls, close: () => server.close() };
}

test('loopRunsRoot absent -> F-Loop routes do not register (mirrors termManager)', async () => {
  const fix = makeHome();
  const app = buildApp({ homeDir: fix.homeDir, env: {}, bindHost: '127.0.0.1', port: 9119, dataDir: fix.dataDir, now: () => NOW });
  try {
    const r = await app.inject({ method: 'GET', url: '/api/loop/runs', headers: GOOD_HOST });
    assert.equal(r.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('GET /api/loop/runs on an empty runsRoot -> {runs: []} (REQ-15.1)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const app = buildApp(deps(runsRoot));
  try {
    const r = await app.inject({ method: 'GET', url: '/api/loop/runs', headers: GOOD_HOST });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { runs: [] });
  } finally {
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('GET /api/loop/runs lists live + ended runs, never leaks the Bearer token (REQ-15.1/15.3/15.6)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  mkdirSync(join(runsRoot, 'RUN-ENDED')); // absent discovery file -> ended (REQ-15.6)
  const app = buildApp(deps(runsRoot));
  try {
    const r = await app.inject({ method: 'GET', url: '/api/loop/runs', headers: GOOD_HOST });
    assert.equal(r.statusCode, 200);
    const runs = (r.json() as { runs: { runId: string; ended: boolean }[] }).runs;
    assert.deepEqual(
      [...runs].sort((a, b) => a.runId.localeCompare(b.runId)),
      [{ runId: 'RUN-ENDED', ended: true }, { runId: 'RUN-LIVE', ended: false }],
    );
    assert.ok(!r.body.includes(live.server.token), 'the Bearer token never appears in a client-visible payload');
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('GET /api/loop/:run/approvals: unknown run -> 404; ended run -> 409; live run -> proxied 200 (REQ-15.2/15.6)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  mkdirSync(join(runsRoot, 'RUN-ENDED'));
  const app = buildApp(deps(runsRoot));
  try {
    const unknown = await app.inject({ method: 'GET', url: '/api/loop/nope/approvals', headers: GOOD_HOST });
    assert.equal(unknown.statusCode, 404);

    const ended = await app.inject({ method: 'GET', url: '/api/loop/RUN-ENDED/approvals', headers: GOOD_HOST });
    assert.equal(ended.statusCode, 409);
    assert.deepEqual(ended.json(), { error: 'run_ended' });

    const ok = await app.inject({ method: 'GET', url: '/api/loop/RUN-LIVE/approvals', headers: GOOD_HOST });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.json() as unknown[]).length, 1);
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('POST /api/loop/:run/approvals/:id: approves through the proxy + records a local-operator audit entry (REQ-15.4/15.10)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  const d = deps(runsRoot) as AppDeps & { __audited: Record<string, unknown>[] };
  const app = buildApp(d);
  try {
    const body = { decision: 'approve', attestations: ['I reviewed the diff', 'Tests cover the change'] };
    const r = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/approvals/RUN-LIVE-A1', headers: GOOD_HOST, payload: body });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(live.calls, ['decision:T-1:approve']);
    assert.deepEqual(d.__audited, [
      { at: NOW, event: 'loop_approval', run: 'RUN-LIVE', approvalId: 'RUN-LIVE-A1', principal: 'local-operator', method: 'none' },
    ]);
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('POST approve with a bad id -> proxied 404, no audit entry (audit fires only on success, REQ-15.4)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  const d = deps(runsRoot) as AppDeps & { __audited: Record<string, unknown>[] };
  const app = buildApp(d);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/approvals/no-such-id', headers: GOOD_HOST, payload: { decision: 'approve', attestations: [] } });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(d.__audited, []);
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('GET /api/loop/:run/events?since= filters by seq (REQ-15.8, since-based pagination at the proxy)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  live.log.append({ runId: 'RUN-LIVE', taskId: 'T-1', type: 'TASK_STATE', payload: { state: 'IMPLEMENTING' } });
  live.log.append({ runId: 'RUN-LIVE', taskId: 'T-1', type: 'TASK_STATE', payload: { state: 'VERIFYING' } });
  const app = buildApp(deps(runsRoot));
  try {
    const all = await app.inject({ method: 'GET', url: '/api/loop/RUN-LIVE/events', headers: GOOD_HOST });
    const allEvents = all.json() as { seq: number }[];
    assert.equal(allEvents.length, 2);
    const lastSeq = allEvents[0]?.seq ?? 0;

    const since = await app.inject({ method: 'GET', url: `/api/loop/RUN-LIVE/events?since=${lastSeq}`, headers: GOOD_HOST });
    const filtered = since.json() as { seq: number }[];
    assert.equal(filtered.length, 1);
    assert.ok((filtered[0]?.seq ?? 0) > lastSeq);
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('steering pause/resume/inject proxy + audit on 202; unknown action -> 404 (REQ-15.4)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  const d = deps(runsRoot) as AppDeps & { __audited: Record<string, unknown>[] };
  const app = buildApp(d);
  try {
    const pause = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/steering/pause', headers: GOOD_HOST });
    assert.equal(pause.statusCode, 202);

    const inject = await app.inject({
      method: 'POST',
      url: '/api/loop/RUN-LIVE/steering/inject',
      headers: GOOD_HOST,
      payload: { guidance: 'try X', atNextBoundary: true }, // REQ-17.1 queue path — fixture state is IMPLEMENTING, not PAUSED
    });
    assert.equal(inject.statusCode, 202);
    assert.deepEqual(inject.json(), { queued: true, evidenceRef: 'blob://guid' });

    const resume = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/steering/resume', headers: GOOD_HOST });
    assert.equal(resume.statusCode, 202);

    const bogus = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/steering/bogus', headers: GOOD_HOST });
    assert.equal(bogus.statusCode, 404);

    assert.deepEqual(live.calls, ['pause', 'inject:try X', 'resume']);
    assert.deepEqual(
      d.__audited.map((e) => e['event']),
      ['loop_steer_pause', 'loop_steer_inject', 'loop_steer_resume'],
    );
    assert.ok(d.__audited.every((e) => e['principal'] === 'local-operator' && e['method'] === 'none'));
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('POST /api/loop/:run/kill proxies + audits (REQ-15.4)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  const d = deps(runsRoot) as AppDeps & { __audited: Record<string, unknown>[] };
  const app = buildApp(d);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/kill', headers: GOOD_HOST });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(live.calls, ['kill']);
    assert.equal(d.__audited.length, 1);
    assert.equal(d.__audited[0]?.['event'], 'loop_kill');
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('GET /api/loop/:run/deploy: unknown run -> 404; ended run -> 409; live run -> proxied 200 (REQ-15.2/15.6, REQ-6.3)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  mkdirSync(join(runsRoot, 'RUN-ENDED'));
  const app = buildApp(deps(runsRoot));
  try {
    const unknown = await app.inject({ method: 'GET', url: '/api/loop/nope/deploy', headers: GOOD_HOST });
    assert.equal(unknown.statusCode, 404);

    const ended = await app.inject({ method: 'GET', url: '/api/loop/RUN-ENDED/deploy', headers: GOOD_HOST });
    assert.equal(ended.statusCode, 409);
    assert.deepEqual(ended.json(), { error: 'run_ended' });

    const ok = await app.inject({ method: 'GET', url: '/api/loop/RUN-LIVE/deploy', headers: GOOD_HOST });
    assert.equal(ok.statusCode, 200);
    const body = ok.json() as { state: string; approval: { id: string } };
    assert.equal(body.state, 'PENDING_APPROVAL');
    assert.equal(body.approval.id, 'RUN-LIVE-D1');
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('POST /api/loop/:run/deploy/decision: proxies through + records a local-operator audit entry (REQ-15.4/15.10, REQ-6.4)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE');
  const d = deps(runsRoot) as AppDeps & { __audited: Record<string, unknown>[] };
  const app = buildApp(d);
  try {
    const body = { decision: 'approve', attestations: ['I reviewed the diff', 'Tests cover the change'] };
    const r = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/deploy/decision', headers: GOOD_HOST, payload: body });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(live.calls, ['deploy_decision:approve']);
    assert.deepEqual(d.__audited, [
      { at: NOW, event: 'loop_deploy_decision', run: 'RUN-LIVE', principal: 'local-operator', method: 'none' },
    ]);
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('POST /api/loop/:run/deploy/rollback: proxies through + audits on success (REQ-15.4, REQ-6.8)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE', { deployState: () => 'EXPANDED' });
  const d = deps(runsRoot) as AppDeps & { __audited: Record<string, unknown>[] };
  const app = buildApp(d);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/deploy/rollback', headers: GOOD_HOST });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(live.calls, ['deploy_rollback']);
    assert.equal(d.__audited.length, 1);
    assert.equal(d.__audited[0]?.['event'], 'loop_deploy_rollback');
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('POST /api/loop/:run/deploy/rollback outside EXPANDED -> proxied 409, no audit (REQ-6.9)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  const live = await makeLiveRun(runsRoot, 'RUN-LIVE', { deployState: () => 'CANARY' });
  const d = deps(runsRoot) as AppDeps & { __audited: Record<string, unknown>[] };
  const app = buildApp(d);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/loop/RUN-LIVE/deploy/rollback', headers: GOOD_HOST });
    assert.equal(r.statusCode, 409);
    assert.deepEqual(live.calls, [], 'the callback never fires outside EXPANDED');
    assert.deepEqual(d.__audited, []);
  } finally {
    await live.close();
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('mutations on an ended run -> 409, upstream never called (REQ-15.6)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  mkdirSync(join(runsRoot, 'RUN-ENDED'));
  const app = buildApp(deps(runsRoot));
  try {
    const kill = await app.inject({ method: 'POST', url: '/api/loop/RUN-ENDED/kill', headers: GOOD_HOST });
    assert.equal(kill.statusCode, 409);
    const pause = await app.inject({ method: 'POST', url: '/api/loop/RUN-ENDED/steering/pause', headers: GOOD_HOST });
    assert.equal(pause.statusCode, 409);
    const approve = await app.inject({ method: 'POST', url: '/api/loop/RUN-ENDED/approvals/x', headers: GOOD_HOST, payload: { decision: 'approve' } });
    assert.equal(approve.statusCode, 409);
    const deployDecision = await app.inject({ method: 'POST', url: '/api/loop/RUN-ENDED/deploy/decision', headers: GOOD_HOST, payload: { decision: 'approve' } });
    assert.equal(deployDecision.statusCode, 409);
    const deployRollback = await app.inject({ method: 'POST', url: '/api/loop/RUN-ENDED/deploy/rollback', headers: GOOD_HOST });
    assert.equal(deployRollback.statusCode, 409);
  } finally {
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('present-but-unreachable run -> 502 human_plane_unreachable, distinct from the 409 ended path (REQ-15.5)', async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'loop-runs-'));
  mkdirSync(join(runsRoot, 'RUN-DEAD'));
  // A discovery file that LOOKS live but points at nothing listening.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(runsRoot, 'RUN-DEAD', 'human-plane.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'tok' }));
  const app = buildApp(deps(runsRoot));
  try {
    const r = await app.inject({ method: 'GET', url: '/api/loop/RUN-DEAD/approvals', headers: GOOD_HOST });
    assert.equal(r.statusCode, 502);
    assert.deepEqual(r.json(), { upstream: 'human_plane_unreachable' });
  } finally {
    await app.close();
    rmSync(runsRoot, { recursive: true, force: true });
  }
});
