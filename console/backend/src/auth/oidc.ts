// Google OIDC provider (REQ-20, INV-15 single operator). Discovery + PKCE
// S256 + id_token verification use only `node:crypto` (RS256 via JWK import —
// no JWT/JOSE dependency, mirrors the zero-parser-dependency ethos elsewhere
// in this codebase). `fetchFn` is injectable so tests are hermetic (no real
// network — mirrors the ExecFn/SpawnChild seam pattern used by the other
// adapters). State/nonce/PKCE verifier travel in a short-lived signed cookie,
// not server memory — the console keeps no session store (provider.ts).

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  mintSession,
  resolvePrincipal,
  serializeClearCookie,
  serializeSessionCookie,
  type AuthConfig,
  type AuthProvider,
  type Principal,
} from './provider.ts';

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Jwk {
  kty: string;
  n: string;
  e: string;
  kid: string;
}

interface Jwks {
  keys: Jwk[];
}

export interface IdTokenVerifyOptions {
  issuer: string;
  audience: string;
  nonce: string;
  allowedSub: string;
  /** ms since epoch (this codebase's clock convention — converted to JWT seconds internally). */
  now: number;
}

/**
 * Pure RS256 `id_token` verification (REQ-20.4/20.5): decodes the JWT,
 * resolves the signing key from `jwks` by `kid`, verifies the signature via
 * `node:crypto`, then pins issuer/audience/nonce/expiry/subject. Returns null
 * on ANY failure — never throws, never distinguishes which check failed
 * (generic 401 at the call site, REQ-20.5).
 */
export function verifyIdToken(idToken: string, jwks: Jwks, opts: IdTokenVerifyOptions): Principal | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as typeof header;
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (jwk === undefined) return null;
  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  } catch {
    return null;
  }
  let sigOk: boolean;
  try {
    sigOk = cryptoVerify('RSA-SHA256', Buffer.from(`${headerB64}.${payloadB64}`), publicKey, Buffer.from(sigB64, 'base64url'));
  } catch {
    return null;
  }
  if (!sigOk) return null;
  if (payload['iss'] !== opts.issuer) return null;
  if (payload['aud'] !== opts.audience) return null;
  if (payload['nonce'] !== opts.nonce) return null;
  if (typeof payload['exp'] !== 'number' || payload['exp'] <= opts.now / 1000) return null;
  if (payload['sub'] !== opts.allowedSub) return null;
  return { sub: opts.allowedSub, method: 'oidc' };
}

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** PKCE S256 (REQ-20.3): a fresh verifier/challenge pair per `/auth/oidc/start`. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomUrlSafe(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface PendingOidc {
  state: string;
  nonce: string;
  codeVerifier: string;
  exp: number;
}

// Small HMAC sign/verify pair distinct from provider.ts's mintSession/verifySession
// (different payload shape — Principal vs. this pending-handshake blob); kept
// local rather than widening provider.ts's API for a single extra caller.
function signPending(p: PendingOidc, secret: string): string {
  const payload = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function verifyPending(token: string, secret: string, now: number): PendingOidc | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<PendingOidc>;
    if (
      typeof parsed.state !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.codeVerifier !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp <= now
    ) {
      return null;
    }
    return { state: parsed.state, nonce: parsed.nonce, codeVerifier: parsed.codeVerifier, exp: parsed.exp };
  } catch {
    return null;
  }
}

const PENDING_COOKIE = 'oidc_pending';
const PENDING_TTL_MS = 5 * 60_000;

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (cookieHeader === undefined) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface OidcProviderOptions {
  config: Extract<AuthConfig, { provider: 'oidc' }>;
  now(): number;
  sessionTtlMs: number;
  /** REQ-20.2: force Secure cookies under --behind-proxy (TLS terminates upstream). */
  forceSecure?: boolean;
  /** Injectable for hermetic tests (default: global fetch). */
  fetchFn?: typeof fetch;
}

const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';

export function createOidcProvider(opts: OidcProviderOptions): AuthProvider {
  const fetchFn = opts.fetchFn ?? fetch;
  const sessionOpts = { signingSecret: opts.config.signingSecret, ttlMs: opts.sessionTtlMs };
  const secure = (req: FastifyRequest): boolean => opts.forceSecure === true || req.protocol === 'https';

  // Fetched once, cached (design §F) — a fresh provider instance per process start.
  let discoveryCache: Promise<Discovery> | null = null;
  const getDiscovery = (): Promise<Discovery> => {
    discoveryCache ??= fetchFn(DISCOVERY_URL).then((r) => r.json() as Promise<Discovery>);
    return discoveryCache;
  };
  let jwksCache: Promise<Jwks> | null = null;
  const getJwks = async (): Promise<Jwks> => {
    const discovery = await getDiscovery();
    jwksCache ??= fetchFn(discovery.jwks_uri).then((r) => r.json() as Promise<Jwks>);
    return jwksCache;
  };

  return {
    kind: 'oidc',
    routes(app: FastifyInstance): void {
      app.get('/auth/oidc/start', async (req, reply) => {
        const discovery = await getDiscovery();
        const state = randomUrlSafe(16);
        const nonce = randomUrlSafe(16);
        const { verifier, challenge } = pkcePair();
        const pending = signPending(
          { state, nonce, codeVerifier: verifier, exp: opts.now() + PENDING_TTL_MS },
          opts.config.signingSecret,
        );
        const secureFlag = secure(req) ? '; Secure' : '';
        reply.header(
          'set-cookie',
          `${PENDING_COOKIE}=${pending}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PENDING_TTL_MS / 1000}${secureFlag}`,
        );
        const url = new URL(discovery.authorization_endpoint);
        url.searchParams.set('client_id', opts.config.clientId);
        url.searchParams.set('redirect_uri', opts.config.redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', 'openid');
        url.searchParams.set('state', state);
        url.searchParams.set('nonce', nonce);
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        return reply.redirect(url.toString());
      });

      app.get<{ Querystring: { code?: string; state?: string } }>('/auth/oidc/callback', async (req, reply) => {
        const pending = verifyPending(readCookie(req.headers.cookie, PENDING_COOKIE) ?? '', opts.config.signingSecret, opts.now());
        const { code, state } = req.query;
        if (pending === null || typeof code !== 'string' || typeof state !== 'string' || state !== pending.state) {
          return reply.code(401).send({ error: 'unauthorized' });
        }
        const discovery = await getDiscovery();
        const tokenRes = await fetchFn(discovery.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: opts.config.redirectUri,
            client_id: opts.config.clientId,
            client_secret: opts.config.clientSecret,
            code_verifier: pending.codeVerifier,
          }).toString(),
        });
        if (!tokenRes.ok) return reply.code(401).send({ error: 'unauthorized' });
        const tokenBody = (await tokenRes.json()) as { id_token?: string };
        if (typeof tokenBody.id_token !== 'string') return reply.code(401).send({ error: 'unauthorized' });
        const jwks = await getJwks();
        const principal = verifyIdToken(tokenBody.id_token, jwks, {
          issuer: opts.config.issuer,
          audience: opts.config.clientId,
          nonce: pending.nonce,
          allowedSub: opts.config.allowedSub,
          now: opts.now(),
        });
        if (principal === null) return reply.code(401).send({ error: 'unauthorized' });
        const session = mintSession(principal, sessionOpts, opts.now());
        reply.header('set-cookie', [
          serializeSessionCookie(session, opts.sessionTtlMs, secure(req)),
          `${PENDING_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        ]);
        return reply.redirect('/');
      });

      // REQ-20.7: stateless expiry is the recorded simplification — no revocation call to Google.
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
