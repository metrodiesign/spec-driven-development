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
