import { test } from 'node:test';
import assert from 'node:assert/strict';

test('workspace smoke: aal package resolves and can see core types', async () => {
  const mod = await import('./index.ts');
  assert.equal(mod.RING, 1);
  // Ring 1 depends on Ring 0 types only (INV-8) — prove the workspace link resolves.
  const core = await import('core/types');
  assert.equal(typeof core, 'object');
});
