import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attestationChecklist,
  canApprove,
  canRollbackDeploy,
  deployCardVisible,
  deployProbeSummary,
  goalProvenanceLine,
  isGovernanceProposal,
  latestTaskState,
  nextSince,
  stateBadge,
  steeringControls,
  taskApprovalPackages,
  type DeployStatus,
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

test('goalProvenanceLine: null when the package carries no provenance (REQ-6.4)', () => {
  assert.equal(goalProvenanceLine(pkg([])), null);
});

test('goalProvenanceLine: specPath @ requirementsCommit · generatedAt, values verbatim (REQ-6.3)', () => {
  const withProvenance: LoopApprovalPackage = {
    ...pkg([]),
    provenance: {
      specPath: '.ai/specs/fixture/requirements.md',
      requirementsCommit: 'abc1234',
      requirementsSha256: 'deadbeef',
      generatedAt: '2026-07-12T00:00:00Z',
    },
  };
  assert.equal(goalProvenanceLine(withProvenance), '.ai/specs/fixture/requirements.md @ abc1234 · 2026-07-12T00:00:00Z');
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

test('deployCardVisible: hidden with no status, or the idle {state:null, approval:null} shape (REQ-7.4)', () => {
  assert.equal(deployCardVisible(null), false, 'fetch failed / 501 not composed');
  assert.equal(deployCardVisible({ state: null, approval: null }), false, 'composed but no deploy: configured');
});

test('deployCardVisible: visible once a state or a pending approval exists (REQ-7.1)', () => {
  assert.equal(deployCardVisible({ state: 'CANARY', approval: null }), true);
  const status: DeployStatus = { state: null, approval: pkg(['a']) };
  assert.equal(deployCardVisible(status), true, 'PENDING_APPROVAL is carried as approval-present, state still null pre-decision');
});

test('canRollbackDeploy: only EXPANDED shows the manual-rollback control (REQ-7.2)', () => {
  assert.equal(canRollbackDeploy('EXPANDED'), true);
  for (const s of [null, 'CANARY', 'OBSERVING', 'ROLLING_BACK', 'ROLLED_BACK', 'ESCALATED']) {
    assert.equal(canRollbackDeploy(s), false, `${String(s)} never shows rollback`);
  }
});

test('deployProbeSummary: null before the stage starts (no CANARY event yet)', () => {
  assert.equal(deployProbeSummary([]), null);
  assert.equal(
    deployProbeSummary([{ seq: 1, type: 'PROBE_RUN', taskId: 'T-1', payload: { exit: 0 } }]),
    null,
    'a repair-round probe with no CANARY event is never mistaken for a deploy probe',
  );
});

test('deployProbeSummary: counts only PROBE_RUN events after CANARY, ignoring earlier repair-round probes (REQ-7.1)', () => {
  const events: LoopEvent[] = [
    // A repair-round probe BEFORE deploy even exists (hypothesis.ts shares PROBE_RUN) — must never count.
    { seq: 1, type: 'PROBE_RUN', taskId: 'T-1', payload: { exit: 1 } },
    { seq: 2, type: 'DEPLOY_STATE', taskId: 'T-1', payload: { state: 'CANARY' } },
    { seq: 3, type: 'DEPLOY_STATE', taskId: 'T-1', payload: { state: 'OBSERVING' } },
    { seq: 4, type: 'PROBE_RUN', taskId: 'T-1', payload: { exit: 0 } },
    { seq: 5, type: 'PROBE_RUN', taskId: 'T-1', payload: { exit: 1 } },
    { seq: 6, type: 'PROBE_RUN', taskId: 'T-1', payload: { exit: null, error: true } },
  ];
  assert.deepEqual(deployProbeSummary(events), { pass: 1, fail: 2 });
});
