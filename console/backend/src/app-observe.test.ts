// Observability endpoints via inject (REQ-18/19/20).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { makeHome } from '../test/helpers/home-fixture.ts';

const GOOD_HOST = { host: '127.0.0.1:9119' };

function deps(over: Partial<AppDeps> = {}): AppDeps {
  const fix = makeHome();
  return { homeDir: fix.homeDir, env: {}, bindHost: '127.0.0.1', port: 9119, dataDir: fix.dataDir, now: () => 0, cliVersion: async () => 't', ...over };
}

test('POST /api/usage/full indexes + splits interactive/autonomous (REQ-18)', async () => {
  const app = buildApp(deps());
  try {
    const r = await app.inject({
      method: 'POST', url: '/api/usage/full', headers: GOOD_HOST,
      payload: { records: [
        { ts: '2026-07-01T10:00:00Z', project: 'app', model: 'sonnet', cwd: '/x/app' },
        { ts: '2026-07-01T11:00:00Z', project: 'app', model: 'opus', cwd: '/x/app' },
      ] },
    });
    const body = r.json() as { interactive: number; label: string };
    assert.equal(body.interactive, 2);
    assert.equal(body.label, 'estimate');
  } finally { await app.close(); }
});

test('POST /api/activity/install returns a fail-open hook entry (REQ-19.1)', async () => {
  const app = buildApp(deps({ activityToken: 'tok' }));
  try {
    const r = await app.inject({ method: 'POST', url: '/api/activity/install', headers: GOOD_HOST, payload: { ingestUrl: 'http://127.0.0.1/api/events/ingest' } });
    const entry = (r.json() as { entry: Record<string, unknown> }).entry;
    assert.equal(entry['failOpen'], true);
  } finally { await app.close(); }
});

test('POST /api/events/ingest requires the install token (REQ-19.2)', async () => {
  const app = buildApp(deps({ activityToken: 'tok' }));
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/events/ingest', headers: GOOD_HOST });
    assert.equal(bad.statusCode, 401);
    const ok = await app.inject({ method: 'POST', url: '/api/events/ingest', headers: { ...GOOD_HOST, 'x-ingest-token': 'tok' } });
    assert.equal(ok.statusCode, 202);
  } finally { await app.close(); }
});

test('GET /api/sessions/search requires q + project, returns results (REQ-20.1)', async () => {
  const app = buildApp(deps());
  try {
    const noq = await app.inject({ method: 'GET', url: '/api/sessions/search?project=app', headers: GOOD_HOST });
    assert.equal(noq.statusCode, 400);
    const ok = await app.inject({ method: 'GET', url: '/api/sessions/search?q=anything&project=app', headers: GOOD_HOST });
    assert.equal(ok.statusCode, 200);
    assert.ok(Array.isArray((ok.json() as { results: unknown[] }).results));
  } finally { await app.close(); }
});
