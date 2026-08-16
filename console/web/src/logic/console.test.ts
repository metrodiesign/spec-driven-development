import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSOLE_VIEWS, consoleView, mergeNamedRecords } from './console.ts';

test('Console registry resolves allowlisted views and defaults to Projects', () => {
  assert.equal(consoleView('terminal'), 'terminal');
  assert.equal(consoleView(null), 'projects');
  assert.equal(consoleView('unknown'), 'projects');
  assert.equal(new Set(CONSOLE_VIEWS).size, CONSOLE_VIEWS.length);
});

test('load-more pages replace duplicates and keep stable identifier order', () => {
  assert.deepEqual(
    mergeNamedRecords([{ id: 'b', value: 1 }], [{ id: 'a', value: 2 }, { id: 'b', value: 3 }], (record) => record.id),
    [{ id: 'a', value: 2 }, { id: 'b', value: 3 }],
  );
});
