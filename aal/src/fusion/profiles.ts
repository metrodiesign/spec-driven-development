// Fusion profile loader (§7.5 + §11.1; REQ-8.1/8.4/8.5). Unlike routing-config,
// which falls back to the STRICTEST interpretation on a malformed field, a fusion
// profile that CONTRADICTS the fixed §7.5 artifact->resolve mapping or omits the
// required per-candidate cost estimate is REJECTED at load with a structured error
// (REQ-8.4/8.5) — enabling fusion is a governance event, so a bad profile must fail
// loud, never silently degrade to a weaker resolve rule.

import { readFileSync } from 'node:fs';

export type FusionArtifact = 'plan' | 'code_diff' | 'tests' | 'hypotheses' | 'reviews';
export type ResolveRule =
  | 'deliberate_synthesis'
  | 'evidence_tournament'
  | 'union_red_check'
  | 'union_rank_probe_cost'
  | 'weighted_ensemble';

/** The FIXED §7.5 mapping — the single authority a profile's resolve rule is validated against (REQ-8.1). */
export const RESOLVE_FOR: Record<FusionArtifact, ResolveRule> = {
  plan: 'deliberate_synthesis',
  code_diff: 'evidence_tournament',
  tests: 'union_red_check',
  hypotheses: 'union_rank_probe_cost',
  reviews: 'weighted_ensemble',
};

export type PanelDiversity =
  | { kind: 'self'; seeds: number[] }
  | { kind: 'cross_lineage'; lineages: string[] };

export interface FusionProfile {
  artifact: FusionArtifact;
  panel: { size: number; diversity: PanelDiversity };
  resolve: ResolveRule;
  /** Hard cap per activation (REQ-10.7). */
  budgetCapCostUnits: number;
  /** REQUIRED (AZ-3, REQ-8.5): pre-panel guard = size x this must fit the cap. */
  estimateCostUnitsPerCandidate: number;
}

/** A profile the loader refused. `.reason` is machine-readable; the message is human-facing. */
export class FusionProfileError extends Error {
  readonly reason:
    | 'not_an_object'
    | 'unknown_artifact'
    | 'resolve_mismatch'
    | 'missing_estimate'
    | 'bad_panel'
    | 'duplicate_artifact';
  readonly artifact: string | undefined;
  constructor(reason: FusionProfileError['reason'], message: string, artifact?: string) {
    super(message);
    this.reason = reason;
    this.artifact = artifact;
    this.name = 'FusionProfileError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArtifact(v: unknown): v is FusionArtifact {
  return v === 'plan' || v === 'code_diff' || v === 'tests' || v === 'hypotheses' || v === 'reviews';
}

function parseDiversity(v: unknown, artifact: string): PanelDiversity {
  if (!isRecord(v)) throw new FusionProfileError('bad_panel', `profile ${artifact}: panel.diversity is not an object`, artifact);
  if (v['kind'] === 'self') {
    const seeds = v['seeds'];
    if (!Array.isArray(seeds) || !seeds.every((s) => typeof s === 'number' && Number.isFinite(s))) {
      throw new FusionProfileError('bad_panel', `profile ${artifact}: self diversity needs a numeric seeds array`, artifact);
    }
    return { kind: 'self', seeds: seeds as number[] };
  }
  if (v['kind'] === 'cross_lineage') {
    const lineages = v['lineages'];
    if (!Array.isArray(lineages) || lineages.length === 0 || !lineages.every((l) => typeof l === 'string')) {
      throw new FusionProfileError('bad_panel', `profile ${artifact}: cross_lineage needs a non-empty string lineages array`, artifact);
    }
    return { kind: 'cross_lineage', lineages: lineages as string[] };
  }
  throw new FusionProfileError('bad_panel', `profile ${artifact}: panel.diversity.kind must be 'self' or 'cross_lineage'`, artifact);
}

/** Validate one raw profile object into a FusionProfile — throws FusionProfileError (REQ-8.4/8.5). */
export function parseFusionProfile(raw: unknown): FusionProfile {
  if (!isRecord(raw)) throw new FusionProfileError('not_an_object', 'fusion profile is not an object');
  const artifact = raw['artifact'];
  if (!isArtifact(artifact)) {
    throw new FusionProfileError('unknown_artifact', `unknown fusion artifact: ${JSON.stringify(artifact)}`, String(artifact));
  }
  // REQ-8.4: the resolve rule is not the profile's to choose — it MUST equal the
  // fixed §7.5 mapping, or the profile is rejected (a judge can never be handed a
  // resolve rule that could overrule a gate).
  const expected = RESOLVE_FOR[artifact];
  if (raw['resolve'] !== expected) {
    throw new FusionProfileError(
      'resolve_mismatch',
      `profile ${artifact}: resolve '${String(raw['resolve'])}' contradicts the fixed §7.5 mapping ('${expected}')`,
      artifact,
    );
  }
  // REQ-8.5 (AZ-3): the per-candidate cost estimate is REQUIRED — without it the
  // pre-panel budget guard (REQ-10.7) cannot run, so the profile is rejected.
  const estimate = raw['estimateCostUnitsPerCandidate'];
  if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate <= 0) {
    throw new FusionProfileError('missing_estimate', `profile ${artifact}: estimateCostUnitsPerCandidate is required and must be a positive number`, artifact);
  }
  const panel = raw['panel'];
  if (!isRecord(panel) || typeof panel['size'] !== 'number' || !Number.isInteger(panel['size']) || panel['size'] < 2) {
    throw new FusionProfileError('bad_panel', `profile ${artifact}: panel.size must be an integer >= 2 (a single-candidate panel makes uplift meaningless)`, artifact);
  }
  const cap = raw['budgetCapCostUnits'];
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    throw new FusionProfileError('bad_panel', `profile ${artifact}: budgetCapCostUnits must be a positive number`, artifact);
  }
  return {
    artifact,
    panel: { size: panel['size'], diversity: parseDiversity(panel['diversity'], artifact) },
    resolve: expected,
    budgetCapCostUnits: cap,
    estimateCostUnitsPerCandidate: estimate,
  };
}

/** Parse the whole file value into a validated map (pure — testable without fs). */
export function parseFusionProfiles(raw: unknown): Map<FusionArtifact, FusionProfile> {
  const list = isRecord(raw) && Array.isArray(raw['profiles']) ? raw['profiles'] : Array.isArray(raw) ? raw : undefined;
  if (list === undefined) {
    throw new FusionProfileError('not_an_object', 'fusion-profiles.json must be an array or { profiles: [...] }');
  }
  const map = new Map<FusionArtifact, FusionProfile>();
  for (const rawProfile of list) {
    const profile = parseFusionProfile(rawProfile);
    if (map.has(profile.artifact)) {
      throw new FusionProfileError('duplicate_artifact', `duplicate fusion profile for artifact ${profile.artifact}`, profile.artifact);
    }
    map.set(profile.artifact, profile);
  }
  return map;
}

/** Load + validate fusion-profiles.json (REQ-8.1). Throws FusionProfileError; an unreadable file throws too (governance surface — never a silent empty map). */
export function loadFusionProfiles(path: string): Map<FusionArtifact, FusionProfile> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FusionProfileError('not_an_object', `cannot read fusion-profiles.json at ${path}: ${String(err)}`);
  }
  return parseFusionProfiles(raw);
}
