import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canAct, overCap, type IssueRecord } from './issues.ts';

const base: IssueRecord = { id: 'iss-1', title: 't', body: 'b', createdAt: '2026-01-01T00:00:00Z', status: 'open' };

test('canAct: true only while open', () => {
  assert.equal(canAct(base), true);
  assert.equal(canAct({ ...base, status: 'converted' }), false);
  assert.equal(canAct({ ...base, status: 'rejected' }), false);
});

test('overCap: trips on either dimension', () => {
  assert.equal(overCap('t', 'b'), false);
  assert.equal(overCap('x'.repeat(201), 'b'), true);
  assert.equal(overCap('t', 'x'.repeat(20001)), true);
});
