// F-Chat session route (REQ-17): ticket issuance only — the WS bridge lives
// in chat-runtime.ts (untested in CI, mirrors F-Term's own split). Auth
// (global onRequest hook) and redaction (global onSend hook) are already
// covered by app-auth.test.ts / app.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { createChatManager } from './chat.ts';
import { addSession, makeHome } from '../test/helpers/home-fixture.ts';

const NOW = Date.parse('2026-07-09T12:00:00Z');
const HOST = { host: '127.0.0.1:9119' };

function makeFixture(over?: Partial<AppDeps>) {
  const fix = makeHome();
  addSession(fix, 'proj-1', 'sess-1', [{ cwd: '/repo/proj-1' }]);
  const audited: Record<string, unknown>[] = [];
  const chat = createChatManager({ now: () => NOW, nextId: () => 'chat-1', nextTicket: () => 'tk-1', ticketTtlS: 30 });
  const deps: AppDeps = {
    homeDir: fix.homeDir,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
    chat,
    audit: (e) => audited.push(e),
    ...over,
  };
  return { deps, audited, cleanup: fix.cleanup };
}

const jsonBody = (obj: unknown) => ({ payload: JSON.stringify(obj), headers: { ...HOST, 'content-type': 'application/json' } });

test('chat routes do not register when chat is absent (mirrors termManager/issuesDir)', async () => {
  const fix = makeHome();
  const app = buildApp({ homeDir: fix.homeDir, env: {}, bindHost: '127.0.0.1', port: 9119, dataDir: fix.dataDir, now: () => NOW });
  try {
    const r = await app.inject({ method: 'POST', url: '/api/chat/sessions', ...jsonBody({ projectDir: '/repo/proj-1' }) });
    assert.equal(r.statusCode, 404);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('POST /api/chat/sessions: creates a session + single-use ticket, audits (REQ-17.1/17.3)', async () => {
  const { deps, audited, cleanup } = makeFixture();
  const app = buildApp(deps);
  try {
    // `projectDir` in the wire body is the opaque project id (matches what
    // App.tsx/TerminalPanel already have) — resolved server-side to the real
    // cwd, mirroring F-Term's cwdFor (never a raw client-supplied path).
    const res = await app.inject({ method: 'POST', url: '/api/chat/sessions', ...jsonBody({ projectDir: 'proj-1', resume: 'sess-9', fork: true }) });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { sessionId: string; wsTicket: string };
    assert.equal(body.sessionId, 'chat-1');
    assert.equal(body.wsTicket, 'tk-1');
    assert.ok(audited.some((a) => a['event'] === 'chat_session_create' && a['sessionId'] === 'chat-1'));

    const redeemed = deps.chat?.redeemTicket('tk-1');
    assert.deepEqual(redeemed, { projectDir: '/repo/proj-1', resume: 'sess-9', fork: true, sessionId: 'chat-1' });
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/chat/sessions: missing projectDir -> 400; unknown projectDir -> 400', async () => {
  const { deps, cleanup } = makeFixture();
  const app = buildApp(deps);
  try {
    const missing = await app.inject({ method: 'POST', url: '/api/chat/sessions', ...jsonBody({}) });
    assert.equal(missing.statusCode, 400);

    const unknown = await app.inject({ method: 'POST', url: '/api/chat/sessions', ...jsonBody({ projectDir: 'not-a-real-project-id' }) });
    assert.equal(unknown.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/chat/sessions: rate limit trips before creation', async () => {
  const { deps, cleanup } = makeFixture({ chatRateOk: () => false });
  const app = buildApp(deps);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/chat/sessions', ...jsonBody({ projectDir: 'proj-1' }) });
    assert.equal(res.statusCode, 429);
  } finally {
    await app.close();
    cleanup();
  }
});
