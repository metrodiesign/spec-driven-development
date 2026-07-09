// Routing/rate-limit policy loader (REQ-8.2). Reads `.ai/policies/routing.json`
// (governance-hashed under POLICY_FILES, REQ-8.3) with TYPE-GUARDED fallbacks that
// NEVER LOOSEN: a missing file or a malformed field falls back to the strictest
// interpretation (tightest susceptibility cap, serialize, no buckets, empty
// allowlist), so a corrupt policy can never silently disable a filter.

import { readFileSync } from 'node:fs';

export interface RoutingBucketConfig {
  capacity: number;
  refillPerSec: number;
}

/** Outcome-routing activation (REQ-14.1) — a policy_change, governance-gated via POLICY_FILES (INV-16). */
export interface OutcomeRoutingConfig {
  mode: 'off' | 'shadow' | 'active';
  /** Integer percent [0,100) — explore-the-runner-up rate in `active` mode (REQ-15.2). */
  epsilon: number;
  minSamples: number;
  /** AZ-10: defaults to 1 when the field is missing/malformed. */
  minDivergences: number;
}

export interface RoutingConfig {
  /** Max p7 susceptibility a low-trust route tolerates (REQ-5.2/5.6). */
  maxSusceptibility: number;
  /** Max concurrent sends for the dispatcher (REQ-6.2). */
  maxParallel: number;
  /** Per-adapterId token bucket params (REQ-6.1). */
  tokenBuckets: Record<string, RoutingBucketConfig>;
  /** F-Sched allowlist (exact-name match, REQ-16.9) — shape lives here so it is POLICY_FILES-hashed. */
  sched: { scriptAllowlist: string[] };
  /** Absent/malformed -> `mode: 'off'` (REQ-14.1) — the plain router, same as today's pre-Phase-4 behavior. */
  outcomeRouting: OutcomeRoutingConfig;
}

/** Strictest safe config — the fallback for an absent/corrupt file (never loosens). */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  maxSusceptibility: 0, // only proven-non-susceptible adapters route low-trust content
  maxParallel: 1, // serialize
  tokenBuckets: {},
  sched: { scriptAllowlist: [] },
  outcomeRouting: { mode: 'off', epsilon: 0, minSamples: 20, minDivergences: 1 },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite susceptibility in [0,1], else the strict default (an out-of-range value never becomes a no-cap). */
function guardSusceptibility(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_ROUTING_CONFIG.maxSusceptibility;
}

/** A positive integer, else serialize (never a bigger fan-out than the file states). */
function guardMaxParallel(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_ROUTING_CONFIG.maxParallel;
}

function guardBuckets(v: unknown): Record<string, RoutingBucketConfig> {
  if (!isRecord(v)) return {};
  const out: Record<string, RoutingBucketConfig> = {};
  for (const [id, raw] of Object.entries(v)) {
    if (!isRecord(raw)) continue;
    const { capacity, refillPerSec } = raw;
    if (
      typeof capacity === 'number' && Number.isFinite(capacity) && capacity >= 0 &&
      typeof refillPerSec === 'number' && Number.isFinite(refillPerSec) && refillPerSec >= 0
    ) {
      out[id] = { capacity, refillPerSec };
    }
  }
  return out;
}

function guardAllowlist(v: unknown): string[] {
  if (!isRecord(v)) return [];
  const list = v['scriptAllowlist'];
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

const VALID_MODES = ['off', 'shadow', 'active'] as const;

/** Never invents `active`/`shadow` from a malformed field — anything but an exact match falls back to `off`. */
function guardMode(v: unknown): OutcomeRoutingConfig['mode'] {
  return typeof v === 'string' && (VALID_MODES as readonly string[]).includes(v)
    ? (v as OutcomeRoutingConfig['mode'])
    : DEFAULT_ROUTING_CONFIG.outcomeRouting.mode;
}

/** An integer percent in [0,100), else 0 (no exploration — never a bigger explore rate than the file states). */
function guardEpsilon(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 100 ? v : DEFAULT_ROUTING_CONFIG.outcomeRouting.epsilon;
}

function guardNonNegativeInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** REQ-14.1; absent block -> `mode: 'off'` (DEFAULT_ROUTING_CONFIG), matching today's pre-Phase-4 behavior. */
function guardOutcomeRouting(v: unknown): OutcomeRoutingConfig {
  const def = DEFAULT_ROUTING_CONFIG.outcomeRouting;
  if (!isRecord(v)) return { ...def };
  return {
    mode: guardMode(v['mode']),
    epsilon: guardEpsilon(v['epsilon']),
    minSamples: guardNonNegativeInt(v['minSamples'], def.minSamples),
    // AZ-10: minDivergences defaults to 1 when missing/malformed.
    minDivergences: guardNonNegativeInt(v['minDivergences'], def.minDivergences),
  };
}

/** Parse the config from an already-read JSON value (pure — testable without fs). */
export function parseRoutingConfig(raw: unknown): RoutingConfig {
  if (!isRecord(raw)) return { ...DEFAULT_ROUTING_CONFIG };
  return {
    maxSusceptibility: guardSusceptibility(raw['maxSusceptibility']),
    maxParallel: guardMaxParallel(raw['maxParallel']),
    tokenBuckets: guardBuckets(raw['tokenBuckets']),
    sched: { scriptAllowlist: guardAllowlist(raw['sched']) },
    outcomeRouting: guardOutcomeRouting(raw['outcomeRouting']),
  };
}

/** Load + guard routing.json; an unreadable/unparseable file falls back to the strict default. */
export function loadRoutingConfig(path: string): RoutingConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ...DEFAULT_ROUTING_CONFIG };
  }
  return parseRoutingConfig(raw);
}
