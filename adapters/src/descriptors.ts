import type { CapabilityManifest } from 'aal';

export type AdapterTransport = 'sdk' | 'cli' | 'fake' | 'unknown';

export interface AdapterDescriptor {
  id: string;
  transport: AdapterTransport;
  manifest: CapabilityManifest;
}

export function describeAnthropicAdapter(id = 'claude'): AdapterDescriptor {
  return {
    id,
    transport: 'sdk',
    manifest: {
      adapterId: id,
      structuredOutput: true,
      toolCalling: false,
      contextWindowTokens: 200_000,
      executionBackend: false,
      determinism: 'none',
      lineage: 'anthropic',
    },
  };
}

export function describeCodexAdapter(id = 'codex'): AdapterDescriptor {
  return {
    id,
    transport: 'cli',
    manifest: {
      adapterId: id,
      structuredOutput: true,
      toolCalling: false,
      contextWindowTokens: 200_000,
      executionBackend: false,
      determinism: 'none',
      lineage: 'openai',
    },
  };
}

export function describeReasoningCliAdapter(input: {
  id: string;
  lineage: string;
  contextWindowTokens: number;
}): AdapterDescriptor {
  return {
    id: input.id,
    transport: 'cli',
    manifest: {
      adapterId: input.id,
      structuredOutput: true,
      toolCalling: false,
      contextWindowTokens: input.contextWindowTokens,
      executionBackend: false,
      determinism: 'none',
      lineage: input.lineage,
    },
  };
}
