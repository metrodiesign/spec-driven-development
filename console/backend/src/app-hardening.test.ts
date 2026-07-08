// §13.3 hardening sweep (REQ-21) — named tests for the checklist lines this
// task adds coverage for: single-operator (no user-creation endpoint),
// redaction extended to the NEW F-Loop/F-Sched/auth routes, and every
// run-spawning endpoint enforcing both a rate limit AND its own confirm/token
// gate. Most other §13.3 lines already have named tests from earlier phases
// (REQ-12/13/14/15/16/18/19) — this file covers the delta task 8-10 introduced.

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

// --- REQ-21.2: single-operator — no endpoint creates an additional user ---

test('§13.3 single-operator: no route exists to create/register a user (REQ-21.2, INV-15)', async () => {
  const fix = makeHome();
  // No `auth` dep: every response is either a real handler or Fastify's
  // default 404 — a gate 401 would be ambiguous with "route absent".
  const app = buildApp({ homeDir: fix.homeDir, env: {}, bindHost: '127.0.0.1', port: 9119, dataDir: fix.dataDir, now: () => NOW });
  try {
    const candidates: { method: 'GET' | 'POST' | 'PUT'; url: string }[] = [
      { method: 'POST', url: '/auth/register' },
      { method: 'POST', url: '/auth/signup' },
      { method: 'POST', url: '/auth/users' },
      { method: 'POST', url: '/api/users' },
      { method: 'PUT', url: '/api/auth/users' },
      { method: 'POST', url: '/api/register' },
    ];
    for (const c of candidates) {
      const res = await app.inject({ method: c.method, url: c.url, headers: GOOD_HOST, payload: {} });
      assert.equal(res.statusCode, 404, `${c.method} ${c.url} must not exist`);
    }
  } finally {
    await app.close();
    fix.cleanup();
  }
});

// --- REQ-21.3: redaction extends to the NEW F-Loop/F-Sched/auth responses ---

function makeSchedDeps(over?: { rateOk?(): boolean }): { deps: AppDeps; cleanup(): void } {
  const fix = makeHome();
  const policiesDir = mkdtempSync(join(tmpdir(), 'hardening-policies-'));
  writeFileSync(
    join(policiesDir, 'routing.json'),
    JSON.stringify({ maxSusceptibility: 0.5, maxParallel: 2, tokenBuckets: {}, sched: { scriptAllowlist: [] } }),
  );
  const scriptsDir = mkdtempSync(join(tmpdir(), 'hardening-scripts-'));
  const spawn: SpawnChild = (_file, _args) => {
    const child: ChildLike = { pid: 4242, onExit: () => {}, kill: () => {} };
    return child;
  };
  const deps: AppDeps = {
    homeDir: fix.homeDir,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
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
    cleanup: () => {
      fix.cleanup();
      rmSync(policiesDir, { recursive: true, force: true });
      rmSync(scriptsDir, { recursive: true, force: true });
    },
  };
}

test('§13.3 redaction: a token-shaped value echoed through a NEW F-Sched response is redacted (REQ-21.3)', async () => {
  const { deps, cleanup } = makeSchedDeps();
  const app = buildApp(deps);
  try {
    // Synthetic token SHAPE assembled at runtime (dodges the repo's own secret
    // scanner) travels start's `goal` -> spawn args -> status response.
    const fakeToken = ['sk', 'ant', 'abc123def456ghi789'].join('-');
    const first = await app.inject({ method: 'POST', url: '/api/sched/start', headers: GOOD_HOST, payload: { goal: fakeToken } });
    const token = (first.json() as { confirmToken: string }).confirmToken;
    await app.inject({
      method: 'POST',
      url: '/api/sched/start',
      headers: GOOD_HOST,
      payload: { goal: fakeToken, confirmToken: token },
    });
    const status = await app.inject({ method: 'GET', url: '/api/sched/status', headers: GOOD_HOST });
    assert.equal(status.statusCode, 200);
    assert.ok(!status.body.includes(fakeToken), 'token shape redacted even inside F-Sched args echo');
    assert.ok(status.body.includes('[redacted]'));
  } finally {
    await app.close();
    cleanup();
  }
});

// --- REQ-21.4: every run-spawning endpoint enforces BOTH a rate limit AND its own confirm/allowlist gate ---

test('§13.3 spawn gates: /api/sched/start enforces the rate limit before AND the confirm flow after (REQ-21.4)', async () => {
  const { deps, cleanup } = makeSchedDeps({ rateOk: () => false });
  const app = buildApp(deps);
  try {
    const limited = await app.inject({ method: 'POST', url: '/api/sched/start', headers: GOOD_HOST, payload: { goal: 'g' } });
    assert.equal(limited.statusCode, 429, 'rate limit enforced even with a well-formed body');
  } finally {
    await app.close();
    cleanup();
  }

  const { deps: deps2, cleanup: cleanup2 } = makeSchedDeps({ rateOk: () => true });
  const app2 = buildApp(deps2);
  try {
    const noToken = await app2.inject({ method: 'POST', url: '/api/sched/start', headers: GOOD_HOST, payload: { goal: 'g' } });
    assert.equal(noToken.statusCode, 428, 'rate limit passed, but the confirm-token gate still applies');
  } finally {
    await app2.close();
    cleanup2();
  }
});

test('§13.3 spawn gates: /api/sched/script enforces the rate limit before AND the allowlist gate after (REQ-21.4)', async () => {
  const { deps, cleanup } = makeSchedDeps({ rateOk: () => false });
  const app = buildApp(deps);
  try {
    const limited = await app.inject({ method: 'POST', url: '/api/sched/script', headers: GOOD_HOST, payload: { name: 'anything.sh' } });
    assert.equal(limited.statusCode, 429, 'rate limit enforced even with a well-formed body');
  } finally {
    await app.close();
    cleanup();
  }

  const { deps: deps2, cleanup: cleanup2 } = makeSchedDeps({ rateOk: () => true });
  const app2 = buildApp(deps2);
  try {
    const notAllowlisted = await app2.inject({
      method: 'POST',
      url: '/api/sched/script',
      headers: GOOD_HOST,
      payload: { name: 'not-allowlisted.sh' },
    });
    assert.equal(notAllowlisted.statusCode, 400, 'rate limit passed, but the allowlist gate still applies');
    assert.deepEqual(notAllowlisted.json(), { error: 'script_not_allowlisted' });
  } finally {
    await app2.close();
    cleanup2();
  }
});
