// REQ-15.1/15.2/15.3/15.5/15.6/15.9: discovery over runsRoot/<runId>/human-plane.json
// + the Human Plane HTTP client. The "live" path is proven against the REAL
// createHumanPlaneServer from `core` — discoverRuns must read exactly what that
// server writes.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHumanPlaneServer, openEventLog } from 'core';

import { discoverRuns, findRun, loopFetch } from './loop-proxy.ts';

function runsRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'loop-proxy-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('discoverRuns on a missing runsRoot -> [] (fresh install, never ran a loop)', () => {
  assert.deepEqual(discoverRuns('/no/such/dir/at/all'), []);
});

test('discoverRuns: absent discovery file -> ended:true, no url/token (REQ-15.6)', () => {
  const rr = runsRoot();
  try {
    mkdirSync(join(rr.root, 'RUN-A')); // directory exists, no human-plane.json inside
    const runs = discoverRuns(rr.root);
    assert.deepEqual(runs, [{ runId: 'RUN-A', runDir: join(rr.root, 'RUN-A'), ended: true }]);
  } finally {
    rr.cleanup();
  }
});

test('discoverRuns: tombstoned discovery file -> ended:true (REQ-15.9)', () => {
  const rr = runsRoot();
  try {
    mkdirSync(join(rr.root, 'RUN-B'));
    writeFileSync(join(rr.root, 'RUN-B', 'human-plane.json'), JSON.stringify({ tombstoned: true }));
    const runs = discoverRuns(rr.root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.ended, true);
    assert.equal(runs[0]?.url, undefined);
    assert.equal(runs[0]?.token, undefined);
  } finally {
    rr.cleanup();
  }
});

test('discoverRuns: live {url,token} -> ended:false, both fields populated (REQ-15.1)', () => {
  const rr = runsRoot();
  try {
    mkdirSync(join(rr.root, 'RUN-C'));
    writeFileSync(join(rr.root, 'RUN-C', 'human-plane.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'tok' }));
    const runs = discoverRuns(rr.root);
    assert.deepEqual(runs, [{ runId: 'RUN-C', runDir: join(rr.root, 'RUN-C'), ended: false, url: 'http://127.0.0.1:1', token: 'tok' }]);
  } finally {
    rr.cleanup();
  }
});

test('discoverRuns ignores non-directory entries under runsRoot', () => {
  const rr = runsRoot();
  try {
    writeFileSync(join(rr.root, 'stray-file.json'), '{}');
    assert.deepEqual(discoverRuns(rr.root), []);
  } finally {
    rr.cleanup();
  }
});

test('findRun: path-containment guard refuses traversal attempts', () => {
  const rr = runsRoot();
  try {
    mkdirSync(join(rr.root, 'RUN-D'));
    writeFileSync(join(rr.root, 'RUN-D', 'human-plane.json'), JSON.stringify({ url: 'http://x', token: 't' }));
    assert.equal(findRun(rr.root, '../RUN-D'), null);
    assert.equal(findRun(rr.root, 'RUN-D/..'), null);
    assert.equal(findRun(rr.root, ''), null);
    assert.equal(findRun(rr.root, 'no-such-run'), null);
    assert.equal(findRun(rr.root, 'RUN-D')?.runId, 'RUN-D');
  } finally {
    rr.cleanup();
  }
});

test('loopFetch on an ended ref (no url/token) -> 502 human_plane_unreachable', async () => {
  const res = await loopFetch({ runId: 'X', runDir: '/x', ended: true }, { method: 'GET', path: '/approvals' });
  assert.deepEqual(res, { status: 502, body: { upstream: 'human_plane_unreachable' } });
});

test('loopFetch against a genuinely unreachable port -> 502 human_plane_unreachable (REQ-15.5)', async () => {
  const res = await loopFetch(
    { runId: 'X', runDir: '/x', ended: false, url: 'http://127.0.0.1:1', token: 'tok' },
    { method: 'GET', path: '/approvals' },
  );
  assert.deepEqual(res, { status: 502, body: { upstream: 'human_plane_unreachable' } });
});

test('loopFetch against the REAL Human Plane server: injects the Bearer token server-side (REQ-15.2/15.3)', async () => {
  const rr = runsRoot();
  const runDir = join(rr.root, 'RUN-1');
  mkdirSync(runDir);
  const log = openEventLog(join(runDir, 'e.db'), { now: () => 1 });
  try {
    const srv = await createHumanPlaneServer({
      runDir,
      deps: {
        runId: 'RUN-1',
        approvals: new Map(),
        log,
        onDecision: () => ({ ok: true, state: 'APPROVED' }),
        onKill: () => {},
        rateOk: () => true,
      },
    });
    try {
      const found = findRun(rr.root, 'RUN-1');
      assert.ok(found !== null && !found.ended, 'discoverRuns reads what createHumanPlaneServer wrote');
      const res = await loopFetch(found, { method: 'GET', path: '/approvals' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []); // no approvals seeded — the Bearer token was accepted (else 401)
      assert.ok(!JSON.stringify(res).includes(found.token ?? '\0'), 'sanity: token is not echoed back in the proxied body');
    } finally {
      await srv.close();
    }
  } finally {
    log.close();
    rr.cleanup();
  }
});
