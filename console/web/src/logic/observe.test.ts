import assert from 'node:assert/strict';
import { test } from 'node:test';

import { modelRows, usageSummary } from './observe.ts';

test('usageSummary always flags the estimate label', () => {
  const s = usageSummary({ interactive: 3, autonomous: 2, byModel: {}, label: 'estimate' });
  assert.match(s, /5 runs/);
  assert.match(s, /3 interactive/);
  assert.match(s, /estimate/);
});

test('modelRows sorts by count desc then name', () => {
  const rows = modelRows({ interactive: 0, autonomous: 0, byModel: { opus: 1, sonnet: 3 }, label: 'estimate' });
  assert.deepEqual(rows, [{ model: 'sonnet', count: 3 }, { model: 'opus', count: 1 }]);
});
