// Deterministic in-process model simulator (first-class dev adapter — NOT a test
// helper; the composition root's default non-live path uses it, so it must be
// product code). A `compliant` instance passes P1–P8; each sabotaged variant
// fails EXACTLY the probe that owns its misbehavior (REQ-3.9 discrimination).
//
// Probes drive behavior through a directive embedded in taskContract.objective —
// `[probe:P1 echo=<token>]` — which doubles as a natural-language instruction, so
// the same requests exercise a real model too (the model reads the words; the
// fake parses the tag).

import type { AdapterInterface, AgentRequest, AgentResponse, CapabilityManifest } from './protocol.ts';
import type { Action } from 'core/types';

export type FakeBehavior =
  | 'compliant'
  | 'prose_only' // fails P2: returns no actionRequests
  | 'fabricate_execution' // fails P6: claims it executed (toolUseCount > 0)
  | 'ignore_schema' // fails P1/P3: structuredResult never conforms
  | 'double_burn' // fails P8: no replay cache, usage charged twice
  | 'schema_fail_first'; // compliant-with-mistake: invalid first send, valid after (drives repair)

export interface FakeAdapterOptions {
  id?: string;
  modelVersion?: string;
  behavior?: FakeBehavior;
  contextWindowTokens?: number;
}

interface Directive {
  probe: string;
  echo?: string;
  tool?: string;
}

function parseDirective(objective: string): Directive {
  const m = /\[probe:(\w+)([^\]]*)\]/.exec(objective);
  if (m === null) return { probe: 'none' };
  const rest = m[2] ?? '';
  const echo = /echo=([^\s\]]+)/.exec(rest)?.[1];
  const tool = /tool=([^\s\]]+)/.exec(rest)?.[1];
  const d: Directive = { probe: m[1] ?? 'none' };
  if (echo !== undefined) d.echo = echo;
  if (tool !== undefined) d.tool = tool;
  return d;
}

const writeAction = (path: string, contentRef: string): Action => ({
  type: 'WRITE_FILE',
  actionId: `fake-${path}`,
  path,
  contentRef,
});

export class FakeAdapter implements AdapterInterface {
  private readonly id: string;
  private readonly modelVersion: string;
  private readonly behavior: FakeBehavior;
  private readonly contextWindowTokens: number;
  /** requestId -> response (durable-within-instance replay; P8). */
  private readonly replay = new Map<string, AgentResponse>();
  /** send attempts (drives schema_fail_first regardless of requestId). */
  private attempts = 0;

  constructor(opts: FakeAdapterOptions = {}) {
    this.id = opts.id ?? 'fake';
    this.modelVersion = opts.modelVersion ?? 'fake-1.0';
    this.behavior = opts.behavior ?? 'compliant';
    this.contextWindowTokens = opts.contextWindowTokens ?? 200_000;
  }

  manifest(): CapabilityManifest {
    return {
      adapterId: this.id,
      structuredOutput: true,
      toolCalling: false,
      contextWindowTokens: this.contextWindowTokens,
      executionBackend: false,
      determinism: 'seed',
    };
  }

  async send(req: AgentRequest): Promise<AgentResponse> {
    // P8: a compliant adapter serves a repeated requestId from its replay record
    // with usage counted once. double_burn skips the cache and re-charges.
    if (this.behavior !== 'double_burn') {
      const cached = this.replay.get(req.requestId);
      if (cached !== undefined) return cached;
    }
    this.attempts += 1;
    const resp = this.compose(req, this.attempts);
    if (this.behavior !== 'double_burn') this.replay.set(req.requestId, resp);
    return resp;
  }

  private compose(req: AgentRequest, attempt: number): AgentResponse {
    const d = parseDirective(req.taskContract.objective);
    const budgetLow = req.budget.costUnits <= 1;

    // Build the structuredResult (task-result shape) per behavior.
    let actionRequests: Action[] = [writeAction('src/impl.txt', 'blob://fake-correct')];
    let structuredResult: Record<string, unknown> = {
      claim: 'READY_FOR_VERIFICATION',
      summary: budgetLow ? 'degraded: single minimal action' : 'proposed fix',
      actionRequests,
      costUnits: budgetLow ? 1 : 2,
    };
    let toolUseCount = 0;

    if (d.echo !== undefined) {
      structuredResult = { ...structuredResult, echo: d.echo };
    }
    // P4: under a tight budget, degrade to ONE action but stay structurally valid.
    if (budgetLow) actionRequests = actionRequests.slice(0, 1);

    // P5: an unavailable tool is REQUESTED, never fabricated.
    if (d.probe === 'P5' && d.tool !== undefined && this.behavior !== 'fabricate_execution') {
      actionRequests = [
        { type: 'REQUEST_TOOL', actionId: 'fake-req-tool', name: d.tool, args: {} },
      ];
      structuredResult = { ...structuredResult, claim: 'WORKING', actionRequests };
    }

    switch (this.behavior) {
      case 'prose_only':
        actionRequests = [];
        structuredResult = { prose: 'here is what I would do, in words' };
        break;
      case 'ignore_schema':
        structuredResult = { nonsense: true }; // missing required `claim`/`actionRequests`
        break;
      case 'fabricate_execution':
        toolUseCount = 1;
        structuredResult = {
          ...structuredResult,
          claim: 'READY_FOR_VERIFICATION',
          executionOutput: 'ran the tests: 42 passed', // claimed execution — forbidden (P6)
        };
        break;
      case 'schema_fail_first':
        if (attempt === 1) structuredResult = { almost: 'missing claim' };
        break;
      case 'compliant':
      case 'double_burn':
        break;
    }

    return {
      structuredResult,
      actionRequests,
      usage: { costUnits: budgetLow ? 1 : 2, raw: { attempt } },
      rawTranscriptRef: null,
      adapterMeta: {
        adapterId: this.id,
        modelVersion: this.modelVersion,
        interactive: false,
        toolUseCount,
      },
    };
  }
}
