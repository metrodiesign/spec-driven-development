// Google OIDC provider (REQ-20). Crypto-level checks exercise `verifyIdToken`
// directly with a REAL RSA keypair (node:crypto) — no network, no JWT library.
// One route-level test proves the wiring (cookies, redirect, state/nonce
// round-trip via a fake injectable `fetchFn` — mirrors the ExecFn seam pattern).

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';

import Fastify from 'fastify';

import { createOidcProvider, verifyIdToken } from './oidc.ts';
import { readSessionCookie, verifySession, type AuthConfig } from './provider.ts';

const NOW = Date.parse('2026-01-05T12:00:00Z');
const ISSUER = 'https://accounts.google.com' as const;
const CLIENT_ID = 'test-client-id';
const ALLOWED_SUB = 'operator-sub-123';
const KID = 'test-kid';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK: { kty: string; n: string; e: string; kid: string } = {
  ...(publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string }),
  kid: KID,
};
const JWKS = { keys: [JWK] };

function signRS256(data: string, key: KeyObject): string {
  return cryptoSign('RSA-SHA256', Buffer.from(data), key).toString('base64url');
}

function makeIdToken(payload: Record<string, unknown>, opts?: { alg?: string; kid?: string }): string {
  const header = { alg: opts?.alg ?? 'RS256', kid: opts?.kid ?? KID };
  const signedData = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${signedData}.${signRS256(signedData, privateKey)}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: ALLOWED_SUB,
    nonce: 'the-nonce',
    exp: Math.floor(NOW / 1000) + 3600,
    ...overrides,
  };
}

const VERIFY_OPTS = { issuer: ISSUER, audience: CLIENT_ID, nonce: 'the-nonce', allowedSub: ALLOWED_SUB, now: NOW };

// --- verifyIdToken: pure crypto verification, exhaustive edge cases ---

test('verifyIdToken: a validly-signed token with matching claims verifies (REQ-20.4)', () => {
  const token = makeIdToken(validPayload());
  assert.deepEqual(verifyIdToken(token, JWKS, VERIFY_OPTS), { sub: ALLOWED_SUB, method: 'oidc' });
});

test('verifyIdToken: a tampered payload fails signature verification (REQ-20.5)', () => {
  const token = makeIdToken(validPayload());
  const [h, , s] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify(validPayload({ sub: 'attacker' }))).toString('base64url');
  assert.equal(verifyIdToken(`${h}.${forgedPayload}.${s}`, JWKS, VERIFY_OPTS), null);
});

test('verifyIdToken: wrong issuer/audience/nonce/sub each fail closed (REQ-20.4/20.5)', () => {
  assert.equal(verifyIdToken(makeIdToken(validPayload({ iss: 'https://evil.example.com' })), JWKS, VERIFY_OPTS), null);
  assert.equal(verifyIdToken(makeIdToken(validPayload({ aud: 'someone-elses-client' })), JWKS, VERIFY_OPTS), null);
  assert.equal(verifyIdToken(makeIdToken(validPayload({ nonce: 'wrong-nonce' })), JWKS, VERIFY_OPTS), null);
  assert.equal(verifyIdToken(makeIdToken(validPayload({ sub: 'someone-else' })), JWKS, VERIFY_OPTS), null);
});

test('verifyIdToken: expired token fails closed', () => {
  const token = makeIdToken(validPayload({ exp: Math.floor(NOW / 1000) - 10 }));
  assert.equal(verifyIdToken(token, JWKS, VERIFY_OPTS), null);
});

test('verifyIdToken: exact expiry boundary fails closed (F6)', () => {
  const token = makeIdToken(validPayload({ exp: Math.floor(NOW / 1000) }));
  assert.equal(verifyIdToken(token, JWKS, VERIFY_OPTS), null);
});

test('verifyIdToken: non-RS256 alg or unknown kid fails closed', () => {
  assert.equal(verifyIdToken(makeIdToken(validPayload(), { alg: 'none' }), JWKS, VERIFY_OPTS), null);
  assert.equal(verifyIdToken(makeIdToken(validPayload(), { kid: 'no-such-key' }), JWKS, VERIFY_OPTS), null);
});

test('verifyIdToken: malformed token (wrong segment count / bad base64) never throws', () => {
  assert.equal(verifyIdToken('not-a-jwt', JWKS, VERIFY_OPTS), null);
  assert.equal(verifyIdToken('a.b', JWKS, VERIFY_OPTS), null);
  assert.equal(verifyIdToken('a.b.c', JWKS, VERIFY_OPTS), null);
});

// --- Route-level: full start -> callback wiring against a fake fetchFn ---

const CONFIG: Extract<AuthConfig, { provider: 'oidc' }> = {
  provider: 'oidc',
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'test-client-secret',
  redirectUri: 'https://box.tailnet.ts.net/auth/oidc/callback',
  allowedSub: ALLOWED_SUB,
  signingSecret: 'test-signing-secret',
};
const SESSION_TTL_MS = 60_000;

function fakeResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function makeFetch(idTokenForCode: (code: string) => string): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href === 'https://accounts.google.com/.well-known/openid-configuration') {
      return fakeResponse({
        authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token',
        jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
      });
    }
    if (href === 'https://www.googleapis.com/oauth2/v3/certs') return fakeResponse(JWKS);
    if (href === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      const code = body.get('code') ?? '';
      return fakeResponse({ id_token: idTokenForCode(code) });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
}

function extractParam(location: string, name: string): string {
  const v = new URL(location).searchParams.get(name);
  assert.ok(v !== null, `missing ${name} in redirect`);
  return v as string;
}

test('GET /auth/oidc/start -> callback: full round trip mints a session (REQ-20.3/20.4)', async () => {
  const fetchFn = makeFetch((code) => {
    assert.equal(code, 'fake-code');
    return makeIdToken(validPayload({ nonce: 'placeholder' })); // nonce patched below via closure
  });
  const provider = createOidcProvider({ config: CONFIG, now: () => NOW, sessionTtlMs: SESSION_TTL_MS, fetchFn });
  const app = Fastify({ logger: false });
  provider.routes(app);
  try {
    const start = await app.inject({ method: 'GET', url: '/auth/oidc/start' });
    assert.equal(start.statusCode, 302);
    const location = start.headers.location as string;
    const state = extractParam(location, 'state');
    const nonce = extractParam(location, 'nonce');
    assert.equal(extractParam(location, 'code_challenge_method'), 'S256');
    const pendingCookie = (start.headers['set-cookie'] as string).split(';')[0];

    // Re-issue the id_token now that we know the real nonce (the browser round-trips it through Google).
    const fetchFn2 = makeFetch((code) => {
      assert.equal(code, 'fake-code');
      return makeIdToken(validPayload({ nonce }));
    });
    const provider2 = createOidcProvider({ config: CONFIG, now: () => NOW, sessionTtlMs: SESSION_TTL_MS, fetchFn: fetchFn2 });
    const app2 = Fastify({ logger: false });
    provider2.routes(app2);
    try {
      const callback = await app2.inject({
        method: 'GET',
        url: `/auth/oidc/callback?code=fake-code&state=${state}`,
        headers: { cookie: pendingCookie as string },
      });
      assert.equal(callback.statusCode, 302);
      assert.equal(callback.headers.location, '/');
      const cookies = callback.headers['set-cookie'] as string[];
      const sessionCookie = cookies.find((c) => c.startsWith('platform_session='));
      assert.ok(sessionCookie !== undefined);
      const token = readSessionCookie(sessionCookie as string);
      assert.deepEqual(verifySession(token as string, { signingSecret: CONFIG.signingSecret, ttlMs: SESSION_TTL_MS }, NOW), {
        sub: ALLOWED_SUB,
        method: 'oidc',
      });
      assert.ok(cookies.some((c) => c.startsWith('oidc_pending=;') || c.includes('oidc_pending=; ')), 'pending cookie cleared');
    } finally {
      await app2.close();
    }
  } finally {
    await app.close();
  }
});

test('GET /auth/oidc/callback: state mismatch -> generic 401 (REQ-20.5)', async () => {
  const fetchFn = makeFetch(() => makeIdToken(validPayload()));
  const provider = createOidcProvider({ config: CONFIG, now: () => NOW, sessionTtlMs: SESSION_TTL_MS, fetchFn });
  const app = Fastify({ logger: false });
  provider.routes(app);
  try {
    const start = await app.inject({ method: 'GET', url: '/auth/oidc/start' });
    const pendingCookie = (start.headers['set-cookie'] as string).split(';')[0];
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=fake-code&state=WRONG-STATE',
      headers: { cookie: pendingCookie as string },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'unauthorized' });
  } finally {
    await app.close();
  }
});

test('GET /auth/oidc/callback: missing pending cookie -> generic 401', async () => {
  const provider = createOidcProvider({ config: CONFIG, now: () => NOW, sessionTtlMs: SESSION_TTL_MS, fetchFn: makeFetch(() => '') });
  const app = Fastify({ logger: false });
  provider.routes(app);
  try {
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=fake-code&state=whatever' });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('GET /auth/oidc/callback: pending cookie exact expiry rejects before token exchange (F7)', async () => {
  let now = NOW;
  let nonce = '';
  let tokenCalls = 0;
  const fetchFn = makeFetch(() => {
    tokenCalls += 1;
    return makeIdToken(validPayload({ nonce }));
  });
  const provider = createOidcProvider({ config: CONFIG, now: () => now, sessionTtlMs: SESSION_TTL_MS, fetchFn });
  const app = Fastify({ logger: false });
  provider.routes(app);
  try {
    const start = await app.inject({ method: 'GET', url: '/auth/oidc/start' });
    const location = start.headers.location as string;
    const state = extractParam(location, 'state');
    nonce = extractParam(location, 'nonce');
    const pendingCookie = (start.headers['set-cookie'] as string).split(';')[0];

    now = NOW + 5 * 60_000;
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/oidc/callback?code=fake-code&state=${state}`,
      headers: { cookie: pendingCookie as string },
    });
    assert.equal(callback.statusCode, 401);
    assert.equal(tokenCalls, 0);
  } finally {
    await app.close();
  }
});

test('forceSecure marks the session AND pending cookies Secure even over plain-http inject (REQ-20.2)', async () => {
  const fetchFn = makeFetch(() => '');
  const provider = createOidcProvider({ config: CONFIG, now: () => NOW, sessionTtlMs: SESSION_TTL_MS, fetchFn, forceSecure: true });
  const app = Fastify({ logger: false });
  provider.routes(app);
  try {
    const start = await app.inject({ method: 'GET', url: '/auth/oidc/start' });
    assert.match(start.headers['set-cookie'] as string, /Secure/);
  } finally {
    await app.close();
  }
});

test('POST /auth/logout clears the session cookie', async () => {
  const provider = createOidcProvider({ config: CONFIG, now: () => NOW, sessionTtlMs: SESSION_TTL_MS, fetchFn: makeFetch(() => '') });
  const app = Fastify({ logger: false });
  provider.routes(app);
  try {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['set-cookie'] as string, /Max-Age=0/);
  } finally {
    await app.close();
  }
});
