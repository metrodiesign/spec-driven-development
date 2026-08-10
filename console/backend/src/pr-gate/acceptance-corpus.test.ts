import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { mergeEffectivePolicy, type PinnedChangeSet } from 'core';

import { classifyPinnedChange } from './classification.ts';
import { ORGANIZATION_PR_GATE_FLOOR, parseRepositoryPolicy } from './policy.ts';

interface CorpusCase { id: string; paths: string[]; coverage: string; risk: string; profiles: string[] }

const corpus = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'pr-gate', 'acceptance-corpus.json'), 'utf8')) as CorpusCase[];
const policy = mergeEffectivePolicy(ORGANIZATION_PR_GATE_FLOOR, parseRepositoryPolicy({
  schemaVersion: 1,
  profiles: [
    { id: 'node-typescript', activation: { technologies: ['node-typescript'] }, checks: [], reviewDimensions: [] },
    { id: 'docs-config', activation: { technologies: ['docs-config'] }, checks: [], reviewDimensions: [] },
    { id: 'openapi', activation: { technologies: ['openapi'] }, checks: [], reviewDimensions: [], riskFloor: 'HIGH' },
  ],
}));

function change(paths: string[]): PinnedChangeSet {
  return {
    descriptor: { repository: 'acme/repo', number: 1, title: '', description: '', baseRef: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), fromFork: false },
    mergeBaseSha: 'c'.repeat(40), diffRef: `sha256:${'d'.repeat(64)}`, trustedRepositoryPolicyRef: `sha256:${'e'.repeat(64)}`,
    files: paths.map((path) => ({ path, status: 'modified' as const })),
  };
}

test('Phase-1 acceptance corpus stays executable, deterministic, and support-limited', () => {
  assert.equal(new Set(corpus.map((entry) => entry.id)).size, corpus.length);
  for (const entry of corpus) {
    const plan = classifyPinnedChange(change(entry.paths), policy);
    assert.equal(plan.analysis.coverage, entry.coverage, `${entry.id}: coverage`);
    assert.equal(plan.analysis.risk.level, entry.risk, `${entry.id}: risk`);
    assert.deepEqual(plan.profiles.map((profile) => profile.id), entry.profiles, `${entry.id}: profiles`);
  }
});
