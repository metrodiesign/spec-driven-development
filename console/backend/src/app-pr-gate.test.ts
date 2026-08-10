import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HumanOverride, RepositoryId } from 'core';

import { buildApp, type AppDeps } from './app.ts';
import type { PrGateManager, PrGateProjection, PrGateRunDetail } from './pr-gate/manager.ts';
import { makeHome, type HomeFixture } from '../test/helpers/home-fixture.ts';

const HOST = { host: '127.0.0.1:9119' };
const projection: PrGateProjection = {
  runId: 'prg-1',
  repository: 'acme/repo' as RepositoryId,
  pullRequest: 7,
  headSha: 'head-1',
  state: 'AWAITING_HUMAN',
  systemDecision: 'HUMAN_REVIEW_REQUIRED',
  effectiveDecision: 'HUMAN_REVIEW_REQUIRED',
  reportRef: 'sha256:report',
  checkRunId: '42',
  publication: 'PUBLISHED',
  reviewerStatuses: [],
  overrideRefs: [],
  updatedAt: '2026-08-10T00:00:00.000Z',
};

function deps(fix: HomeFixture, prGateManager?: PrGateManager): AppDeps {
  return {
    homeDir: fix.homeDir,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => Date.parse('2026-08-10T00:00:00Z'),
    cliVersion: async () => 'test',
    ...(prGateManager === undefined ? {} : { prGateManager }),
  };
}

function fakeManager(overrides: Partial<PrGateManager> = {}): PrGateManager {
  const detail: PrGateRunDetail = {
    ...projection, systemReport: null, deterministicReport: null, judgedFindings: [], overrideHistory: [],
  };
  return {
    start: () => ({ runId: projection.runId, completion: Promise.resolve(projection) }),
    run: async () => projection,
    runVerified: async () => projection,
    cancel: async (id) => id === projection.runId ? projection : null,
    list: () => [projection],
    detail: (id) => id === projection.runId ? detail : null,
    headStatus: async (id) => id === projection.runId ? {
      reviewedHeadSha: 'head-1', currentHeadSha: 'head-1', stale: false, publication: 'PUBLISHED',
    } : null,
    override: async () => ({
      overrideId: 'pro-1', idempotencyKey: 'key-1', runId: projection.runId, actor: 'local-operator',
      headSha: 'head-1', action: 'APPROVE', reason: 'reviewed', findingIds: [], createdAt: '2026-08-10T00:00:00.000Z',
    }),
    recoverInterrupted: () => [],
    ...overrides,
  };
}

test('PR quality routes stay absent unless manager is configured (REQ-10.5)', async () => {
  const fix = makeHome();
  const app = buildApp(deps(fix));
  try {
    await app.ready();
    assert.equal(app.hasRoute({ method: 'POST', url: '/api/pr-quality/runs' }), false);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('PR quality API starts, lists, details current head, and cancels one shared manager (REQ-10.2-10.6)', async () => {
  const fix = makeHome();
  const starts: unknown[] = [];
  const manager = fakeManager({
    start: (input) => {
      starts.push(input);
      return { runId: projection.runId, completion: Promise.resolve(projection) };
    },
  });
  const app = buildApp(deps(fix, manager));
  try {
    const badHost = await app.inject({ method: 'GET', url: '/api/pr-quality/runs', headers: { host: 'evil.example:9119' } });
    assert.equal(badHost.statusCode, 403);

    const started = await app.inject({
      method: 'POST', url: '/api/pr-quality/runs', headers: { ...HOST, 'content-type': 'application/json' },
      payload: JSON.stringify({ repository: 'acme/repo', pullRequest: 7 }),
    });
    assert.equal(started.statusCode, 202);
    assert.equal(started.json().runId, projection.runId);
    assert.deepEqual(starts, [{ repository: 'acme/repo', pullRequest: 7 }]);

    const listed = await app.inject({ method: 'GET', url: '/api/pr-quality/runs?limit=10', headers: HOST });
    assert.equal(listed.json().runs.length, 1);
    const detailed = await app.inject({ method: 'GET', url: `/api/pr-quality/runs/${projection.runId}`, headers: HOST });
    assert.deepEqual(detailed.json().headStatus, {
      reviewedHeadSha: 'head-1', currentHeadSha: 'head-1', stale: false, publication: 'PUBLISHED',
    });
    const cancelled = await app.inject({ method: 'POST', url: `/api/pr-quality/runs/${projection.runId}/cancel`, headers: HOST });
    assert.equal(cancelled.json().state, 'AWAITING_HUMAN');
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('override ignores client actor/time, derives authenticated actor, and maps stale conflict (REQ-10.7-10.13)', async () => {
  const fix = makeHome();
  const calls: Parameters<PrGateManager['override']>[0][] = [];
  let stale = false;
  const manager = fakeManager({
    override: async (input): Promise<HumanOverride> => {
      calls.push(input);
      if (stale) throw new Error('PR head changed to head-2');
      return {
        overrideId: 'pro-1', idempotencyKey: input.idempotencyKey, runId: input.runId, actor: input.actor,
        headSha: input.headSha, action: input.action, reason: input.reason, findingIds: input.findingIds,
        createdAt: '2026-08-10T00:00:00.000Z',
      };
    },
  });
  const app = buildApp({
    ...deps(fix, manager),
    auth: {
      kind: 'basic',
      routes: () => {},
      verify: (cookie) => cookie === 'session=ok' ? { sub: 'maintainer-7', method: 'basic' } : null,
    },
  });
  try {
    const request = {
      method: 'POST' as const,
      url: `/api/pr-quality/runs/${projection.runId}/override`,
      headers: { ...HOST, cookie: 'session=ok', 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      payload: JSON.stringify({
        headSha: 'head-1', action: 'APPROVE', reason: 'reviewed', findingIds: ['finding-1'],
        actor: 'attacker', createdAt: '1900-01-01T00:00:00Z',
      }),
    };
    const accepted = await app.inject(request);
    assert.equal(accepted.statusCode, 200);
    assert.equal(calls[0]?.actor, 'maintainer-7');
    assert.equal('createdAt' in (calls[0] ?? {}), false);

    stale = true;
    const conflict = await app.inject({ ...request, headers: { ...request.headers, 'idempotency-key': 'key-2' } });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), { error: 'override conflicts with current run state' });
  } finally {
    await app.close();
    fix.cleanup();
  }
});
