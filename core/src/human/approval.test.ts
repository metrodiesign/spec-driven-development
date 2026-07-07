// RED (approval fns throw NotImplemented) -> GREEN same task. REQ-9.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attestationsFor, buildApprovalPackage, type ApprovalInput } from './approval.ts';

function input(over: boolean): ApprovalInput {
  return {
    id: 'A-1',
    taskId: 'T-1',
    runId: 'RUN-1',
    goalExcerpt: 'make auth work',
    acIds: ['AC-1'],
    diffRef: 'blob://diff',
    diffLineCount: over ? 900 : 120,
    maxDiffBudget: 400,
    gateReports: ['blob://gate1'],
    worktreeHash: 'abc123',
    assumptions: ['assumes postgres'],
    unresolvedRisks: [],
    riskClass: 'L2',
    createdAt: 1_000,
  };
}

test('attestation checklist grows with risk class', () => {
  const l1 = attestationsFor('L1');
  const l3 = attestationsFor('L3');
  assert.ok(l1.length >= 1);
  assert.ok(l3.length > l1.length, 'L3 requires more attestations than L1');
});

test('under the diff budget -> a package with risk-derived attestations (REQ-9.1)', () => {
  const r = buildApprovalPackage(input(false));
  assert.equal(r.kind, 'package');
  if (r.kind === 'package') {
    assert.equal(r.package.taskId, 'T-1');
    assert.deepEqual(r.package.attestations, attestationsFor('L2'));
    assert.equal(r.package.evidence.worktreeHash, 'abc123');
  }
});

test('over the diff budget -> NO package, escalate split_required (REQ-9.2)', () => {
  const r = buildApprovalPackage(input(true));
  assert.equal(r.kind, 'escalate');
  if (r.kind === 'escalate') assert.equal(r.reason, 'split_required');
});
