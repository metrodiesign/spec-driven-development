// Blind-judge deliberation-analysis schema (REQ-9.3/9.4). Embedded here so Ring 1
// validates without reading the repo at runtime; the governance copy lives at
// `.ai/schemas/deliberation-analysis.schema.json` and MUST stay byte-equivalent in
// SHAPE (a co-located test asserts the required-property set matches). The judge
// returns ONLY this analysis — never a ranking (a ranking could overrule gate
// evidence, REQ-10.1) and never a synthesized artifact.

export interface DeliberationAnalysis {
  consensus: string[];
  contradictions: string[];
  partialAgreements: string[];
  uniqueContributions: string[];
  blindSpots: string[];
}

/** The five required array properties — the single source both the validator and the tests read. */
export const DELIBERATION_KEYS: readonly (keyof DeliberationAnalysis)[] = [
  'consensus',
  'contradictions',
  'partialAgreements',
  'uniqueContributions',
  'blindSpots',
];

/** Minimal JSON-Schema (validateAgainstSchema-compatible: type + required + properties). */
export const DELIBERATION_ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: [...DELIBERATION_KEYS],
  properties: Object.fromEntries(
    DELIBERATION_KEYS.map((k) => [k, { type: 'array' }]),
  ),
};

/** Coerce an unknown (validated) judge result into a DeliberationAnalysis — non-arrays degrade to []. */
export function asDeliberation(v: unknown): DeliberationAnalysis {
  const o = (v ?? {}) as Record<string, unknown>;
  const arr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
  return {
    consensus: arr(o['consensus']),
    contradictions: arr(o['contradictions']),
    partialAgreements: arr(o['partialAgreements']),
    uniqueContributions: arr(o['uniqueContributions']),
    blindSpots: arr(o['blindSpots']),
  };
}
