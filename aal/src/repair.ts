// Bounded schema-repair loop (§7.2 fallback row 1; REQ-1.4/1.5, REQ-3.3).
// Validates a response's structuredResult against the request's outputSchema; on
// failure it re-asks the adapter with the validator errors appended, at most
// `maxRounds` times, then gives up with a structured result (valid: false).

import type { AdapterInterface, AgentRequest, AgentResponse } from './protocol.ts';

export interface RepairOutcome {
  response: AgentResponse;
  repairRounds: number;
  valid: boolean;
  errors: string[];
  /**
   * Usage summed across the initial send AND every repair round (backlog #1,
   * REQ-6.1). `response.usage` is only the LAST round; the budget must be charged
   * the total, or a schema-repair burn is invisible to the backstop.
   */
  totalUsage: { costUnits: number };
}

type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean';

function typeOf(v: unknown): JsonType | 'null' | 'undefined' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'object' || t === 'string' || t === 'number' || t === 'boolean') return t as JsonType;
  return 'undefined';
}

/**
 * Minimal JSON-Schema validation: `type`, `required`, `properties` (type + enum),
 * `enum`. Enough for the Phase-1 task-result contract; not a general validator.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const expectType = schema['type'] as JsonType | undefined;
  if (expectType !== undefined && typeOf(value) !== expectType) {
    errors.push(`expected type ${expectType}, got ${typeOf(value)}`);
    return { valid: false, errors };
  }
  const enumVals = schema['enum'] as unknown[] | undefined;
  if (enumVals !== undefined && !enumVals.includes(value)) {
    errors.push(`value not in enum ${JSON.stringify(enumVals)}`);
  }
  if (expectType === 'object' && typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const required = (schema['required'] as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) errors.push(`missing required property "${key}"`);
    }
    const props = (schema['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        const r = validateAgainstSchema(obj[key], sub);
        for (const e of r.errors) errors.push(`${key}: ${e}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Append validator feedback to the objective so the re-ask is self-describing. */
function repairRequest(req: AgentRequest, errors: string[], round: number): AgentRequest {
  return {
    ...req,
    requestId: `${req.requestId}#r${round}`,
    taskContract: {
      ...req.taskContract,
      objective:
        `${req.taskContract.objective}\n\n[repair] Your previous result failed schema ` +
        `validation: ${errors.join('; ')}. Return a corrected result that conforms.`,
    },
  };
}

export async function proposeWithRepair(
  adapter: AdapterInterface,
  req: AgentRequest,
  maxRounds: number,
): Promise<RepairOutcome> {
  let response = await adapter.send(req);
  let totalCost = response.usage.costUnits;
  let check = validateAgainstSchema(response.structuredResult, req.outputSchema);
  let rounds = 0;
  while (!check.valid && rounds < maxRounds) {
    rounds += 1;
    response = await adapter.send(repairRequest(req, check.errors, rounds));
    totalCost += response.usage.costUnits;
    check = validateAgainstSchema(response.structuredResult, req.outputSchema);
  }
  return {
    response,
    repairRounds: rounds,
    valid: check.valid,
    errors: check.errors,
    totalUsage: { costUnits: totalCost },
  };
}
