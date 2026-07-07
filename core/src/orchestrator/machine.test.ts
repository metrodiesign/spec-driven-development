import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIVE_STATES, resumeTransition, transition } from './machine.ts';

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

test('Phase 2 ENABLES the auto-merge chain: auto_approved/merge_queued/audited/completed (REQ-7.2/7.8, REQ-8)', () => {
  // auto_approved rides REVIEWING -> APPROVED (core/merge policy only, REQ-7.2).
  const auto = transition('REVIEWING', 'auto_approved');
  assert.ok(auto.ok && auto.next === 'APPROVED', 'auto_approved is enabled');
  const human = transition('REVIEWING', 'human_approved');
  assert.ok(human.ok && human.next === 'APPROVED', 'human_approved still enabled');
  let s = transition('APPROVED', 'merge_queued');
  assert.ok(s.ok && s.next === 'MERGE_QUEUED', 'merge_queued enabled (REQ-7.8)');
  s = transition('MERGE_QUEUED', 'audited');
  assert.ok(s.ok && s.next === 'AUDITED', 'audited enabled');
  s = transition('AUDITED', 'completed');
  assert.ok(s.ok && s.next === 'COMPLETED', 'completed enabled');
});

test('MERGE_QUEUED and AUDITED are active: escalate is legal (merge_conflict / audit_mismatch paths) (REQ-7.8, 8.3)', () => {
  for (const st of ['MERGE_QUEUED', 'AUDITED'] as const) {
    const esc = transition(st, 'escalate');
    assert.ok(esc.ok && esc.next === 'ESCALATED', `escalate legal from ${st}`);
  }
});

test('COMPLETED is reachable ONLY via the core-internal `completed` trigger — INV-2 structural check (REQ-7.3, 8.5)', () => {
  const states = [
    'PROPOSED', 'ANALYZING', 'READY', 'IMPLEMENTING', 'VERIFYING', 'FAILED', 'DIAGNOSING',
    'REPAIRING', 'PASSED', 'REVIEWING', 'CHANGES_REQUESTED', 'APPROVED', 'MERGE_QUEUED', 'AUDITED',
  ] as const;
  const triggers = [
    'analyze', 'ready', 'start_implementing', 'verify', 'gate_failed', 'gate_passed', 'diagnose',
    'repair', 'review', 'changes_requested', 'human_approved', 'auto_approved', 'merge_queued',
    'audited', 'completed', 'block', 'escalate', 'cancel', 'roll_back', 'quarantine', 'pause',
  ] as const;
  for (const st of states) {
    for (const tr of triggers) {
      const r = transition(st, tr);
      if (r.ok && r.next === 'COMPLETED') {
        assert.equal(tr, 'completed', `${st} --${tr}--> COMPLETED: only the core-internal completed trigger may reach COMPLETED`);
        assert.equal(st, 'AUDITED', 'and only from AUDITED');
      }
    }
  }
  // auto_approved is exposed by no port (ProposalClaim), so no agent claim can fire
  // it; ports.ts has no doorway to any trigger. Proven end-to-end in fault-injection.
});

test('universal escapes work from active states only (spec §6.3)', () => {
  const fromActive = transition('IMPLEMENTING', 'pause');
  assert.ok(fromActive.ok && fromActive.next === 'PAUSED');
  const fromTerminal = transition('CANCELLED', 'escalate');
  assert.equal(fromTerminal.ok, false);
});

test('pause/resume round-trips from EVERY active state (REQ-10.2/10.3)', () => {
  // Property: pause is legal from every active state, and resumeTransition restores
  // exactly the recorded pre-pause state (the state carried in PAUSE_REQUESTED).
  for (const s of ACTIVE_STATES) {
    const paused = transition(s, 'pause');
    assert.ok(paused.ok && paused.next === 'PAUSED', `pause legal from ${s}`);
    const resumed = resumeTransition('PAUSED', s);
    assert.ok(resumed.ok && resumed.next === s, `resume restores ${s}`);
  }
});

test('resumeTransition is legal ONLY from PAUSED, ONLY to an active state (REQ-10.3)', () => {
  // Not from PAUSED -> illegal (resume has no meaning outside the pause window).
  const notPaused = resumeTransition('IMPLEMENTING', 'VERIFYING');
  assert.equal(notPaused.ok, false);
  // Target not an active state (a terminal cannot be a resume target) -> illegal.
  const badTarget = resumeTransition('PAUSED', 'COMPLETED');
  assert.equal(badTarget.ok, false);
  const cancelledTarget = resumeTransition('PAUSED', 'CANCELLED');
  assert.equal(cancelledTarget.ok, false);
});
