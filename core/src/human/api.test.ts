// RED (handler + server throw NotImplemented) -> GREEN same task. REQ-10.
// The pure handler is tested directly; a small server smoke proves loopback bind
// + token file + one real request.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHumanPlaneServer, handleHumanRequest, type HandlerDeps, type HttpLike } from './api.ts';
import { openEventLog } from '../state/event-log.ts';
import type { ApprovalPackage } from './approval.ts';
import type { DeployState } from '../deploy/stage.ts';

function pkg(): ApprovalPackage {
  return {
    id: 'A-1',
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

function deployPkg(): ApprovalPackage {
  return {
    id: 'deploy-T-1',
    taskId: 'T-1',
    runId: 'RUN-1',
    goalExcerpt: 'g',
    acIds: ['AC-1'],
    diffRef: 'sha-merge-commit',
    evidence: { gateReports: ['blob://g'], worktreeHash: 'h' },
    assumptions: ['network: none (simulation)'],
    unresolvedRisks: [],
    attestations: [
      'I reviewed the diff',
      'Tests cover the change',
      'I verified the security/permission impact',
      'I confirmed no secret or credential change',
      'I confirmed this is recoverable OR has an explicit rollback + backup',
    ],
    riskClass: 'L4',
    createdAt: 1,
  };
}

function deps(over?: Partial<HandlerDeps>) {
  const root = mkdtempSync(join(tmpdir(), 'hp-'));
  const log = openEventLog(join(root, 'e.db'), { now: () => 1 });
  const decisions: string[] = [];
  let killed = false;
  const base: HandlerDeps = {
    runId: 'RUN-1',
    token: 'secret-token',
    approvals: new Map([['A-1', pkg()]]),
    log,
    onDecision: (taskId, decision) => {
      decisions.push(`${taskId}:${decision}`);
      return { ok: true, state: decision === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED' };
    },
    onKill: () => { killed = true; },
    rateOk: () => true,
    ...over,
  };
  return { d: base, log, decisions, killed: () => killed, cleanup: () => { log.close(); rmSync(root, { recursive: true, force: true }); } };
}

const auth = (token = 'secret-token') => ({ authorization: `Bearer ${token}` });
const httpReq = (o: Partial<HttpLike>): HttpLike => ({ method: 'GET', path: '/approvals', headers: {}, body: '', ...o });

test('missing/wrong token -> generic 401 (REQ-10.6)', () => {
  const h = deps();
  try {
    assert.equal(handleHumanRequest(httpReq({ headers: {} }), h.d).status, 401);
    assert.equal(handleHumanRequest(httpReq({ headers: auth('nope') }), h.d).status, 401);
  } finally { h.cleanup(); }
});

test('GET /approvals lists pending packages', () => {
  const h = deps();
  try {
    const r = handleHumanRequest(httpReq({ path: '/approvals', headers: auth() }), h.d);
    assert.equal(r.status, 200);
    assert.equal((r.body as ApprovalPackage[]).length, 1);
  } finally { h.cleanup(); }
});

test('approve with complete attestations -> APPROVAL_RECORDED + transition (REQ-10.2)', () => {
  const h = deps();
  try {
    const body = JSON.stringify({ decision: 'approve', attestations: ['I reviewed the diff', 'Tests cover the change'] });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/approvals/A-1', headers: auth(), body }), h.d);
    assert.equal(r.status, 200);
    assert.deepEqual(h.decisions, ['T-1:approve']);
    assert.equal(h.log.all({ type: 'APPROVAL_RECORDED' }).length, 1);
  } finally { h.cleanup(); }
});

test('approve with incomplete attestations -> 400, no transition (REQ-9.3)', () => {
  const h = deps();
  try {
    const body = JSON.stringify({ decision: 'approve', attestations: ['I reviewed the diff'] });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/approvals/A-1', headers: auth(), body }), h.d);
    assert.equal(r.status, 400);
    assert.equal(h.decisions.length, 0);
  } finally { h.cleanup(); }
});

test('GET /approvals also lists governance proposals when the plane is present (REQ-9.4)', () => {
  const h = deps({
    governanceProposals: () => [
      { id: 'gov-1', kind: 'policy_change', beforeHash: null, afterHash: 'x', rationale: 'r' },
    ],
  });
  try {
    const r = handleHumanRequest(httpReq({ path: '/approvals', headers: auth() }), h.d);
    assert.equal(r.status, 200);
    const body = r.body as Array<{ kind?: string }>;
    assert.equal(body.length, 2); // one task package + one governance proposal
    assert.equal(body.some((x) => x.kind === 'policy_change'), true);
  } finally { h.cleanup(); }
});

test('POST governance approval routes to onGovernanceApprove, never onDecision (REQ-9.4)', () => {
  const approved: string[] = [];
  const h = deps({
    onGovernanceApprove: (id) => {
      approved.push(id);
      return { ok: true, kind: 'flaky_quarantine' };
    },
  });
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/approvals/gov-9', headers: auth(), body: '' }), h.d);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { kind: 'flaky_quarantine' });
    assert.deepEqual(approved, ['gov-9']);
    assert.equal(h.decisions.length, 0); // governance never fires a task transition
    assert.equal(h.log.all({ type: 'APPROVAL_RECORDED' }).length, 0); // nor a task approval record
  } finally { h.cleanup(); }
});

test('unknown governance id -> 404 no_such_approval (REQ-9.4)', () => {
  const h = deps({ onGovernanceApprove: () => ({ ok: false, detail: 'no_such_proposal' }) });
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/approvals/gov-nope', headers: auth(), body: '' }), h.d);
    assert.equal(r.status, 404);
  } finally { h.cleanup(); }
});

test('unknown id with no governance plane -> 404 (Phase-1 behavior preserved)', () => {
  const h = deps();
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/approvals/nope', headers: auth(), body: '' }), h.d);
    assert.equal(r.status, 404);
  } finally { h.cleanup(); }
});

test('steering endpoints -> 501 when the plane exposes no steering (Phase-1 server unchanged)', () => {
  const h = deps();
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/pause', headers: auth() }), h.d);
    assert.equal(r.status, 501);
  } finally { h.cleanup(); }
});

function steerDeps(over?: Partial<HandlerDeps>) {
  const calls: string[] = [];
  let state: import('../types.ts').TaskState = 'IMPLEMENTING';
  const h = deps({
    steeringState: () => state,
    onPause: () => { calls.push('pause'); },
    onResume: () => { calls.push('resume'); },
    onInject: (g, opts) => { calls.push(`inject:${g}:${opts.atNextBoundary}`); return { ok: true, evidenceRef: 'blob://guid' }; },
    ...over,
  });
  return { ...h, calls, setState: (s: import('../types.ts').TaskState) => { state = s; } };
}

test('POST /steering/pause when steerable -> 202 pause_requested + signals control (REQ-10.1)', () => {
  const h = steerDeps();
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/pause', headers: auth() }), h.d);
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { state: 'pause_requested' });
    assert.deepEqual(h.calls, ['pause']);
  } finally { h.cleanup(); }
});

test('POST /steering/inject legal ONLY in PAUSED — 409 otherwise (REQ-10.4)', () => {
  const h = steerDeps();
  try {
    const notPaused = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/inject', headers: auth(), body: JSON.stringify({ guidance: 'g' }) }), h.d);
    assert.equal(notPaused.status, 409);
    h.setState('PAUSED');
    const paused = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/inject', headers: auth(), body: JSON.stringify({ guidance: 'try X' }) }), h.d);
    assert.equal(paused.status, 202);
    assert.deepEqual(paused.body, { evidenceRef: 'blob://guid' });
    assert.deepEqual(h.calls, ['inject:try X:false'], 'PAUSED path is immediate mode (atNextBoundary:false)');
  } finally { h.cleanup(); }
});

test('POST /steering/inject atNextBoundary:true in a steerable non-PAUSED state -> 202 queued (REQ-17.1)', () => {
  const h = steerDeps();
  try {
    const body = JSON.stringify({ guidance: 'try Y', atNextBoundary: true });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/inject', headers: auth(), body }), h.d);
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { queued: true, evidenceRef: 'blob://guid' });
    assert.deepEqual(h.calls, ['inject:try Y:true'], 'the queue path is mode next_boundary (atNextBoundary:true)');
  } finally { h.cleanup(); }
});

test('POST /steering/inject atNextBoundary:true from a non-steerable state -> still 409 (REQ-17.1 scope)', () => {
  const h = steerDeps();
  try {
    h.setState('MERGE_QUEUED'); // past the last boundary — no steering window exists (REQ-10.8)
    const body = JSON.stringify({ guidance: 'try Z', atNextBoundary: true });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/inject', headers: auth(), body }), h.d);
    assert.equal(r.status, 409);
    assert.deepEqual(h.calls, [], 'no queue call for a state with no boundary');
  } finally { h.cleanup(); }
});

test('POST /steering/inject atNextBoundary absent, non-PAUSED -> unchanged 409 (REQ-17.5)', () => {
  const h = steerDeps();
  try {
    const body = JSON.stringify({ guidance: 'try W' }); // atNextBoundary omitted entirely
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/inject', headers: auth(), body }), h.d);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: 'not_paused', state: 'IMPLEMENTING' });
    assert.deepEqual(h.calls, []);
  } finally { h.cleanup(); }
});

test('POST /steering/resume -> 202 resumed + signals control (REQ-10.3)', () => {
  const h = steerDeps();
  try {
    h.setState('PAUSED');
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/resume', headers: auth() }), h.d);
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { state: 'resumed' });
    assert.deepEqual(h.calls, ['resume']);
  } finally { h.cleanup(); }
});

test('steering from MERGE_QUEUED onward -> 409 structured, no boundary exists (REQ-10.8)', () => {
  const h = steerDeps();
  try {
    for (const s of ['MERGE_QUEUED', 'AUDITED', 'COMPLETED'] as const) {
      h.setState(s);
      const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/pause', headers: auth() }), h.d);
      assert.equal(r.status, 409, `pause refused in ${s}`);
      assert.equal((r.body as { state?: string }).state, s);
    }
    assert.deepEqual(h.calls, [], 'the control port is never signaled for a non-steerable state');
  } finally { h.cleanup(); }
});

test('inject with no guidance body -> 400 (REQ-10.5)', () => {
  const h = steerDeps();
  try {
    h.setState('PAUSED');
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/inject', headers: auth(), body: '{}' }), h.d);
    assert.equal(r.status, 400);
  } finally { h.cleanup(); }
});

test('a task-approval decision arriving while PAUSED -> 409, resume first (REQ-10.9)', () => {
  const h = steerDeps();
  try {
    h.setState('PAUSED');
    const body = JSON.stringify({ decision: 'approve', attestations: ['I reviewed the diff', 'Tests cover the change'] });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/approvals/A-1', headers: auth(), body }), h.d);
    assert.equal(r.status, 409);
    assert.equal(h.decisions.length, 0, 'no transition fired while paused');
  } finally { h.cleanup(); }
});

test('POST /kill -> onKill + KILL_REQUESTED (REQ-10.4)', () => {
  const h = deps();
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/kill', headers: auth() }), h.d);
    assert.equal(r.status, 200);
    assert.equal(h.killed(), true);
    assert.equal(h.log.all({ type: 'KILL_REQUESTED' }).length, 1);
  } finally { h.cleanup(); }
});

test('GET /events is redacted (REQ-10.3)', () => {
  const h = deps();
  const key = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  h.log.append({ runId: 'RUN-1', taskId: 'T-1', type: 'ERROR', payload: { leak: key } });
  try {
    const r = handleHumanRequest(httpReq({ path: '/events?since=0', headers: auth() }), h.d);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes(key), 'secret redacted in events projection');
  } finally { h.cleanup(); }
});

test('rate limit -> 429', () => {
  const h = deps({ rateOk: () => false });
  try {
    assert.equal(handleHumanRequest(httpReq({ headers: auth() }), h.d).status, 429);
  } finally { h.cleanup(); }
});

function deployHarness(over?: Partial<HandlerDeps>) {
  const calls: string[] = [];
  let state: DeployState | null = null;
  let approval: ApprovalPackage | null = null;
  const h = deps({
    deployState: () => state,
    deployApproval: () => approval,
    onDeployDecision: (decision) => {
      calls.push(`decision:${decision}`);
      return { ok: true };
    },
    onDeployRollback: () => {
      calls.push('rollback');
      return { ok: true };
    },
    ...over,
  });
  return {
    ...h,
    calls,
    setState: (s: DeployState | null) => {
      state = s;
    },
    setApproval: (p: ApprovalPackage | null) => {
      approval = p;
    },
  };
}

test('GET /deploy -> 501 when deploy is not composed (Phase-1 pattern, REQ-6.3)', () => {
  const h = deps();
  try {
    const r = handleHumanRequest(httpReq({ path: '/deploy', headers: auth() }), h.d);
    assert.equal(r.status, 501);
  } finally { h.cleanup(); }
});

test('GET /deploy -> {state:null, approval:null} when composed but idle (REQ-6.3)', () => {
  const h = deployHarness();
  try {
    const r = handleHumanRequest(httpReq({ path: '/deploy', headers: auth() }), h.d);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { state: null, approval: null });
  } finally { h.cleanup(); }
});

test('GET /deploy -> {state, approval} once a deploy package is pending (REQ-6.3)', () => {
  const h = deployHarness();
  try {
    h.setState('PENDING_APPROVAL');
    h.setApproval(deployPkg());
    const r = handleHumanRequest(httpReq({ path: '/deploy', headers: auth() }), h.d);
    assert.equal(r.status, 200);
    const body = r.body as { state: string; approval: ApprovalPackage };
    assert.equal(body.state, 'PENDING_APPROVAL');
    assert.equal(body.approval.id, 'deploy-T-1');
    assert.equal(body.approval.riskClass, 'L4', 'deploy uses L4 attestations, never L2/L3 (architect finding #7)');
  } finally { h.cleanup(); }
});

test('regression: the deploy package never enters GET /approvals, deciding it never calls onDecision (REQ-6.1/6.2, architect finding #1)', () => {
  const h = deployHarness();
  try {
    h.setState('PENDING_APPROVAL');
    h.setApproval(deployPkg());
    const list = handleHumanRequest(httpReq({ path: '/approvals', headers: auth() }), h.d);
    const ids = (list.body as ApprovalPackage[]).map((p) => p.id);
    assert.ok(!ids.includes('deploy-T-1'), 'the deploy package is invisible to the task-approvals list');

    const body = JSON.stringify({ decision: 'approve', attestations: deployPkg().attestations });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/decision', headers: auth(), body }), h.d);
    assert.equal(r.status, 200);
    assert.deepEqual(h.decisions, [], 'deploy decision never routes through onDecision');
    assert.equal(h.log.all({ type: 'APPROVAL_RECORDED' }).length, 0, 'deploy decision is DEPLOY_DECISION, never APPROVAL_RECORDED');
  } finally { h.cleanup(); }
});

test('POST /deploy/decision -> 501 when deploy is not composed', () => {
  const h = deps();
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/decision', headers: auth(), body: '{}' }), h.d);
    assert.equal(r.status, 501);
  } finally { h.cleanup(); }
});

test('POST /deploy/decision -> 404 when no deploy package is pending (REQ-6.6)', () => {
  const h = deployHarness();
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/decision', headers: auth(), body: '{}' }), h.d);
    assert.equal(r.status, 404);
    assert.deepEqual(h.calls, []);
  } finally { h.cleanup(); }
});

test('POST /deploy/decision approve with incomplete attestations -> 400, callback never fires (REQ-6.5)', () => {
  const h = deployHarness();
  try {
    h.setApproval(deployPkg());
    const body = JSON.stringify({ decision: 'approve', attestations: ['I reviewed the diff'] });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/decision', headers: auth(), body }), h.d);
    assert.equal(r.status, 400);
    assert.deepEqual(h.calls, []);
  } finally { h.cleanup(); }
});

test('POST /deploy/decision approve with complete attestations -> DEPLOY_DECISION event + onDeployDecision (REQ-6.4)', () => {
  const h = deployHarness();
  try {
    h.setApproval(deployPkg());
    const body = JSON.stringify({ decision: 'approve', attestations: deployPkg().attestations });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/decision', headers: auth(), body }), h.d);
    assert.equal(r.status, 200);
    assert.deepEqual(h.calls, ['decision:approve']);
    const event = h.log.all({ type: 'DEPLOY_DECISION' }).at(-1);
    assert.equal(event?.payload['decision'], 'approve');
    assert.equal(event?.payload['approvalId'], 'deploy-T-1');
  } finally { h.cleanup(); }
});

test('POST /deploy/decision reject -> DEPLOY_DECISION{decision:reject} + onDeployDecision, no attestation check (REQ-6.7)', () => {
  const h = deployHarness();
  try {
    h.setApproval(deployPkg());
    const body = JSON.stringify({ decision: 'reject' });
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/decision', headers: auth(), body }), h.d);
    assert.equal(r.status, 200);
    assert.deepEqual(h.calls, ['decision:reject']);
    assert.equal(h.log.all({ type: 'DEPLOY_DECISION' }).at(-1)?.payload['decision'], 'reject');
  } finally { h.cleanup(); }
});

test('POST /deploy/rollback -> 501 when deploy is not composed', () => {
  const h = deps();
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/rollback', headers: auth() }), h.d);
    assert.equal(r.status, 501);
  } finally { h.cleanup(); }
});

test('POST /deploy/rollback outside EXPANDED -> 409, callback never fires (REQ-6.9)', () => {
  const h = deployHarness();
  try {
    for (const s of [null, 'CANARY', 'OBSERVING', 'ROLLED_BACK'] as const) {
      h.setState(s);
      const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/rollback', headers: auth() }), h.d);
      assert.equal(r.status, 409, `rollback refused in state ${String(s)}`);
    }
    assert.deepEqual(h.calls, [], 'onDeployRollback never called outside EXPANDED');
  } finally { h.cleanup(); }
});

test('POST /deploy/rollback at EXPANDED -> 200, runs the same rollback callback (REQ-6.8)', () => {
  const h = deployHarness();
  try {
    h.setState('EXPANDED');
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/deploy/rollback', headers: auth() }), h.d);
    assert.equal(r.status, 200);
    assert.deepEqual(h.calls, ['rollback']);
  } finally { h.cleanup(); }
});

test('server smoke: binds loopback, writes human-plane.json 0600, serves one request', async () => {
  const h = deps();
  const root = mkdtempSync(join(tmpdir(), 'hp-srv-'));
  try {
    const { token, ...rest } = h.d;
    void token;
    const srv = await createHumanPlaneServer({ runDir: root, deps: rest });
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback bind');
    const meta = JSON.parse(readFileSync(join(root, 'human-plane.json'), 'utf8'));
    assert.equal(meta.url, srv.url);
    assert.equal(typeof meta.token, 'string');
    const res = await fetch(`${srv.url}/approvals`, { headers: { authorization: `Bearer ${srv.token}` } });
    assert.equal(res.status, 200);
    await srv.close();
  } finally {
    h.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
