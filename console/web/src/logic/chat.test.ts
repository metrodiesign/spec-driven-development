import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendUserMessage, applyServerEvent, chatWsUrl, initialChatUiState, resolveApproval } from './chat.ts';

test('chatWsUrl encodes the ticket', () => {
  assert.equal(chatWsUrl('tk 1/2'), '/api/chat/ws?ticket=tk%201%2F2');
});

test('applyServerEvent: stream_delta appends an assistant message', () => {
  const s = applyServerEvent(initialChatUiState, { type: 'stream_delta', text: 'hi' });
  assert.deepEqual(s.messages, [{ role: 'assistant', text: 'hi' }]);
});

test('applyServerEvent: tool_card and approval_request are tracked separately (design.md G)', () => {
  let s = initialChatUiState;
  s = applyServerEvent(s, { type: 'tool_card', toolUseId: 'tu-1', name: 'Read', input: { path: 'a.ts' } });
  s = applyServerEvent(s, { type: 'approval_request', toolUseId: 'tu-2', name: 'Bash', input: { cmd: 'ls' } });
  assert.deepEqual(s.toolCards, [{ toolUseId: 'tu-1', name: 'Read', input: { path: 'a.ts' } }]);
  assert.deepEqual(s.pendingApprovals, [{ toolUseId: 'tu-2', name: 'Bash', input: { cmd: 'ls' } }]);
});

test('applyServerEvent: error appends an error-role message', () => {
  const s = applyServerEvent(initialChatUiState, { type: 'error', message: 'boom' });
  assert.deepEqual(s.messages, [{ role: 'error', text: 'boom' }]);
});

test('applyServerEvent: done is a no-op', () => {
  const s = applyServerEvent(initialChatUiState, { type: 'done', sdkSessionId: 's1' });
  assert.deepEqual(s, initialChatUiState);
});

test('resolveApproval removes only the matching pending entry', () => {
  let s = initialChatUiState;
  s = applyServerEvent(s, { type: 'approval_request', toolUseId: 'tu-1', name: 'Read', input: {} });
  s = applyServerEvent(s, { type: 'approval_request', toolUseId: 'tu-2', name: 'Bash', input: {} });
  s = resolveApproval(s, 'tu-1');
  assert.deepEqual(s.pendingApprovals, [{ toolUseId: 'tu-2', name: 'Bash', input: {} }]);
});

test('appendUserMessage appends a user-role message', () => {
  const s = appendUserMessage(initialChatUiState, 'hello');
  assert.deepEqual(s.messages, [{ role: 'user', text: 'hello' }]);
});
