// F-Sched (REQ-16) — pure decision + allowlist matcher + the thin single-child
// runtime, all scheduler-agnostic like guards.ts's decideAutomationStart.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSchedRuntime, decideSchedStart, scriptAllowed, type ChildLike } from './sched.ts';

const OK = { ok: true as const, overridden: false };
const UNAVAILABLE = { defer: true as const, reason: 'estimate_unavailable' as const };
const THRESHOLD = { defer: true as const, reason: 'quota_threshold' as const, window: 'fiveHour' as const, percent: 90 };

test('running -> already_running regardless of automation/confirmed (REQ-16.1)', () => {
  const d = decideSchedStart({ running: true, automation: UNAVAILABLE, confirmed: true });
  assert.deepEqual(d, { refuse: true, reason: 'already_running' });
});

test('automation.ok -> starts immediately, no confirm needed (REQ-16.2 non-trip)', () => {
  const d = decideSchedStart({ running: false, automation: OK, confirmed: false });
  assert.deepEqual(d, { ok: true });
});

test('a KNOWN over-threshold estimate never yields to confirm (REQ-16.2/16.3)', () => {
  const notConfirmed = decideSchedStart({ running: false, automation: THRESHOLD, confirmed: false });
  const confirmed = decideSchedStart({ running: false, automation: THRESHOLD, confirmed: true });
  assert.deepEqual(notConfirmed, { refuse: true, reason: 'automation_deferred' });
  assert.deepEqual(confirmed, { refuse: true, reason: 'automation_deferred' });
});

test('an unavailable estimate asks for confirmation, then the confirm-token override proceeds (REQ-16.2/16.3)', () => {
  const first = decideSchedStart({ running: false, automation: UNAVAILABLE, confirmed: false });
  assert.deepEqual(first, { refuse: true, reason: 'needs_confirmation' });
  const second = decideSchedStart({ running: false, automation: UNAVAILABLE, confirmed: true });
  assert.deepEqual(second, { ok: true });
});

test('scriptAllowed: exact match only — traversal and near-misses never match (REQ-16.7/16.9)', () => {
  const allowlist = ['calibrate.sh'];
  assert.equal(scriptAllowed('calibrate.sh', allowlist), true);
  assert.equal(scriptAllowed('../calibrate.sh', allowlist), false);
  assert.equal(scriptAllowed('calibrate.sh/../../etc/passwd', allowlist), false);
  assert.equal(scriptAllowed('calibrate.sh ', allowlist), false);
  assert.equal(scriptAllowed('other.sh', []), false);
});

function fakeChild(pid: number): { child: ChildLike; fireExit(code: number | null): void; killed: string[] } {
  let onExitCb: ((code: number | null) => void) | null = null;
  const killed: string[] = [];
  const child: ChildLike = {
    pid,
    onExit: (cb) => {
      onExitCb = cb;
    },
    kill: (signal) => killed.push(signal ?? 'SIGTERM'),
  };
  return { child, fireExit: (code) => onExitCb?.(code), killed };
}

test('status() before any start reports not-running with no exited field (REQ-16.5)', () => {
  const rt = createSchedRuntime({ spawn: () => fakeChild(1).child, now: () => 0 });
  assert.deepEqual(rt.status(), { running: false });
});

test('start() registers the child; status() reports pid/args/startedAt while alive (REQ-16.5)', () => {
  const f = fakeChild(4242);
  const rt = createSchedRuntime({ spawn: () => f.child, now: () => 1_000 });
  const { pid } = rt.start('platform', ['loop', 'run', '--goal', 'g.yaml'], { cwd: '/repo', env: {} });
  assert.equal(pid, 4242);
  assert.deepEqual(rt.status(), { running: true, pid: 4242, args: ['loop', 'run', '--goal', 'g.yaml'], startedAt: 1_000 });
});

test('a second start() while one is registered throws (callers gate on decideSchedStart first)', () => {
  const rt = createSchedRuntime({ spawn: () => fakeChild(1).child, now: () => 0 });
  rt.start('platform', [], { cwd: '/repo', env: {} });
  assert.throws(() => rt.start('platform', [], { cwd: '/repo', env: {} }));
});

test('exit -> status flips to not-running and reports the exit code, no auto-respawn (REQ-16.5)', () => {
  const f = fakeChild(7);
  const rt = createSchedRuntime({ spawn: () => f.child, now: () => 0 });
  rt.start('platform', [], { cwd: '/repo', env: {} });
  f.fireExit(3);
  assert.deepEqual(rt.status(), { running: false, exited: 3 });
});

test('stop() SIGTERMs the registered child and returns true; false when nothing is running (REQ-16.6)', () => {
  const f = fakeChild(9);
  const rt = createSchedRuntime({ spawn: () => f.child, now: () => 0 });
  assert.equal(rt.stop(), false);
  rt.start('platform', [], { cwd: '/repo', env: {} });
  assert.equal(rt.stop(), true);
  assert.deepEqual(f.killed, ['SIGTERM']);
});

test('after start() a NEW start() is possible once the previous child has exited', () => {
  const f1 = fakeChild(1);
  let calls = 0;
  const rt = createSchedRuntime({
    spawn: () => {
      calls += 1;
      return calls === 1 ? f1.child : fakeChild(2).child;
    },
    now: () => 0,
  });
  rt.start('platform', [], { cwd: '/repo', env: {} });
  f1.fireExit(0);
  const { pid } = rt.start('platform', [], { cwd: '/repo', env: {} });
  assert.equal(pid, 2);
});
