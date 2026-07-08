import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authBanner, projectLabel, windowSummary } from './format.ts';

test('auth banner: red with variable names when shadowing (REQ-14.1 display)', () => {
  const red = authBanner({
    shadowing: true,
    shadowingVars: ['ANTHROPIC_API_KEY'],
    severity: 'red',
    guidance: 'unset ANTHROPIC_API_KEY ...',
    remote: false,
  });
  assert.equal(red.tone, 'red');
  assert.match(red.text, /ANTHROPIC_API_KEY/);
  assert.match(red.text, /bills API rates/);

  const ok = authBanner({ shadowing: false, shadowingVars: [], severity: 'ok', guidance: null, remote: false });
  assert.equal(ok.tone, 'ok');
});

test('window summary: open window shows remaining time, closed/none degrade (REQ-15.1 display)', () => {
  const now = Date.parse('2026-01-05T12:00:00Z');
  const open = windowSummary(
    { start: '2026-01-05T10:00:00Z', end: '2026-01-05T15:00:00Z', entryCount: 7 },
    now,
  );
  assert.match(open, /7 entries/);
  assert.match(open, /~3h 0m/);
  assert.match(open, /estimate/);
  assert.equal(windowSummary(null, now), 'No open 5h window — the next prompt starts one.');
});

test('project label marks loop-managed projects (spec §8 F-Proj banner)', () => {
  assert.equal(
    projectLabel({ id: '-x', cwd: '~/work/app', loopManaged: true }),
    '~/work/app [loop-managed]',
  );
  assert.equal(projectLabel({ id: '-x', cwd: null, loopManaged: false }), '-x');
});
