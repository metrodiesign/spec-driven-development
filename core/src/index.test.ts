import { test } from 'node:test';
import assert from 'node:assert/strict';

test('workspace smoke: core package resolves', async () => {
  const mod = await import('./index.ts');
  assert.equal(typeof mod, 'object');
});
