import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPreference, writePreference } from './preferences.ts';

test('storage failure falls back to session-only preferences without throwing (REQ-9.14)', () => {
  const unavailable = {
    getItem(): string | null { throw new Error('storage disabled'); },
    setItem(): void { throw new Error('storage disabled'); },
  };
  assert.equal(readPreference(unavailable, 'theme'), null);
  assert.equal(writePreference(unavailable, 'theme', 'dark'), false);
});

test('available storage reads and writes preferences', () => {
  const values = new Map<string, string>();
  const available = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(writePreference(available, 'locale', 'th'), true);
  assert.equal(readPreference(available, 'locale'), 'th');
});
