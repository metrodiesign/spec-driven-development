// F-Chat live-wiring guards (bugfix-fchat-hardening F1-F4) — the two literal
// values passed to the real SDK query, and the WS-frame redaction wrapper.
// Both are pure/exported specifically so they're testable without invoking
// the real SDK or a real WebSocket (chat-runtime.ts stays otherwise
// untested-in-CI by design, mirroring term-runtime.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLiveQueryOptions, redactChatEvent } from './chat-runtime.ts';
import type { ChatServerEvent } from './chat.ts';

const fakeCanUseTool = (async () => ({ behavior: 'allow' as const })) as never;

test('buildLiveQueryOptions: always isolates from ambient operator settings (F3/F4)', () => {
  const opts = buildLiveQueryOptions({ cwd: '/proj', canUseTool: fakeCanUseTool });
  assert.deepEqual(opts.settingSources, []);
  assert.equal(opts.permissionMode, 'default');
});

test('buildLiveQueryOptions: still passes cwd/canUseTool through unchanged', () => {
  const opts = buildLiveQueryOptions({ cwd: '/proj', canUseTool: fakeCanUseTool });
  assert.equal(opts.cwd, '/proj');
  assert.equal(opts.canUseTool, fakeCanUseTool);
});

test('buildLiveQueryOptions: resume/forkSession stay conditionally-included, matching prior behavior', () => {
  const bare = buildLiveQueryOptions({ cwd: '/proj', canUseTool: fakeCanUseTool });
  assert.equal('resume' in bare, false);
  assert.equal('forkSession' in bare, false);

  const withBoth = buildLiveQueryOptions({ cwd: '/proj', resume: 'sess-1', forkSession: true, canUseTool: fakeCanUseTool });
  assert.equal(withBoth.resume, 'sess-1');
  assert.equal(withBoth.forkSession, true);
});

const HOME = '/Users/operator';

test('redactChatEvent: a clean stream_delta round-trips byte-identical (B1, no-op on clean content)', () => {
  const event: ChatServerEvent = { type: 'stream_delta', text: 'the file has 3 lines' };
  assert.deepEqual(JSON.parse(redactChatEvent(event, HOME)), event);
});

test('redactChatEvent: a token in stream_delta text is redacted (F1, the actual leak scenario)', () => {
  const event: ChatServerEvent = { type: 'stream_delta', text: 'OPENAI_API_KEY=sk-proj-abc12345XYZ is set' };
  const out = JSON.parse(redactChatEvent(event, HOME)) as ChatServerEvent & { text: string };
  assert.equal(out.text.includes('sk-proj-abc12345XYZ'), false);
  assert.match(out.text, /\[redacted]/);
});

test('redactChatEvent: a token inside a tool_card input value is redacted too (F1, the Bearer-header scenario)', () => {
  const event: ChatServerEvent = {
    type: 'tool_card',
    toolUseId: 'toolu_01abc',
    name: 'Bash',
    input: { command: "curl -H 'Authorization: Bearer sk-live-abcdefgh12345678'" },
  };
  const out = JSON.parse(redactChatEvent(event, HOME)) as { input: { command: string } };
  assert.equal(out.input.command.includes('sk-live-abcdefgh12345678'), false);
});

test('redactChatEvent: toolUseId survives redaction verbatim (B3, approve/deny matching still works)', () => {
  const event: ChatServerEvent = { type: 'approval_request', toolUseId: 'toolu_01abc', name: 'Read', input: { file: 'x' } };
  const out = JSON.parse(redactChatEvent(event, HOME)) as { toolUseId: string };
  assert.equal(out.toolUseId, 'toolu_01abc');
});

test('redactChatEvent: sdkSessionId on a done event survives redaction verbatim (B2, resume chaining still works)', () => {
  const event: ChatServerEvent = { type: 'done', sdkSessionId: 'a1b2c3d4-0000-0000-0000-000000000000' };
  const out = JSON.parse(redactChatEvent(event, HOME)) as { sdkSessionId: string };
  assert.equal(out.sdkSessionId, 'a1b2c3d4-0000-0000-0000-000000000000');
});

test('redactChatEvent: a credential path is redacted and the home dir collapses to ~ (matches the HTTP onSend behavior)', () => {
  const event: ChatServerEvent = { type: 'error', message: `${HOME}/.credentials.json could not be read` };
  const out = JSON.parse(redactChatEvent(event, HOME)) as { message: string };
  assert.equal(out.message.includes(HOME), false);
  assert.match(out.message, /\[credential-path-redacted]/);
});

test('redactChatEvent: output is always valid JSON the client can parse (wire contract intact)', () => {
  const event: ChatServerEvent = { type: 'stream_delta', text: 'quotes " and \\ backslash and sk-abcdefgh12345678' };
  assert.doesNotThrow(() => JSON.parse(redactChatEvent(event, HOME)));
});
