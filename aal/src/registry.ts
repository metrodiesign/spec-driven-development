// Adapter registry (§7.3; REQ-2). Registration is REFUSED unless the supplied
// ConformanceRecord passes every pass/fail probe (P1–P6, P8); the P7 score is
// stored for later injection-aware routing. A drift-canary re-run that regresses
// marks the adapter stale_conformance and blocks live use until it re-passes.
//
// Phase 2 (REQ-1/REQ-2): eligibility now also consults the circuit breaker
// (open keys excluded) and a cached HEALTH snapshot (quota-exhausted / probe-
// failed keys excluded). Probes run async via refreshHealth(); eligible()/route()
// stay synchronous over the cached snapshot so routing never blocks (AZ-14).

import { breakerKey, type Breaker } from './breaker.ts';
import { evaluateEligibility, type RouteHints } from './eligibility.ts';
import { PASS_FAIL_PROBES } from './protocol.ts';
import type { AdapterHealth, AdapterInterface, ConformanceRecord } from './protocol.ts';
import type { Role as CoreRole } from 'core/types';

export interface RegisteredAdapter {
  adapter: AdapterInterface;
  record: ConformanceRecord;
  stale: boolean;
  susceptibilityScore: number;
  /** Vendor family for cross-lineage routing (REQ-4.1); defaulted 'unknown' from the manifest. */
  lineage: string;
  /** Optional quota/health probe; absent = always-ok (e.g. FakeAdapter). */
  healthProbe?: () => Promise<AdapterHealth>;
}

/** A health snapshot that changed since the last refresh — the source emits QUOTA_PROBE for it. */
export interface HealthChange {
  key: string;
  adapterId: string;
  health: AdapterHealth;
}

export interface Registry {
  register(
    adapter: AdapterInterface,
    record: ConformanceRecord,
    healthProbe?: () => Promise<AdapterHealth>,
  ): void;
  recordConformance(adapterId: string, record: ConformanceRecord): void;
  eligible(role: CoreRole, hints?: RouteHints): RegisteredAdapter[];
  /**
   * Every registered adapter INCLUDING stale ones (REQ-4.3). `eligible()` filters
   * stale out, so "any adapter stale" is unobservable through it — shadow-freeze
   * (drift canary) and observability enumerate through `all()` instead.
   */
  all(): RegisteredAdapter[];
  /** Run every health probe (each timeout-bounded), cache the results, return changes. */
  refreshHealth(): Promise<HealthChange[]>;
  get(adapterId: string): RegisteredAdapter | undefined;
}

export type { CoreRole as Role };
export type { AdapterHealth } from './protocol.ts';

export interface RegistryOptions {
  /** When present, an open breaker key is excluded from eligible(). */
  breaker?: Breaker;
  /** Per-probe timeout inside refreshHealth (policy-pinned; AZ-14). */
  healthProbeTimeoutMs?: number;
}

/** True iff every pass/fail probe is present AND passing. */
function recordPasses(record: ConformanceRecord): boolean {
  return PASS_FAIL_PROBES.every((id) => {
    const v = record.probes.find((p) => p.id === id);
    return v !== undefined && v.pass;
  });
}

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/** Resolve a probe under a timeout; a hung/thrown probe = not-ok (probe_failed), never a hang (AZ-14). */
function probeWithTimeout(
  probe: () => Promise<AdapterHealth>,
  timeoutMs: number,
): Promise<AdapterHealth> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: false, reason: 'probe_failed' });
      }
    }, timeoutMs);
    probe().then(
      (h) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(h);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: 'probe_failed' });
        }
      },
    );
  });
}

export function createRegistry(opts: RegistryOptions = {}): Registry {
  const byId = new Map<string, RegisteredAdapter>();
  const health = new Map<string, AdapterHealth>();
  const timeoutMs = opts.healthProbeTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  const keyOf = (r: RegisteredAdapter): string =>
    breakerKey(r.record.adapterId, r.record.modelVersion);

  return {
    register(adapter, record, healthProbe) {
      if (!recordPasses(record)) {
        const failing = PASS_FAIL_PROBES.filter(
          (id) => !(record.probes.find((p) => p.id === id)?.pass ?? false),
        );
        throw new Error(
          `conformance gate: adapter "${record.adapterId}" cannot register — ` +
            `probes not passing: ${failing.join(', ')}`,
        );
      }
      byId.set(record.adapterId, {
        adapter,
        record,
        stale: false,
        susceptibilityScore: record.p7.susceptibilityScore,
        lineage: adapter.manifest().lineage ?? 'unknown',
        ...(healthProbe ? { healthProbe } : {}),
      });
    },

    recordConformance(adapterId, record) {
      const existing = byId.get(adapterId);
      if (existing === undefined) {
        throw new Error(`recordConformance: unknown adapter "${adapterId}"`);
      }
      const regressed = !recordPasses(record);
      byId.set(adapterId, {
        ...existing,
        record,
        stale: regressed,
        susceptibilityScore: record.p7.susceptibilityScore,
      });
    },

    async refreshHealth() {
      const changes: HealthChange[] = [];
      for (const r of byId.values()) {
        if (r.healthProbe === undefined) continue; // absent probe = always-ok, never emits
        const key = keyOf(r);
        const next = await probeWithTimeout(r.healthProbe, timeoutMs);
        const prev = health.get(key);
        health.set(key, next);
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
          changes.push({ key, adapterId: r.record.adapterId, health: next });
        }
      }
      return changes;
    },

    // Filter order (§7.4): !stale -> capability -> breaker not-open -> health.ok.
    eligible(role, hints) {
      return [...byId.values()].filter((r) => {
        const key = keyOf(r);
        const observedHealth = health.get(key);
        return evaluateEligibility({
          role,
          manifest: r.adapter.manifest(),
          conformancePasses: recordPasses(r.record),
          stale: r.stale,
          breakerState: opts.breaker?.state(key) ?? 'unconfigured',
          health: r.healthProbe === undefined ? 'unconfigured' : (observedHealth ?? 'unknown'),
          susceptibilityScore: r.susceptibilityScore,
          lineage: r.lineage,
          ...(hints === undefined ? {} : { hints }),
        }).state !== 'ineligible';
      });
    },

    all() {
      return [...byId.values()];
    },

    get(adapterId) {
      return byId.get(adapterId);
    },
  };
}
