import { test } from 'node:test';
import assert from 'node:assert/strict';

test('workspace smoke: console-web logic tests run under node:test', () => {
  assert.equal(1 + 1, 2);
});
