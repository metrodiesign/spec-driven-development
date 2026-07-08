// F-Sched REST routes (REQ-16): two-step confirm + rate limit + exact-match
// script allowlist, over the REAL createSchedRuntime (only `spawn` is faked).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { createSchedRuntime, type ChildLike, type SpawnChild } from './sched.ts';
import { makeHome } from '../test/helpers/home-fixture.ts';

const NOW = Date.parse('2026-01-05T12:00:00Z');
const GOOD_HOST = { host: '127.0.0.1:9119' };

function fakeChild(pid: number): { child: ChildLike; fireExit(code: number | null): void } {
  let onExitCb: ((code: number | null) => void) | null = null;
  const child: ChildLike = {
    pid,
    onExit: (cb) => {
      onExitCb = cb;
    },
    kill: () => {},
  };
  return { child, fireExit: (code) => onExitCb?.(code) };
}

function makeFixture(over?: { rateOk?(): boolean; scriptAllowlist?: string[] }) {
  const fix = makeHome();
  const policiesDir = mkdtempSync(join(tmpdir(), 'sched-policies-'));
  writeFileSync(
    join(policiesDir, 'routing.json'),
    JSON.stringify({ maxSusceptibility: 0.5, maxParallel: 2, tokenBuckets: {}, sched: { scriptAllowlist: over?.scriptAllowlist ?? [] } }),
  );
  const scriptsDir = mkdtempSync(join(tmpdir(), 'sched-scripts-'));
  const spawnCalls: { file: string; args: string[] }[] = [];
  let lastFake: ReturnType<typeof fakeChild> | null = null;
  const spawn: SpawnChild = (file, args) => {
    spawnCalls.push({ file, args });
    lastFake = fakeChild(1234);
    return lastFake.child;
  };
  const audited: Record<string, unknown>[] = [];
  const deps: AppDeps = {
    homeDir: fix.homeDir,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
    audit: (e) => audited.push(e),
    sched: {
      runtime: createSchedRuntime({ spawn, now: () => NOW }),
      policiesDir,
      platformBinPath: 'platform-bin',
      scriptsDir,
      ...(over?.rateOk !== undefined ? { rateOk: over.rateOk } : {}),
    },
  };
  return {
    deps,
    audited,
    spawnCalls,
    scriptsDir,
    fireLastExit: (code: number | null) => lastFake?.fireExit(code),
    cleanup: () => {
      fix.cleanup();
      rmSync(policiesDir, { recursive: true, force: true });
      rmSync(scriptsDir, { recursive: true, force: true });
    },
  };
}

async function confirmedStart(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json(): unknown }> {
  const first = await app.inject({ method: 'POST', url: '/api/sched/start', headers: GOOD_HOST, payload });
  const token = (first.json() as { confirmToken: string }).confirmToken;
  return app.inject({ method: 'POST', url: '/api/sched/start', headers: GOOD_HOST, payload: { ...payload, confirmToken: token } });
}

test('sched absent -> F-Sched routes do not register (mirrors termManager/loopRunsRoot)', async () => {
  const fix = makeHome();
  const app = buildApp({ homeDir: fix.homeDir, env: {}, bindHost: '127.0.0.1', port: 9119, dataDir: fix.dataDir, now: () => NOW });
  try {
    const r = await app.inject({ method: 'GET', url: '/api/sched/status', headers: GOOD_HOST });
    assert.equal(r.statusCode, 404);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('GET /api/sched/status on a fresh runtime -> not running (REQ-16.5)', async () => {
  const f = makeFixture();
  const app = buildApp(f.deps);
  try {
    const r = await app.inject({ method: 'GET', url: '/api/sched/status', headers: GOOD_HOST });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { running: false });
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('POST /api/sched/start without goal -> 400', async () => {
  const f = makeFixture();
  const app = buildApp(f.deps);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/sched/start', headers: GOOD_HOST, payload: {} });
    assert.equal(r.statusCode, 400);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('POST /api/sched/start: rate limit trips before the confirm flow (REQ-16.4)', async () => {
  const f = makeFixture({ rateOk: () => false });
  const app = buildApp(f.deps);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/sched/start', headers: GOOD_HOST, payload: { goal: 'g.yaml' } });
    assert.equal(r.statusCode, 429);
    assert.equal(f.spawnCalls.length, 0);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('POST /api/sched/start: 428 needs_confirmation, the echoed confirmToken then starts it (REQ-16.2/16.3/16.8)', async () => {
  const f = makeFixture();
  const app = buildApp(f.deps);
  try {
    const first = await app.inject({
      method: 'POST', url: '/api/sched/start', headers: GOOD_HOST,
      payload: { goal: 'g.yaml', task: 'T-1', live: true },
    });
    assert.equal(first.statusCode, 428);
    const body1 = first.json() as { error: string; confirmToken: string; automation: unknown };
    assert.equal(body1.error, 'needs_confirmation');
    assert.deepEqual(body1.automation, { defer: true, reason: 'estimate_unavailable' });
    assert.equal(f.spawnCalls.length, 0, 'nothing spawns before confirmation');

    const second = await app.inject({
      method: 'POST', url: '/api/sched/start', headers: GOOD_HOST,
      payload: { goal: 'g.yaml', task: 'T-1', live: true, confirmToken: body1.confirmToken },
    });
    assert.equal(second.statusCode, 200);
    const body2 = second.json() as { pid: number; args: string[] };
    assert.equal(body2.pid, 1234);
    assert.deepEqual(body2.args, ['loop', 'run', '--goal', 'g.yaml', '--task', 'T-1', '--live']);
    assert.deepEqual(f.spawnCalls, [{ file: 'platform-bin', args: ['loop', 'run', '--goal', 'g.yaml', '--task', 'T-1', '--live'] }]);
    assert.deepEqual(f.audited.map((e) => e['event']), ['sched_start']);

    const status = await app.inject({ method: 'GET', url: '/api/sched/status', headers: GOOD_HOST });
    assert.deepEqual(status.json(), { running: true, pid: 1234, args: body2.args, startedAt: NOW });
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('a mismatched confirmToken is treated as unconfirmed, not a crash (REQ-16.3)', async () => {
  const f = makeFixture();
  const app = buildApp(f.deps);
  try {
    const r = await app.inject({
      method: 'POST', url: '/api/sched/start', headers: GOOD_HOST,
      payload: { goal: 'g.yaml', confirmToken: 'not-the-real-token' },
    });
    assert.equal(r.statusCode, 428);
    assert.equal(f.spawnCalls.length, 0);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('a second start while one is registered -> 409 already_running (REQ-16.1)', async () => {
  const f = makeFixture();
  const app = buildApp(f.deps);
  try {
    const started = await confirmedStart(app, { goal: 'g.yaml' });
    assert.equal(started.statusCode, 200);

    const again = await app.inject({ method: 'POST', url: '/api/sched/start', headers: GOOD_HOST, payload: { goal: 'g.yaml' } });
    assert.equal(again.statusCode, 409);
    assert.equal((again.json() as { error: string }).error, 'already_running');
    assert.equal(f.spawnCalls.length, 1, 'the second attempt never spawns');
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('a crashed child is reflected at /api/sched/status without auto-respawn (REQ-16.5)', async () => {
  const f = makeFixture();
  const app = buildApp(f.deps);
  try {
    await confirmedStart(app, { goal: 'g.yaml' });
    f.fireLastExit(2);
    const status = await app.inject({ method: 'GET', url: '/api/sched/status', headers: GOOD_HOST });
    assert.deepEqual(status.json(), { running: false, exited: 2 });
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('POST /api/sched/stop SIGTERMs the registered child + audits; no-op (no audit) when idle (REQ-16.6/16.8)', async () => {
  const f = makeFixture();
  const app = buildApp(f.deps);
  try {
    const idle = await app.inject({ method: 'POST', url: '/api/sched/stop', headers: GOOD_HOST });
    assert.deepEqual(idle.json(), { stopped: false });
    assert.deepEqual(f.audited, []);

    await confirmedStart(app, { goal: 'g.yaml' });
    const stop = await app.inject({ method: 'POST', url: '/api/sched/stop', headers: GOOD_HOST });
    assert.deepEqual(stop.json(), { stopped: true });
    assert.deepEqual(f.audited.map((e) => e['event']), ['sched_start', 'sched_stop']);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('POST /api/sched/script: rejects a non-allowlisted name; runs an exact allowlist match; already-running refuses (REQ-16.1/16.7/16.9)', async () => {
  const f = makeFixture({ scriptAllowlist: ['ok.sh'] });
  const app = buildApp(f.deps);
  try {
    const rejected = await app.inject({ method: 'POST', url: '/api/sched/script', headers: GOOD_HOST, payload: { name: '../etc/passwd' } });
    assert.equal(rejected.statusCode, 400);
    assert.equal((rejected.json() as { error: string }).error, 'script_not_allowlisted');
    assert.equal(f.spawnCalls.length, 0);

    const ran = await app.inject({ method: 'POST', url: '/api/sched/script', headers: GOOD_HOST, payload: { name: 'ok.sh' } });
    assert.equal(ran.statusCode, 200);
    assert.deepEqual(f.spawnCalls, [{ file: 'sh', args: [join(f.scriptsDir, 'ok.sh')] }]);
    assert.deepEqual(f.audited.map((e) => e['event']), ['sched_script']);

    const again = await app.inject({ method: 'POST', url: '/api/sched/script', headers: GOOD_HOST, payload: { name: 'ok.sh' } });
    assert.equal(again.statusCode, 409);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('POST /api/sched/script also honors the per-source rate limit (REQ-16.4, spawn-endpoint rule)', async () => {
  const f = makeFixture({ rateOk: () => false, scriptAllowlist: ['ok.sh'] });
  const app = buildApp(f.deps);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/sched/script', headers: GOOD_HOST, payload: { name: 'ok.sh' } });
    assert.equal(r.statusCode, 429);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('the sched allowlist has no write route (REQ-16.9): no PUT/POST route touches routing.json', async () => {
  const f = makeFixture();
  const app = buildApp(f.deps);
  try {
    const attempts = await Promise.all(
      ['/api/sched/allowlist', '/api/sched/routing', '/api/policies/routing'].map((url) =>
        app.inject({ method: 'POST', url, headers: GOOD_HOST, payload: { scriptAllowlist: ['evil.sh'] } }),
      ),
    );
    for (const r of attempts) assert.equal(r.statusCode, 404);
  } finally {
    await app.close();
    f.cleanup();
  }
});
