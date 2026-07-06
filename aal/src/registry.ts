// Adapter registry (§7.3; REQ-2). Registration is REFUSED unless the supplied
// ConformanceRecord passes every pass/fail probe (P1–P6, P8); the P7 score is
// stored for later injection-aware routing. A drift-canary re-run that regresses
// marks the adapter stale_conformance and blocks live use until it re-passes.
// STUB in task 2 (RED) — implemented in task 3.

import type { AdapterInterface, ConformanceRecord } from './protocol.ts';
import type { Role as CoreRole } from 'core/types';

export interface RegisteredAdapter {
  adapter: AdapterInterface;
  record: ConformanceRecord;
  stale: boolean;
  susceptibilityScore: number;
}

export interface Registry {
  /** Refuses (throws) unless the record passes P1–P6 + P8. */
  register(adapter: AdapterInterface, record: ConformanceRecord): void;
  /** Records a drift-canary re-run; regressions mark the adapter stale. */
  recordConformance(adapterId: string, record: ConformanceRecord): void;
  eligible(role: CoreRole): RegisteredAdapter[];
  get(adapterId: string): RegisteredAdapter | undefined;
}

// Re-export core Role under the protocol namespace for callers.
export type { CoreRole as Role };

export function createRegistry(): Registry {
  throw new Error('NotImplemented: createRegistry');
}
