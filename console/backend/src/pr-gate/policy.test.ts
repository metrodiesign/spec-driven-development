import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeEffectivePolicy } from 'core';

import { ORGANIZATION_PR_GATE_FLOOR, parseRepositoryPolicy } from './policy.ts';

test('governed repository policy can tighten but cannot loosen hard floor', () => {
  const layer = parseRepositoryPolicy({ schemaVersion: 1, requireHumanApproval: true, maxCostUnits: 20, profiles: [] });
  const effective = mergeEffectivePolicy(ORGANIZATION_PR_GATE_FLOOR, layer);
  assert.equal(effective.requireHumanApproval, true);
  assert.equal(effective.maxCostUnits, 20);
  assert.throws(() => parseRepositoryPolicy({ schemaVersion: 1, network: 'full' }), /network/);
  assert.throws(() => parseRepositoryPolicy({ schemaVersion: 1, surprise: true }), /unknown/);
});
