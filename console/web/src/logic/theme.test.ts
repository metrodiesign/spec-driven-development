import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTheme, resolveInitialTheme, themeToggleLabel, toggleTheme } from './theme.ts';

test('isTheme: only "light"/"dark" are valid, everything else (incl. null) is not', () => {
  assert.equal(isTheme('light'), true);
  assert.equal(isTheme('dark'), true);
  assert.equal(isTheme(null), false);
  assert.equal(isTheme('system'), false);
  assert.equal(isTheme(''), false);
});

test('resolveInitialTheme: a stored value wins in both directions (REQ-9.1)', () => {
  assert.equal(resolveInitialTheme('dark', false), 'dark', 'stored dark wins even when OS prefers light');
  assert.equal(resolveInitialTheme('light', true), 'light', 'stored light wins even when OS prefers dark');
});

test('resolveInitialTheme: no stored value defaults dark regardless of prefers-color-scheme (REQ-9.1)', () => {
  assert.equal(resolveInitialTheme(null, true), 'dark');
  assert.equal(resolveInitialTheme(null, false), 'dark');
});

test('resolveInitialTheme: a malformed stored value is treated as absent, not trusted', () => {
  assert.equal(resolveInitialTheme('blue', true), 'dark');
  assert.equal(resolveInitialTheme('', false), 'dark');
});

test('toggleTheme: flips both directions', () => {
  assert.equal(toggleTheme('light'), 'dark');
  assert.equal(toggleTheme('dark'), 'light');
});

test('themeToggleLabel: names the theme a click switches TO, not the current one (REQ-22 key, not text)', () => {
  assert.equal(themeToggleLabel('light'), 'themeToggleToDark');
  assert.equal(themeToggleLabel('dark'), 'themeToggleToLight');
});
