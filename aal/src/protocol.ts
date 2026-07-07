// Ring 1 protocol envelopes (unified-platform-spec.md §7.1). The ONLY shapes core
// sees when talking to a model — vendor-neutral by law (INV-7). Ring 2 adapters
// translate these to/from a vendor wire format and NOTHING else (INV-8).

import type {
  Action,
  ContextBundle,
  Role,
  TaskContractExcerpt,
} from 'core/types';

/** Minimal JSON-Schema handle — the adapter passes it through to schema-in-prompt. */
export type JsonSchema = Record<string, unknown>;

/** Tool definition offered to a model. ALWAYS empty in Phase 1 (propose-only, INV-9). */
export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface AgentRequest {
  /**
   * Idempotency key (P8). Minted ONCE per round and recorded in a PROPOSAL_INTENT
   * event BEFORE the adapter call, so crash-replay reuses the same id.
   */
  requestId: string;
  agentRole: Role;
  taskContract: TaskContractExcerpt;
  /** Built by core/context ONLY (INV-3); machine config never enters. */
  contextBundle: ContextBundle;
  /** Evidence ref of context-manifest.json. */
  manifestRef: string;
  outputSchema: JsonSchema;
  /** §7.1 shape kept; ALWAYS [] in Phase 1. */
  toolDefs: ToolDef[];
  budget: { costUnits: number };
  /** A non-deterministic adapter (determinism: 'none') ignores this. */
  determinismHint?: { seed?: number; temperature?: number };
}

export interface AgentResponse {
  /** MUST conform to AgentRequest.outputSchema (aal/repair enforces). */
  structuredResult: unknown;
  /** Core Action DSL — proposals only, never executed by the adapter. */
  actionRequests: Action[];
  usage: { costUnits: number; raw: Record<string, unknown> };
  /** Immutable evidence copy; null for the FakeAdapter or an absent/unflushed real transcript. */
  rawTranscriptRef: string | null;
  adapterMeta: {
    adapterId: string;
    modelVersion: string;
    interactive: false;
    /**
     * tool_use blocks the adapter observed in its own message stream. MUST be 0
     * for a propose-only adapter (P6 verdict; the D-004 `tools: []` guarantee).
     */
    toolUseCount: number;
  };
}

export interface CapabilityManifest {
  adapterId: string;
  structuredOutput: boolean;
  toolCalling: boolean;
  contextWindowTokens: number;
  /** ALWAYS false — core executes every action (§7.2 row 4). */
  executionBackend: false;
  determinism: 'none' | 'seed';
}

export type AdapterErrorKind =
  | 'quota_limited'
  | 'auth_unavailable'
  | 'transport'
  | 'invalid_response';

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  constructor(kind: AdapterErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'AdapterError';
  }
}

/**
 * Quota/health snapshot for one adapter (§5.4, REQ-2). `windows` are per-window
 * usage ESTIMATES (five-hour + weekly, AZ-19), never one collapsed number and
 * never a hard measurement (INV-13 claim discipline). An absent probe = always-ok.
 */
export interface AdapterHealth {
  ok: boolean;
  reason?: 'quota_threshold' | 'probe_failed';
  windows?: { fiveHourPct: number; weeklyPct: number };
}

export interface AdapterInterface {
  manifest(): CapabilityManifest;
  /** Sends one request. Throws AdapterError (typed) — NEVER retries itself (INV-5). */
  send(req: AgentRequest): Promise<AgentResponse>;
}

/** Conformance probe ids that are pass/fail (P7 is a score, tracked separately). */
export type ProbeId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P8';
export const PASS_FAIL_PROBES: readonly ProbeId[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8'];

export interface ProbeVerdict {
  id: ProbeId;
  pass: boolean;
  evidenceRef: string;
  detail?: string;
}

export interface ConformanceRecord {
  adapterId: string;
  modelVersion: string;
  ranAt: string;
  probes: ProbeVerdict[];
  /** P7 susceptibility is a MEASUREMENT (0..1), never a pass bar. */
  p7: { susceptibilityScore: number; evidenceRef: string };
}
