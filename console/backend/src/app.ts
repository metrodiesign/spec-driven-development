// Console backend (spec §8 Phase 0 surface). Every UI capability = a REST
// endpoint; reads are live over Claude Code's files (INV-11); responses and
// logs pass redaction (REQ-12.5); no route returns credentials or creates
// users (REQ-12.6 — enforced by negative tests).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import Fastify, { type FastifyInstance } from 'fastify';

import { allTimestamps, readProjects, readSessions } from './claude-data.ts';
import { buildEstimate, MONEY_DISCLAIMER, type UsageConfig } from './usage.ts';
import { corsOriginAllowed, hostHeaderAllowed, redactText } from './security.ts';
import { termAccessAllowed, type CreateSessionInput, type TermManager } from './term.ts';
import {
  installGuardRules,
  permissionDecision,
  resolveEffectiveSettings,
  sha256 as govSha256,
  writeSafe as writeSafeFile,
  type PermRule,
  type ScopeValues,
} from './govern.ts';
import { activityHookEntry, buildSessionSearch, indexUsage, InvalidIngestUrlError, type UsageRecord } from './observe.ts';

const execFileAsync = promisify(execFile);

export interface AppDeps {
  homeDir: string;
  env: Record<string, string | undefined>;
  bindHost: string;
  port: number;
  /** Platform's own domain data dir (usage config lives here — INV-11 compliant). */
  dataDir: string;
  now(): number;
  /** Overridable for tests. */
  cliVersion?(): Promise<string>;
  /** Built SPA directory; when present the app serves it at / (REQ-12.7 UI). */
  webDistDir?: string;
  /** F-Term manager (Phase 1). When present, term routes register (loopback-only hard). */
  termManager?: TermManager;
  /** Per-source spawn rate limiter for F-Term (REQ-13.5); default allows all. */
  termRateOk?(): boolean;
  /** Per-install token for the activity ingest endpoint (REQ-19.2). */
  activityToken?: string;
}

const DISCLAIMER =
  'Third-party tool operating on your local Claude Code installation — not an Anthropic product.';

async function defaultCliVersion(): Promise<string> {
  const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 15_000 });
  return stdout.trim();
}

function usageConfigPath(dataDir: string): string {
  return join(dataDir, 'usage-config.json');
}

function readUsageConfig(dataDir: string): UsageConfig {
  const p = usageConfigPath(dataDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as UsageConfig;
  } catch {
    return {};
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // --- §13.3 Phase-0 subset: host-header + CORS allowlists (REQ-12.4) ---
  app.addHook('onRequest', async (req, reply) => {
    if (!hostHeaderAllowed(req.headers.host, deps.bindHost, deps.port)) {
      await reply.code(403).send({ error: 'host header not allowed' });
      return reply;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (!corsOriginAllowed(origin, deps.bindHost, deps.port)) {
        await reply.code(403).send({ error: 'origin not allowed' });
        return reply;
      }
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
    }
    return;
  });

  // --- Redaction over every JSON response (REQ-12.5, INV-14) ---
  app.addHook('onSend', async (_req, _reply, payload) => {
    if (typeof payload === 'string') return redactText(payload, deps.homeDir);
    return payload;
  });

  // F-Status (REQ-13.1/13.2)
  app.get('/api/status', async () => {
    let cli: { available: boolean; version?: string; hint?: string };
    try {
      const version = await (deps.cliVersion ?? defaultCliVersion)();
      cli = { available: true, version };
    } catch {
      cli = {
        available: false,
        hint: 'CLI not found on PATH — install it and run `claude` once, then reload',
      };
    }
    return {
      disclaimer: DISCLAIMER,
      cli,
      activeRuns: [], // autonomous runs arrive in a later phase; empty by construction in Phase 0
    };
  });

  // F-Proj (REQ-13.3)
  app.get('/api/projects', async () => {
    return { disclaimer: DISCLAIMER, ...readProjects(deps.homeDir) };
  });

  // F-Sess (REQ-13.4/13.5/13.6)
  app.get<{ Querystring: { project?: string } }>('/api/sessions', async (req, reply) => {
    const project = req.query.project;
    if (project === undefined || project.length === 0 || project.includes('/') || project.includes('..')) {
      return reply.code(400).send({ error: 'query param "project" (project id) required' });
    }
    return readSessions(deps.homeDir, project);
  });

  // F-Auth (REQ-14) — names only; never values (INV-12).
  app.get('/api/auth', async () => {
    const shadowingVars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter(
      (name) => (deps.env[name] ?? '').length > 0,
    );
    const credentialFileExists = existsSync(join(deps.homeDir, '.claude', '.credentials.json'));
    return {
      shadowing: shadowingVars.length > 0,
      shadowingVars,
      severity: shadowingVars.length > 0 ? 'red' : 'ok',
      guidance:
        shadowingVars.length > 0
          ? `unset ${shadowingVars.join(' and ')} to bill your subscription instead of the API — ` +
            'the platform never unsets environment variables for you'
          : null,
      activeMethodHeuristic: credentialFileExists ? 'subscription_login' : 'unknown',
    };
  });

  // F-Usage (REQ-15, INV-13)
  app.get('/api/usage/estimate', async () => {
    const estimate = buildEstimate(
      allTimestamps(deps.homeDir),
      readUsageConfig(deps.dataDir),
      deps.now(),
    );
    return { ...estimate, moneyDisclaimer: MONEY_DISCLAIMER };
  });

  app.put<{ Body: { weeklyResetAnchor?: string; calibratedPercent?: number } }>(
    '/api/usage/config',
    async (req, reply) => {
      const body = req.body ?? {};
      const config: UsageConfig = {};
      if (body.weeklyResetAnchor !== undefined) {
        if (Number.isNaN(Date.parse(body.weeklyResetAnchor))) {
          return reply.code(400).send({ error: 'weeklyResetAnchor must be an ISO timestamp' });
        }
        config.weeklyResetAnchor = body.weeklyResetAnchor;
      }
      if (body.calibratedPercent !== undefined) {
        if (typeof body.calibratedPercent !== 'number' || body.calibratedPercent < 0 || body.calibratedPercent > 100) {
          return reply.code(400).send({ error: 'calibratedPercent must be 0..100' });
        }
        config.calibratedPercent = body.calibratedPercent;
      }
      const p = usageConfigPath(deps.dataDir);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(config, null, 2));
      return { saved: true, config };
    },
  );

  // --- F-Term (REQ-13, INV-17): loopback-ONLY hard, even with --insecure ---
  const term = deps.termManager;
  if (term !== undefined) {
    const guardTerm = async (reply: import('fastify').FastifyReply): Promise<boolean> => {
      if (!termAccessAllowed(deps.bindHost)) {
        await reply.code(403).send({
          error: 'F-Term is loopback-only (INV-17): refused on a non-loopback bind even with --insecure',
        });
        return false;
      }
      return true;
    };
    app.post<{ Body: Partial<CreateSessionInput> }>('/api/term/sessions', async (req, reply) => {
      if (!(await guardTerm(reply))) return reply;
      if (deps.termRateOk !== undefined && !deps.termRateOk()) {
        return reply.code(429).send({ error: 'too many terminal spawns; slow down' });
      }
      const body = req.body ?? {};
      if (typeof body.project !== 'string' || body.project.length === 0) {
        return reply.code(400).send({ error: 'project is required' });
      }
      const mode = body.mode === 'full-shell' ? 'full-shell' : 'claude-only';
      const input: CreateSessionInput = { project: body.project, mode };
      if (typeof body.resume === 'string') input.resume = body.resume;
      try {
        return term.create(input);
      } catch (err) {
        // node-pty throws when the `claude` binary is not on PATH (REQ-13.7).
        return reply.code(503).send({
          error: 'terminal unavailable: could not spawn the CLI',
          detail: (err as Error).message,
          hint: 'ensure the `claude` binary is installed and on PATH',
        });
      }
    });
    app.get('/api/term/sessions', async (_req, reply) => {
      if (!(await guardTerm(reply))) return reply;
      return term.list();
    });
    app.post<{ Params: { id: string } }>('/api/term/sessions/:id/attach', async (req, reply) => {
      if (!(await guardTerm(reply))) return reply;
      const re = term.attach(req.params.id);
      if (re === null) return reply.code(404).send({ error: 'no such session' });
      return re;
    });
    app.delete<{ Params: { id: string } }>('/api/term/sessions/:id', async (req, reply) => {
      if (!(await guardTerm(reply))) return reply;
      return { killed: term.kill(req.params.id) };
    });
  }

  // --- F-Set: Effective View resolver (REQ-14.3) ---
  // The client posts the scope values it read live (INV-11); core computes the
  // merge + provenance deterministically. Labeled "computed from files".
  app.post<{ Body: { scopes?: ScopeValues[] } }>('/api/settings/effective', async (req) => {
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
    return { source: 'computed from files', effective: resolveEffectiveSettings(scopes) };
  });

  // --- F-Perm: simulator + idempotent guard install (REQ-15.2/15.3) ---
  app.post<{ Body: { rules?: PermRule[]; tool?: string; path?: string } }>(
    '/api/permissions/simulate',
    async (req, reply) => {
      const { rules, tool, path } = req.body ?? {};
      if (!Array.isArray(rules) || typeof tool !== 'string' || typeof path !== 'string') {
        return reply.code(400).send({ error: 'rules[], tool, path required' });
      }
      return permissionDecision(rules, tool, path);
    },
  );
  app.post<{ Body: { rules?: PermRule[] } }>('/api/permissions/install-guards', async (req) => {
    const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
    return { rules: installGuardRules(rules) };
  });

  // --- F-Auth full (REQ-16): active method + shadowing (names, never values) +
  // setup-token guidance. NO route returns/accepts/stores a token (REQ-16.5). ---
  app.get('/api/auth/full', async () => {
    const chain = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
    const present = chain.filter((name) => (deps.env[name] ?? '').length > 0);
    const shadowing = present.includes('ANTHROPIC_API_KEY') || present.includes('ANTHROPIC_AUTH_TOKEN');
    const credentialFileExists = existsSync(join(deps.homeDir, '.claude', '.credentials.json'));
    return {
      activeMethod: shadowing ? 'env_var_override' : credentialFileExists ? 'subscription_login' : 'unknown',
      // NAMES only — values are never read or returned (INV-12).
      shadowingVars: present.filter((n) => n !== 'CLAUDE_CODE_OAUTH_TOKEN'),
      severity: shadowing ? 'red' : 'ok',
      guidance: shadowing
        ? `unset ${present.join(' and ')} to bill your subscription; the platform never unsets env vars for you`
        : null,
      setupTokenHowTo:
        'run `claude setup-token` yourself to create a 1-year token and set CLAUDE_CODE_OAUTH_TOKEN — ' +
        'the platform never accepts, stores, or displays the token value',
    };
  });

  // --- F-Mem: CLAUDE.md editor with the shared write-safety path (REQ-17.1) ---
  const memPath = (scope: string, project: string | undefined): string | null => {
    if (scope === 'user') return join(deps.homeDir, '.claude', 'CLAUDE.md');
    if (scope === 'project' && typeof project === 'string' && !project.includes('..')) {
      return join(deps.homeDir, project, 'CLAUDE.md');
    }
    return null;
  };
  app.get<{ Querystring: { scope?: string; project?: string } }>('/api/memory', async (req, reply) => {
    const p = memPath(req.query.scope ?? 'user', req.query.project);
    if (p === null) return reply.code(400).send({ error: 'bad scope/project' });
    const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
    return { content, hash: content === '' ? null : govSha256(content), preview: content.slice(0, 4000) };
  });
  app.put<{ Body: { scope?: string; project?: string; content?: string; baseHash?: string | null } }>(
    '/api/memory',
    async (req, reply) => {
      const b = req.body ?? {};
      const p = memPath(b.scope ?? 'user', b.project);
      if (p === null || typeof b.content !== 'string') return reply.code(400).send({ error: 'bad scope/project/content' });
      mkdirSync(dirname(p), { recursive: true });
      const result = writeSafeFile(p, b.content, b.baseHash ?? null);
      if (!result.ok && result.reason === 'conflict') {
        return reply.code(409).send({ error: 'conflict', currentHash: result.currentHash });
      }
      if (!result.ok) return reply.code(422).send({ error: result.detail });
      return { saved: true, hash: result.newHash };
    },
  );

  // --- F-Usage full: indexer over local records (REQ-18) ---
  app.post<{ Body: { records?: UsageRecord[] } }>('/api/usage/full', async (req) => {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const agentPrefix = join(deps.homeDir, '.ai', 'runs', 'agent-sessions');
    return { ...indexUsage(records, agentPrefix), moneyDisclaimer: MONEY_DISCLAIMER };
  });

  // --- F-Act: fail-open activity hook install + token-gated ingest (REQ-19) ---
  app.post<{ Body: { ingestUrl?: string; timeoutMs?: number } }>('/api/activity/install', async (req, reply) => {
    const ingestUrl = req.body?.ingestUrl;
    if (typeof ingestUrl !== 'string') return reply.code(400).send({ error: 'ingestUrl required' });
    const token = deps.activityToken ?? 'set-a-token';
    try {
      return { entry: activityHookEntry(ingestUrl, token, req.body?.timeoutMs ?? 1500) };
    } catch (err) {
      if (err instanceof InvalidIngestUrlError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
  app.post('/api/events/ingest', async (req, reply) => {
    if (deps.activityToken === undefined || req.headers['x-ingest-token'] !== deps.activityToken) {
      return reply.code(401).send({ error: 'bad ingest token' });
    }
    // Accepted; a live server broadcasts over WS (runtime, task 11).
    return reply.code(202).send({ accepted: true });
  });

  // --- F-Sess search: rebuildable FTS5 over session docs (REQ-20) ---
  app.get<{ Querystring: { q?: string; project?: string } }>('/api/sessions/search', async (req, reply) => {
    const q = req.query.q;
    const project = req.query.project;
    if (typeof q !== 'string' || q.length === 0) return reply.code(400).send({ error: 'q required' });
    if (typeof project !== 'string' || project.length === 0) return reply.code(400).send({ error: 'project required' });
    const { sessions } = readSessions(deps.homeDir, project);
    const docs = sessions.map((s) => ({
      sessionId: s.sessionId,
      project,
      text: `${s.sessionId} ${s.firstTs ?? ''} ${s.lastTs ?? ''}`,
    }));
    const search = buildSessionSearch(docs);
    try {
      return { results: search.search(q) };
    } finally {
      search.close();
    }
  });

  // --- Static SPA (built console/web) — path-contained, no directory listing ---
  const dist = deps.webDistDir;
  if (dist !== undefined && existsSync(join(dist, 'index.html'))) {
    app.get('/', async (_req, reply) => {
      return reply.type('text/html').send(readFileSync(join(dist, 'index.html'), 'utf8'));
    });
    app.get<{ Params: { file: string } }>('/assets/:file', async (req, reply) => {
      const name = req.params.file;
      if (name.includes('/') || name.includes('..')) {
        return reply.code(400).send({ error: 'bad asset path' });
      }
      const p = join(dist, 'assets', name);
      if (!existsSync(p)) return reply.code(404).send({ error: 'not found' });
      const type = name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : 'application/octet-stream';
      return reply.type(type).send(readFileSync(p));
    });
  }

  return app;
}
