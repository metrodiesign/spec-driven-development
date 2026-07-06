import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildEstimate, fiveHourWindows } from './usage.ts';

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-01-05T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

test('5h windows open at first prompt and roll over after the window elapses (REQ-15.1)', () => {
  const stamps = [iso(T0), iso(T0 + 1 * H), iso(T0 + 4 * H), iso(T0 + 6 * H), iso(T0 + 7 * H)];
  const windows = fiveHourWindows(stamps);
  assert.equal(windows.length, 2);
  assert.equal(windows[0]?.entryCount, 3, 'first window holds entries within 5h of its start');
  assert.equal(windows[1]?.entryCount, 2, 'entry at +6h opens the second window');
  assert.equal(windows[1]?.start, iso(T0 + 6 * H));
});

test('malformed timestamps are ignored, not fatal', () => {
  const windows = fiveHourWindows(['garbage', iso(T0)]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.entryCount, 1);
});

test('weekly estimate requires an anchor — no unanchored guessing (REQ-15.2)', () => {
  const est = buildEstimate([iso(T0)], {}, T0 + H);
  assert.equal(est.weekly.available, false);
  if (!est.weekly.available) assert.match(est.weekly.needed, /reset time/);
  assert.equal(est.label, 'estimate');
});

test('weekly estimate counts entries since the most recent anchored reset (REQ-15.2/15.3)', () => {
  const anchor = iso(T0 - 14 * 24 * H); // two weeks before T0 -> latest reset = T0
  const stamps = [iso(T0 - 2 * H), iso(T0 + 1 * H), iso(T0 + 2 * H)];
  const est = buildEstimate(stamps, { weeklyResetAnchor: anchor, calibratedPercent: 40 }, T0 + 3 * H);
  assert.equal(est.weekly.available, true);
  if (est.weekly.available) {
    assert.equal(est.weekly.sinceReset, iso(T0));
    assert.equal(est.weekly.entryCount, 2, 'pre-reset entry excluded');
    assert.equal(est.weekly.calibratedPercent, 40);
  }
});

test('current window only reported while it is still open (REQ-15.1)', () => {
  const stamps = [iso(T0)];
  const open = buildEstimate(stamps, {}, T0 + 1 * H);
  assert.notEqual(open.currentWindow, null);
  const closed = buildEstimate(stamps, {}, T0 + 6 * H);
  assert.equal(closed.currentWindow, null);
});
