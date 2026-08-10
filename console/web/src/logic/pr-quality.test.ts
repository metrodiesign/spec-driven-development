import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canCancel, canOverride, decisionTone, semanticStatus, type PrGateDetail } from './pr-quality.ts';

test('PR gate controls use lifecycle, durable decision, and exact current head', () => {
  assert.equal(canCancel('REVIEWING'), true);
  assert.equal(canCancel('COMPLETED'), false);
  const detail = {
    state: 'AWAITING_HUMAN', effectiveDecision: 'HUMAN_REVIEW_REQUIRED', systemReport: {},
    headStatus: { stale: false },
  } as PrGateDetail;
  assert.equal(canOverride(detail), true);
  assert.equal(canOverride({ ...detail, headStatus: { ...detail.headStatus!, stale: true } }), false);
  assert.equal(canOverride({ ...detail, systemReport: null }), false);
});

test('semantic status accompanies color tone', () => {
  assert.equal(semanticStatus({ state: 'COMPLETED', effectiveDecision: 'PASS' }), 'COMPLETED: PASS');
  assert.equal(decisionTone('PASS'), 'success');
  assert.equal(decisionTone('HUMAN_REVIEW_REQUIRED'), 'warning');
  assert.equal(decisionTone('FAIL'), 'danger');
});
