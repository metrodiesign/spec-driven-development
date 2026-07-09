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

test('resolveInitialTheme: a stored value wins over prefers-color-scheme in both directions (REQ-20.2)', () => {
  assert.equal(resolveInitialTheme('dark', false), 'dark', 'stored dark wins even when OS prefers light');
  assert.equal(resolveInitialTheme('light', true), 'light', 'stored light wins even when OS prefers dark');
});

test('resolveInitialTheme: no stored value follows prefers-color-scheme (REQ-20.2)', () => {
  assert.equal(resolveInitialTheme(null, true), 'dark');
  assert.equal(resolveInitialTheme(null, false), 'light');
});

test('resolveInitialTheme: a malformed stored value is treated as absent, not trusted', () => {
  assert.equal(resolveInitialTheme('blue', true), 'dark');
  assert.equal(resolveInitialTheme('', false), 'light');
});

test('toggleTheme: flips both directions', () => {
  assert.equal(toggleTheme('light'), 'dark');
  assert.equal(toggleTheme('dark'), 'light');
});

test('themeToggleLabel: names the theme a click switches TO, not the current one', () => {
  assert.equal(themeToggleLabel('light'), 'Dark mode');
  assert.equal(themeToggleLabel('dark'), 'Light mode');
});
