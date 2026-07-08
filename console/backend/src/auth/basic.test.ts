import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import { createBasicProvider, createLoginLimiter, generateSalt, scryptHash } from './basic.ts';
import { mintSession, readSessionCookie, verifySession, type AuthConfig } from './provider.ts';

const NOW = Date.parse('2026-01-05T12:00:00Z');
const SALT = 'fixed-test-salt';
const PASSWORD = 'correct horse battery staple';
const CONFIG: Extract<AuthConfig, { provider: 'basic' }> = {
  provider: 'basic',
  scryptHash: scryptHash(PASSWORD, SALT),
  salt: SALT,
  signingSecret: 'test-signing-secret',
};
const SESSION_TTL_MS = 60_000;

function buildTestApp(nowFn: () => number = () => NOW) {
  const app = Fastify({ logger: false });
  const provider = createBasicProvider({
    config: CONFIG,
    now: nowFn,
    sessionTtlMs: SESSION_TTL_MS,
    limiter: { maxAttempts: 3, cooldownMs: 60_000 },
  });
  provider.routes(app);
  return { app, provider };
}

test('scryptHash: deterministic for the same password+salt, differs for a wrong password', () => {
  assert.equal(scryptHash(PASSWORD, SALT), scryptHash(PASSWORD, SALT));
  assert.notEqual(scryptHash(PASSWORD, SALT), scryptHash('wrong password', SALT));
});

test('generateSalt: produces distinct hex salts', () => {
  const a = generateSalt();
  const b = generateSalt();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('createLoginLimiter: locks after maxAttempts, unlocks after cooldown, success resets, per-IP (REQ-19.7)', () => {
  let now = 0;
  const limiter = createLoginLimiter({ maxAttempts: 2, cooldownMs: 1000 }, () => now);
  assert.equal(limiter.isLocked('1.2.3.4'), false);
  limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isLocked('1.2.3.4'), false, 'one failure is not a lockout yet');
  limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isLocked('1.2.3.4'), true, 'second failure trips the lock');

  const other = '5.6.7.8';
  assert.equal(limiter.isLocked(other), false, 'lockout is per source IP');

  now += 1001;
  assert.equal(limiter.isLocked('1.2.3.4'), false, 'cooldown elapsed');
  limiter.recordFailure('1.2.3.4');
  limiter.recordSuccess('1.2.3.4');
  assert.equal(limiter.isLocked('1.2.3.4'), false, 'success resets failures');
});

test('POST /auth/login: correct password sets a session cookie (REQ-19.4/19.5)', async () => {
  const { app } = buildTestApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: PASSWORD } });
    assert.equal(res.statusCode, 200);
    const cookie = res.headers['set-cookie'];
    assert.equal(typeof cookie, 'string');
    const cookieStr = cookie as string;
    assert.match(cookieStr, /HttpOnly/);
    assert.match(cookieStr, /SameSite=Lax/);
    assert.ok(!cookieStr.includes('Secure'), 'plain http inject -> no Secure flag');

    const token = readSessionCookie(cookieStr);
    assert.ok(token !== null);
    assert.deepEqual(verifySession(token as string, { signingSecret: CONFIG.signingSecret, ttlMs: SESSION_TTL_MS }, NOW), {
      sub: 'operator',
      method: 'basic',
    });
  } finally {
    await app.close();
  }
});

test('POST /auth/login: wrong password -> generic 401, no cookie (REQ-19.6)', async () => {
  const { app } = buildTestApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'nope' } });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'unauthorized' });
    assert.equal(res.headers['set-cookie'], undefined);
  } finally {
    await app.close();
  }
});

test('POST /auth/login: missing password body -> the SAME generic 401 (REQ-19.6 generic-401 property)', async () => {
  const { app } = buildTestApp();
  try {
    const wrongPw = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'nope' } });
    const noPw = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    assert.equal(noPw.statusCode, wrongPw.statusCode);
    assert.deepEqual(noPw.json(), wrongPw.json());
  } finally {
    await app.close();
  }
});

test('POST /auth/login: lockout after maxAttempts -> 429, even with the correct password (REQ-19.7)', async () => {
  const { app } = buildTestApp();
  try {
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'nope' } });
      assert.equal(r.statusCode, 401);
    }
    const locked = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: PASSWORD } });
    assert.equal(locked.statusCode, 429);
  } finally {
    await app.close();
  }
});

test('POST /auth/login: lockout releases after the cooldown (REQ-19.7)', async () => {
  let now = NOW;
  const { app } = buildTestApp(() => now);
  try {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'nope' } });
    }
    now += 60_001;
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: PASSWORD } });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('POST /auth/logout: clears the cookie', async () => {
  const { app } = buildTestApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['set-cookie'] as string, /Max-Age=0/);
  } finally {
    await app.close();
  }
});

test('provider.verify: valid cookie -> Principal; missing/invalid -> null', () => {
  const { provider } = buildTestApp();
  const token = mintSession({ sub: 'operator', method: 'basic' }, { signingSecret: CONFIG.signingSecret, ttlMs: SESSION_TTL_MS }, NOW);
  assert.deepEqual(provider.verify(`platform_session=${token}`), { sub: 'operator', method: 'basic' });
  assert.equal(provider.verify(undefined), null);
  assert.equal(provider.verify('platform_session=garbage'), null);
});
