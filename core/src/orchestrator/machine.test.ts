import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transition } from './machine.ts';

test('happy path walks the §6.3 chain (REQ-7.1)', () => {
  let s = transition('PROPOSED', 'analyze');
  assert.ok(s.ok && s.next === 'ANALYZING');
  s = transition('ANALYZING', 'ready');
  assert.ok(s.ok && s.next === 'READY');
  s = transition('READY', 'start_implementing');
  assert.ok(s.ok && s.next === 'IMPLEMENTING');
  s = transition('IMPLEMENTING', 'verify');
  assert.ok(s.ok && s.next === 'VERIFYING');
  s = transition('VERIFYING', 'gate_passed');
  assert.ok(s.ok && s.next === 'PASSED');
  s = transition('PASSED', 'review');
  assert.ok(s.ok && s.next === 'REVIEWING');
});

test('repair cycle: VERIFYING -> FAILED -> DIAGNOSING -> REPAIRING -> VERIFYING (REQ-7.1)', () => {
  let s = transition('VERIFYING', 'gate_failed');
  assert.ok(s.ok && s.next === 'FAILED');
  s = transition('FAILED', 'diagnose');
  assert.ok(s.ok && s.next === 'DIAGNOSING');
  s = transition('DIAGNOSING', 'repair');
  assert.ok(s.ok && s.next === 'REPAIRING');
  s = transition('REPAIRING', 'verify');
  assert.ok(s.ok && s.next === 'VERIFYING');
});

test('illegal transitions refuse with structured reason, never throw (REQ-7.4)', () => {
  const r = transition('READY', 'gate_passed');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'illegal_transition');
});

test('Phase 1 ENABLES human_approved (REVIEWING -> APPROVED); merge_queued/audited/completed stay gated as not_enabled_phase1 (REQ-10.2, REQ-11.5)', () => {
  const approved = transition('REVIEWING', 'human_approved');
  assert.ok(approved.ok && approved.next === 'APPROVED', 'human_approved is enabled in Phase 1');
  const changes = transition('REVIEWING', 'changes_requested');
  assert.ok(changes.ok && changes.next === 'CHANGES_REQUESTED');
  for (const trigger of ['merge_queued', 'audited', 'completed'] as const) {
    const r = transition('APPROVED', trigger);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'not_enabled_phase1');
  }
});

test('no trigger reaches COMPLETED in this phase — INV-2 structural check (REQ-7.3)', () => {
  const states = [
    'PROPOSED', 'ANALYZING', 'READY', 'IMPLEMENTING', 'VERIFYING', 'FAILED', 'DIAGNOSING',
    'REPAIRING', 'PASSED', 'REVIEWING', 'CHANGES_REQUESTED', 'APPROVED', 'MERGE_QUEUED', 'AUDITED',
  ] as const;
  const triggers = [
    'analyze', 'ready', 'start_implementing', 'verify', 'gate_failed', 'gate_passed', 'diagnose',
    'repair', 'review', 'changes_requested', 'human_approved', 'merge_queued', 'audited',
    'completed', 'block', 'escalate', 'cancel', 'roll_back', 'quarantine', 'pause',
  ] as const;
  for (const st of states) {
    for (const tr of triggers) {
      const r = transition(st, tr);
      if (r.ok) assert.notEqual(r.next, 'COMPLETED', `${st} --${tr}--> COMPLETED must not exist`);
    }
  }
});

test('universal escapes work from active states only (spec §6.3)', () => {
  const fromActive = transition('IMPLEMENTING', 'pause');
  assert.ok(fromActive.ok && fromActive.next === 'PAUSED');
  const fromTerminal = transition('CANCELLED', 'escalate');
  assert.equal(fromTerminal.ok, false);
});
