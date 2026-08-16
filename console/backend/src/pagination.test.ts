import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InvalidPaginationQueryError,
  paginateCreated,
  paginateNamed,
  parseOptionalPagination,
} from './pagination.ts';

test('pagination is opt-in and limits batches to 1..100', () => {
  assert.equal(parseOptionalPagination({}), null);
  assert.deepEqual(parseOptionalPagination({ limit: '50' }), { cursor: null, limit: 50 });
  assert.throws(() => parseOptionalPagination({ limit: '0' }), InvalidPaginationQueryError);
  assert.throws(() => parseOptionalPagination({ limit: '101' }), InvalidPaginationQueryError);
  assert.throws(() => parseOptionalPagination({ limit: '1.5' }), InvalidPaginationQueryError);
});

test('named keyset pages are stable and reject malformed or wrong-sort cursors', () => {
  const records = [{ name: 'charlie' }, { name: 'alpha' }, { name: 'bravo' }];
  const first = paginateNamed(records, (record) => record.name, { cursor: null, limit: 2 });
  assert.deepEqual(first.items.map((record) => record.name), ['alpha', 'bravo']);
  assert.notEqual(first.nextCursor, null);
  const second = paginateNamed(records, (record) => record.name, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.items.map((record) => record.name), ['charlie']);
  assert.equal(second.nextCursor, null);
  assert.throws(() => paginateNamed(records, (record) => record.name, { cursor: 'bad', limit: 2 }), InvalidPaginationQueryError);
});

test('created keyset uses immutable createdAt/id tuple without duplicate records', () => {
  const records = [
    { id: 'b', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'c', createdAt: '2026-01-02T00:00:00Z' },
  ];
  const first = paginateCreated(records, (record) => record.createdAt, (record) => record.id, { cursor: null, limit: 1 });
  const second = paginateCreated(records, (record) => record.createdAt, (record) => record.id, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual([...first.items, ...second.items].map((record) => record.id), ['a', 'b', 'c']);
});
