// Ring 2 — GLM (Z.ai) OpenAI-compatible adapter (unified-platform-spec.md §7.6,
// .ai/specs/glm-5-3-adapter REQ-1..REQ-4). The third vendor lineage under the
// AAL: propose-only structured actions over an OpenAI-compatible
// chat-completions transport. Wire translation ONLY (INV-8). The transport seam
// is INJECTED so unit tests are hermetic (CI spends zero quota); the live fetch
// wiring lives in openai-compatible-live.ts. Pure helpers (buildGlmRequestBody,
// parseGlmHttpBody, resolveGlmEndpointConfig) live HERE so they are testable
// without the network — same discipline as buildCodexArgv in codex.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AdapterError } from 'aal';
import { buildProposePrompt, classifyAdapterError, normalizeActions, unfence } from './wire.ts';
import type { AdapterInterface, AgentCallControl, AgentRequest, AgentResponse, CapabilityManifest } from 'aal';
import type { Action } from 'core';

/** GLM-5.3 context window (z.ai/blog/glm-5.3): 1M tokens in, 128K max output. */
export const GLM_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** Default Z.ai OpenAI-compatible chat-completions endpoint (REQ-2.1). */
export const GLM_DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4/chat/completions';

export type GlmReasoningEffort = 'low' | 'high' | 'max';

/** What a transport returns on success. It throws on any failure (see wire classify). */
export interface GlmTransportResult {
  /** choices[0].message.content */
  text: string;
  /** The two load-bearing token counts (billed). */
  usage: { promptTokens: number; completionTokens: number };
  /** The raw parsed `usage` object — passed through as AgentResponse.usage.raw (REQ-1.9). */
  rawUsage: Record<string, unknown>;
  /** The raw HTTP response body — persisted as the transcript via putEvidence. */
  rawBody: string;
}

/** The injected seam. CI tests pass a fake; the live module passes a fetch-backed one. */
export type GlmTransport = (prompt: string, control?: AgentCallControl) => Promise<GlmTransportResult>;

export interface OpenAICompatibleAdapterOptions {
  id?: string;
  /** Recorded as adapterMeta.modelVersion; the live factory passes 'glm-5.3'. */
  model?: string;
  contextWindowTokens?: number;
  transport: GlmTransport;
  /** Durable per-request replay dir (P8), per-run, never committed. */
  replayDir: string;
  putEvidence: (content: string) => string;
  /** costUnits = (prompt+completion tokens)/1000 * per1k (REQ-1.9); default 1. */
  costUnitsPer1k?: number;
}

/**
 * Resolve + validate endpoint credentials (REQ-2.1/2.2). Pure. Throws
 * AdapterError('auth_unavailable') when ZAI_API_KEY is unset/empty — the live
 * factory calls this at construction so misconfiguration surfaces before any
 * network call. The key is returned to the caller only; it never reaches an
 * error message, evidence, or a replay file (REQ-3.1).
 */
export function resolveGlmEndpointConfig(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey: string } {
  const apiKey = env['ZAI_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new AdapterError('auth_unavailable', 'ZAI_API_KEY is not set — refusing before any network call');
  }
  const baseUrl = env['ZAI_BASE_URL']?.trim() || GLM_DEFAULT_BASE_URL;
  return { baseUrl, apiKey };
}

/**
 * Pure: the chat-completions request body (REQ-2.3). GLM-5.3 REMOVED
 * thinking.type 'disabled' — thinking is always on and reasoning_effort is
 * mandatory on every request (z.ai/blog/glm-5.3).
 */
export function buildGlmRequestBody(
  prompt: string,
  opts: { model: string; reasoningEffort: GlmReasoningEffort },
): {
  model: string;
  messages: { role: 'user'; content: string }[];
  thinking: { type: 'enabled' };
  reasoning_effort: GlmReasoningEffort;
  stream: false;
} {
  return {
    model: opts.model,
    messages: [{ role: 'user', content: prompt }],
    thinking: { type: 'enabled' },
    reasoning_effort: opts.reasoningEffort,
    stream: false,
  };
}

/**
 * Pure: map an HTTP exchange to a GlmTransportResult (REQ-2.4/2.6). Non-2xx
 * throws Error("HTTP <status>: <body>") — status+body in the message so
 * classifyAdapterError maps 429 → quota_limited, 401/403 → auth_unavailable,
 * context-length text → context_limited, unmatched → transport. A 2xx body
 * without a usable choice/usage throws AdapterError('invalid_response'), which
 * the adapter core passes through unchanged.
 */
export function parseGlmHttpBody(status: number, bodyText: string): GlmTransportResult {
  if (!(status >= 200 && status < 300)) {
    throw new Error(`HTTP ${status}: ${bodyText}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new AdapterError('invalid_response', `glm endpoint returned a non-JSON body: ${bodyText.slice(0, 200)}`);
  }
  const body = parsed as { choices?: unknown; usage?: unknown };
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const content = (choice as { message?: { content?: unknown } } | undefined)?.message?.content;
  const usageObj = (body.usage ?? {}) as Record<string, unknown>;
  const promptTokens = usageObj['prompt_tokens'];
  const completionTokens = usageObj['completion_tokens'];
  if (typeof content !== 'string' || typeof promptTokens !== 'number' || typeof completionTokens !== 'number') {
    throw new AdapterError('invalid_response', `glm endpoint 2xx body has no usable choice/usage: ${bodyText.slice(0, 200)}`);
  }
  return { text: content, usage: { promptTokens, completionTokens }, rawUsage: usageObj, rawBody: bodyText };
}

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleAdapterOptions): AdapterInterface {
  const id = opts.id ?? 'glm';
  const per1k = opts.costUnitsPer1k ?? 1;
  const replayPath = (requestId: string): string => join(opts.replayDir, `${encodeURIComponent(requestId)}.json`);

  return {
    manifest(): CapabilityManifest {
      return {
        adapterId: id,
        structuredOutput: true,
        toolCalling: false,
        contextWindowTokens: opts.contextWindowTokens ?? GLM_CONTEXT_WINDOW_TOKENS,
        executionBackend: false,
        determinism: 'none', // no seed; reproducibility = frozen artifact at verification (§16)
        lineage: 'zai',
      };
    },

    async send(req: AgentRequest, control?: AgentCallControl): Promise<AgentResponse> {
      // Durable replay (survives restart): a repeated requestId is served from disk so a
      // crash-resume retry cannot double-burn quota; transport is NOT invoked (P8).
      const rfile = replayPath(req.requestId);
      if (existsSync(rfile)) return JSON.parse(readFileSync(rfile, 'utf8')) as AgentResponse;
      if (control?.signal.aborted) throw new AdapterError('cancelled', 'provider call cancelled');

      // The Z.ai path has no wire-level schema enforcement equivalent to codex
      // --output-schema, so the fence-guard clause stays on (REQ-1.3).
      let out: GlmTransportResult;
      try {
        out = await opts.transport(buildProposePrompt(req, { fenceGuard: true }), control);
      } catch (err) {
        // Already-typed errors (e.g. invalid_response from parseGlmHttpBody) pass through
        // unchanged; everything else is classified from its message. Never self-retried
        // (REQ-1.5, INV-5).
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(classifyAdapterError(err), err instanceof Error ? err.message : String(err));
      }

      const { promptTokens, completionTokens } = out.usage;
      if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || promptTokens < 0 || completionTokens < 0) {
        throw new AdapterError('invalid_response', 'glm transport returned invalid usage numbers');
      }

      let structuredResult: unknown;
      try {
        structuredResult = JSON.parse(unfence(out.text));
      } catch {
        structuredResult = { raw: out.text }; // non-JSON -> source's repair loop handles it (REQ-1.7)
      }
      const ar = (structuredResult as { actionRequests?: unknown }).actionRequests;
      const actionRequests: Action[] = normalizeActions(ar, opts.putEvidence);

      const response: AgentResponse = {
        structuredResult,
        actionRequests,
        usage: {
          costUnits: ((promptTokens + completionTokens) / 1000) * per1k,
          raw: out.rawUsage,
        },
        rawTranscriptRef: opts.putEvidence(out.rawBody),
        // Propose-only: no tool_use exists on this wire, toolUseCount 0 (P6).
        adapterMeta: { adapterId: id, modelVersion: opts.model ?? 'unknown', interactive: false, toolUseCount: 0 },
      };

      mkdirSync(opts.replayDir, { recursive: true });
      writeFileSync(rfile, JSON.stringify(response));
      return response;
    },
  };
}
