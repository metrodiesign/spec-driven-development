// Phase-2 governance surfaces — route tests (REQ-12/13/14/15, REQ-18.3). Every
// route exercised through Fastify inject over a synthetic ~/.claude home.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { sha256 } from './govern.ts';
import { makeHome, type HomeFixture } from '../test/helpers/home-fixture.ts';

const NOW = Date.parse('2026-07-07T12:00:00Z');
const HOST = { host: '127.0.0.1:9119' };
const PROJECT = 'work';

function depsFor(fix: HomeFixture, extra: Partial<AppDeps> = {}): AppDeps {
  return {
    homeDir: fix.homeDir,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
    cliVersion: async () => '9.9.9 (test)',
    ...extra,
  };
}

const body = (obj: unknown) => ({ payload: JSON.stringify(obj), headers: { ...HOST, 'content-type': 'application/json' } });

// --- F-MCP (REQ-12) ---

test('F-MCP: project .mcp.json GET/PUT with writeSafe; invalid -> 422, stale -> 409 (REQ-12.1/12.4)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const empty = await app.inject({ method: 'GET', url: `/api/mcp/project?project=${PROJECT}`, headers: HOST });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().hash, null);
    assert.equal(empty.json().readOnly, false);

    const good = JSON.stringify({ mcpServers: { fs: { command: 'mcp-fs' }, api: { url: 'http://localhost:9' } } });
    const saved = await app.inject({ method: 'PUT', url: '/api/mcp/project', ...body({ project: PROJECT, content: good, baseHash: null }) });
    assert.equal(saved.statusCode, 200);
    const hash = saved.json().hash;

    const invalid = await app.inject({ method: 'PUT', url: '/api/mcp/project', ...body({ project: PROJECT, content: '{ "mcpServers": { "x": { "nope": 1 } } }', baseHash: hash }) });
    assert.equal(invalid.statusCode, 422);

    const stale = await app.inject({ method: 'PUT', url: '/api/mcp/project', ...body({ project: PROJECT, content: good, baseHash: 'stale' }) });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().currentHash, hash);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-MCP: user scope is read-only — no PUT route registered (REQ-12.1/13.4)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    await app.ready();
    assert.equal(app.hasRoute({ method: 'PUT', url: '/api/mcp/user' }), false, 'no user-scope MCP writer');
    assert.equal(app.hasRoute({ method: 'PUT', url: '/api/mcp/project' }), true, 'project writer exists');
    const view = await app.inject({ method: 'GET', url: '/api/mcp/user', headers: HOST });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().readOnly, true);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-MCP: test connection is advisory, never blocks (REQ-12.3)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const refused = await app.inject({ method: 'POST', url: '/api/mcp/test', ...body({ transport: 'http', url: 'http://127.0.0.1:1' }) });
    assert.equal(refused.statusCode, 200);
    assert.equal(refused.json().advisory, true);
    assert.equal(refused.json().reachable, false);

    const missing = await app.inject({ method: 'POST', url: '/api/mcp/test', ...body({}) });
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.json().advisory, true);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

// --- F-Hook (REQ-13) ---

const HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './g.sh' }] }] } });

test('F-Hook: validate returns diff + confirmToken; install needs BOTH token and baseHash (REQ-13.1/13.2/13.3)', async () => {
  const fix = makeHome();
  const audits: Record<string, unknown>[] = [];
  const app = buildApp(depsFor(fix, { audit: (e) => audits.push(e) }));
  try {
    const val = await app.inject({ method: 'POST', url: '/api/hooks/validate', ...body({ scope: 'user', content: HOOKS }) });
    assert.equal(val.statusCode, 200);
    assert.equal(val.json().valid, true);
    assert.ok(Array.isArray(val.json().diff.added));
    const { confirmToken, baseHash } = val.json();
    assert.equal(baseHash, null, 'no settings.json yet');

    // No token -> 428, writes nothing.
    const noToken = await app.inject({ method: 'POST', url: '/api/hooks/install', ...body({ scope: 'user', content: HOOKS, baseHash }) });
    assert.equal(noToken.statusCode, 428);
    assert.equal(existsSync(join(fix.homeDir, '.claude', 'settings.json')), false);

    // Both token + baseHash -> 200 + audited.
    const ok = await app.inject({ method: 'POST', url: '/api/hooks/install', ...body({ scope: 'user', content: HOOKS, baseHash, confirmToken }) });
    assert.equal(ok.statusCode, 200);
    assert.ok(existsSync(join(fix.homeDir, '.claude', 'settings.json')));
    assert.equal(audits.filter((a) => a['event'] === 'hook_install').length, 1);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-Hook: a stale baseHash yields 409 even with a matching token (REQ-13.2)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const p = join(fix.homeDir, '.claude', 'settings.json');
    mkdirSync(join(fix.homeDir, '.claude'), { recursive: true });
    writeFileSync(p, '{}');
    const currentHash = sha256('{}');
    // Token minted against a DIFFERENT (moved) base than the file currently has.
    const movedBase = sha256('old');
    const tok = sha256(`${movedBase}\n${HOOKS}`);
    const res = await app.inject({ method: 'POST', url: '/api/hooks/install', ...body({ scope: 'user', content: HOOKS, baseHash: movedBase, confirmToken: tok }) });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().currentHash, currentHash);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-Hook: invalid hook content -> 422 (REQ-13.1)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const bad = JSON.stringify({ hooks: { Nope: [] } });
    const tok = sha256(`\n${bad}`);
    const res = await app.inject({ method: 'POST', url: '/api/hooks/install', ...body({ scope: 'user', content: bad, baseHash: null, confirmToken: tok }) });
    assert.equal(res.statusCode, 422);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

// --- F-Sub (REQ-14.1/14.3) ---

test('F-Sub: CRUD .claude/agents/*.md, frontmatter-validated (REQ-14.1/14.3)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const good = '---\nname: rev\ndescription: reviewer\ntools: Read, Grep\n---\n# body\n';
    const put = await app.inject({ method: 'PUT', url: '/api/subagents/rev', ...body({ scope: 'user', content: good, baseHash: null }) });
    assert.equal(put.statusCode, 200);

    const bad = await app.inject({ method: 'PUT', url: '/api/subagents/broken', ...body({ scope: 'user', content: '# no frontmatter', baseHash: null }) });
    assert.equal(bad.statusCode, 422);
    assert.equal(existsSync(join(fix.homeDir, '.claude', 'agents', 'broken.md')), false);

    const list = await app.inject({ method: 'GET', url: '/api/subagents?scope=user', headers: HOST });
    assert.deepEqual(list.json().subagents, ['rev']);

    const del = await app.inject({ method: 'DELETE', url: '/api/subagents/rev?scope=user', headers: HOST });
    assert.equal(del.json().deleted, true);
    assert.equal(existsSync(join(fix.homeDir, '.claude', 'agents', 'rev.md')), false);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

// --- F-Skill (REQ-14.2) ---

test('F-Skill: SKILL.md edit + enabledPlugins toggle through writeSafe (REQ-14.2)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const put = await app.inject({ method: 'PUT', url: '/api/skills/demo', ...body({ scope: 'user', content: '# Demo skill\n', baseHash: null }) });
    assert.equal(put.statusCode, 200);
    const list = await app.inject({ method: 'GET', url: '/api/skills?scope=user', headers: HOST });
    assert.deepEqual(list.json().skills, ['demo']);

    const settingsPath = join(fix.homeDir, '.claude', 'settings.json');
    const on = await app.inject({ method: 'PUT', url: '/api/settings/enabled-plugins', ...body({ scope: 'user', plugin: 'p@1', enabled: true, baseHash: null }) });
    assert.equal(on.statusCode, 200);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).enabledPlugins, ['p@1']);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

// --- F-Sys (REQ-15) ---

test('F-Sys: doctor degraded card never 500; stats from node:os (REQ-15.1/15.2)', async () => {
  const fix = makeHome();
  const degradedApp = buildApp(depsFor(fix, { doctorCapture: async () => { throw new Error('ENOENT'); } }));
  const okApp = buildApp(depsFor(fix, { doctorCapture: async () => 'all good' }));
  try {
    const degraded = await degradedApp.inject({ method: 'GET', url: '/api/system/doctor', headers: HOST });
    assert.equal(degraded.statusCode, 200);
    assert.equal(degraded.json().degraded, true);

    const ok = await okApp.inject({ method: 'GET', url: '/api/system/doctor', headers: HOST });
    assert.equal(ok.json().available, true);

    const stats = await okApp.inject({ method: 'GET', url: '/api/system/stats', headers: HOST });
    assert.equal(stats.statusCode, 200);
    assert.equal(typeof stats.json().cpus, 'number');
    assert.equal(typeof stats.json().totalMem, 'number');
  } finally {
    await degradedApp.close();
    await okApp.close();
    fix.cleanup();
  }
});

test('F-Sys: retention prune is two-step + refuses under a live PTY + audits (REQ-15.3/15.4, REQ-18.3)', async () => {
  const fix = makeHome();
  // Seed an OLD transcript the prune should target.
  const pdir = join(fix.homeDir, '.claude', 'projects', 'proj');
  mkdirSync(pdir, { recursive: true });
  const old = join(pdir, 'old.jsonl');
  writeFileSync(old, '{}\n');
  const past = (NOW - 90 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(old, past, past);

  const audits: Record<string, unknown>[] = [];
  let live = false;
  const termManager = { list: () => (live ? [{ ptyId: 'x' }] : []) } as unknown as NonNullable<AppDeps['termManager']>;
  const app = buildApp(depsFor(fix, { audit: (e) => audits.push(e), termManager }));
  try {
    const preview = await app.inject({ method: 'GET', url: '/api/system/retention/preview?cleanupPeriodDays=30', headers: HOST });
    assert.equal(preview.statusCode, 200);
    assert.deepEqual(preview.json().candidates, ['proj/old.jsonl']);
    const token = preview.json().confirmToken;

    // No token -> 428, deletes nothing.
    const noTok = await app.inject({ method: 'POST', url: '/api/system/retention/prune', ...body({ cleanupPeriodDays: 30 }) });
    assert.equal(noTok.statusCode, 428);
    assert.ok(existsSync(old));

    // Live PTY -> 409.
    live = true;
    const busy = await app.inject({ method: 'POST', url: '/api/system/retention/prune', ...body({ cleanupPeriodDays: 30, confirmToken: token }) });
    assert.equal(busy.statusCode, 409);
    assert.ok(existsSync(old));
    live = false;

    // Token + no live PTY -> prunes + audits.
    const done = await app.inject({ method: 'POST', url: '/api/system/retention/prune', ...body({ cleanupPeriodDays: 30, confirmToken: token }) });
    assert.equal(done.statusCode, 200);
    assert.equal(done.json().pruned, 1);
    assert.equal(existsSync(old), false);
    assert.equal(audits.filter((a) => a['event'] === 'retention_prune').length, 1);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('F-Sys: retention edits cleanupPeriodDays through writeSafe (REQ-15.3)', async () => {
  const fix = makeHome();
  const app = buildApp(depsFor(fix));
  try {
    const res = await app.inject({ method: 'PUT', url: '/api/system/retention', ...body({ scope: 'user', cleanupPeriodDays: 45, baseHash: null }) });
    assert.equal(res.statusCode, 200);
    const settings = JSON.parse(readFileSync(join(fix.homeDir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.cleanupPeriodDays, 45);
  } finally {
    await app.close();
    fix.cleanup();
  }
});
