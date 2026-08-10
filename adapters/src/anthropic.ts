// Ring 2 — Claude adapter (spec §5.2, REQ-4). The ONE place autonomous code knows
// Claude. Wire-format translation ONLY (INV-8): isolation flags, usage
// normalization, transcript capture. Execution is stripped (tools: [] +
// settingSources: [], D-004) so every action is a PROPOSAL for core (INV-9/P6).
// The SDK `query` is injected so the adapter is unit-testable with a mock
// transport (CI never spends quota); production passes the real SDK query.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AdapterError } from 'aal';
import { buildProposePrompt, classifyAdapterError, normalizeActions, unfence } from './wire.ts';
import { linkCallControl, providerEnvironment } from './control.ts';
import type { AdapterHealth, AdapterInterface, AgentCallControl, AgentRequest, AgentResponse, CapabilityManifest } from 'aal';
import type { Action } from 'core';

// Re-export the shared wire helpers so existing importers (and tests) keep resolving
// them from this module unchanged (REQ-1.2); the definitions now live in wire.ts.
export { normalizeActions, unfence } from './wire.ts';

export interface SdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  tools?: string[];
  message?: { content?: { type?: string; text?: string }[] };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type QueryFn = (args: {
  prompt: string;
  options: {
    model?: string;
    tools: string[];
    settingSources: string[];
    systemPrompt: string;
    cwd: string;
    maxTurns?: number;
    abortController?: AbortController;
    env?: Record<string, string>;
  };
}) => AsyncIterable<SdkMessage>;

export interface AnthropicAdapterOptions {
  id?: string;
  model?: string;
  query: QueryFn;
  systemPrompt: string;
  cwd: string;
  replayDir: string;
  transcriptDir?: string;
  putEvidence: (content: string) => string;
  costUnitsPer1k?: number;
  pollIntervalMs?: number;
  pollAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Quota estimate injected by the composition root from the console usage
   * estimator (REQ-2.5) — the adapter itself stays estimation-free. Returns
   * per-window ESTIMATES (AZ-19) or null when no estimate is available.
   */
  quotaProbe?: () => Promise<{ fiveHourPct: number; weeklyPct: number } | null>;
  /** Health flips not-ok when either window's estimate meets this (default 85%). */
  quotaThresholdPct?: number;
}

/** The Claude adapter plus its (optional) quota-aware health probe for the registry. */
export type AnthropicAdapter = AdapterInterface & {
  healthProbe?: () => Promise<AdapterHealth>;
};

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Glob the projects root once (REQ-17.4): scan each project subdir for the
 * transcript the nested process may have written elsewhere. Returns the file
 * content, or null if the root/entries are unreadable — never throws (REQ-17.5).
 */
function globTranscript(projectsRoot: string, sessionId: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const dir of entries) {
    const candidate = join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, 'utf8');
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): AnthropicAdapter {
  const id = opts.id ?? 'claude';
  const per1k = opts.costUnitsPer1k ?? 1;
  const sleep = opts.sleep ?? realSleep;
  const pollAttempts = opts.pollAttempts ?? 10;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const quotaThresholdPct = opts.quotaThresholdPct ?? 85;
  const replayPath = (requestId: string): string => join(opts.replayDir, `${encodeURIComponent(requestId)}.json`);

  // Map the injected estimate to an AdapterHealth (probe vs threshold) — the only
  // "quota logic" the adapter holds is the comparison; the estimate itself is the
  // injected closure's job (REQ-2.5, INV-13 claim discipline).
  const healthProbe: (() => Promise<AdapterHealth>) | undefined =
    opts.quotaProbe === undefined
      ? undefined
      : async (): Promise<AdapterHealth> => {
          const w = await opts.quotaProbe!();
          if (w === null) return { ok: false, reason: 'probe_failed' };
          const max = Math.max(w.fiveHourPct, w.weeklyPct);
          return max >= quotaThresholdPct
            ? { ok: false, reason: 'quota_threshold', windows: w }
            : { ok: true, windows: w };
        };

  /**
   * Capture the run's transcript (REQ-17.4/17.5, REQ-4.6). Poll the PREDICTED path,
   * then — because a nested `claude` process munges HOME/cwd and can write under a
   * DIFFERENT projects subdir than we predicted -- glob every sibling project
   * ONCE before giving up. Both miss -> structured null, never a crash.
   */
  async function captureTranscript(
    sessionId: string | null,
  ): Promise<{ ref: string | null; source: string }> {
    if (sessionId === null) return { ref: null, source: 'no_session_id' };
    if (opts.transcriptDir === undefined) return { ref: null, source: 'no_transcript_dir' };
    const predicted = join(opts.transcriptDir, `${sessionId}.jsonl`);
    for (let i = 0; i < pollAttempts; i += 1) {
      if (existsSync(predicted)) return { ref: opts.putEvidence(readFileSync(predicted, 'utf8')), source: 'predicted' };
      await sleep(pollIntervalMs);
    }
    // Predicted path missed after polling — glob every sibling project dir ONCE.
    const globHit = globTranscript(dirname(opts.transcriptDir), sessionId);
    if (globHit !== null) return { ref: opts.putEvidence(globHit), source: 'glob_fallback' };
    return { ref: null, source: 'not_found_after_poll_and_glob' };
  }

  return {
    ...(healthProbe ? { healthProbe } : {}),
    manifest(): CapabilityManifest {
      return {
        adapterId: id,
        structuredOutput: true,
        toolCalling: false,
        contextWindowTokens: 200_000,
        executionBackend: false,
        determinism: 'none', // no seed; reproducibility = frozen artifact at verification (§16)
        lineage: 'anthropic', // vendor family for cross-lineage fusion routing (§7.4, REQ-4.1) — legal in Ring 2 only
      };
    },

    async send(req: AgentRequest, control?: AgentCallControl): Promise<AgentResponse> {
      // Durable replay (survives restart): a repeated requestId is served from disk
      // so a crash-resume retry cannot double-burn quota (REQ-4.9/P8).
      const rfile = replayPath(req.requestId);
      if (existsSync(rfile)) return JSON.parse(readFileSync(rfile, 'utf8')) as AgentResponse;

      let assistantText = '';
      let toolUseCount = 0;
      let sessionId: string | null = null;
      let inTok = 0;
      let outTok = 0;
      const linked = linkCallControl(control);
      try {
        for await (const msg of opts.query({
          prompt: buildProposePrompt(req, { fenceGuard: true }),
          options: {
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            tools: [], // D-004 — strip tool DEFINITIONS (not allowedTools: [])
            settingSources: [], // isolate machine config (CLAUDE.md/settings/hooks)
            systemPrompt: opts.systemPrompt,
            cwd: opts.cwd,
            maxTurns: 4,
            ...(linked.controller !== undefined ? { abortController: linked.controller } : {}),
            env: providerEnvironment(process.env, ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY']),
          },
        })) {
          if (msg.session_id !== undefined) sessionId = msg.session_id;
          if (msg.type === 'assistant') {
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'text') assistantText += block.text ?? '';
              if (block.type === 'tool_use') toolUseCount += 1;
            }
          }
          if (msg.type === 'result') {
            inTok += msg.usage?.input_tokens ?? 0;
            outTok += msg.usage?.output_tokens ?? 0;
          }
        }
      } catch (err) {
        const controlled = linked.reason();
        if (controlled !== null) throw new AdapterError(controlled, controlled === 'timed_out' ? 'provider call timed out' : 'provider call cancelled');
        throw new AdapterError(classifyAdapterError(err), err instanceof Error ? err.message : String(err));
      } finally {
        linked.dispose();
      }

      let structuredResult: unknown;
      try {
        structuredResult = JSON.parse(unfence(assistantText));
      } catch {
        structuredResult = { raw: assistantText }; // non-JSON -> repair loop handles (REQ-1.4)
      }
      const ar = (structuredResult as { actionRequests?: unknown }).actionRequests;
      const actionRequests: Action[] = normalizeActions(ar, opts.putEvidence);

      const transcript = await captureTranscript(sessionId);
      const response: AgentResponse = {
        structuredResult,
        actionRequests,
        usage: {
          costUnits: ((inTok + outTok) / 1000) * per1k,
          // `transcriptSource` is the structured reason (predicted/glob_fallback/miss)
          // that accompanies rawTranscriptRef — observable, never a bare null (REQ-17.5).
          raw: { input_tokens: inTok, output_tokens: outTok, transcriptSource: transcript.source },
        },
        rawTranscriptRef: transcript.ref,
        adapterMeta: { adapterId: id, modelVersion: opts.model ?? 'unknown', interactive: false, toolUseCount },
      };

      mkdirSync(opts.replayDir, { recursive: true });
      writeFileSync(rfile, JSON.stringify(response));
      return response;
    },
  };
}
