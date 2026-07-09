// Console backend (spec §8 Phase 0 surface). Every UI capability = a REST
// endpoint; reads are live over Claude Code's files (INV-11); responses and
// logs pass redaction (REQ-12.5); no route returns credentials or creates
// users (REQ-12.6 — enforced by negative tests).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { AuthProvider } from './auth/provider.ts';
import { allTimestamps, readProjects, readSessions } from './claude-data.ts';
import { buildEstimate, MONEY_DISCLAIMER, type UsageConfig } from './usage.ts';
import { corsOriginAllowed, hostHeaderAllowed, isLoopback, redactText } from './security.ts';
import { termAccessAllowed, type CreateSessionInput, type TermManager } from './term.ts';
import { discoverRuns, findRun, loopFetch } from './loop-proxy.ts';
import { decideAutomationStart, loadAutomationConfig } from './guards.ts';
import { decideSchedStart, scriptAllowed, type SchedRuntime } from './sched.ts';
import { loadRoutingConfig } from 'aal';
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
import {
  confirmToken,
  jsonDiffPreview,
  retentionPreview,
  validateHookConfig,
  validateMcpConfig,
  validateSubagentFrontmatter,
} from './surfaces.ts';

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
  /** Captured non-interactive `claude doctor` output (REQ-15.1). Overridable for tests. */
  doctorCapture?(): Promise<string>;
  /** Built SPA directory; when present the app serves it at / (REQ-12.7 UI). */
  webDistDir?: string;
  /**
   * Remote auth gate (REQ-19). When present, every route requires a valid
   * session except this provider's own `/auth/*` routes and the static SPA
   * shell. Absent = no gate (loopback dev default, mirrors termManager).
   */
  auth?: AuthProvider;
  /**
   * REQ-20.2/20.8: the --behind-proxy public host (hostname[:port] form), when
   * set. Threaded into the host-header/CORS allowlist and ORed into the single
   * remote definition (REQ-20.8) alongside the per-request peer-loopback check.
   */
  behindProxyHost?: string;
  /** F-Term manager (Phase 1). When present, term routes register (loopback-only hard). */
  termManager?: TermManager;
  /** Per-source spawn rate limiter for F-Term (REQ-13.5); default allows all. */
  termRateOk?(): boolean;
  /** F-Loop (REQ-15): root dir whose subdirectories hold each run's human-plane.json. Absent = routes do not register (mirrors termManager). */
  loopRunsRoot?: string;
  /**
   * F-Sched (REQ-16): the thin runtime for the one registered child + where its
   * governed inputs live. Absent = routes do not register (mirrors termManager).
   */
  sched?: {
    runtime: SchedRuntime;
    /** Dir holding automation.json + routing.json (REQ-16.2/16.9). */
    policiesDir: string;
    /** This same `platform` binary, spawned again for `loop run` (REQ-16.1). */
    platformBinPath: string;
    /** Dir allowlisted script names resolve against (REQ-16.1/16.7). */
    scriptsDir: string;
    /** Per-source spawn rate limiter (REQ-16.4); default allows all (mirrors termRateOk). */
    rateOk?(): boolean;
  };
  /** Per-install token for the activity ingest endpoint (REQ-19.2). */
  activityToken?: string;
  /**
   * Append-only governance audit sink (REQ-18.3): hook install/uninstall, retention
   * prune. Absent = no-op; the live server appends to the shared audit JSONL, tests
   * inject a capture. Loop-side approvals/steering/kill/governance decisions are
   * recorded in the durable core event log by their producing tasks (3/4/5).
   */
  audit?(entry: Record<string, unknown>): void;
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
    if (!hostHeaderAllowed(req.headers.host, deps.bindHost, deps.port, deps.behindProxyHost)) {
      await reply.code(403).send({ error: 'host header not allowed' });
      return reply;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (!corsOriginAllowed(origin, deps.bindHost, deps.port, deps.behindProxyHost)) {
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

  // --- Remote auth gate (REQ-19, INV-15): every route requires a valid session
  // except this provider's own /auth/* routes and the static SPA shell — an
  // unauthenticated browser still needs to load index.html/assets to render the
  // Login view. Absent = no gate (loopback dev default, mirrors termManager). ---
  const auth = deps.auth;
  if (auth !== undefined) {
    auth.routes(app);
    // REQ-20: lets the unauthenticated Login view (which cannot call the
    // gated /api/auth) discover which form to render — password vs. the OIDC
    // redirect link — before any session exists. Exempt via the /auth/ prefix below.
    app.get('/auth/provider', async () => ({ kind: auth.kind }));
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      if (path.startsWith('/auth/') || path === '/' || path.startsWith('/assets/')) return;
      if (auth.verify(req.headers.cookie) === null) {
        await reply.code(401).send({ error: 'unauthorized' });
        return reply;
      }
      return;
    });
  }

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
  app.get('/api/auth', async (req) => {
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
      // REQ-18.3/20.8/20.9: the single remote definition — behind-proxy set
      // (every request is remote regardless of socket address, since Tailscale
      // Serve TLS-proxies onto the loopback bind) OR a non-loopback peer.
      remote: deps.behindProxyHost !== undefined || !isLoopback(req.ip),
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
      else if (body.mcp === true) input.mcp = true; // F-MCP Authenticate deep link (REQ-18.1)
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

  // ===== Phase-2 governance surfaces (F-MCP/F-Hook/F-Sub/F-Skill/F-Sys) =====
  // All copy the F-Mem pattern: GET -> {content, hash}; writes go through writeSafe
  // (409 conflict / 422 invalid / 200). The MANAGED scope never gets a PUT route
  // (REQ-13.4) — read-only by construction. The audit sink records every write.

  const audit = (entry: Record<string, unknown>): void => deps.audit?.({ at: deps.now(), ...entry });

  const projectBase = (project: string | undefined): string | null => {
    if (typeof project !== 'string' || project.length === 0 || project.includes('..')) return null;
    return join(deps.homeDir, project);
  };
  const settingsScopePath = (scope: string, project: string | undefined): string | null => {
    if (scope === 'user') return join(deps.homeDir, '.claude', 'settings.json');
    if (scope === 'project') { const b = projectBase(project); return b === null ? null : join(b, '.claude', 'settings.json'); }
    if (scope === 'local') { const b = projectBase(project); return b === null ? null : join(b, '.claude', 'settings.local.json'); }
    return null; // managed (or unknown) has no writable path — REQ-13.4
  };
  const contentHash = (p: string): { content: string; hash: string | null } => {
    const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
    return { content, hash: content === '' ? null : govSha256(content) };
  };
  const putThrough = (
    reply: FastifyReply,
    p: string,
    content: string,
    baseHash: string | null | undefined,
    validate?: (c: string) => string | null,
  ): unknown => {
    mkdirSync(dirname(p), { recursive: true });
    const result = writeSafeFile(p, content, baseHash ?? null, validate);
    if (!result.ok && result.reason === 'conflict') return reply.code(409).send({ error: 'conflict', currentHash: result.currentHash });
    if (!result.ok) return reply.code(422).send({ error: result.detail });
    return { saved: true, hash: result.newHash };
  };
  const safeName = (name: string): boolean => name.length > 0 && !name.includes('/') && !name.includes('..');
  const readJson = (p: string): Record<string, unknown> => {
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return {}; }
  };

  // --- F-MCP (REQ-12): project .mcp.json writable; user scope read-only view ---
  const mcpPath = (scope: string, project: string | undefined): string | null => {
    if (scope === 'user') return join(deps.homeDir, '.claude.json'); // multi-purpose CLI state — READ-ONLY (AZ-18)
    if (scope === 'project') { const b = projectBase(project); return b === null ? null : join(b, '.mcp.json'); }
    return null;
  };
  app.get<{ Params: { scope: string }; Querystring: { project?: string } }>('/api/mcp/:scope', async (req, reply) => {
    const p = mcpPath(req.params.scope, req.query.project);
    if (p === null) return reply.code(400).send({ error: 'bad scope/project' });
    return { scope: req.params.scope, readOnly: req.params.scope !== 'project', ...contentHash(p) };
  });
  // PUT registered ONLY for the project scope — user/managed stay read-only (REQ-12.1/13.4).
  app.put<{ Body: { project?: string; content?: string; baseHash?: string | null } }>('/api/mcp/project', async (req, reply) => {
    const b = req.body ?? {};
    const p = mcpPath('project', b.project);
    if (p === null || typeof b.content !== 'string') return reply.code(400).send({ error: 'bad project/content' });
    return putThrough(reply, p, b.content, b.baseHash, validateMcpConfig);
  });
  app.post<{ Body: { transport?: string; command?: string; url?: string } }>('/api/mcp/test', async (req) => {
    // Advisory ONLY — never a verdict that blocks saving (REQ-12.3).
    const { transport, command, url } = req.body ?? {};
    if (transport === 'http' && typeof url === 'string') {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        return { advisory: true, reachable: true, status: r.status };
      } catch (e) {
        return { advisory: true, reachable: false, detail: (e as Error).message };
      } finally {
        clearTimeout(timer);
      }
    }
    if (transport === 'stdio' && typeof command === 'string') {
      try {
        await execFileAsync(command, [], { timeout: 3000 });
        return { advisory: true, reachable: true };
      } catch (e) {
        // A non-zero exit still means the binary spawned — advisory, not a blocker.
        return { advisory: true, reachable: false, detail: (e as Error).message };
      }
    }
    return { advisory: true, reachable: false, detail: 'provide transport stdio+command or http+url' };
  });

  // --- F-Hook (REQ-13): two-step consent gate over settings.json scopes ---
  app.get<{ Params: { scope: string }; Querystring: { project?: string } }>('/api/hooks/:scope', async (req, reply) => {
    const p = settingsScopePath(req.params.scope, req.query.project);
    if (p === null) return reply.code(400).send({ error: 'bad or read-only scope' });
    return { scope: req.params.scope, ...contentHash(p) };
  });
  app.post<{ Body: { scope?: string; project?: string; content?: string } }>('/api/hooks/validate', async (req, reply) => {
    const b = req.body ?? {};
    const p = settingsScopePath(b.scope ?? 'user', b.project);
    if (p === null || typeof b.content !== 'string') return reply.code(400).send({ error: 'bad scope/content' });
    const { content: current, hash: baseHash } = contentHash(p);
    const error = validateHookConfig(b.content);
    return {
      valid: error === null,
      error,
      diff: jsonDiffPreview(current, b.content),
      baseHash,
      confirmToken: confirmToken(baseHash, b.content),
    };
  });
  type HookBody = { scope?: string; project?: string; content?: string; confirmToken?: string; baseHash?: string | null };
  const hookWrite = (verb: 'install' | 'uninstall') =>
    async (req: FastifyRequest<{ Body: HookBody }>, reply: FastifyReply): Promise<unknown> => {
      const b = req.body ?? {};
      const p = settingsScopePath(b.scope ?? '', b.project);
      if (p === null || typeof b.content !== 'string') return reply.code(400).send({ error: 'bad or read-only scope/content' });
      // Consent gate (REQ-13.3): the echoed token must match sha256(baseHash + content).
      if (typeof b.confirmToken !== 'string' || b.confirmToken !== confirmToken(b.baseHash ?? null, b.content)) {
        return reply.code(428).send({ error: 'missing or stale confirmToken; re-run validate' });
      }
      // writeSafe re-checks the base against the CURRENT file: a moved base -> 409 (REQ-13.2).
      const result = putThrough(reply, p, b.content, b.baseHash, validateHookConfig);
      if (result !== null && typeof result === 'object' && 'saved' in (result as object)) {
        audit({ event: `hook_${verb}`, scope: b.scope, path: p });
      }
      return result;
    };
  app.post<{ Body: HookBody }>('/api/hooks/install', hookWrite('install'));
  app.post<{ Body: HookBody }>('/api/hooks/uninstall', hookWrite('uninstall'));

  // --- F-Sub (REQ-14.1/14.3): CRUD .claude/agents/*.md, frontmatter-validated ---
  const agentsDir = (scope: string, project: string | undefined): string | null => {
    if (scope === 'user') return join(deps.homeDir, '.claude', 'agents');
    if (scope === 'project') { const b = projectBase(project); return b === null ? null : join(b, '.claude', 'agents'); }
    return null;
  };
  app.get<{ Querystring: { scope?: string; project?: string } }>('/api/subagents', async (req) => {
    const dir = agentsDir(req.query.scope ?? 'user', req.query.project);
    const names = dir !== null && existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort()
      : [];
    return { subagents: names };
  });
  app.get<{ Params: { name: string }; Querystring: { scope?: string; project?: string } }>('/api/subagents/:name', async (req, reply) => {
    const dir = agentsDir(req.query.scope ?? 'user', req.query.project);
    if (dir === null || !safeName(req.params.name)) return reply.code(400).send({ error: 'bad scope/name' });
    return contentHash(join(dir, `${req.params.name}.md`));
  });
  app.put<{ Params: { name: string }; Body: { scope?: string; project?: string; content?: string; baseHash?: string | null } }>(
    '/api/subagents/:name',
    async (req, reply) => {
      const b = req.body ?? {};
      const dir = agentsDir(b.scope ?? 'user', b.project);
      if (dir === null || !safeName(req.params.name) || typeof b.content !== 'string') {
        return reply.code(400).send({ error: 'bad scope/name/content' });
      }
      return putThrough(reply, join(dir, `${req.params.name}.md`), b.content, b.baseHash, (c) => {
        const v = validateSubagentFrontmatter(c);
        return v.ok ? null : v.error;
      });
    },
  );
  app.delete<{ Params: { name: string }; Querystring: { scope?: string; project?: string } }>('/api/subagents/:name', async (req, reply) => {
    const dir = agentsDir(req.query.scope ?? 'user', req.query.project);
    if (dir === null || !safeName(req.params.name)) return reply.code(400).send({ error: 'bad scope/name' });
    const p = join(dir, `${req.params.name}.md`);
    const existed = existsSync(p);
    if (existed) unlinkSync(p);
    return { deleted: existed };
  });

  // --- F-Skill (REQ-14.2): list/edit SKILL.md + toggle enabledPlugins in settings ---
  const skillsDir = (scope: string, project: string | undefined): string | null => {
    if (scope === 'user') return join(deps.homeDir, '.claude', 'skills');
    if (scope === 'project') { const b = projectBase(project); return b === null ? null : join(b, '.claude', 'skills'); }
    return null;
  };
  app.get<{ Querystring: { scope?: string; project?: string } }>('/api/skills', async (req) => {
    const dir = skillsDir(req.query.scope ?? 'user', req.query.project);
    const names = dir !== null && existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
          .map((d) => d.name).sort()
      : [];
    return { skills: names };
  });
  app.get<{ Params: { name: string }; Querystring: { scope?: string; project?: string } }>('/api/skills/:name', async (req, reply) => {
    const dir = skillsDir(req.query.scope ?? 'user', req.query.project);
    if (dir === null || !safeName(req.params.name)) return reply.code(400).send({ error: 'bad scope/name' });
    return contentHash(join(dir, req.params.name, 'SKILL.md'));
  });
  app.put<{ Params: { name: string }; Body: { scope?: string; project?: string; content?: string; baseHash?: string | null } }>(
    '/api/skills/:name',
    async (req, reply) => {
      const b = req.body ?? {};
      const dir = skillsDir(b.scope ?? 'user', b.project);
      if (dir === null || !safeName(req.params.name) || typeof b.content !== 'string') {
        return reply.code(400).send({ error: 'bad scope/name/content' });
      }
      return putThrough(reply, join(dir, req.params.name, 'SKILL.md'), b.content, b.baseHash);
    },
  );
  app.put<{ Body: { scope?: string; project?: string; plugin?: string; enabled?: boolean; baseHash?: string | null } }>(
    '/api/settings/enabled-plugins',
    async (req, reply) => {
      const b = req.body ?? {};
      const p = settingsScopePath(b.scope ?? '', b.project);
      if (p === null || typeof b.plugin !== 'string' || typeof b.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'bad or read-only scope/plugin/enabled' });
      }
      const settings = readJson(p);
      const set = new Set(Array.isArray(settings['enabledPlugins']) ? (settings['enabledPlugins'] as string[]) : []);
      if (b.enabled) set.add(b.plugin); else set.delete(b.plugin);
      settings['enabledPlugins'] = [...set].sort();
      return putThrough(reply, p, JSON.stringify(settings, null, 2) + '\n', b.baseHash);
    },
  );

  // --- F-Sys (REQ-15): doctor capture / host stats / retention with two-step prune ---
  const defaultDoctor = async (): Promise<string> => {
    const { stdout } = await execFileAsync('claude', ['doctor'], { timeout: 15_000 });
    return stdout;
  };
  app.get('/api/system/doctor', async () => {
    try {
      const output = await (deps.doctorCapture ?? defaultDoctor)();
      return { available: true, output };
    } catch (err) {
      // Degraded card, NEVER a 500 (REQ-15.1, Phase-0 pattern).
      return { available: false, degraded: true, hint: 'claude doctor unavailable — install the CLI and retry', detail: (err as Error).message };
    }
  });
  app.get('/api/system/stats', async () => ({
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    loadAvg: os.loadavg(),
    uptimeS: os.uptime(),
  }));
  app.put<{ Body: { scope?: string; project?: string; cleanupPeriodDays?: number; baseHash?: string | null } }>(
    '/api/system/retention',
    async (req, reply) => {
      const b = req.body ?? {};
      const p = settingsScopePath(b.scope ?? 'user', b.project);
      if (p === null || typeof b.cleanupPeriodDays !== 'number' || b.cleanupPeriodDays < 0) {
        return reply.code(400).send({ error: 'bad scope or cleanupPeriodDays' });
      }
      const settings = readJson(p);
      settings['cleanupPeriodDays'] = Math.floor(b.cleanupPeriodDays);
      return putThrough(reply, p, JSON.stringify(settings, null, 2) + '\n', b.baseHash);
    },
  );
  // Transcript files a prune WOULD delete, oldest-first (REQ-15.3 preview).
  const pruneCandidates = (cleanupPeriodDays: number): string[] => {
    const projectsRoot = join(deps.homeDir, '.claude', 'projects');
    if (!existsSync(projectsRoot)) return [];
    const files: { path: string; mtimeMs: number }[] = [];
    for (const proj of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const pdir = join(projectsRoot, proj.name);
      for (const f of readdirSync(pdir)) {
        if (!f.endsWith('.jsonl')) continue;
        const abs = join(pdir, f);
        files.push({ path: join(proj.name, f), mtimeMs: statSync(abs).mtimeMs });
      }
    }
    return retentionPreview(files, cleanupPeriodDays, deps.now());
  };
  app.get<{ Querystring: { cleanupPeriodDays?: string } }>('/api/system/retention/preview', async (req) => {
    const days = Number(req.query.cleanupPeriodDays ?? '30');
    const candidates = pruneCandidates(Number.isFinite(days) && days >= 0 ? days : 30);
    return { candidates, confirmToken: confirmToken(null, candidates.join('\n')) };
  });
  app.post<{ Body: { cleanupPeriodDays?: number; confirmToken?: string } }>('/api/system/retention/prune', async (req, reply) => {
    const b = req.body ?? {};
    const days = typeof b.cleanupPeriodDays === 'number' && b.cleanupPeriodDays >= 0 ? b.cleanupPeriodDays : 30;
    // Never yank transcripts under an attached session (REQ-15.4).
    if (deps.termManager !== undefined && deps.termManager.list().length > 0) {
      return reply.code(409).send({ error: 'a terminal session is live; refusing to prune transcripts' });
    }
    const candidates = pruneCandidates(days);
    // Two-step consent (REQ-15.3): the token must match the CURRENT candidate list.
    if (typeof b.confirmToken !== 'string' || b.confirmToken !== confirmToken(null, candidates.join('\n'))) {
      return reply.code(428).send({ error: 'missing or stale confirmToken; re-run preview' });
    }
    const projectsRoot = join(deps.homeDir, '.claude', 'projects');
    for (const rel of candidates) unlinkSync(join(projectsRoot, rel));
    audit({ event: 'retention_prune', count: candidates.length, cleanupPeriodDays: days });
    return { pruned: candidates.length, files: candidates };
  });

  // --- F-Loop (REQ-15): Human Plane discovery + proxy. Console = client, owns no
  // state (INV-11) — the Bearer token read from a run's discovery file is injected
  // server-side per request and never appears in a response (REQ-15.2/15.3).
  const loopRunsRoot = deps.loopRunsRoot;
  if (loopRunsRoot !== undefined) {
    // REQ-15.10: no auth provider ships yet (Task 10) — every loop audit entry
    // records the fixed local-operator principal until then.
    const localOperator = { principal: 'local-operator', method: 'none' };
    const resolveRun = async (runId: string, reply: FastifyReply): Promise<ReturnType<typeof findRun>> => {
      const ref = findRun(loopRunsRoot, runId);
      if (ref === null) {
        await reply.code(404).send({ error: 'no_such_run' });
        return null;
      }
      return ref;
    };

    app.get('/api/loop/runs', async () => {
      return { runs: discoverRuns(loopRunsRoot).map((r) => ({ runId: r.runId, ended: r.ended })) };
    });

    app.get<{ Params: { run: string } }>('/api/loop/:run/approvals', async (req, reply) => {
      const ref = await resolveRun(req.params.run, reply);
      if (ref === null) return reply;
      if (ref.ended) return reply.code(409).send({ error: 'run_ended' });
      const res = await loopFetch(ref, { method: 'GET', path: '/approvals' });
      return reply.code(res.status).send(res.body);
    });

    app.post<{ Params: { run: string; id: string }; Body: unknown }>(
      '/api/loop/:run/approvals/:id',
      async (req, reply) => {
        const ref = await resolveRun(req.params.run, reply);
        if (ref === null) return reply;
        if (ref.ended) return reply.code(409).send({ error: 'run_ended' });
        const res = await loopFetch(ref, { method: 'POST', path: `/approvals/${req.params.id}`, body: req.body });
        if (res.status === 200) {
          audit({ event: 'loop_approval', run: req.params.run, approvalId: req.params.id, ...localOperator });
        }
        return reply.code(res.status).send(res.body);
      },
    );

    // REQ-15.8: since-based pagination over the existing /events route (no new WS
    // surface) — the upstream route has no since support of its own, so the proxy
    // fetches the full (already-redacted) log and slices by PlatformEvent.seq here.
    app.get<{ Params: { run: string }; Querystring: { since?: string } }>('/api/loop/:run/events', async (req, reply) => {
      const ref = await resolveRun(req.params.run, reply);
      if (ref === null) return reply;
      if (ref.ended) return reply.code(409).send({ error: 'run_ended' });
      const res = await loopFetch(ref, { method: 'GET', path: '/events' });
      if (res.status !== 200) return reply.code(res.status).send(res.body);
      const sinceRaw = Number(req.query.since ?? '0');
      const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
      const all = Array.isArray(res.body) ? (res.body as { seq?: number }[]) : [];
      return all.filter((e) => (e.seq ?? 0) > since);
    });

    app.post<{ Params: { run: string; action: string }; Body: unknown }>(
      '/api/loop/:run/steering/:action',
      async (req, reply) => {
        const ref = await resolveRun(req.params.run, reply);
        if (ref === null) return reply;
        if (!['pause', 'inject', 'resume'].includes(req.params.action)) {
          return reply.code(404).send({ error: 'not_found' });
        }
        if (ref.ended) return reply.code(409).send({ error: 'run_ended' });
        const res = await loopFetch(ref, { method: 'POST', path: `/steering/${req.params.action}`, body: req.body });
        if (res.status === 202) {
          audit({ event: `loop_steer_${req.params.action}`, run: req.params.run, ...localOperator });
        }
        return reply.code(res.status).send(res.body);
      },
    );

    app.post<{ Params: { run: string } }>('/api/loop/:run/kill', async (req, reply) => {
      const ref = await resolveRun(req.params.run, reply);
      if (ref === null) return reply;
      if (ref.ended) return reply.code(409).send({ error: 'run_ended' });
      const res = await loopFetch(ref, { method: 'POST', path: '/kill' });
      if (res.status === 200) audit({ event: 'loop_kill', run: req.params.run, ...localOperator });
      return reply.code(res.status).send(res.body);
    });

    // REQ-6/7: F-Loop deploy card — a SEPARATE surface from /approvals (architect
    // finding #1); same proxy + audit-on-success pattern as the routes above.
    app.get<{ Params: { run: string } }>('/api/loop/:run/deploy', async (req, reply) => {
      const ref = await resolveRun(req.params.run, reply);
      if (ref === null) return reply;
      if (ref.ended) return reply.code(409).send({ error: 'run_ended' });
      const res = await loopFetch(ref, { method: 'GET', path: '/deploy' });
      return reply.code(res.status).send(res.body);
    });

    app.post<{ Params: { run: string }; Body: unknown }>('/api/loop/:run/deploy/decision', async (req, reply) => {
      const ref = await resolveRun(req.params.run, reply);
      if (ref === null) return reply;
      if (ref.ended) return reply.code(409).send({ error: 'run_ended' });
      const res = await loopFetch(ref, { method: 'POST', path: '/deploy/decision', body: req.body });
      if (res.status === 200) {
        audit({ event: 'loop_deploy_decision', run: req.params.run, ...localOperator });
      }
      return reply.code(res.status).send(res.body);
    });

    app.post<{ Params: { run: string } }>('/api/loop/:run/deploy/rollback', async (req, reply) => {
      const ref = await resolveRun(req.params.run, reply);
      if (ref === null) return reply;
      if (ref.ended) return reply.code(409).send({ error: 'run_ended' });
      const res = await loopFetch(ref, { method: 'POST', path: '/deploy/rollback' });
      if (res.status === 200) {
        audit({ event: 'loop_deploy_rollback', run: req.params.run, ...localOperator });
      }
      return reply.code(res.status).send(res.body);
    });
  }

  // --- F-Sched (REQ-16): start/stop the platform loop process or an
  // allowlisted opaque script under the SAME quota guard `platform loop run
  // --live` already uses (decideAutomationStart, unchanged). Exactly one
  // registered child; no task scheduling, no lease (REQ-16.1).
  const sched = deps.sched;
  if (sched !== undefined) {
    const localOperator = { principal: 'local-operator', method: 'none' };

    const freshAutomation = () => {
      const cfg = loadAutomationConfig(join(sched.policiesDir, 'automation.json'));
      // F-Sched has no more of a real fiveHour/weekly formula than the CLI's
      // own automation guard does (INV-13 honest posture) — estimate stays
      // null, exactly like `platform loop run --live`'s automationGuard.
      return decideAutomationStart({ estimate: null, thresholdPercent: cfg.thresholdPercent, override: false });
    };

    app.get('/api/sched/status', async () => sched.runtime.status());

    app.post<{ Body: { goal?: string; task?: string; live?: boolean; confirmToken?: string } }>(
      '/api/sched/start',
      async (req, reply) => {
        if (sched.rateOk !== undefined && !sched.rateOk()) {
          return reply.code(429).send({ error: 'too many sched start attempts; slow down' });
        }
        const body = req.body ?? {};
        if (typeof body.goal !== 'string' || body.goal.length === 0) {
          return reply.code(400).send({ error: 'goal is required' });
        }
        const running = sched.runtime.status().running;
        const automation = freshAutomation();
        const token = confirmToken(null, JSON.stringify(automation));
        const decision = decideSchedStart({ running, automation, confirmed: body.confirmToken === token });
        if ('refuse' in decision) {
          const status = decision.reason === 'needs_confirmation' ? 428 : 409;
          return reply.code(status).send({ error: decision.reason, automation, confirmToken: token });
        }
        const args = ['loop', 'run', '--goal', body.goal];
        if (typeof body.task === 'string') args.push('--task', body.task);
        if (body.live === true) args.push('--live');
        const { pid } = sched.runtime.start(sched.platformBinPath, args, { cwd: process.cwd(), env: deps.env });
        audit({ event: 'sched_start', args, ...localOperator });
        return { pid, args };
      },
    );

    app.post('/api/sched/stop', async () => {
      const stopped = sched.runtime.stop();
      if (stopped) audit({ event: 'sched_stop', ...localOperator });
      return { stopped };
    });

    app.post<{ Body: { name?: string } }>('/api/sched/script', async (req, reply) => {
      if (sched.rateOk !== undefined && !sched.rateOk()) {
        return reply.code(429).send({ error: 'too many sched start attempts; slow down' });
      }
      const name = req.body?.name;
      if (typeof name !== 'string' || name.length === 0) {
        return reply.code(400).send({ error: 'name is required' });
      }
      const routing = loadRoutingConfig(join(sched.policiesDir, 'routing.json'));
      if (!scriptAllowed(name, routing.sched.scriptAllowlist)) {
        return reply.code(400).send({ error: 'script_not_allowlisted' });
      }
      if (sched.runtime.status().running) {
        return reply.code(409).send({ error: 'already_running' });
      }
      const { pid } = sched.runtime.start('sh', [join(sched.scriptsDir, name)], { cwd: process.cwd(), env: deps.env });
      audit({ event: 'sched_script', name, ...localOperator });
      return { pid, name };
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
