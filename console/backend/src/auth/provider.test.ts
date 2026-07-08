import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  loadAuthConfig,
  mintSession,
  readSessionCookie,
  serializeClearCookie,
  serializeSessionCookie,
  verifySession,
  type Principal,
  type SessionTokenOptions,
} from './provider.ts';

const NOW = Date.parse('2026-01-05T12:00:00Z');
const OPTS: SessionTokenOptions = { signingSecret: 'test-signing-secret', ttlMs: 60_000 };
const PRINCIPAL: Principal = { sub: 'operator', method: 'basic' };

test('mintSession/verifySession round-trip (REQ-19.4)', () => {
  const token = mintSession(PRINCIPAL, OPTS, NOW);
  assert.deepEqual(verifySession(token, OPTS, NOW), PRINCIPAL);
  assert.deepEqual(verifySession(token, OPTS, NOW + 30_000), PRINCIPAL, 'still valid before expiry');
});

test('verifySession: expiry rejects (REQ-19.4)', () => {
  const token = mintSession(PRINCIPAL, OPTS, NOW);
  assert.equal(verifySession(token, OPTS, NOW + 60_001), null);
});

test('verifySession: tamper (bit-flip) rejects (REQ-19.4)', () => {
  const token = mintSession(PRINCIPAL, OPTS, NOW);
  const dot = token.indexOf('.');
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Flip the payload's first character — the signature no longer matches.
  const flipped = payload.charAt(0) === 'a' ? 'b' : 'a';
  const tampered = `${flipped}${payload.slice(1)}.${sig}`;
  assert.equal(verifySession(tampered, OPTS, NOW), null);
});

test('verifySession: wrong signing secret rejects', () => {
  const token = mintSession(PRINCIPAL, OPTS, NOW);
  assert.equal(verifySession(token, { ...OPTS, signingSecret: 'a-different-secret' }, NOW), null);
});

test('verifySession: malformed tokens reject without throwing', () => {
  assert.equal(verifySession('', OPTS, NOW), null);
  assert.equal(verifySession('not-a-token-at-all', OPTS, NOW), null);
  assert.equal(verifySession('..', OPTS, NOW), null);
});

test('loadAuthConfig: missing file -> null', () => {
  assert.equal(loadAuthConfig(join(tmpdir(), 'does-not-exist-console-auth.json')), null);
});

test('loadAuthConfig: valid basic config round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'console-auth-'));
  try {
    const p = join(dir, 'console-auth.json');
    writeFileSync(p, JSON.stringify({ provider: 'basic', scryptHash: 'ab', salt: 'cd', signingSecret: 'ef' }));
    assert.deepEqual(loadAuthConfig(p), { provider: 'basic', scryptHash: 'ab', salt: 'cd', signingSecret: 'ef' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAuthConfig: corrupt JSON / unknown provider / missing fields -> null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'console-auth-'));
  try {
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    assert.equal(loadAuthConfig(corrupt), null);

    const unknown = join(dir, 'unknown.json');
    writeFileSync(unknown, JSON.stringify({ provider: 'saml' }));
    assert.equal(loadAuthConfig(unknown), null);

    const incomplete = join(dir, 'incomplete.json');
    writeFileSync(incomplete, JSON.stringify({ provider: 'basic', scryptHash: 'ab' }));
    assert.equal(loadAuthConfig(incomplete), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSessionCookie: finds the named cookie among others', () => {
  assert.equal(readSessionCookie(undefined), null);
  assert.equal(readSessionCookie('foo=bar'), null);
  assert.equal(readSessionCookie('foo=bar; platform_session=tok123; other=x'), 'tok123');
});

test('serializeSessionCookie/serializeClearCookie: flags (REQ-19.5)', () => {
  const set = serializeSessionCookie('tok', 60_000, false);
  assert.match(set, /^platform_session=tok;/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Max-Age=60/);
  assert.ok(!set.includes('Secure'), 'no Secure flag over plain http');

  const setSecure = serializeSessionCookie('tok', 60_000, true);
  assert.match(setSecure, /Secure/);

  const cleared = serializeClearCookie(false);
  assert.match(cleared, /Max-Age=0/);
  assert.ok(!cleared.includes('Secure'));
  assert.match(serializeClearCookie(true), /Secure/);
});
