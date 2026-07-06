// Bounded schema-repair loop (§7.2 fallback row 1; REQ-1.4/1.5). Validates a
// response's structuredResult against the request's outputSchema; on failure it
// re-asks the adapter with the validator errors appended, at most `maxRounds`
// times, then gives up with a structured invalid_response.
// STUB in task 2 (RED) — implemented in task 3.

import type { AdapterInterface, AgentRequest, AgentResponse } from './protocol.ts';

export interface RepairOutcome {
  response: AgentResponse;
  repairRounds: number;
  valid: boolean;
  errors: string[];
}

export async function proposeWithRepair(
  _adapter: AdapterInterface,
  _req: AgentRequest,
  _maxRounds: number,
): Promise<RepairOutcome> {
  throw new Error('NotImplemented: proposeWithRepair');
}

/** Minimal JSON-Schema validation surface used by the repair loop. */
export function validateAgainstSchema(
  _value: unknown,
  _schema: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  throw new Error('NotImplemented: validateAgainstSchema');
}
