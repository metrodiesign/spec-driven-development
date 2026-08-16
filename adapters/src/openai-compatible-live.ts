// Ring 2 — live Z.ai wiring for the GLM adapter (.ai/specs/glm-5-3-adapter
// REQ-2). CI test files never import this module directly (REQ-2.7): every
// behavioral branch (request body, response parse, credential resolution,
// error classification) lives in the pure helpers of openai-compatible.ts;
// this file only composes them with fetch. The API key stays inside this
// module's closure — it is never in an error message, evidence blob, replay
// file, or transcript (REQ-3.1).

import { AdapterError } from 'aal';
import type { AdapterInterface, AgentCallControl } from 'aal';

import { linkCallControl } from './control.ts';
import {
  buildGlmRequestBody,
  createOpenAICompatibleAdapter,
  parseGlmHttpBody,
  resolveGlmEndpointConfig,
  type GlmReasoningEffort,
} from './openai-compatible.ts';

export const GLM_DEFAULT_MODEL = 'glm-5.3';

/** Same ceiling rationale as codex DEFAULT_KILL_TIMEOUT_MS — thinking models run long. */
export const GLM_DEFAULT_TIMEOUT_MS = 600_000;

export interface LiveGlmOptions {
  id?: string;
  model?: string;
  /** Defaults to process.env — resolution is delegated to resolveGlmEndpointConfig. */
  env?: NodeJS.ProcessEnv;
  reasoningEffort?: GlmReasoningEffort;
  timeoutMs?: number;
  /** Injectable for future wiring; CI never exercises this module. */
  fetchFn?: typeof fetch;
  replayDir: string;
  putEvidence: (content: string) => string;
  costUnitsPer1k?: number;
}

export function createLiveGlmAdapter(opts: LiveGlmOptions): AdapterInterface {
  // Factory-time credential resolution: a missing key is a wiring error, not a
  // runtime condition — fail before any network call (REQ-2.2).
  const { baseUrl, apiKey } = resolveGlmEndpointConfig(opts.env ?? process.env);
  const model = opts.model ?? GLM_DEFAULT_MODEL;
  const effort: GlmReasoningEffort = opts.reasoningEffort ?? 'high';
  const timeoutMs = opts.timeoutMs ?? GLM_DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchFn ?? fetch;

  return createOpenAICompatibleAdapter({
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    model,
    ...(opts.costUnitsPer1k !== undefined ? { costUnitsPer1k: opts.costUnitsPer1k } : {}),
    replayDir: opts.replayDir,
    putEvidence: opts.putEvidence,
    transport: (prompt: string, control?: AgentCallControl) => {
      // Even without an explicit control, live calls carry the default timeout;
      // with one, its signal/timeout are forwarded to the fetch (REQ-2.5).
      const lc = linkCallControl(control ?? { signal: new AbortController().signal, timeoutMs });
      return (async () => {
        try {
          const res = await doFetch(baseUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(buildGlmRequestBody(prompt, { model, reasoningEffort: effort })),
            ...(lc.controller !== undefined ? { signal: lc.controller.signal } : {}),
          });
          const bodyText = await res.text();
          return parseGlmHttpBody(res.status, bodyText);
        } catch (err) {
          if (err instanceof AdapterError) throw err;
          const reason = lc.reason();
          if (reason === 'timed_out' || reason === 'cancelled') {
            throw new AdapterError(reason, reason === 'timed_out' ? `provider timeout after ${timeoutMs}ms` : 'provider call cancelled');
          }
          throw err; // the adapter core classifies it via classifyAdapterError
        } finally {
          lc.dispose();
        }
      })();
    },
  });
}
