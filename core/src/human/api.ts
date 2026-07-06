// Human Plane API (spec §10.3, REQ-10) on the node:http builtin (no framework in
// Ring 0). Loopback-only, bearer token, hand-rolled rate limit, core-own redaction
// on event projections. Vendor-neutral: serves core data, names no client. The
// pure request handler is separated from the socket so it is unit-testable.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { redactSecrets } from './redact.ts';
import type { EventLog } from '../state/event-log.ts';
import type { ApprovalPackage } from './approval.ts';

export interface HandlerDeps {
  runId: string;
  token: string;
  approvals: Map<string, ApprovalPackage>;
  log: EventLog;
  onDecision(taskId: string, decision: 'approve' | 'reject'): { ok: boolean; state?: string; detail?: string };
  onKill(): void;
  rateOk(): boolean;
}

export interface HttpLike {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpResult {
  status: number;
  body: unknown;
}

function authed(req: HttpLike, token: string): boolean {
  return req.headers['authorization'] === `Bearer ${token}`;
}

export function handleHumanRequest(req: HttpLike, deps: HandlerDeps): HttpResult {
  if (!deps.rateOk()) return { status: 429, body: { error: 'rate_limited' } };
  if (!authed(req, deps.token)) return { status: 401, body: { error: 'unauthorized' } };

  const path = req.path.split('?')[0] ?? req.path;

  if (req.method === 'GET' && path === '/approvals') {
    return { status: 200, body: [...deps.approvals.values()] };
  }

  if (req.method === 'POST' && path.startsWith('/approvals/')) {
    const id = path.slice('/approvals/'.length);
    const pkg = deps.approvals.get(id);
    if (pkg === undefined) return { status: 404, body: { error: 'no_such_approval' } };
    let parsed: { decision?: unknown; attestations?: unknown };
    try {
      parsed = JSON.parse(req.body) as typeof parsed;
    } catch {
      return { status: 400, body: { error: 'bad_json' } };
    }
    const decision = parsed.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return { status: 400, body: { error: 'decision must be approve|reject' } };
    }
    if (decision === 'approve') {
      const given = new Set(Array.isArray(parsed.attestations) ? parsed.attestations.map(String) : []);
      const complete = pkg.attestations.every((a) => given.has(a));
      if (!complete) return { status: 400, body: { error: 'attestations_incomplete' } };
    }
    deps.log.append({
      runId: deps.runId,
      taskId: pkg.taskId,
      type: 'APPROVAL_RECORDED',
      payload: { approvalId: id, decision },
    });
    const res = deps.onDecision(pkg.taskId, decision);
    if (!res.ok) return { status: 409, body: { error: res.detail ?? 'transition_refused' } };
    deps.approvals.delete(id);
    return { status: 200, body: { state: res.state } };
  }

  if (req.method === 'GET' && path === '/events') {
    const events = deps.log.all();
    const redacted = JSON.parse(redactSecrets(JSON.stringify(events)));
    return { status: 200, body: redacted };
  }

  if (req.method === 'POST' && path === '/kill') {
    deps.log.append({ runId: deps.runId, taskId: null, type: 'KILL_REQUESTED', payload: {} });
    deps.onKill();
    return { status: 200, body: { killed: true } };
  }

  if (req.method === 'POST' && path.startsWith('/steering/')) {
    return { status: 501, body: { error: 'not_enabled_phase1', detail: 'steering arrives in Phase 2' } };
  }

  return { status: 404, body: { error: 'not_found' } };
}

export interface HumanPlaneServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

export interface ServerOptions {
  runDir: string;
  deps: Omit<HandlerDeps, 'token'>;
}

export async function createHumanPlaneServer(opts: ServerOptions): Promise<HumanPlaneServer> {
  const token = randomBytes(24).toString('hex');
  const deps: HandlerDeps = { ...opts.deps, token };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const result = handleHumanRequest(
        {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers: req.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks).toString('utf8'),
        },
        deps,
      );
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('failed to bind human plane server');
  const url = `http://127.0.0.1:${addr.port}`;

  // Operator discovery: {url, token} at 0600 (REQ-10.1).
  writeFileSync(join(opts.runDir, 'human-plane.json'), JSON.stringify({ url, token }), { mode: 0o600 });

  return {
    url,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
