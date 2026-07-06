import { test } from 'node:test';
import assert from 'node:assert/strict';

test('workspace smoke: adapters package resolves', async () => {
  const mod = await import('./index.ts');
  assert.equal(mod.RING, 2);
});
