import assert from 'node:assert/strict';
import { test } from 'node:test';

import { automationHint, interpretStartResponse, schedStatusLabel } from './sched.ts';

test('schedStatusLabel: running shows the pid; idle shows nothing until a first exit (REQ-16.5)', () => {
  assert.equal(schedStatusLabel({ running: true, pid: 4242, args: [], startedAt: 0 }), 'running (pid 4242)');
  assert.equal(schedStatusLabel({ running: false }), 'idle');
  assert.equal(schedStatusLabel({ running: false, exited: 2 }), 'idle (last exit code 2)');
  assert.equal(schedStatusLabel({ running: false, exited: null }), 'idle (last exit code null)');
});

test('automationHint: a KNOWN over-threshold estimate reads as non-overridable (REQ-16.2/16.3)', () => {
  const hint = automationHint({ reason: 'quota_threshold', window: 'fiveHour', percent: 90, until: '2026-07-07T20:00:00.000Z' });
  assert.match(hint, /cannot override/);
  assert.match(hint, /fiveHour at 90%/);
  assert.match(hint, /2026-07-07T20:00:00\.000Z/);
});

test('automationHint: an unavailable estimate reads as the confirm-token override path (REQ-16.3)', () => {
  const hint = automationHint({ reason: 'estimate_unavailable' });
  assert.match(hint, /--force-quota-override/);
});

test('interpretStartResponse: 200 -> started; 428 with automation+token -> needs_confirmation; else refused', () => {
  assert.deepEqual(interpretStartResponse(200, { pid: 7, args: ['loop', 'run'] }), { kind: 'started', pid: 7, args: ['loop', 'run'] });

  const automation = { reason: 'estimate_unavailable' as const };
  assert.deepEqual(
    interpretStartResponse(428, { error: 'needs_confirmation', automation, confirmToken: 'tok-1' }),
    { kind: 'needs_confirmation', automation, confirmToken: 'tok-1' },
  );

  assert.deepEqual(interpretStartResponse(409, { error: 'already_running' }), { kind: 'refused', reason: 'already_running' });
  assert.deepEqual(interpretStartResponse(429, {}), { kind: 'refused', reason: 'http 429' });
});
