// F-Term backend lifecycle (REQ-13) with a FAKE pty — no quota, no real claude.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTermManager, termAccessAllowed, type AuditEntry, type PtyLike, type SpawnPty } from './term.ts';

function fakePty(): PtyLike & { emit(d: string): void; exit(): void; written: string[]; killed: string[]; resized: [number, number][] } {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  const written: string[] = [];
  const killed: string[] = [];
  const resized: [number, number][] = [];
  return {
    pid: 123,
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    write: (d) => written.push(d),
    resize: (cols, rows) => resized.push([cols, rows]),
    kill: (s) => killed.push(s ?? 'SIGTERM'),
    emit: (d) => dataCb(d),
    exit: () => exitCb({ exitCode: 0 }),
    written,
    killed,
    resized,
  };
}

function mgr() {
  const ptys: ReturnType<typeof fakePty>[] = [];
  const audit: AuditEntry[] = [];
  let now = 1000;
  let idN = 0;
  let tkN = 0;
  const spawn: SpawnPty = () => { const p = fakePty(); ptys.push(p); return p; };
  const m = createTermManager({
    spawn,
    now: () => now,
    nextId: () => `pty-${++idN}`,
    nextTicket: () => `tk-${++tkN}`,
    ticketTtlS: 30,
    buildCommand: (input) => (input.mode === 'full-shell' ? { file: '/bin/sh', args: [] } : { file: 'claude', args: input.resume ? ['--resume', input.resume] : [] }),
    audit: (e) => audit.push(e),
    cwdFor: (p) => `/projects/${p}`,
  });
  return { m, ptys, audit, tick: (ms: number) => { now += ms; } };
}

test('F-Term is loopback-only hard, even conceptually with --insecure (REQ-13.4)', () => {
  assert.equal(termAccessAllowed('127.0.0.1'), true);
  assert.equal(termAccessAllowed('localhost'), true);
  assert.equal(termAccessAllowed('0.0.0.0'), false);
  assert.equal(termAccessAllowed('192.168.1.5'), false);
});

test('onData taps live PTY output until unsubscribed; ring buffer still fills (REQ-13.2 streaming)', () => {
  const h = mgr();
  const { ptyId } = h.m.create({ project: 'p', mode: 'claude-only' });
  const seen: string[] = [];
  const off = h.m.onData(ptyId, (d) => seen.push(d));
  h.ptys[0]!.emit('hello ');
  off();
  h.ptys[0]!.emit('world');
  assert.deepEqual(seen, ['hello '], 'tap receives only while subscribed');
  const re = h.m.attach(ptyId);
  assert.equal(re?.buffer, 'hello world', 'ring buffer keeps everything');
  assert.equal(typeof h.m.onData('absent', () => {}), 'function', 'unknown pty returns a no-op unsubscribe');
});

test('create spawns, audits, returns a ptyId + writer ticket (REQ-13.1/13.5)', () => {
  const h = mgr();
  const { ptyId, ticket } = h.m.create({ project: 'p', mode: 'claude-only' });
  assert.match(ptyId, /^pty-/);
  assert.match(ticket, /^tk-/);
  assert.equal(h.audit.filter((a) => a.event === 'spawn').length, 1);
});

test('PTY survives browser close: re-attach replays the ring buffer (REQ-13.2)', () => {
  const h = mgr();
  const { ptyId } = h.m.create({ project: 'p', mode: 'claude-only' });
  h.ptys[0]?.emit('hello from claude\n');
  // "browser closes" = no explicit kill; re-attach later.
  const re = h.m.attach(ptyId);
  assert.ok(re);
  assert.match(re?.buffer ?? '', /hello from claude/);
  assert.equal(h.m.list()[0]?.alive, true, 'still alive after tab close');
});

test('single active writer: a new attach takes over; the old ticket can no longer write (REQ-13.9)', () => {
  const h = mgr();
  const { ptyId, ticket: t1 } = h.m.create({ project: 'p', mode: 'claude-only' });
  assert.equal(h.m.write(ptyId, t1, 'a'), true);
  const re = h.m.attach(ptyId);
  assert.equal(h.m.write(ptyId, re?.ticket ?? '', 'b'), true, 'new writer works');
  assert.equal(h.m.write(ptyId, t1, 'c'), false, 'old writer is displaced');
});

test('tickets are single-use and expire (REQ-13.3)', () => {
  const h = mgr();
  const { ptyId, ticket } = h.m.create({ project: 'p', mode: 'claude-only' });
  assert.equal(h.m.redeemTicket(ptyId, ticket), true, 'first redeem ok');
  assert.equal(h.m.redeemTicket(ptyId, ticket), false, 'reuse rejected (single-use)');
  const a = h.m.attach(ptyId);
  h.tick(31_000);
  assert.equal(h.m.redeemTicket(ptyId, a?.ticket ?? ''), false, 'expired ticket rejected');
});

test('DELETE reaps the PTY (SIGHUP) and audits close (REQ-13.2)', () => {
  const h = mgr();
  const { ptyId } = h.m.create({ project: 'p', mode: 'claude-only' });
  assert.equal(h.m.kill(ptyId), true);
  assert.deepEqual(h.ptys[0]?.killed, ['SIGHUP']);
  assert.equal(h.m.list().length, 0, 'no zombie session left');
  assert.equal(h.audit.filter((a) => a.event === 'close').length, 1);
});

test('resume builds `claude --resume <id>` (REQ-13.6)', () => {
  const h = mgr();
  const commands: string[] = [];
  // Re-create a manager that records the built command via a spy buildCommand.
  const m2 = createTermManager({
    spawn: () => { const p = { pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} }; return p; },
    now: () => 1,
    nextId: () => 'x',
    nextTicket: () => 't',
    ticketTtlS: 30,
    buildCommand: (input) => { const c = { file: 'claude', args: input.resume ? ['--resume', input.resume] : [] }; commands.push(c.args.join(' ')); return c; },
    audit: () => {},
    cwdFor: () => '/p',
  });
  m2.create({ project: 'p', mode: 'claude-only', resume: 'sess-9' });
  assert.deepEqual(commands, ['--resume sess-9']);
  void h;
});

test('resize tracks per-session dims and forwards to the PTY (REQ-17.1)', () => {
  const h = mgr();
  const { ptyId } = h.m.create({ project: 'p', mode: 'claude-only' });
  assert.equal(h.m.resize(ptyId, 100, 40), true);
  assert.deepEqual(h.ptys[0]!.resized.at(-1), [100, 40]);
  assert.equal(h.m.resize('absent', 80, 24), false, 'unknown pty -> false');
  assert.equal(h.m.resize(ptyId, 0, 40), false, 'non-positive dims rejected');
});

test('nudgeRepaint double-resizes rows-1 -> rows around the tracked geometry (REQ-17.2)', () => {
  const h = mgr();
  const { ptyId } = h.m.create({ project: 'p', mode: 'claude-only' });
  h.m.resize(ptyId, 100, 40); // client set real dims
  h.ptys[0]!.resized.length = 0; // ignore the resize above; watch only the nudge
  assert.equal(h.m.nudgeRepaint(ptyId), true);
  assert.deepEqual(h.ptys[0]!.resized, [[100, 39], [100, 40]], 'off-by-one then back to the same size');
  assert.equal(h.m.nudgeRepaint('absent'), false);
});

test('nudgeRepaint is signal-only: no bytes written, ring stays a byte-prefix (REQ-17.3)', () => {
  const h = mgr();
  const { ptyId } = h.m.create({ project: 'p', mode: 'claude-only' });
  h.ptys[0]!.emit('full-screen frame');
  const ringBefore = h.m.attach(ptyId)!.buffer;
  h.m.nudgeRepaint(ptyId);
  assert.equal(h.ptys[0]!.written.length, 0, 'the nudge injects no bytes into the PTY');
  assert.equal(h.m.attach(ptyId)!.buffer, ringBefore, 'ring unchanged by the nudge');
});
