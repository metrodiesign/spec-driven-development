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

export interface RoutingConfig {
  /** Max p7 susceptibility a low-trust route tolerates (REQ-5.2/5.6). */
  maxSusceptibility: number;
  /** Max concurrent sends for the dispatcher (REQ-6.2). */
  maxParallel: number;
  /** Per-adapterId token bucket params (REQ-6.1). */
  tokenBuckets: Record<string, RoutingBucketConfig>;
  /** F-Sched allowlist (exact-name match, REQ-16.9) — shape lives here so it is POLICY_FILES-hashed. */
  sched: { scriptAllowlist: string[] };
}

/** Strictest safe config — the fallback for an absent/corrupt file (never loosens). */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  maxSusceptibility: 0, // only proven-non-susceptible adapters route low-trust content
  maxParallel: 1, // serialize
  tokenBuckets: {},
  sched: { scriptAllowlist: [] },
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

/** Parse the config from an already-read JSON value (pure — testable without fs). */
export function parseRoutingConfig(raw: unknown): RoutingConfig {
  if (!isRecord(raw)) return { ...DEFAULT_ROUTING_CONFIG };
  return {
    maxSusceptibility: guardSusceptibility(raw['maxSusceptibility']),
    maxParallel: guardMaxParallel(raw['maxParallel']),
    tokenBuckets: guardBuckets(raw['tokenBuckets']),
    sched: { scriptAllowlist: guardAllowlist(raw['sched']) },
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
