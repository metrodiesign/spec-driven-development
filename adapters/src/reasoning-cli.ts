import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AdapterError } from 'aal';
import type { AdapterInterface, AgentCallControl, AgentRequest, AgentResponse, CapabilityManifest } from 'aal';
import type { Action } from 'core';

import { buildProposePrompt, classifyAdapterError, normalizeActions, unfence } from './wire.ts';
import { describeReasoningCliAdapter } from './descriptors.ts';

export interface ReasoningCliResult {
  exitCode: number;
  responseText: string;
  transcript: string;
  stderr: string;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number };
  toolUseCount: number;
}

export type ReasoningCliExec = (input: {
  prompt: string;
  cwd: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<ReasoningCliResult>;

export interface ReasoningCliAdapterOptions {
  id: string;
  lineage: string;
  model?: string;
  contextWindowTokens: number;
  exec: ReasoningCliExec;
  cwd: string;
  replayDir: string;
  putEvidence(content: string): string;
  costUnitsPer1k?: number;
}

export function createReasoningCliAdapter(opts: ReasoningCliAdapterOptions): AdapterInterface {
  const replayPath = (requestId: string): string => join(opts.replayDir, `${encodeURIComponent(requestId)}.json`);
  const per1k = opts.costUnitsPer1k ?? 1;
  return {
    manifest(): CapabilityManifest {
      return describeReasoningCliAdapter(opts).manifest;
    },
    async send(req: AgentRequest, control?: AgentCallControl): Promise<AgentResponse> {
      const rfile = replayPath(req.requestId);
      if (existsSync(rfile)) return JSON.parse(readFileSync(rfile, 'utf8')) as AgentResponse;
      if (control?.signal.aborted) throw new AdapterError('cancelled', 'provider call cancelled');
      let result: ReasoningCliResult;
      try {
        result = await opts.exec({
          prompt: buildProposePrompt(req),
          cwd: opts.cwd,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(control !== undefined ? { signal: control.signal, timeoutMs: control.timeoutMs } : {}),
        });
      } catch (error) {
        throw new AdapterError(classifyAdapterError(error), error instanceof Error ? error.message : String(error));
      }
      if (result.exitCode !== 0) {
        throw new AdapterError(classifyAdapterError(result.stderr), `${opts.id} exited ${result.exitCode}: ${result.stderr}`);
      }
      const numbers = Object.values(result.usage);
      if (!numbers.every((value) => Number.isFinite(value) && value >= 0)) {
        throw new AdapterError('invalid_response', `${opts.id} returned invalid usage`);
      }
      let structuredResult: unknown;
      try {
        structuredResult = JSON.parse(unfence(result.responseText));
      } catch {
        structuredResult = { raw: result.responseText };
      }
      const rawActions = (structuredResult as { actionRequests?: unknown }).actionRequests;
      const actionRequests: Action[] = normalizeActions(rawActions, opts.putEvidence);
      const response: AgentResponse = {
        structuredResult,
        actionRequests,
        usage: {
          costUnits: ((result.usage.inputTokens + result.usage.outputTokens + result.usage.reasoningTokens) / 1000) * per1k,
          raw: result.usage,
        },
        rawTranscriptRef: opts.putEvidence(result.transcript),
        adapterMeta: {
          adapterId: opts.id,
          modelVersion: opts.model ?? 'unknown',
          interactive: false,
          toolUseCount: result.toolUseCount,
        },
      };
      mkdirSync(opts.replayDir, { recursive: true });
      writeFileSync(rfile, JSON.stringify(response));
      return response;
    },
  };
}
