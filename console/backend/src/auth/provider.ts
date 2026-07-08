// Remote auth seam (REQ-19, INV-15 single operator). Sessions are self-verifying
// HMAC tokens — the console keeps no server-side session store (INV-11 pattern
// extended to auth state). `basic.ts` (task 10) and `oidc.ts` (task 11) both
// implement this seam and share the session/cookie plumbing below.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

export interface Principal {
  sub: string;
  method: 'basic' | 'oidc';
}

export interface AuthProvider {
  kind: 'basic' | 'oidc';
  /** Registers this provider's own routes (e.g. /auth/login, /auth/logout). */
  routes(app: FastifyInstance): void;
  /** Stateless: verifies the raw `Cookie` header, returns the Principal or null. */
  verify(cookieHeader: string | undefined): Principal | null;
}

export interface SessionTokenOptions {
  signingSecret: string;
  ttlMs: number;
}

interface SessionPayload {
  sub: string;
  method: 'basic' | 'oidc';
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** `payload.signature` token, HMAC-SHA256 — expiry lives INSIDE the signed payload (REQ-19.4). */
export function mintSession(p: Principal, opts: SessionTokenOptions, now: number): string {
  const payloadObj: SessionPayload = { sub: p.sub, method: p.method, exp: now + opts.ttlMs };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${payload}.${sign(payload, opts.signingSecret)}`;
}

/** Rejects a malformed/expired/tampered token by returning null — never throws (REQ-19.4). */
export function verifySession(token: string, opts: SessionTokenOptions, now: number): Principal | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload, opts.signingSecret);
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (typeof parsed.exp !== 'number' || parsed.exp < now) return null;
    if (parsed.method !== 'basic' && parsed.method !== 'oidc') return null;
    if (typeof parsed.sub !== 'string') return null;
    return { sub: parsed.sub, method: parsed.method };
  } catch {
    return null;
  }
}

/**
 * `~/.platform/console-auth.json` (mode 0600, never committed — Secrets rules).
 * Hand-authored by the operator; `basic.ts`'s `scryptHash()` prints the hash half.
 */
export type AuthConfig =
  | { provider: 'basic'; scryptHash: string; salt: string; signingSecret: string }
  | {
      provider: 'oidc';
      issuer: 'https://accounts.google.com';
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      allowedSub: string;
      signingSecret: string;
    };

export function loadAuthConfig(path: string): AuthConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (
      parsed['provider'] === 'basic' &&
      typeof parsed['scryptHash'] === 'string' &&
      typeof parsed['salt'] === 'string' &&
      typeof parsed['signingSecret'] === 'string'
    ) {
      return { provider: 'basic', scryptHash: parsed['scryptHash'], salt: parsed['salt'], signingSecret: parsed['signingSecret'] };
    }
    if (
      parsed['provider'] === 'oidc' &&
      typeof parsed['clientId'] === 'string' &&
      typeof parsed['clientSecret'] === 'string' &&
      typeof parsed['redirectUri'] === 'string' &&
      typeof parsed['allowedSub'] === 'string' &&
      typeof parsed['signingSecret'] === 'string'
    ) {
      return {
        provider: 'oidc',
        issuer: 'https://accounts.google.com',
        clientId: parsed['clientId'],
        clientSecret: parsed['clientSecret'],
        redirectUri: parsed['redirectUri'],
        allowedSub: parsed['allowedSub'],
        signingSecret: parsed['signingSecret'],
      };
    }
    return null;
  } catch {
    return null;
  }
}

const COOKIE_NAME = 'platform_session';

export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Cookie flags per REQ-19.5: HttpOnly + SameSite=Lax always, Secure only over TLS. */
export function serializeSessionCookie(token: string, ttlMs: number, secure: boolean): string {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(ttlMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function serializeClearCookie(secure: boolean): string {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Shared by every provider's `verify()`: cookie lookup + session verification. */
export function resolvePrincipal(cookieHeader: string | undefined, opts: SessionTokenOptions, now: number): Principal | null {
  const token = readSessionCookie(cookieHeader);
  return token === null ? null : verifySession(token, opts, now);
}
