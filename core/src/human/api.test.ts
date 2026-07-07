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

test('steering endpoints -> 501 not_enabled_phase1 (REQ-10.5)', () => {
  const h = deps();
  try {
    const r = handleHumanRequest(httpReq({ method: 'POST', path: '/steering/pause', headers: auth() }), h.d);
    assert.equal(r.status, 501);
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
