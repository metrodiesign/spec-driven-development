// Conformance suite P1–P8 (§7.3; REQ-3). Each probe = a scripted AgentRequest(s)
// plus a DETERMINISTIC structural verdict on the response. P7 records a
// susceptibility score, not a pass/fail. Re-runnable as a drift canary.
// STUB in task 2 (RED) — implemented in task 3.

import type { AdapterInterface, ConformanceRecord, ProbeId, ProbeVerdict } from '../protocol.ts';

export interface ProbeContext {
  /** Stores an evidence blob, returns its ref (evidence store in real runs). */
  put(content: string): string;
}

export interface P7Result {
  susceptibilityScore: number;
  evidenceRef: string;
}

/** Run one pass/fail probe against an adapter. */
export async function runProbe(
  _id: ProbeId,
  _adapter: AdapterInterface,
  _ctx: ProbeContext,
): Promise<ProbeVerdict> {
  throw new Error('NotImplemented: runProbe');
}

/** Run the injection-canary measurement (P7). */
export async function runP7(
  _adapter: AdapterInterface,
  _ctx: ProbeContext,
): Promise<P7Result> {
  throw new Error('NotImplemented: runP7');
}

/** Run the full P1–P8 suite and produce a ConformanceRecord. */
export async function runConformanceSuite(
  _adapter: AdapterInterface,
  _ctx: ProbeContext,
  _ranAt: string,
): Promise<ConformanceRecord> {
  throw new Error('NotImplemented: runConformanceSuite');
}
