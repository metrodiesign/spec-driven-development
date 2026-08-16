import type { BreakerState } from './breaker.ts';
import type { AdapterHealth, CapabilityManifest } from './protocol.ts';
import type { Role } from 'core/types';

export interface RouteHints {
  maxSusceptibility?: number;
  excludeLineages?: string[];
}

export interface EligibilityInput {
  role: Role;
  manifest: CapabilityManifest | null;
  conformancePasses: boolean | null;
  stale: boolean | null;
  breakerState: BreakerState | 'unconfigured' | 'unknown';
  health: AdapterHealth | 'unconfigured' | 'unknown';
  susceptibilityScore: number | null;
  lineage: string | null;
  hints?: RouteHints;
}

export interface EligibilityResult {
  state: 'eligible' | 'ineligible' | 'unknown';
  reasons: string[];
}

/** Shared pure eligibility decision for the live registry and recorded projections. */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const denied: string[] = [];
  const unknown: string[] = [];

  if (input.manifest === null) {
    unknown.push('manifest_unknown');
  } else if (
    (input.role === 'implementer' || input.role === 'test_designer') &&
    !input.manifest.structuredOutput
  ) {
    denied.push('structured_output_required');
  }

  if (input.conformancePasses === false) denied.push('conformance_failed');
  else if (input.conformancePasses === null) unknown.push('conformance_unknown');

  if (input.stale === true) denied.push('stale_conformance');
  else if (input.stale === null) unknown.push('staleness_unknown');

  if (input.breakerState === 'open') denied.push('breaker_open');
  else if (input.breakerState === 'unknown') unknown.push('breaker_unknown');

  if (input.health === 'unknown') unknown.push('health_unknown');
  else if (input.health !== 'unconfigured' && !input.health.ok) denied.push(input.health.reason ?? 'health_unavailable');

  if (input.hints?.maxSusceptibility !== undefined) {
    if (input.susceptibilityScore === null) unknown.push('susceptibility_unknown');
    else if (input.susceptibilityScore > input.hints.maxSusceptibility) denied.push('susceptibility_exceeded');
  }

  if (input.hints?.excludeLineages !== undefined && input.hints.excludeLineages.length > 0) {
    if (input.lineage === null) unknown.push('lineage_unknown');
    else if (input.hints.excludeLineages.includes(input.lineage)) denied.push('lineage_excluded');
  }

  if (denied.length > 0) return { state: 'ineligible', reasons: denied };
  if (unknown.length > 0) return { state: 'unknown', reasons: unknown };
  return { state: 'eligible', reasons: [] };
}
