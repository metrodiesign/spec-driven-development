// Fusion profile validation (REQ-8.1/8.4/8.5). A profile whose resolve rule
// contradicts the fixed §7.5 mapping, or that omits the required per-candidate cost
// estimate, is REJECTED at load — enabling fusion is a governance event, so a bad
// profile fails loud, never silently degrades. The shipped policy file is loaded and
// checked against the mapping too.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  loadFusionProfiles,
  parseFusionProfile,
  parseFusionProfiles,
  FusionProfileError,
  RESOLVE_FOR,
  type FusionArtifact,
} from './profiles.ts';

const SHIPPED = fileURLToPath(new URL('../../../.ai/policies/fusion-profiles.json', import.meta.url));

function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact: 'code_diff',
    panel: { size: 2, diversity: { kind: 'cross_lineage', lineages: ['familyA', 'familyB'] } },
    resolve: 'evidence_tournament',
    budgetCapCostUnits: 60,
    estimateCostUnitsPerCandidate: 12,
    ...over,
  };
}

test('the shipped fusion-profiles.json loads and every resolve rule matches the fixed §7.5 mapping (REQ-8.1)', () => {
  const map = loadFusionProfiles(SHIPPED);
  const artifacts: FusionArtifact[] = ['plan', 'code_diff', 'tests', 'hypotheses', 'reviews'];
  for (const a of artifacts) {
    const p = map.get(a);
    assert.ok(p !== undefined, `missing profile for ${a}`);
    assert.equal(p.resolve, RESOLVE_FOR[a], `${a} resolve must equal the fixed mapping`);
    assert.ok(p.panel.size >= 2, `${a} panel must seat >= 2`);
    assert.ok(p.estimateCostUnitsPerCandidate > 0, `${a} needs a positive estimate`);
  }
});

test('a resolve rule that contradicts the §7.5 mapping is rejected at load (REQ-8.4)', () => {
  assert.throws(
    () => parseFusionProfile(valid({ resolve: 'weighted_ensemble' })), // code_diff must be evidence_tournament
    (err: unknown) => err instanceof FusionProfileError && err.reason === 'resolve_mismatch',
  );
});

test('a profile that omits estimateCostUnitsPerCandidate is rejected at load (REQ-8.5, AZ-3)', () => {
  const { estimateCostUnitsPerCandidate: _dropped, ...without } = valid();
  assert.throws(
    () => parseFusionProfile(without),
    (err: unknown) => err instanceof FusionProfileError && err.reason === 'missing_estimate',
  );
});

test('a non-positive estimate is rejected (cannot gate the pre-panel budget check)', () => {
  assert.throws(
    () => parseFusionProfile(valid({ estimateCostUnitsPerCandidate: 0 })),
    (err: unknown) => err instanceof FusionProfileError && err.reason === 'missing_estimate',
  );
});

test('an unknown artifact is rejected', () => {
  assert.throws(
    () => parseFusionProfile(valid({ artifact: 'refactor' })),
    (err: unknown) => err instanceof FusionProfileError && err.reason === 'unknown_artifact',
  );
});

test('a single-candidate panel is rejected (uplift is meaningless with < 2, AZ-8)', () => {
  assert.throws(
    () => parseFusionProfile(valid({ panel: { size: 1, diversity: { kind: 'cross_lineage', lineages: ['familyA'] } } })),
    (err: unknown) => err instanceof FusionProfileError && err.reason === 'bad_panel',
  );
});

test('cross_lineage with an empty lineages array is rejected', () => {
  assert.throws(
    () => parseFusionProfile(valid({ panel: { size: 2, diversity: { kind: 'cross_lineage', lineages: [] } } })),
    (err: unknown) => err instanceof FusionProfileError && err.reason === 'bad_panel',
  );
});

test('a duplicate artifact across profiles is rejected', () => {
  assert.throws(
    () => parseFusionProfiles({ profiles: [valid(), valid()] }),
    (err: unknown) => err instanceof FusionProfileError && err.reason === 'duplicate_artifact',
  );
});

test('a valid self-diversity profile round-trips with the mapped resolve rule', () => {
  const p = parseFusionProfile(valid({ artifact: 'plan', resolve: 'deliberate_synthesis', panel: { size: 3, diversity: { kind: 'self', seeds: [1, 2, 3] } } }));
  assert.equal(p.artifact, 'plan');
  assert.equal(p.resolve, 'deliberate_synthesis');
  assert.deepEqual(p.panel.diversity, { kind: 'self', seeds: [1, 2, 3] });
});
