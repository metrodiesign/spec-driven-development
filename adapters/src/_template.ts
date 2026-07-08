// _template.ts — copy this to add a THIRD lineage. NOT registered anywhere and NOT
// exported from index.ts on purpose; it is a documented starting point, not product.
//
// INV-8 checklist for a new Ring-2 adapter (wire-format translation ONLY):
//   [ ] implement AdapterInterface: manifest() + send()
//   [ ] COMPOSE wire.ts helpers — never reinvent the prompt/action vocabulary
//       (buildProposePrompt, unfence, normalizeActions, classifyAdapterError)
//   [ ] map the vendor transport error to a typed AdapterError (never self-retry, INV-5)
//   [ ] durable per-request replay so a crash-resume cannot double-burn quota (P8)
//   [ ] set a `lineage` on the manifest (vendor names are legal HERE, Ring 2 ONLY)
//   [ ] pass conformance P1–P8 (runConformanceSuite) then register in the composition root
//   [ ] NEVER import core/executor or aal internals beyond the public protocol types (INV-8)

import { AdapterError } from 'aal';
import { buildProposePrompt, classifyAdapterError, normalizeActions, unfence } from './wire.ts';
import type { AdapterInterface, AgentRequest, AgentResponse, CapabilityManifest } from 'aal';
import type { Action } from 'core';

export interface TemplateAdapterOptions {
  id: string;
  lineage: string;
  model?: string;
  putEvidence: (content: string) => string;
  /** The vendor transport seam: given a prompt, return the model's final message text + token count. */
  transport: (prompt: string) => Promise<{ text: string; tokens: number }>;
}

export function createTemplateAdapter(opts: TemplateAdapterOptions): AdapterInterface {
  return {
    manifest(): CapabilityManifest {
      return {
        adapterId: opts.id,
        structuredOutput: true,
        toolCalling: false,
        contextWindowTokens: 128_000,
        executionBackend: false,
        determinism: 'none',
        lineage: opts.lineage,
      };
    },

    async send(req: AgentRequest): Promise<AgentResponse> {
      let out: { text: string; tokens: number };
      try {
        out = await opts.transport(buildProposePrompt(req, { fenceGuard: true }));
      } catch (err) {
        throw new AdapterError(classifyAdapterError(err), err instanceof Error ? err.message : String(err));
      }
      let structuredResult: unknown;
      try {
        structuredResult = JSON.parse(unfence(out.text));
      } catch {
        structuredResult = { raw: out.text };
      }
      const actionRequests: Action[] = normalizeActions(
        (structuredResult as { actionRequests?: unknown }).actionRequests,
        opts.putEvidence,
      );
      return {
        structuredResult,
        actionRequests,
        usage: { costUnits: out.tokens / 1000, raw: { tokens: out.tokens } },
        rawTranscriptRef: opts.putEvidence(out.text),
        adapterMeta: { adapterId: opts.id, modelVersion: opts.model ?? 'unknown', interactive: false, toolUseCount: 0 },
      };
    },
  };
}
