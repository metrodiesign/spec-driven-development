import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffLines, listOrEmpty, mcpAuthenticateState, statsRows } from './surfaces.ts';

test('statsRows renders host/memory/load/uptime lines (B4)', () => {
  const rows = statsRows({
    platform: 'darwin', arch: 'arm64', cpus: 10,
    totalMem: 32 * 1024 ** 3, freeMem: 8 * 1024 ** 3, loadAvg: [1.5, 1, 1], uptimeS: 7200,
  });
  assert.equal(rows[0], 'host: darwin/arm64 · 10 CPUs');
  assert.equal(rows[1], 'memory: 8.0 GiB free of 32.0 GiB');
  assert.match(rows[2] ?? '', /load \(1m\): 1\.50/);
  assert.equal(rows[3], 'uptime: 2h');
});

test('statsRows renders only an unavailable uptime as unavailable (F6)', () => {
  const rows = statsRows({
    platform: 'darwin', arch: 'arm64', cpus: 10,
    totalMem: 32 * 1024 ** 3, freeMem: 8 * 1024 ** 3, loadAvg: [1.5, 1, 1], uptimeS: null,
  });
  assert.equal(rows[0], 'host: darwin/arm64 · 10 CPUs');
  assert.equal(rows[1], 'memory: 8.0 GiB free of 32.0 GiB');
  assert.equal(rows[2], 'load (1m): 1.50');
  assert.equal(rows[3], 'uptime: unavailable');
});

test('diffLines prefixes removed with - and added with +', () => {
  assert.deepEqual(diffLines({ removed: ['a'], added: ['b', 'c'] }), ['- a', '+ b', '+ c']);
});

test('listOrEmpty falls back to an empty-state line', () => {
  assert.equal(listOrEmpty([], 'subagents'), 'no subagents in this scope');
  assert.equal(listOrEmpty(['x', 'y'], 'skills'), 'x, y');
});

test('mcpAuthenticateState: disabled with a hint when remote, enabled locally (REQ-18.1/18.3)', () => {
  assert.deepEqual(mcpAuthenticateState(false), { enabled: true, hint: null });
  const remote = mcpAuthenticateState(true);
  assert.equal(remote.enabled, false);
  assert.match(remote.hint ?? '', /loopback-only/);
});
