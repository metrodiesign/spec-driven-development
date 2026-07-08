// Basic auth provider (REQ-19.6/19.7/19.8, INV-15): scrypt-verified password,
// constant-time compare, per-source-IP lockout. No username — there is exactly
// one operator, so the config's scryptHash IS the account.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import {
  mintSession,
  resolvePrincipal,
  serializeClearCookie,
  serializeSessionCookie,
  type AuthConfig,
  type AuthProvider,
} from './provider.ts';

const SUB = 'operator';
const KEYLEN = 64;

/** Generates the `scryptHash` half of console-auth.json for a given password + salt. */
export function scryptHash(password: string, salt: string): string {
  return scryptSync(password, salt, KEYLEN).toString('hex');
}

/** A fresh random salt for a new console-auth.json (hex, 16 bytes). */
export function generateSalt(): string {
  return randomBytes(16).toString('hex');
}

function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = scryptSync(password, salt, KEYLEN);
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface LoginLimiterOptions {
  maxAttempts: number;
  cooldownMs: number;
}

const DEFAULT_LIMITER: LoginLimiterOptions = { maxAttempts: 5, cooldownMs: 5 * 60_000 };

// ponytail: one in-process Map, not a shared store — single-operator (INV-15),
// single process, mirrors createSpawnRateLimiter's identical shape in bin/platform.ts.
export function createLoginLimiter(opts: LoginLimiterOptions, now: () => number) {
  const state = new Map<string, { failures: number; lockedUntil: number }>();
  return {
    isLocked(ip: string): boolean {
      return (state.get(ip)?.lockedUntil ?? 0) > now();
    },
    recordFailure(ip: string): void {
      const s = state.get(ip) ?? { failures: 0, lockedUntil: 0 };
      s.failures += 1;
      if (s.failures >= opts.maxAttempts) {
        s.lockedUntil = now() + opts.cooldownMs;
        s.failures = 0;
      }
      state.set(ip, s);
    },
    recordSuccess(ip: string): void {
      state.delete(ip);
    },
  };
}

export interface BasicProviderOptions {
  config: Extract<AuthConfig, { provider: 'basic' }>;
  now(): number;
  sessionTtlMs: number;
  limiter?: LoginLimiterOptions;
  /** REQ-20.2: --behind-proxy TLS-terminates upstream, so `req.protocol` reads 'http' at this process even though the browser is on https — force Secure regardless. */
  forceSecure?: boolean;
}

export function createBasicProvider(opts: BasicProviderOptions): AuthProvider {
  const limiter = createLoginLimiter(opts.limiter ?? DEFAULT_LIMITER, opts.now);
  const sessionOpts = { signingSecret: opts.config.signingSecret, ttlMs: opts.sessionTtlMs };
  const secure = (req: { protocol: string }): boolean => opts.forceSecure === true || req.protocol === 'https';

  return {
    kind: 'basic',
    routes(app: FastifyInstance): void {
      app.post<{ Body: { password?: string } }>('/auth/login', async (req, reply) => {
        const ip = req.ip;
        if (limiter.isLocked(ip)) {
          return reply.code(429).send({ error: 'too many attempts; try again later' });
        }
        const password = req.body?.password;
        const ok = typeof password === 'string' && verifyPassword(password, opts.config.salt, opts.config.scryptHash);
        if (!ok) {
          limiter.recordFailure(ip);
          return reply.code(401).send({ error: 'unauthorized' });
        }
        limiter.recordSuccess(ip);
        const token = mintSession({ sub: SUB, method: 'basic' }, sessionOpts, opts.now());
        reply.header('set-cookie', serializeSessionCookie(token, opts.sessionTtlMs, secure(req)));
        return { ok: true };
      });
      app.post('/auth/logout', async (req, reply) => {
        reply.header('set-cookie', serializeClearCookie(secure(req)));
        return { ok: true };
      });
    },
    verify(cookieHeader) {
      return resolvePrincipal(cookieHeader, sessionOpts, opts.now());
    },
  };
}
