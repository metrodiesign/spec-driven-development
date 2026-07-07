// Shared fixtures for the AAL suite: request builders + an in-memory ProbeContext.

import { createHash } from 'node:crypto';

import type { AgentRequest } from '../src/protocol.ts';
import type { ProbeContext } from '../src/conformance/harness.ts';
import type { ContextBundle, Role, TaskContractExcerpt } from 'core/types';

export function memContext(): ProbeContext & { get(ref: string): string } {
  const store = new Map<string, string>();
  return {
    put(content: string): string {
      const ref = `blob://${createHash('sha256').update(content).digest('hex')}`;
      store.set(ref, content);
      return ref;
    },
    get(ref: string): string {
      const v = store.get(ref);
      if (v === undefined) throw new Error(`no such blob: ${ref}`);
      return v;
    },
  };
}

export function bundle(pieces: ContextBundle['pieces'] = [], canaryToken = 'CANARY-xyz'): ContextBundle {
  const bytes = pieces.reduce((n, p) => n + p.content.length, 0);
  return { pieces, canaryToken, stats: { bytes, pieceCount: pieces.length } };
}

export const TASK_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['claim', 'actionRequests'],
  properties: {
    claim: { type: 'string', enum: ['WORKING', 'READY_FOR_VERIFICATION', 'BLOCKED'] },
    summary: { type: 'string' },
    actionRequests: { type: 'array' },
    costUnits: { type: 'number' },
  },
};

export function request(opts: {
  requestId?: string;
  role?: Role;
  objective?: string;
  costUnits?: number;
  outputSchema?: Record<string, unknown>;
  contextBundle?: ContextBundle;
}): AgentRequest {
  const contract: TaskContractExcerpt = {
    goalId: 'G-1',
    title: 'fixture task',
    objective: opts.objective ?? 'implement the fixture',
    acceptanceCriteria: [{ id: 'AC-1', description: 'impl contains correct' }],
  };
  return {
    requestId: opts.requestId ?? 'req-1',
    agentRole: opts.role ?? 'implementer',
    taskContract: contract,
    contextBundle: opts.contextBundle ?? bundle(),
    manifestRef: 'blob://manifest',
    outputSchema: opts.outputSchema ?? TASK_RESULT_SCHEMA,
    toolDefs: [],
    budget: { costUnits: opts.costUnits ?? 500 },
  };
}
