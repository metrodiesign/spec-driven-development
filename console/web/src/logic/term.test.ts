import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBodyFromQuery, sessionRowLabel, termWsUrl } from './term.ts';

test('termWsUrl carries ptyId + single-use ticket', () => {
  assert.equal(termWsUrl('pty-1', 'tk-9'), '/api/term/ws?ptyId=pty-1&ticket=tk-9');
});

test('createBodyFromQuery: project required; shell + resume optional (REQ-13.6)', () => {
  assert.equal(createBodyFromQuery(new URLSearchParams('')), null);
  assert.deepEqual(createBodyFromQuery(new URLSearchParams('project=demo')), { project: 'demo', mode: 'claude-only' });
  assert.deepEqual(createBodyFromQuery(new URLSearchParams('project=demo&shell=1')), { project: 'demo', mode: 'full-shell' });
  assert.deepEqual(createBodyFromQuery(new URLSearchParams('project=demo&resume=s9')), { project: 'demo', mode: 'claude-only', resume: 's9' });
});

test('sessionRowLabel marks exited sessions', () => {
  assert.match(sessionRowLabel({ ptyId: 'p1', project: 'x', mode: 'claude-only', alive: false }), /exited/);
  assert.doesNotMatch(sessionRowLabel({ ptyId: 'p1', project: 'x', mode: 'claude-only', alive: true }), /exited/);
});
