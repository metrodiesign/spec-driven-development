// Governance endpoints via inject (REQ-14/15/16) + the negative token guarantee.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { makeHome } from '../test/helpers/home-fixture.ts';

const GOOD_HOST = { host: '127.0.0.1:9119' };

function deps(env: Record<string, string | undefined> = {}): AppDeps {
  const fix = makeHome();
  return { homeDir: fix.homeDir, env, bindHost: '127.0.0.1', port: 9119, dataDir: fix.dataDir, now: () => 0, cliVersion: async () => 't' };
}

test('POST /api/settings/effective merges with provenance (REQ-14.3)', async () => {
  const app = buildApp(deps());
  try {
    const r = await app.inject({
      method: 'POST', url: '/api/settings/effective', headers: GOOD_HOST,
      payload: { scopes: [{ scope: 'user', values: { model: 'sonnet' } }, { scope: 'project', values: { model: 'opus' } }] },
    });
    const body = r.json() as { effective: Record<string, { value: unknown; scope: string }> };
    assert.equal(body.effective['model']?.value, 'opus');
    assert.equal(body.effective['model']?.scope, 'project');
  } finally { await app.close(); }
});

test('POST /api/permissions/simulate returns the winning decision (REQ-15.2)', async () => {
  const app = buildApp(deps());
  try {
    const r = await app.inject({
      method: 'POST', url: '/api/permissions/simulate', headers: GOOD_HOST,
      payload: { rules: [{ action: 'deny', pattern: 'Write(test/golden/**)' }], tool: 'Write', path: 'test/golden/x' },
    });
    assert.equal((r.json() as { decision: string }).decision, 'deny');
  } finally { await app.close(); }
});

test('POST /api/permissions/install-guards is idempotent (REQ-15.3)', async () => {
  const app = buildApp(deps());
  try {
    const first = await app.inject({ method: 'POST', url: '/api/permissions/install-guards', headers: GOOD_HOST, payload: { rules: [] } });
    const rules1 = (first.json() as { rules: unknown[] }).rules;
    const second = await app.inject({ method: 'POST', url: '/api/permissions/install-guards', headers: GOOD_HOST, payload: { rules: rules1 } });
    assert.equal((second.json() as { rules: unknown[] }).rules.length, rules1.length);
  } finally { await app.close(); }
});

test('GET /api/auth/full: shadowing red-warns by NAME, never leaks the value (REQ-16.2/16.5)', async () => {
  const secret = ['sk', 'ant', 'REALSECRET1234567890'].join('-');
  const app = buildApp(deps({ ANTHROPIC_API_KEY: secret }));
  try {
    const r = await app.inject({ method: 'GET', url: '/api/auth/full', headers: GOOD_HOST });
    const text = r.body;
    assert.match(text, /ANTHROPIC_API_KEY/, 'names the shadowing var');
    assert.ok(!text.includes(secret), 'never leaks the token value');
    assert.match(text, /setup-token|setup_token|setupToken/i, 'setup-token guidance present');
    assert.equal((r.json() as { severity: string }).severity, 'red');
  } finally { await app.close(); }
});

test('F-Mem: PUT CLAUDE.md write-safe; stale baseHash -> 409 (REQ-17.1)', async () => {
  const app = buildApp(deps());
  try {
    const put1 = await app.inject({ method: 'PUT', url: '/api/memory', headers: GOOD_HOST, payload: { scope: 'user', content: '# rules\n', baseHash: null } });
    assert.equal(put1.statusCode, 200);
    const get1 = await app.inject({ method: 'GET', url: '/api/memory?scope=user', headers: GOOD_HOST });
    const { hash } = get1.json() as { hash: string };
    // stale write -> 409
    const stale = await app.inject({ method: 'PUT', url: '/api/memory', headers: GOOD_HOST, payload: { scope: 'user', content: 'x', baseHash: 'deadbeef' } });
    assert.equal(stale.statusCode, 409);
    // correct baseHash -> ok
    const ok = await app.inject({ method: 'PUT', url: '/api/memory', headers: GOOD_HOST, payload: { scope: 'user', content: '# v2\n', baseHash: hash } });
    assert.equal(ok.statusCode, 200);
  } finally { await app.close(); }
});

test('negative guarantee: no governance route accepts or returns a credential (REQ-16.3/16.5)', async () => {
  const app = buildApp(deps({ ANTHROPIC_API_KEY: 'sk-ant-xyz' }));
  try {
    // Probe the credential-ish routes; none should echo a token value.
    for (const url of ['/api/auth', '/api/auth/full']) {
      const r = await app.inject({ method: 'GET', url, headers: GOOD_HOST });
      assert.ok(!r.body.includes('sk-ant-xyz'), `${url} must not return the token value`);
    }
    // There is no route to SET a token.
    const post = await app.inject({ method: 'POST', url: '/api/auth/token', headers: GOOD_HOST, payload: { token: 'x' } });
    assert.equal(post.statusCode, 404, 'no token-accepting route exists');
  } finally { await app.close(); }
});
