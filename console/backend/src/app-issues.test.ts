// F-Issue routes (REQ-8/9): issue intake -> human-gated draft goal.yaml.
// Auth (global onRequest hook) and redaction (global onSend hook) are already
// covered by app-auth.test.ts / app.test.ts — this file covers what's specific
// to issues: caps, status transitions, the rate limit, and audit entries.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildApp, type AppDeps } from './app.ts';
import { TITLE_MAX, BODY_MAX } from './issues.ts';
import { makeHome } from '../test/helpers/home-fixture.ts';

const NOW = Date.parse('2026-07-09T12:00:00Z');
const HOST = { host: '127.0.0.1:9119' };

function makeFixture(over?: Partial<AppDeps>) {
  const fix = makeHome();
  const issuesDir = mkdtempSync(join(tmpdir(), 'issues-dir-'));
  const audited: Record<string, unknown>[] = [];
  const deps: AppDeps = {
    homeDir: fix.homeDir,
    env: {},
    bindHost: '127.0.0.1',
    port: 9119,
    dataDir: fix.dataDir,
    now: () => NOW,
    issuesDir,
    audit: (e) => audited.push(e),
    ...over,
  };
  return {
    deps,
    audited,
    cleanup: () => {
      fix.cleanup();
      rmSync(issuesDir, { recursive: true, force: true });
    },
  };
}

const jsonBody = (obj: unknown) => ({ payload: JSON.stringify(obj), headers: { ...HOST, 'content-type': 'application/json' } });

test('issues routes do not register when issuesDir is absent (mirrors termManager/loopRunsRoot)', async () => {
  const fix = makeHome();
  const app = buildApp({ homeDir: fix.homeDir, env: {}, bindHost: '127.0.0.1', port: 9119, dataDir: fix.dataDir, now: () => NOW });
  try {
    const r = await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 't', body: 'b' }) });
    assert.equal(r.statusCode, 404);
  } finally {
    await app.close();
    fix.cleanup();
  }
});

test('POST /api/issues creates an open issue; GET lists it (REQ-8.1/8.2/8.4)', async () => {
  const { deps, cleanup } = makeFixture();
  const app = buildApp(deps);
  try {
    const created = await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 'slow build', body: 'CI takes 20 minutes' }) });
    assert.equal(created.statusCode, 200);
    const issue = created.json();
    assert.match(issue.id, /^iss-[0-9a-f]{16}$/);
    assert.equal(issue.status, 'open');

    const listed = await app.inject({ method: 'GET', url: '/api/issues', headers: HOST });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().issues.length, 1);
    assert.equal(listed.json().issues[0].id, issue.id);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /api/issues paginates by createdAt/id while legacy response stays unchanged', async () => {
  let now = NOW;
  const { deps, cleanup } = makeFixture({ now: () => now });
  const app = buildApp(deps);
  try {
    await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 'first', body: 'b' }) });
    now += 1;
    await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 'second', body: 'b' }) });

    const legacy = await app.inject({ method: 'GET', url: '/api/issues', headers: HOST });
    assert.equal('nextCursor' in legacy.json(), false);
    const first = await app.inject({ method: 'GET', url: '/api/issues?limit=1', headers: HOST });
    assert.equal(first.json().issues[0].title, 'first');
    const second = await app.inject({
      method: 'GET',
      url: `/api/issues?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: HOST,
    });
    assert.equal(second.json().issues[0].title, 'second');
    assert.equal((await app.inject({ method: 'GET', url: '/api/issues?cursor=bad', headers: HOST })).statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/issues: non-string title/body -> 400; over-cap -> 413, writes nothing (REQ-8.3)', async () => {
  const { deps, cleanup } = makeFixture();
  const app = buildApp(deps);
  try {
    const missing = await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 't' }) });
    assert.equal(missing.statusCode, 400);

    const bigTitle = await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 'x'.repeat(TITLE_MAX + 1), body: 'ok' }) });
    assert.equal(bigTitle.statusCode, 413);
    const bigBody = await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 'ok', body: 'x'.repeat(BODY_MAX + 1) }) });
    assert.equal(bigBody.statusCode, 413);

    const listed = await app.inject({ method: 'GET', url: '/api/issues', headers: HOST });
    assert.equal(listed.json().issues.length, 0);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/issues/:id/convert: writes draft goal.yaml, sets converted, audits, refuses non-open/unknown (REQ-9.1/9.2/9.3, REQ-18.3)', async () => {
  const { deps, audited, cleanup } = makeFixture();
  const app = buildApp(deps);
  try {
    const created = await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 't', body: 'b' }) });
    const id = created.json().id as string;

    const converted = await app.inject({ method: 'POST', url: `/api/issues/${id}/convert`, headers: HOST });
    assert.equal(converted.statusCode, 200);
    assert.equal(converted.json().issue.status, 'converted');
    assert.ok(existsSync(converted.json().issue.goalDraftPath));
    assert.ok(audited.some((a) => a['event'] === 'issue_convert' && a['id'] === id));

    const again = await app.inject({ method: 'POST', url: `/api/issues/${id}/convert`, headers: HOST });
    assert.equal(again.statusCode, 409);

    const unknown = await app.inject({ method: 'POST', url: '/api/issues/iss-doesnotexist/convert', headers: HOST });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/issues/:id/reject: rejects an open issue, audits, refuses non-open/unknown (REQ-8.6)', async () => {
  const { deps, audited, cleanup } = makeFixture();
  const app = buildApp(deps);
  try {
    const created = await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 't', body: 'b' }) });
    const id = created.json().id as string;

    const rejected = await app.inject({ method: 'POST', url: `/api/issues/${id}/reject`, headers: HOST });
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().issue.status, 'rejected');
    assert.ok(audited.some((a) => a['event'] === 'issue_reject' && a['id'] === id));

    const again = await app.inject({ method: 'POST', url: `/api/issues/${id}/reject`, headers: HOST });
    assert.equal(again.statusCode, 409);

    const unknown = await app.inject({ method: 'POST', url: '/api/issues/iss-doesnotexist/reject', headers: HOST });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/issues: rate limit trips before creation (REQ-8.5, spawn-endpoint rule)', async () => {
  const { deps, cleanup } = makeFixture({ issuesRateOk: () => false });
  const app = buildApp(deps);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/issues', ...jsonBody({ title: 't', body: 'b' }) });
    assert.equal(res.statusCode, 429);
  } finally {
    await app.close();
    cleanup();
  }
});
