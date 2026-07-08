import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { addSession, makeHome, type HomeFixture } from '../test/helpers/home-fixture.ts';

const NOW = Date.parse('2026-01-05T12:00:00Z');

function depsFor(fix: HomeFixture, env: Record<string, string | undefined> = {}): AppDeps {
  return {
    homeDir: fix.homeDir,
    env,
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
    cliVersion: async () => '9.9.9 (test)',
  };
}

const GOOD_HOST = { host: '127.0.0.1:9119' };

test('host-header allowlist blocks DNS-rebinding, CORS restricted (REQ-12.4)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const evil = await app.inject({ method: 'GET', url: '/api/status', headers: { host: 'evil.example.com:9119' } });
    assert.equal(evil.statusCode, 403);

    const good = await app.inject({ method: 'GET', url: '/api/status', headers: GOOD_HOST });
    assert.equal(good.statusCode, 200);

    const badOrigin = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { ...GOOD_HOST, origin: 'http://evil.example.com' },
    });
    assert.equal(badOrigin.statusCode, 403);

    const goodOrigin = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { ...GOOD_HOST, origin: 'http://localhost:9119' },
    });
    assert.equal(goodOrigin.statusCode, 200);
    assert.equal(goodOrigin.headers['access-control-allow-origin'], 'http://localhost:9119');
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-Status: version + disclaimer; degraded card when CLI missing (REQ-13.1/13.2, REQ-12.7)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  const broken = buildApp({
    ...depsFor(fix),
    cliVersion: async () => {
      throw new Error('ENOENT');
    },
  });
  try {
    const ok = await app.inject({ method: 'GET', url: '/api/status', headers: GOOD_HOST });
    const body = ok.json() as { cli: { available: boolean; version?: string }; disclaimer: string; activeRuns: unknown[] };
    assert.equal(body.cli.available, true);
    assert.equal(body.cli.version, '9.9.9 (test)');
    assert.match(body.disclaimer, /not an Anthropic product/);
    assert.deepEqual(body.activeRuns, []);

    const degraded = await broken.inject({ method: 'GET', url: '/api/status', headers: GOOD_HOST });
    assert.equal(degraded.statusCode, 200, 'degraded, not a 500');
    const dbody = degraded.json() as { cli: { available: boolean; hint?: string } };
    assert.equal(dbody.cli.available, false);
    assert.match(dbody.cli.hint ?? '', /not found/);
  } finally {
    await app.close();
    await broken.close();
    fix.cleanup();
  }
});

test('F-Auth: red shadowing warning names variables, never values (REQ-14)', async () => {
  const fix = makeHome();
  // Assembled at runtime so the repo's secret scanner sees no literal key assignment.
  const secret = ['sk', 'ant', 'supersecretvalue1234567890'].join('-');
  const app = buildApp(depsFor(fix, { ANTHROPIC_API_KEY: secret }));
  const clean = buildApp(depsFor(fix, {}));
  try {
    const res = await app.inject({ method: 'GET', url: '/api/auth', headers: GOOD_HOST });
    const body = res.json() as { shadowing: boolean; shadowingVars: string[]; severity: string; guidance: string };
    assert.equal(body.shadowing, true);
    assert.equal(body.severity, 'red');
    assert.deepEqual(body.shadowingVars, ['ANTHROPIC_API_KEY']);
    assert.match(body.guidance, /never unsets/);
    assert.ok(!res.body.includes(secret), 'token value never leaves the process (INV-12)');

    const cleanRes = await clean.inject({ method: 'GET', url: '/api/auth', headers: GOOD_HOST });
    const cleanBody = cleanRes.json() as { shadowing: boolean; severity: string };
    assert.equal(cleanBody.shadowing, false);
    assert.equal(cleanBody.severity, 'ok');
  } finally {
    await app.close();
    await clean.close();
    fix.cleanup();
  }
});

test('F-Auth: remote is the peer half of the single remote definition (REQ-18.3/20.8)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const local = await app.inject({ method: 'GET', url: '/api/auth', headers: GOOD_HOST });
    assert.equal((local.json() as { remote: boolean }).remote, false);

    const remote = await app.inject({ method: 'GET', url: '/api/auth', headers: GOOD_HOST, remoteAddress: '100.64.0.5' });
    assert.equal((remote.json() as { remote: boolean }).remote, true);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-Proj/F-Sess wired over live files; home paths render in ~ form (REQ-13.3/13.4, REQ-12.5)', async () => {
  const fix = makeHome();
  addSession(fix, '-my-app', 's1', [
    { cwd: `${fix.homeDir}/work/my-app`, timestamp: '2026-01-05T10:00:00Z' },
  ]);
  const app = buildApp(depsFor(fix));
  try {
    const projects = await app.inject({ method: 'GET', url: '/api/projects', headers: GOOD_HOST });
    assert.equal(projects.statusCode, 200);
    assert.ok(!projects.body.includes(fix.homeDir), 'raw home path redacted to ~ form');
    assert.ok(projects.body.includes('~/work/my-app'), 'project path usable in display form');

    const sessions = await app.inject({ method: 'GET', url: '/api/sessions?project=-my-app', headers: GOOD_HOST });
    assert.equal(sessions.statusCode, 200);
    const sbody = sessions.json() as { sessions: { sessionId: string }[] };
    assert.equal(sbody.sessions[0]?.sessionId, 's1');

    const traversal = await app.inject({ method: 'GET', url: '/api/sessions?project=..%2F..%2Fetc', headers: GOOD_HOST });
    assert.equal(traversal.statusCode, 400, 'path traversal in project id rejected');
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-Usage: estimate labeled, weekly needs anchor, config roundtrip (REQ-15)', async () => {
  const fix = makeHome();
  addSession(fix, '-my-app', 's1', [
    { timestamp: '2026-01-05T11:00:00Z' },
    { timestamp: '2026-01-05T11:30:00Z' },
  ]);
  const app = buildApp(depsFor(fix));
  try {
    const before = await app.inject({ method: 'GET', url: '/api/usage/estimate', headers: GOOD_HOST });
    const est = before.json() as { label: string; disclaimer: string; moneyDisclaimer: string; weekly: { available: boolean }; currentWindow: { entryCount: number } | null };
    assert.equal(est.label, 'estimate');
    assert.match(est.disclaimer, /estimate/);
    assert.match(est.moneyDisclaimer, /not an actual bill/);
    assert.equal(est.weekly.available, false, 'no unanchored weekly guess');
    assert.equal(est.currentWindow?.entryCount, 2);

    const badPut = await app.inject({
      method: 'PUT',
      url: '/api/usage/config',
      headers: GOOD_HOST,
      payload: { weeklyResetAnchor: 'not-a-date' },
    });
    assert.equal(badPut.statusCode, 400);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/usage/config',
      headers: GOOD_HOST,
      payload: { weeklyResetAnchor: '2026-01-01T00:00:00Z', calibratedPercent: 35 },
    });
    assert.equal(put.statusCode, 200);

    const after = await app.inject({ method: 'GET', url: '/api/usage/estimate', headers: GOOD_HOST });
    const est2 = after.json() as { weekly: { available: boolean; calibratedPercent?: number } };
    assert.equal(est2.weekly.available, true);
    assert.equal(est2.weekly.calibratedPercent, 35);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('negative guarantees: no credential-returning route, no user creation (REQ-12.6, INV-12/15)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    await app.ready();
    const routes = app.printRoutes();
    assert.ok(!/credential|token|login|user/i.test(routes), `route table clean: ${routes}`);
    for (const url of ['/api/users', '/api/credentials', '/api/token', '/api/export']) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await app.inject({ method, url, headers: GOOD_HOST });
        assert.equal(res.statusCode, 404, `${method} ${url} must not exist`);
      }
    }
  } finally {
    await app.close();
    fix.cleanup();
  }
});
