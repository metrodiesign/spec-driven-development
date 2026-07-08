// Remote auth gate via Fastify inject (REQ-19). Proves the onRequest hook wired
// in app.ts: gated-by-default, /auth/* + static SPA exempt, and that F-Term stays
// loopback-hard even for a validly authenticated remote session (INV-17 regression).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { createBasicProvider, scryptHash } from './auth/basic.ts';
import { readSessionCookie, type AuthProvider } from './auth/provider.ts';
import { makeHome, type HomeFixture } from '../test/helpers/home-fixture.ts';
import type { TermManager } from './term.ts';

const NOW = Date.parse('2026-01-05T12:00:00Z');
const GOOD_HOST = { host: '127.0.0.1:9119' };
const PASSWORD = 'correct horse battery staple';
const SALT = 'fixed-test-salt';

function makeAuth(): AuthProvider {
  return createBasicProvider({
    config: { provider: 'basic', scryptHash: scryptHash(PASSWORD, SALT), salt: SALT, signingSecret: 'test-signing-secret' },
    now: () => NOW,
    sessionTtlMs: 60_000,
  });
}

function stubTerm(): TermManager {
  return {
    create: () => ({ ptyId: 'pty-1', ticket: 'tk-1' }),
    attach: () => null,
    redeemTicket: () => true,
    onData: () => () => {},
    write: () => true,
    resize: () => true,
    nudgeRepaint: () => true,
    list: () => [],
    kill: () => false,
  };
}

function depsFor(fix: HomeFixture, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    homeDir: fix.homeDir,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
    cliVersion: async () => '9.9.9 (test)',
    ...overrides,
  };
}

async function login(app: ReturnType<typeof buildApp>, host: Record<string, string>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', headers: host, payload: { password: PASSWORD } });
  assert.equal(res.statusCode, 200);
  const token = readSessionCookie(res.headers['set-cookie'] as string);
  assert.ok(token !== null);
  return `platform_session=${token}`;
}

test('protected route: 401 without a session, 200 with a valid one (REQ-19.3)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix, { auth: makeAuth() }));
  try {
    const denied = await app.inject({ method: 'GET', url: '/api/status', headers: GOOD_HOST });
    assert.equal(denied.statusCode, 401);
    assert.deepEqual(denied.json(), { error: 'unauthorized' });

    const cookie = await login(app, GOOD_HOST);
    const allowed = await app.inject({ method: 'GET', url: '/api/status', headers: { ...GOOD_HOST, cookie } });
    assert.equal(allowed.statusCode, 200);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('/auth/login itself is exempt from the gate (REQ-19.3)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix, { auth: makeAuth() }));
  try {
    const res = await app.inject({ method: 'POST', url: '/auth/login', headers: GOOD_HOST, payload: { password: PASSWORD } });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('static SPA shell is exempt: / serves with no session; a missing asset still 404s, not 401 (REQ-19.3)', async () => {
  const fix = makeHome();
  const distDir = mkdtempSync(join(tmpdir(), 'console-web-dist-'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
  const app = buildApp(depsFor(fix, { auth: makeAuth(), webDistDir: distDir }));
  try {
    const index = await app.inject({ method: 'GET', url: '/', headers: GOOD_HOST });
    assert.equal(index.statusCode, 200);

    const asset = await app.inject({ method: 'GET', url: '/assets/missing.js', headers: GOOD_HOST });
    assert.equal(asset.statusCode, 404, 'exemption lets the route run; the route itself 404s a missing file');
  } finally {
    await app.close();
    fix.cleanup();
    rmSync(distDir, { recursive: true, force: true });
  }
});

test('the gate applies uniformly, even to unregistered paths (REQ-19.3)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix, { auth: makeAuth() }));
  try {
    const known = await app.inject({ method: 'GET', url: '/api/projects', headers: GOOD_HOST });
    const unknown = await app.inject({ method: 'GET', url: '/api/does-not-exist', headers: GOOD_HOST });
    assert.equal(known.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(known.json(), unknown.json());
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-Term stays loopback-hard even with a VALID authenticated session on a non-loopback bind (REQ-19.9, INV-17 regression)', async () => {
  const fix = makeHome();
  const host = { host: '192.168.1.5:9119' };
  const app = buildApp(depsFor(fix, { bindHost: '192.168.1.5', auth: makeAuth(), termManager: stubTerm() }));
  try {
    const cookie = await login(app, host);
    const list = await app.inject({ method: 'GET', url: '/api/term/sessions', headers: { ...host, cookie } });
    assert.equal(list.statusCode, 403, 'authenticated but F-Term is loopback-only regardless (INV-17)');
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('no auth provider configured: routes stay open (backward compatible, loopback dev default)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: GOOD_HOST });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
    fix.cleanup();
  }
});
