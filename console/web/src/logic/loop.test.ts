import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attestationChecklist,
  canApprove,
  isGovernanceProposal,
  latestTaskState,
  nextSince,
  stateBadge,
  steeringControls,
  taskApprovalPackages,
  type LoopApprovalPackage,
  type LoopEvent,
} from './loop.ts';

test('isGovernanceProposal discriminates by the presence of kind', () => {
  assert.equal(isGovernanceProposal({ id: 'gov-1', kind: 'policy_change' }), true);
  assert.equal(isGovernanceProposal({ id: 'A-1', taskId: 'T-1' }), false);
});

test('taskApprovalPackages filters out governance proposals (REQ-9.4 shared list, REQ-15.7 scope)', () => {
  const items = [
    { id: 'gov-1', kind: 'policy_change' },
    { id: 'A-1', taskId: 'T-1', goalExcerpt: 'g', acIds: [], diffRef: 'd', attestations: [], riskClass: 'L2', assumptions: [], unresolvedRisks: [] },
  ];
  const packages = taskApprovalPackages(items);
  assert.equal(packages.length, 1);
  assert.equal(packages[0]?.id, 'A-1');
});

test('nextSince advances to the highest seq seen, never regresses on an empty poll', () => {
  assert.equal(nextSince(0, [{ seq: 3, type: 'X', taskId: null, payload: {} }, { seq: 5, type: 'X', taskId: null, payload: {} }]), 5);
  assert.equal(nextSince(5, []), 5);
});

test('latestTaskState returns the last TASK_STATE payload.state, ignoring other event types', () => {
  const events: LoopEvent[] = [
    { seq: 1, type: 'TASK_STATE', taskId: 'T-1', payload: { state: 'IMPLEMENTING' } },
    { seq: 2, type: 'ACTION_APPLIED', taskId: 'T-1', payload: {} },
    { seq: 3, type: 'TASK_STATE', taskId: 'T-1', payload: { state: 'VERIFYING' } },
  ];
  assert.equal(latestTaskState(events), 'VERIFYING');
});

test('latestTaskState -> null when no TASK_STATE event has arrived yet', () => {
  assert.equal(latestTaskState([]), null);
  assert.equal(latestTaskState([{ seq: 1, type: 'CLAIM_RECORDED', taskId: 'T-1', payload: {} }]), null);
});

test('stateBadge: ended wins over any state; unknown when no state seen yet', () => {
  assert.equal(stateBadge(true, 'IMPLEMENTING'), 'ended');
  assert.equal(stateBadge(false, 'IMPLEMENTING'), 'IMPLEMENTING');
  assert.equal(stateBadge(false, null), 'unknown');
});

function pkg(attestations: string[]): LoopApprovalPackage {
  return {
    id: 'A-1', taskId: 'T-1', goalExcerpt: 'g', acIds: ['AC-1'], diffRef: 'blob://d',
    attestations, riskClass: 'L2', assumptions: [], unresolvedRisks: [],
  };
}

test('attestationChecklist marks each attestation checked/unchecked against the operator selection', () => {
  const rows = attestationChecklist(pkg(['I reviewed the diff', 'Tests cover the change']), ['I reviewed the diff']);
  assert.deepEqual(rows, [
    { text: 'I reviewed the diff', checked: true },
    { text: 'Tests cover the change', checked: false },
  ]);
});

test('canApprove requires every attestation checked (mirrors the server gate)', () => {
  const p = pkg(['a', 'b']);
  assert.equal(canApprove(p, []), false);
  assert.equal(canApprove(p, ['a']), false);
  assert.equal(canApprove(p, ['a', 'b']), true);
});

test('steeringControls: ended or unknown state -> everything disabled', () => {
  assert.deepEqual(steeringControls(true, 'IMPLEMENTING'), { canPause: false, canResume: false, canInject: false, injectAtNextBoundary: false });
  assert.deepEqual(steeringControls(false, null), { canPause: false, canResume: false, canInject: false, injectAtNextBoundary: false });
});

test('steeringControls: a non-steerable state (no boundary) -> everything disabled (REQ-10.8 parity)', () => {
  assert.deepEqual(steeringControls(false, 'COMPLETED'), { canPause: false, canResume: false, canInject: false, injectAtNextBoundary: false });
});

test('steeringControls: PAUSED -> resume + immediate inject, pause disabled', () => {
  assert.deepEqual(steeringControls(false, 'PAUSED'), { canPause: false, canResume: true, canInject: true, injectAtNextBoundary: false });
});

test('steeringControls: a steerable running state -> pause + queue-at-boundary inject (REQ-17.1), resume disabled', () => {
  assert.deepEqual(steeringControls(false, 'IMPLEMENTING'), { canPause: true, canResume: false, canInject: true, injectAtNextBoundary: true });
});
