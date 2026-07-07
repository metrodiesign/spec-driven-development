// F-Term REST routes via Fastify inject (REQ-13). Uses a stub TermManager (no
// real PTY) — proves the routes + the loopback-only-hard gate (REQ-13.4).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { makeHome } from '../test/helpers/home-fixture.ts';
import type { TermManager } from './term.ts';

const NOW = Date.parse('2026-01-05T12:00:00Z');
const GOOD_HOST = { host: '127.0.0.1:9119' };

function stubTerm(): TermManager {
  const sessions = new Map<string, { project: string; mode: 'claude-only' | 'full-shell' }>();
  let n = 0;
  return {
    create: (input) => { const id = `pty-${++n}`; sessions.set(id, { project: input.project, mode: input.mode }); return { ptyId: id, ticket: 'tk-1' }; },
    attach: (id) => (sessions.has(id) ? { ticket: 'tk-2', buffer: 'replayed' } : null),
    redeemTicket: () => true,
    onData: () => () => {},
    write: () => true,
    resize: () => true,
    nudgeRepaint: () => true,
    list: () => [...sessions.entries()].map(([ptyId, s]) => ({ ptyId, project: s.project, mode: s.mode, alive: true })),
    kill: (id) => sessions.delete(id),
  };
}

function deps(bindHost: string): AppDeps {
  const fix = makeHome();
  return {
    homeDir: fix.homeDir,
    env: {},
    bindHost,
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
    cliVersion: async () => '9.9.9 (test)',
    termManager: stubTerm(),
  };
}

test('loopback bind: create -> list -> attach -> delete (REQ-13.1/13.2)', async () => {
  const app = buildApp(deps('127.0.0.1'));
  try {
    const created = await app.inject({ method: 'POST', url: '/api/term/sessions', headers: GOOD_HOST, payload: { project: 'demo', mode: 'claude-only' } });
    assert.equal(created.statusCode, 200);
    const { ptyId } = created.json() as { ptyId: string };
    assert.match(ptyId, /^pty-/);

    const list = await app.inject({ method: 'GET', url: '/api/term/sessions', headers: GOOD_HOST });
    assert.equal((list.json() as unknown[]).length, 1);

    const attach = await app.inject({ method: 'POST', url: `/api/term/sessions/${ptyId}/attach`, headers: GOOD_HOST });
    assert.equal(attach.statusCode, 200);
    assert.match((attach.json() as { buffer: string }).buffer, /replayed/);

    const del = await app.inject({ method: 'DELETE', url: `/api/term/sessions/${ptyId}`, headers: GOOD_HOST });
    assert.equal((del.json() as { killed: boolean }).killed, true);
  } finally {
    await app.close();
  }
});

test('missing project -> 400', async () => {
  const app = buildApp(deps('127.0.0.1'));
  try {
    const r = await app.inject({ method: 'POST', url: '/api/term/sessions', headers: GOOD_HOST, payload: {} });
    assert.equal(r.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('spawn failure (claude not on PATH) -> 503 degraded, not a crash (REQ-13.7)', async () => {
  const d = deps('127.0.0.1');
  d.termManager = {
    ...stubTerm(),
    create: () => { throw new Error('spawn claude ENOENT'); },
  };
  const app = buildApp(d);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/term/sessions', headers: GOOD_HOST, payload: { project: 'demo' } });
    assert.equal(r.statusCode, 503);
  } finally {
    await app.close();
  }
});

test('spawn rate limit -> 429 (REQ-13.5)', async () => {
  const d = deps('127.0.0.1');
  d.termRateOk = () => false;
  const app = buildApp(d);
  try {
    const r = await app.inject({ method: 'POST', url: '/api/term/sessions', headers: GOOD_HOST, payload: { project: 'demo' } });
    assert.equal(r.statusCode, 429);
  } finally {
    await app.close();
  }
});

test('non-loopback bind: ALL F-Term routes 403 even conceptually with --insecure (REQ-13.4, INV-17)', async () => {
  // Host header must match the bind host to pass the earlier allowlist, so we can
  // reach the F-Term gate and prove it refuses on a non-loopback bind.
  const app = buildApp(deps('192.168.1.5'));
  const host = { host: '192.168.1.5:9119' };
  try {
    const create = await app.inject({ method: 'POST', url: '/api/term/sessions', headers: host, payload: { project: 'demo' } });
    assert.equal(create.statusCode, 403);
    const list = await app.inject({ method: 'GET', url: '/api/term/sessions', headers: host });
    assert.equal(list.statusCode, 403);
  } finally {
    await app.close();
  }
});
