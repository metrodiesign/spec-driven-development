import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateEligibility, type EligibilityInput } from './eligibility.ts';

const base: EligibilityInput = {
  role: 'implementer',
  manifest: {
    adapterId: 'a',
    structuredOutput: true,
    toolCalling: false,
    contextWindowTokens: 1_000,
    executionBackend: false,
    determinism: 'none',
    lineage: 'family-a',
  },
  conformancePasses: true,
  stale: false,
  breakerState: 'closed',
  health: { ok: true },
  susceptibilityScore: 0,
  lineage: 'family-a',
};

test('evaluateEligibility returns eligible for the live registry baseline', () => {
  assert.deepEqual(evaluateEligibility(base), { state: 'eligible', reasons: [] });
});

test('evaluateEligibility reports recorded inputs that are unknown instead of guessing', () => {
  assert.deepEqual(
    evaluateEligibility({
      ...base,
      manifest: null,
      conformancePasses: null,
      stale: null,
      breakerState: 'unknown',
      health: 'unknown',
    }),
    {
      state: 'unknown',
      reasons: ['manifest_unknown', 'conformance_unknown', 'staleness_unknown', 'breaker_unknown', 'health_unknown'],
    },
  );
});

test('evaluateEligibility applies capability, conformance, resilience, and route hints without reordering', () => {
  const result = evaluateEligibility({
    ...base,
    manifest: { ...base.manifest!, structuredOutput: false },
    conformancePasses: false,
    stale: true,
    breakerState: 'open',
    health: { ok: false, reason: 'quota_threshold' },
    susceptibilityScore: 9,
    hints: { maxSusceptibility: 2, excludeLineages: ['family-a'] },
  });
  assert.deepEqual(result, {
    state: 'ineligible',
    reasons: [
      'structured_output_required',
      'conformance_failed',
      'stale_conformance',
      'breaker_open',
      'quota_threshold',
      'susceptibility_exceeded',
      'lineage_excluded',
    ],
  });
});
