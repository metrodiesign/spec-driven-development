// F-Chat pure logic (REQ-17/18/19) — ticket lifecycle + the turn/canUseTool
// driver, proven with a scripted queryFn (no SDK import, no network).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createChatConnection,
  createChatManager,
  type ChatQueryFn,
  type ChatSdkMessage,
  type ChatServerEvent,
} from './chat.ts';

function fakeSink() {
  const events: ChatServerEvent[] = [];
  const audited: Record<string, unknown>[] = [];
  let closed = false;
  return {
    events,
    audited,
    send: (e: ChatServerEvent) => events.push(e),
    audit: (e: Record<string, unknown>) => audited.push(e),
    close: () => {
      closed = true;
    },
    isClosed: () => closed,
  };
}

function fakeClock() {
  let now = 0;
  const timers: { at: number; cb: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    setTimer: (cb: () => void, ms: number) => {
      const t = { at: now + ms, cb, cancelled: false };
      timers.push(t);
      return { cancel: () => { t.cancelled = true; } };
    },
    advance: (ms: number) => {
      now += ms;
      for (const t of timers) {
        if (!t.cancelled && t.at <= now) {
          t.cancelled = true;
          t.cb();
        }
      }
    },
  };
}

// ---- ChatManager (ticket lifecycle) ----

test('createChatManager: ticket is single-use and TTL-bound (REQ-17.1/17.2)', () => {
  const now = 1000;
  const m = createChatManager({ now: () => now, nextId: () => 'chat-1', nextTicket: () => 'tk-1', ticketTtlS: 30 });
  const { sessionId, ticket } = m.create({ projectDir: '/p' });
  assert.equal(sessionId, 'chat-1');
  assert.deepEqual(m.redeemTicket(ticket), { projectDir: '/p', sessionId: 'chat-1' });
  assert.equal(m.redeemTicket(ticket), null, 'reuse rejected (single-use)');
  assert.equal(m.redeemTicket('nope'), null, 'unknown ticket rejected');
});

test('createChatManager: expired ticket rejected; resume/fork carried through (REQ-19.1)', () => {
  let now = 1000;
  const m = createChatManager({ now: () => now, nextId: () => 'chat-2', nextTicket: () => 'tk-2', ticketTtlS: 30 });
  const { ticket } = m.create({ projectDir: '/q', resume: 'sess-1', fork: true });
  now += 31_000;
  assert.equal(m.redeemTicket(ticket), null, 'expired ticket rejected');

  now = 1000;
  const { ticket: t2 } = m.create({ projectDir: '/q', resume: 'sess-1', fork: true });
  assert.deepEqual(m.redeemTicket(t2), { projectDir: '/q', resume: 'sess-1', fork: true, sessionId: 'chat-2' });
});

// ---- ChatConnection (turn driver + canUseTool bridge) ----

test('handleUserMessage streams text deltas and tool cards from assistant messages (REQ-18.1)', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  const queryFn: ChatQueryFn = () =>
    (async function* (): AsyncGenerator<ChatSdkMessage> {
      yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'hello ' }] } };
      yield {
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'world' }, { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: 'a.ts' } }] },
      };
      yield { type: 'result', session_id: 's1', is_error: false, result: 'ok' };
    })();
  const conn = createChatConnection({
    queryFn, cwd: '/p', approvalTimeoutMs: 1000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  await conn.handleUserMessage('hi');
  assert.deepEqual(sink.events, [
    { type: 'stream_delta', text: 'hello ' },
    { type: 'stream_delta', text: 'world' },
    { type: 'tool_card', toolUseId: 'tu-1', name: 'Read', input: { path: 'a.ts' } },
    { type: 'done', sdkSessionId: 's1' },
  ]);
  assert.equal(sink.isClosed(), false, 'a normal turn leaves the session open');
});

test('canUseTool bridge: approval_request then allow resolves the SDK-side promise; audited (REQ-18.2/18.5)', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  let decision: unknown;
  const queryFn: ChatQueryFn = (args) =>
    (async function* (): AsyncGenerator<ChatSdkMessage> {
      yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { cmd: 'ls' } }] } };
      decision = await args.options.canUseTool('Bash', { cmd: 'ls' }, { toolUseID: 'tu-1' });
      yield { type: 'result', session_id: 's1', is_error: false, result: 'ok' };
    })();
  const conn = createChatConnection({
    queryFn, cwd: '/p', approvalTimeoutMs: 5000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  const donePromise = conn.handleUserMessage('run ls');
  await new Promise((r) => setTimeout(r, 0)); // let the generator reach the pending canUseTool await
  assert.deepEqual(sink.events.at(-1), { type: 'approval_request', toolUseId: 'tu-1', name: 'Bash', input: { cmd: 'ls' } });
  conn.handleToolDecision('tu-1', 'allow');
  await donePromise;
  assert.deepEqual(decision, { behavior: 'allow' });
  assert.deepEqual(sink.audited, [{ event: 'chat_tool_decision', decision: 'allow', toolUseId: 'tu-1', at: 0 }]);
});

test('canUseTool bridge: deny resolves the SDK-side promise with a message', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  let decision: unknown;
  const queryFn: ChatQueryFn = (args) =>
    (async function* (): AsyncGenerator<ChatSdkMessage> {
      decision = await args.options.canUseTool('Bash', { cmd: 'rm -rf /' }, { toolUseID: 'tu-2' });
      yield { type: 'result', session_id: 's1', is_error: false, result: 'ok' };
    })();
  const conn = createChatConnection({
    queryFn, cwd: '/p', approvalTimeoutMs: 5000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  const donePromise = conn.handleUserMessage('run rm');
  await new Promise((r) => setTimeout(r, 0));
  conn.handleToolDecision('tu-2', 'deny');
  await donePromise;
  assert.deepEqual(decision, { behavior: 'deny', message: 'denied by operator' });
});

test('canUseTool bridge: no response within approvalTimeoutMs -> deny, fail-closed, audited (REQ-18.3/18.5)', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  let decision: unknown;
  const queryFn: ChatQueryFn = (args) =>
    (async function* (): AsyncGenerator<ChatSdkMessage> {
      decision = await args.options.canUseTool('Bash', { cmd: 'ls' }, { toolUseID: 'tu-3' });
      yield { type: 'result', session_id: 's1', is_error: false, result: 'ok' };
    })();
  const conn = createChatConnection({
    queryFn, cwd: '/p', approvalTimeoutMs: 5000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  const donePromise = conn.handleUserMessage('run ls');
  await new Promise((r) => setTimeout(r, 0));
  clock.advance(5000);
  await donePromise;
  assert.deepEqual(decision, { behavior: 'deny', message: 'approval timed out' });
  assert.deepEqual(sink.audited, [{ event: 'chat_tool_decision', decision: 'timeout', toolUseId: 'tu-3', name: 'Bash', at: 5000 }]);
});

test('handleDisconnect denies every pending approval, fail-closed, audited as ws_drop (REQ-18.3/18.5)', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  let decision: unknown;
  const queryFn: ChatQueryFn = (args) =>
    (async function* (): AsyncGenerator<ChatSdkMessage> {
      decision = await args.options.canUseTool('Bash', { cmd: 'ls' }, { toolUseID: 'tu-4' });
      yield { type: 'result', session_id: 's1', is_error: false, result: 'ok' };
    })();
  const conn = createChatConnection({
    queryFn, cwd: '/p', approvalTimeoutMs: 5000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  const donePromise = conn.handleUserMessage('run ls');
  await new Promise((r) => setTimeout(r, 0));
  conn.handleDisconnect();
  await donePromise;
  assert.deepEqual(decision, { behavior: 'deny', message: 'denied by operator' });
  assert.deepEqual(sink.audited, [{ event: 'chat_tool_decision', decision: 'ws_drop', toolUseId: 'tu-4', at: 0 }]);
});

test('stream error (result is_error) -> error card + audit + close, no retry, no done (REQ-18.4)', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  const queryFn: ChatQueryFn = () =>
    (async function* (): AsyncGenerator<ChatSdkMessage> {
      yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial' }] } };
      yield { type: 'result', session_id: 's1', is_error: true, errors: ['overloaded'] };
    })();
  const conn = createChatConnection({
    queryFn, cwd: '/p', approvalTimeoutMs: 1000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  await conn.handleUserMessage('hi');
  assert.deepEqual(sink.events, [
    { type: 'stream_delta', text: 'partial' },
    { type: 'error', message: 'overloaded' },
  ]);
  assert.deepEqual(sink.audited, [{ event: 'chat_stream_error', message: 'overloaded', at: 0 }]);
  assert.equal(sink.isClosed(), true);
});

test('thrown error mid-stream -> error card + audit + close (REQ-18.4)', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  const queryFn: ChatQueryFn = () =>
    (async function* (): AsyncGenerator<ChatSdkMessage> {
      yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial' }] } };
      throw new Error('subprocess crashed');
    })();
  const conn = createChatConnection({
    queryFn, cwd: '/p', approvalTimeoutMs: 1000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  await conn.handleUserMessage('hi');
  assert.deepEqual(sink.events, [
    { type: 'stream_delta', text: 'partial' },
    { type: 'error', message: 'subprocess crashed' },
  ]);
  assert.equal(sink.isClosed(), true);
});

test('a second user_message while a turn is in flight is rejected, not dispatched (busy guard)', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  let calls = 0;
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseFirst = r; });
  const queryFn: ChatQueryFn = () => {
    calls += 1;
    return (async function* (): AsyncGenerator<ChatSdkMessage> {
      await gate;
      yield { type: 'result', session_id: 's1', is_error: false, result: 'ok' };
    })();
  };
  const conn = createChatConnection({
    queryFn, cwd: '/p', approvalTimeoutMs: 1000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  const firstDone = conn.handleUserMessage('a');
  await conn.handleUserMessage('b');
  assert.equal(calls, 1, 'queryFn is not invoked for the rejected second message');
  assert.ok(sink.events.some((e) => e.type === 'error' && e.message.includes('already in progress')));
  releaseFirst();
  await firstDone;
});

test('resume chains across turns from the previous SDK session id; fork applies only to the first turn (REQ-19.1)', async () => {
  const sink = fakeSink();
  const clock = fakeClock();
  const seenOptions: { resume: string | undefined; forkSession: boolean | undefined }[] = [];
  const queryFn: ChatQueryFn = (args) => {
    seenOptions.push({ resume: args.options.resume, forkSession: args.options.forkSession });
    return (async function* (): AsyncGenerator<ChatSdkMessage> {
      yield { type: 'result', session_id: 'sdk-turn-1', is_error: false, result: 'ok' };
    })();
  };
  const conn = createChatConnection({
    queryFn, cwd: '/p', initialResume: 'seed-session', initialFork: true, approvalTimeoutMs: 1000,
    now: clock.now, setTimer: clock.setTimer, send: sink.send, audit: sink.audit, close: sink.close,
  });
  await conn.handleUserMessage('one');
  await conn.handleUserMessage('two');
  assert.deepEqual(seenOptions, [
    { resume: 'seed-session', forkSession: true },
    { resume: 'sdk-turn-1', forkSession: false },
  ]);
});
