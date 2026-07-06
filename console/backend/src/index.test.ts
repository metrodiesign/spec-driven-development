import { test } from 'node:test';
import assert from 'node:assert/strict';

test('workspace smoke: console-backend package resolves', async () => {
  const mod = await import('./index.ts');
  assert.equal(typeof mod, 'object');
});
