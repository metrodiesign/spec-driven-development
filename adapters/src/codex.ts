// Ring 2 — Codex adapter (spec §5.2, Phase 3 REQ-2). The second lineage under the
// AAL: `codex exec` proposes structured actions WITHOUT executing (SPIKE-6 PASS;
// `--sandbox read-only` is the enforcement, the prompt merely restates it). Wire
// translation ONLY (INV-8). The exec seam is INJECTED so unit tests are hermetic
// (a fake ExecFn — CI spends zero quota); the live wiring in codex-live.ts wraps a
// real child process. Mirrors anthropic.ts: same durable replay, same wire helpers.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AdapterError } from 'aal';
import { buildProposePrompt, classifyAdapterError, normalizeActions, unfence } from './wire.ts';
import type { AdapterInterface, AgentRequest, AgentResponse, CapabilityManifest } from 'aal';
import type { Action } from 'core';

/** Default hard kill timeout for the live spawn (SPIKE-6 #1) — recorded calibration knob (AZ-6). */
export const DEFAULT_KILL_TIMEOUT_MS = 600_000;

/** One `codex exec --json` JSONL event. Only `type` + `usage` are load-bearing here. */
export interface CodexEvent {
  type: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  [k: string]: unknown;
}

/** What an ExecFn returns: the process outcome the adapter translates to an AgentResponse. */
export interface CodexExecResult {
  exitCode: number;
  /** The final agent message (from `-o <file>`) — expected to be schema-conforming JSON. */
  lastMessage: string;
  /** The `--json` JSONL event stream (the transcript; `--ephemeral` leaves no session files). */
  events: CodexEvent[];
  stderr: string;
}

/** The injected process seam. Unit tests pass a fake; codex-live.ts passes a real spawn. */
export type ExecFn = (args: {
  prompt: string;
  schema: Record<string, unknown>;
  cwd: string;
  model?: string;
}) => Promise<CodexExecResult>;

export interface CodexAdapterOptions {
  id?: string;
  /** Recorded as adapterMeta.modelVersion (codex events do not echo it — SPIKE-6 #5). */
  model?: string;
  exec: ExecFn;
  /** Fixed agent-sessions dir, like anthropic. */
  cwd: string;
  /** Durable per-request replay dir (P8), per-run, never committed. */
  replayDir: string;
  putEvidence: (content: string) => string;
  /** costUnits = (input+output+reasoning)/1000 * per1k (REQ-2.3); default 1. */
  costUnitsPer1k?: number;
  /** Consumed by codex-live.ts's real spawn (REQ-2.9); createCodexAdapter itself never spawns. */
  killTimeoutMs?: number;
}

/** Parse a `--json` stdout blob into events (one JSON object per line; blank/garbage lines skipped). */
export function parseCodexEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // A non-JSON line (e.g. a stray log) is not an event — skip it, never throw.
    }
  }
  return events;
}

/** Sum per-turn usage across events (SPIKE-6: usage rides `turn.completed`). Cached is tracked, never billed. */
export function sumCodexUsage(events: CodexEvent[]): {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
} {
  const acc = { input: 0, cached: 0, output: 0, reasoning: 0 };
  for (const e of events) {
    if (e.usage === undefined) continue;
    acc.input += e.usage.input_tokens ?? 0;
    acc.cached += e.usage.cached_input_tokens ?? 0;
    acc.output += e.usage.output_tokens ?? 0;
    acc.reasoning += e.usage.reasoning_output_tokens ?? 0;
  }
  return acc;
}

export function createCodexAdapter(opts: CodexAdapterOptions): AdapterInterface {
  const id = opts.id ?? 'codex';
  const per1k = opts.costUnitsPer1k ?? 1;
  const replayPath = (requestId: string): string => join(opts.replayDir, `${encodeURIComponent(requestId)}.json`);

  return {
    manifest(): CapabilityManifest {
      return {
        adapterId: id,
        structuredOutput: true,
        toolCalling: false,
        contextWindowTokens: 200_000,
        executionBackend: false,
        determinism: 'none', // no seed; reproducibility = frozen artifact at verification (§16)
        lineage: 'openai',
      };
    },

    async send(req: AgentRequest): Promise<AgentResponse> {
      // Durable replay (survives restart): a repeated requestId is served from disk so a
      // crash-resume retry cannot double-burn quota; ExecFn is NOT invoked (REQ-2.4/P8).
      const rfile = replayPath(req.requestId);
      if (existsSync(rfile)) return JSON.parse(readFileSync(rfile, 'utf8')) as AgentResponse;

      // `--output-schema` already constrains the final message, so fenceGuard=false (REQ-1.3).
      let result: CodexExecResult;
      try {
        result = await opts.exec({
          prompt: buildProposePrompt(req, { fenceGuard: false }),
          schema: req.outputSchema,
          cwd: opts.cwd,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        });
      } catch (err) {
        // Transport-level failure (spawn/timeout) — typed, never self-retried (REQ-2.7, INV-5).
        throw new AdapterError(classifyAdapterError(err), err instanceof Error ? err.message : String(err));
      }

      // Non-zero exit OR a rate-limit/auth stderr → typed AdapterError (REQ-2.7). A bare
      // non-zero exit with unmatched stderr classifies as transport (REQ-1.5). The `--json`
      // stream often carries the actually-useful detail (e.g. an API-side schema rejection)
      // on an `error` event over stdout while stderr just shows codex's generic startup
      // chatter — prefer that event's message when present (live task 13 residual).
      if (result.exitCode !== 0) {
        const apiError = result.events.find((e) => e.type === 'error')?.['message'];
        const detail = typeof apiError === 'string' ? apiError : result.stderr;
        // Classify from the SAME detail the message reports — a quota/auth signal
        // that only appears in the --json error event (stderr stays generic) must
        // not silently classify as transport (Codex review finding on PR #47).
        throw new AdapterError(classifyAdapterError(detail), `codex exec exited ${result.exitCode}: ${detail}`);
      }

      let structuredResult: unknown;
      try {
        structuredResult = JSON.parse(unfence(result.lastMessage));
      } catch {
        structuredResult = { raw: result.lastMessage }; // non-JSON -> source's repair loop handles it
      }
      const ar = (structuredResult as { actionRequests?: unknown }).actionRequests;
      const actionRequests: Action[] = normalizeActions(ar, opts.putEvidence);

      const usage = sumCodexUsage(result.events);
      // The JSONL events ARE the transcript (--ephemeral leaves no session files) (REQ-2.5).
      const rawTranscriptRef = opts.putEvidence(result.events.map((e) => JSON.stringify(e)).join('\n'));

      const response: AgentResponse = {
        structuredResult,
        actionRequests,
        usage: {
          // cached tokens are cheaper/free — excluded from the billed cost (REQ-2.3).
          costUnits: ((usage.input + usage.output + usage.reasoning) / 1000) * per1k,
          raw: {
            input_tokens: usage.input,
            cached_input_tokens: usage.cached,
            output_tokens: usage.output,
            reasoning_output_tokens: usage.reasoning,
          },
        },
        rawTranscriptRef,
        // codex events do not echo the model — record the requested one (REQ-2.6, SPIKE-6 #5).
        // Propose-only: no tool_use exists on the wire (--sandbox read-only), toolUseCount 0 (P6).
        adapterMeta: { adapterId: id, modelVersion: opts.model ?? 'unknown', interactive: false, toolUseCount: 0 },
      };

      mkdirSync(opts.replayDir, { recursive: true });
      writeFileSync(rfile, JSON.stringify(response));
      return response;
    },
  };
}
