import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EffectivePolicy, PinnedChangeSet } from 'core';

import { classifyPinnedChange } from './classification.ts';

const policy: EffectivePolicy = {
  requiredReviewerCount: 4, blockingSeverity: 'HIGH', secretScanningRequired: true, allowStalePass: false,
  network: 'none', install: false, providerTimeoutMs: 600_000, runDeadlineMs: 1_800_000,
  maxCostUnits: 40, riskFloor: 'LOW', requireHumanApproval: false, checks: [],
  profiles: [
    { id: 'node', activation: { technologies: ['node-typescript'] }, checks: [], reviewDimensions: ['correctness'] },
    { id: 'docs', activation: { technologies: ['docs-config'] }, checks: [], reviewDimensions: ['accuracy'] },
    { id: 'openapi', activation: { technologies: ['openapi'] }, checks: [], reviewDimensions: ['compatibility'], riskFloor: 'HIGH' },
  ],
};

function change(paths: string[]): PinnedChangeSet {
  return {
    descriptor: { repository: 'acme/repo', number: 1, title: '', description: '', baseRef: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), fromFork: false },
    mergeBaseSha: 'c'.repeat(40), diffRef: `sha256:${'d'.repeat(64)}`, trustedRepositoryPolicyRef: `sha256:${'e'.repeat(64)}`,
    files: paths.map((path) => ({ path, status: 'modified' as const })),
  };
}

test('acceptance corpus classifies backend, docs-only, and OpenAPI contract changes deterministically', () => {
  const backend = classifyPinnedChange(change(['console/backend/src/app.ts', 'console/backend/src/app.test.ts']), policy);
  assert.deepEqual(backend.analysis.technologies, ['node-typescript']);
  assert.equal(backend.analysis.coverage, 'FULL');
  assert.ok(backend.analysis.impactEdges.length > 0);
  assert.deepEqual(backend.profiles.map((profile) => profile.id), ['node']);

  const docs = classifyPinnedChange(change(['docs/guide.md']), policy);
  assert.deepEqual(docs.analysis.categories, ['DOCUMENTATION']);
  assert.deepEqual(docs.profiles.map((profile) => profile.id), ['docs']);

  const openapi = classifyPinnedChange(change(['api/openapi.yaml']), policy);
  assert.equal(openapi.analysis.risk.level, 'HIGH');
  assert.deepEqual(openapi.analysis.publicContracts, ['api/openapi.yaml']);
  assert.deepEqual(openapi.profiles.map((profile) => profile.id), ['openapi']);
});

test('renamed public contract keeps old path impact and profile risk floor applies', () => {
  const renamed = change([]);
  renamed.files = [{ path: 'docs/schema.txt', previousPath: 'api/openapi.yaml', status: 'renamed' }];
  const plan = classifyPinnedChange(renamed, policy);
  assert.deepEqual(plan.analysis.publicContracts, ['api/openapi.yaml']);
  assert.equal(plan.analysis.risk.level, 'HIGH');
  assert.deepEqual(plan.profiles.map((profile) => profile.id), ['docs', 'openapi']);
});

test('unsupported Phase-1 stack is explicit LIMITED and cannot silently pass', () => {
  const plan = classifyPinnedChange(change(['ios/App.swift']), policy);
  assert.equal(plan.analysis.coverage, 'LIMITED');
  assert.deepEqual(plan.analysis.omittedPaths, [{ path: 'ios/App.swift', reason: 'unsupported_phase1_technology' }]);
});
