// RED (redactSecrets throws NotImplemented) -> GREEN same task. REQ-10.3.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redactSecrets } from './redact.ts';

test('redacts token/key shapes, leaves ordinary text intact', () => {
  const gh = 'ghp'.concat('_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901');
  const key = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const input = `owner=${gh} k=${key} note=hello-world`;
  const out = redactSecrets(input);
  assert.ok(!out.includes(gh), 'gh token redacted');
  assert.ok(!out.includes(key), 'key redacted');
  assert.ok(out.includes('note=hello-world'), 'ordinary text preserved');
  assert.match(out, /\[redacted\]/);
});
