import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isLocale, resolveInitialLocale, toggleLocale, translate } from './i18n.ts';

test('isLocale: only "en"/"th" are valid, everything else (incl. null) is not', () => {
  assert.equal(isLocale('en'), true);
  assert.equal(isLocale('th'), true);
  assert.equal(isLocale(null), false);
  assert.equal(isLocale('fr'), false);
  assert.equal(isLocale(''), false);
});

test('resolveInitialLocale: a stored value wins over the browser language in both directions (REQ-22.2)', () => {
  assert.equal(resolveInitialLocale('th', false), 'th', 'stored th wins even when the browser prefers en');
  assert.equal(resolveInitialLocale('en', true), 'en', 'stored en wins even when the browser prefers th');
});

test('resolveInitialLocale: no stored value follows the browser language', () => {
  assert.equal(resolveInitialLocale(null, true), 'th');
  assert.equal(resolveInitialLocale(null, false), 'en');
});

test('resolveInitialLocale: a malformed stored value is treated as absent, not trusted', () => {
  assert.equal(resolveInitialLocale('fr', true), 'th');
  assert.equal(resolveInitialLocale('', false), 'en');
});

test('toggleLocale: flips both directions', () => {
  assert.equal(toggleLocale('en'), 'th');
  assert.equal(toggleLocale('th'), 'en');
});

test('translate: looks up the active locale', () => {
  assert.equal(translate('en', 'appTitle'), 'Platform Console');
  assert.equal(translate('en', 'schedStartButton'), 'Start');
  assert.equal(translate('th', 'schedStartButton'), 'เริ่ม');
});

test('translate: fills {param} placeholders from the params object', () => {
  assert.equal(translate('en', 'appWeeklySinceLine', { date: '2026-07-01', count: 5 }), 'Weekly since 2026-07-01: 5 entries');
  assert.equal(translate('th', 'schedStarted', { pid: 42 }), 'เริ่มแล้ว (pid 42)');
});

test('translate: a missing param leaves the literal {placeholder} in place, never throws', () => {
  assert.equal(translate('en', 'appWeeklySinceLine', {}), 'Weekly since {date}: {count} entries');
});

test('translate: no params returns the template as-is (non-templated keys)', () => {
  assert.equal(translate('en', 'loading'), 'loading…');
  assert.equal(translate('th', 'loading'), 'กำลังโหลด…');
});
