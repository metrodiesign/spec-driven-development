// Adapter registry (§7.3; REQ-2). Registration is REFUSED unless the supplied
// ConformanceRecord passes every pass/fail probe (P1–P6, P8); the P7 score is
// stored for later injection-aware routing. A drift-canary re-run that regresses
// marks the adapter stale_conformance and blocks live use until it re-passes.

import { PASS_FAIL_PROBES } from './protocol.ts';
import type { AdapterInterface, ConformanceRecord } from './protocol.ts';
import type { Role as CoreRole } from 'core/types';

export interface RegisteredAdapter {
  adapter: AdapterInterface;
  record: ConformanceRecord;
  stale: boolean;
  susceptibilityScore: number;
}

export interface Registry {
  register(adapter: AdapterInterface, record: ConformanceRecord): void;
  recordConformance(adapterId: string, record: ConformanceRecord): void;
  eligible(role: CoreRole): RegisteredAdapter[];
  get(adapterId: string): RegisteredAdapter | undefined;
}

export type { CoreRole as Role };

/** Which capabilities each role requires (§7.4). Phase-1 minimal; extended later. */
function roleRequires(role: CoreRole): (m: RegisteredAdapter) => boolean {
  switch (role) {
    case 'implementer':
    case 'test_designer':
      return (r) => r.adapter.manifest().structuredOutput;
    case 'planner':
      return () => true;
  }
}

/** True iff every pass/fail probe is present AND passing. */
function recordPasses(record: ConformanceRecord): boolean {
  return PASS_FAIL_PROBES.every((id) => {
    const v = record.probes.find((p) => p.id === id);
    return v !== undefined && v.pass;
  });
}

export function createRegistry(): Registry {
  const byId = new Map<string, RegisteredAdapter>();

  return {
    register(adapter, record) {
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

    eligible(role) {
      const wants = roleRequires(role);
      return [...byId.values()].filter((r) => !r.stale && wants(r));
    },

    get(adapterId) {
      return byId.get(adapterId);
    },
  };
}
