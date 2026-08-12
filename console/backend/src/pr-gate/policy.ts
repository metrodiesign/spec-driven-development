import { mergeEffectivePolicy, type EffectivePolicy, type PolicyLayer } from 'core';

import type { LocalGitObjectReader } from './local-git.ts';
import type { PinnedChangeSet } from 'core';

export const ORGANIZATION_PR_GATE_FLOOR: EffectivePolicy = {
  requiredReviewerCount: 4,
  blockingSeverity: 'HIGH',
  secretScanningRequired: true,
  allowStalePass: false,
  network: 'none',
  install: false,
  providerTimeoutMs: 600_000,
  runDeadlineMs: 1_800_000,
  maxCostUnits: 40,
  riskFloor: 'LOW',
  requireHumanApproval: false,
  checks: [{
    id: 'secret-scan', kind: 'security', command: 'builtin:secret-scan', required: true, timeoutMs: 120_000,
    network: 'none', install: false, profiles: [], components: [],
  }],
  profiles: [],
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Core merge is final authority; edge parser rejects unknown/non-object policy shapes first. */
export function parseRepositoryPolicy(value: unknown): PolicyLayer {
  if (!record(value) || value['schemaVersion'] !== 1) throw new Error('PR quality policy schemaVersion must be 1');
  const allowed = new Set([
    '$comment', 'schemaVersion', 'requiredReviewerCount', 'blockingSeverity', 'providerTimeoutMs', 'runDeadlineMs',
    'maxCostUnits', 'riskFloor', 'requireHumanApproval', 'secretScanningRequired', 'allowStalePass', 'network', 'install',
    'checks', 'profiles',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`unknown PR quality policy keys: ${unknown.sort().join(', ')}`);
  const { schemaVersion: _schemaVersion, $comment: _comment, ...layer } = value;
  // Validates floors, checks, profiles, timeouts, costs, and isolation invariants.
  mergeEffectivePolicy(ORGANIZATION_PR_GATE_FLOOR, layer as PolicyLayer);
  return layer as PolicyLayer;
}

export async function loadPinnedRepositoryPolicy(
  reader: LocalGitObjectReader,
  change: PinnedChangeSet,
  signal: AbortSignal,
): Promise<PolicyLayer> {
  const text = await reader.readText('base', '.ai/policies/pr-quality-gate.json', change, 1024 * 1024, signal);
  if (text === null) throw new Error('trusted PR quality policy missing at base SHA');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('trusted PR quality policy is malformed JSON'); }
  return parseRepositoryPolicy(parsed);
}
