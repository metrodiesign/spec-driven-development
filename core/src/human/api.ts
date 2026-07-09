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
import type { DeployState } from '../deploy/stage.ts';
import type { GovernanceKind, GovernanceProposal } from '../governance/policy.ts';
import type { TaskState } from '../types.ts';

/**
 * Steering has an iteration boundary only in the pre-merge working states (+ PAUSED);
 * from MERGE_QUEUED onward the merge/audit path is short, deterministic, core-only
 * work with no boundary, so a steering request there is refused rather than silently
 * unreachable (REQ-10.8).
 */
const STEERABLE: ReadonlySet<TaskState> = new Set<TaskState>([
  'PROPOSED', 'ANALYZING', 'READY', 'IMPLEMENTING', 'VERIFYING', 'FAILED',
  'DIAGNOSING', 'REPAIRING', 'PASSED', 'REVIEWING', 'CHANGES_REQUESTED', 'PAUSED',
]);

export interface HandlerDeps {
  runId: string;
  token: string;
  approvals: Map<string, ApprovalPackage>;
  log: EventLog;
  onDecision(taskId: string, decision: 'approve' | 'reject'): { ok: boolean; state?: string; detail?: string };
  onKill(): void;
  rateOk(): boolean;
  /**
   * Governance proposals to also list at GET /approvals (REQ-9.4). Optional so a
   * server started without the governance plane behaves exactly as in Phase 1.
   */
  governanceProposals?(): GovernanceProposal[];
  /**
   * Approve a governance proposal by id (REQ-9.4). `policy_change` appends the change
   * and returns (never calls onDecision); `flaky_quarantine` additionally fires the
   * quarantine transition for its taskId — the callback owns both effects.
   */
  onGovernanceApprove?(id: string): { ok: boolean; kind?: GovernanceKind; detail?: string };
  /**
   * Steering (REQ-10). All optional and wired together by the composition root; a
   * server started without them keeps the Phase-1 501 behavior. `steeringState`
   * reports the current task state so the handler can enforce the pause/inject
   * windows; `onPause`/`onResume` signal the loop control port; `onInject` stores
   * guidance in the evidence store, records GUIDANCE_INJECTED, and queues it for the
   * next round.
   */
  steeringState?(): TaskState;
  onPause?(): void;
  onResume?(): void;
  /**
   * `opts.atNextBoundary` echoes the request (REQ-17.3): PAUSED-immediate inject
   * always passes `false`; the queue-at-boundary path (REQ-17.1) passes `true`. The
   * composition root uses it only to pick the `GUIDANCE_INJECTED` mode label —
   * both paths feed the SAME queue `runTaskLoop` drains at its next boundary.
   */
  onInject?(guidance: string, opts: { atNextBoundary: boolean }): { ok: true; evidenceRef: string } | { ok: false; reason: string };
  /**
   * Deploy approval + Human Plane deploy surface (REQ-6). A SEPARATE path from
   * `onDecision`/`approvals` — the deploy package never enters the task `approvals`
   * Map and its decision never touches the task state machine (COMPLETED stays
   * terminal for tasks; architect finding #1). All optional: a server started
   * without them keeps GET /deploy and POST /deploy/* at the Phase-1 501.
   */
  deployState?(): DeployState | null;
  deployApproval?(): ApprovalPackage | null;
  onDeployDecision?(decision: 'approve' | 'reject'): { ok: boolean; state?: DeployState; detail?: string };
  /** Manual rollback, EXPANDED-only (guarded here, before this is ever called — REQ-6.9). */
  onDeployRollback?(): { ok: boolean; detail?: string };
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
    // Governance proposals (REQ-9.4) are listed alongside task approval packages;
    // a consumer tells them apart by the presence of `kind`.
    return { status: 200, body: [...deps.approvals.values(), ...(deps.governanceProposals?.() ?? [])] };
  }

  if (req.method === 'POST' && path.startsWith('/approvals/')) {
    const id = path.slice('/approvals/'.length);
    const pkg = deps.approvals.get(id);
    if (pkg === undefined) {
      // Not a task package — maybe a governance proposal (REQ-9.4). Handled by kind
      // inside the callback: policy_change appends only; flaky_quarantine also
      // quarantines. onDecision (task transitions) is never called for governance.
      if (deps.onGovernanceApprove !== undefined) {
        const res = deps.onGovernanceApprove(id);
        if (res.ok) return { status: 200, body: { kind: res.kind } };
        if (res.detail === 'no_such_proposal') return { status: 404, body: { error: 'no_such_approval' } };
        return { status: 409, body: { error: res.detail ?? 'governance_refused' } };
      }
      return { status: 404, body: { error: 'no_such_approval' } };
    }
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
    // A task-approval decision arriving while PAUSED is refused — resume first, then
    // decide (the pause window and the decision must not race, REQ-10.9).
    if (deps.steeringState?.() === 'PAUSED') {
      return { status: 409, body: { error: 'paused_resume_first' } };
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

  if (req.method === 'GET' && path === '/deploy') {
    // Phase-1 pattern (mirrors /steering/* below): a server started without deploy
    // composed keeps this a flat 501 (REQ-6.3).
    if (deps.deployState === undefined) {
      return { status: 501, body: { error: 'not_enabled_phase1', detail: 'deploy not composed' } };
    }
    return { status: 200, body: { state: deps.deployState(), approval: deps.deployApproval?.() ?? null } };
  }

  if (req.method === 'POST' && path === '/deploy/decision') {
    if (deps.onDeployDecision === undefined) {
      return { status: 501, body: { error: 'not_enabled_phase1', detail: 'deploy not composed' } };
    }
    const pending = deps.deployApproval?.() ?? null;
    if (pending === null) return { status: 404, body: { error: 'no_pending_deploy' } };
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
      const complete = pending.attestations.every((a) => given.has(a));
      if (!complete) return { status: 400, body: { error: 'attestations_incomplete' } };
    }
    deps.log.append({
      runId: deps.runId,
      taskId: pending.taskId,
      type: 'DEPLOY_DECISION',
      payload: { approvalId: pending.id, decision },
    });
    const res = deps.onDeployDecision(decision);
    if (!res.ok) return { status: 409, body: { error: res.detail ?? 'deploy_decision_refused' } };
    return { status: 200, body: { state: res.state ?? null } };
  }

  if (req.method === 'POST' && path === '/deploy/rollback') {
    if (deps.onDeployRollback === undefined) {
      return { status: 501, body: { error: 'not_enabled_phase1', detail: 'deploy not composed' } };
    }
    // Legal ONLY from EXPANDED (REQ-6.9) — the automated path owns rollback during
    // CANARY/OBSERVING; interrupting a running stage is the kill switch's job.
    if (deps.deployState?.() !== 'EXPANDED') {
      return { status: 409, body: { error: 'not_expanded', state: deps.deployState?.() ?? null } };
    }
    const res = deps.onDeployRollback();
    if (!res.ok) return { status: 409, body: { error: res.detail ?? 'rollback_refused' } };
    return { status: 200, body: { ok: true } };
  }

  if (req.method === 'POST' && path.startsWith('/steering/')) {
    // A plane without the steering callbacks behaves as in Phase 1 (501).
    if (deps.onPause === undefined) {
      return { status: 501, body: { error: 'not_enabled_phase1', detail: 'steering not composed' } };
    }
    const state = deps.steeringState?.();

    if (path === '/steering/pause') {
      if (state !== undefined && !STEERABLE.has(state)) {
        return { status: 409, body: { error: 'not_steerable', state } };
      }
      deps.onPause();
      return { status: 202, body: { state: 'pause_requested' } };
    }

    if (path === '/steering/resume') {
      deps.onResume?.();
      return { status: 202, body: { state: 'resumed' } };
    }

    if (path === '/steering/inject') {
      let parsed: { guidance?: unknown; atNextBoundary?: unknown };
      try {
        parsed = JSON.parse(req.body) as typeof parsed;
      } catch {
        return { status: 400, body: { error: 'bad_json' } };
      }
      const guidance = parsed.guidance;
      if (typeof guidance !== 'string' || guidance.length === 0) {
        return { status: 400, body: { error: 'guidance must be a non-empty string' } };
      }
      if (state !== 'PAUSED') {
        // REQ-17.1: a steerable non-PAUSED state queues at the next boundary instead
        // of refusing outright, but ONLY when the caller opts in explicitly —
        // REQ-17.5 keeps the plain not_paused 409 for every other case (default).
        const atNextBoundary = parsed.atNextBoundary === true;
        if (!atNextBoundary || state === undefined || !STEERABLE.has(state)) {
          return { status: 409, body: { error: 'not_paused', state } };
        }
        const res = deps.onInject?.(guidance, { atNextBoundary: true });
        if (res === undefined || !res.ok) {
          return { status: 409, body: { error: res?.reason ?? 'inject_failed' } };
        }
        return { status: 202, body: { queued: true, evidenceRef: res.evidenceRef } };
      }
      // Guidance is atomic with the pause window (REQ-10.4) — immediate mode.
      const res = deps.onInject?.(guidance, { atNextBoundary: false });
      if (res === undefined || !res.ok) {
        return { status: 409, body: { error: res?.reason ?? 'inject_failed' } };
      }
      return { status: 202, body: { evidenceRef: res.evidenceRef } };
    }

    return { status: 404, body: { error: 'not_found' } };
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
