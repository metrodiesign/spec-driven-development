// Deterministic in-process model simulator (first-class dev adapter — NOT a test
// helper; the composition root's default non-live path uses it, so it must be
// product code). A `compliant` instance passes P1–P8; each sabotaged variant
// fails EXACTLY the probe that owns its misbehavior (REQ-3.9 discrimination).
//
// Probes drive behavior through a directive embedded in taskContract.objective —
// `[probe:P1 echo=<token>]` — which doubles as a natural-language instruction, so
// the same requests exercise a real model too (the model reads the words; the
// fake parses the tag).

import { AdapterError } from './protocol.ts';
import type { AdapterHealth, AdapterInterface, AgentRequest, AgentResponse, CapabilityManifest } from './protocol.ts';
import type { Action } from 'core/types';

export type FakeBehavior =
  | 'compliant'
  | 'prose_only' // fails P2: returns no actionRequests
  | 'fabricate_execution' // fails P6: claims it executed (toolUseCount > 0)
  | 'ignore_schema' // fails P1/P3: structuredResult never conforms
  | 'double_burn' // fails P8: no replay cache, usage charged twice
  | 'schema_fail_first' // compliant-with-mistake: invalid first send, valid after (drives repair)
  | 'repairable'; // writes the WRONG marker first (T1 fails -> DIAGNOSING), then the
// correct one after a confirmed hypothesis — drives the full FAILED->DIAGNOSING->
// REPAIRING->REVIEWING loop end to end (REQ-5 production).

/**
 * Survivability fault knobs (REQ-1/2/3) — orthogonal to the conformance
 * behaviors above. `throw_*` make send() raise a typed AdapterError so the
 * breaker + degraded re-route can be exercised deterministically; `health_unhealthy`
 * exposes a not-ok healthProbe so quota-aware routing skips this adapter.
 */
export type FakeFault = 'throw_quota_limited' | 'throw_transport' | 'health_unhealthy';

export interface FakeAdapterOptions {
  id?: string;
  modelVersion?: string;
  behavior?: FakeBehavior;
  fault?: FakeFault;
  contextWindowTokens?: number;
  /** Vendor family surfaced through the manifest (REQ-4.4); absent → registry defaults 'unknown'. */
  lineage?: string;
  /**
   * Optional evidence writer. A real adapter maps the model's inline content to a
   * core evidence ref; when provided, the fake's WRITE_FILE carries a resolvable
   * ref (so a full loop can execute it). Conformance runs omit it (no execution).
   */
  putContent?: (content: string) => string;
  /** The file body the compliant fake proposes to write (default satisfies the fixture gate). */
  writeContent?: string;
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

// The actionId is per-ATTEMPT unique: the core executor dedups by actionId (crash
// replay), so a task that writes the same path across rounds (e.g. `repairable`)
// needs distinct ids or the later write is skipped as a duplicate. A replayed send
// (P8) returns the cached response with the SAME attempt/id, so dedup still holds.
const writeAction = (path: string, contentRef: string, attempt: number): Action => ({
  type: 'WRITE_FILE',
  actionId: `fake-${path}-${attempt}`,
  path,
  contentRef,
});

export class FakeAdapter implements AdapterInterface {
  private readonly id: string;
  private readonly modelVersion: string;
  private readonly behavior: FakeBehavior;
  private readonly fault: FakeFault | undefined;
  private readonly contextWindowTokens: number;
  private readonly putContent: ((content: string) => string) | undefined;
  private readonly writeContent: string;
  private readonly lineage: string | undefined;
  /** requestId -> response (durable-within-instance replay; P8). */
  private readonly replay = new Map<string, AgentResponse>();
  /** send attempts (drives schema_fail_first regardless of requestId). */
  private attempts = 0;
  /** Implementer writes seen (drives `repairable`: 1st = wrong marker, later = correct). */
  private implWrites = 0;
  /** A not-ok quota/health probe when fault === 'health_unhealthy'; the registry consumes it. */
  readonly healthProbe: (() => Promise<AdapterHealth>) | undefined;

  constructor(opts: FakeAdapterOptions = {}) {
    this.id = opts.id ?? 'fake';
    this.modelVersion = opts.modelVersion ?? 'fake-1.0';
    this.behavior = opts.behavior ?? 'compliant';
    this.fault = opts.fault;
    this.contextWindowTokens = opts.contextWindowTokens ?? 200_000;
    this.putContent = opts.putContent;
    this.writeContent = opts.writeContent ?? 'correct\n';
    this.lineage = opts.lineage;
    this.healthProbe =
      opts.fault === 'health_unhealthy'
        ? () =>
            Promise.resolve<AdapterHealth>({
              ok: false,
              reason: 'quota_threshold',
              windows: { fiveHourPct: 99, weeklyPct: 80 },
            })
        : undefined;
  }

  manifest(): CapabilityManifest {
    return {
      adapterId: this.id,
      structuredOutput: true,
      toolCalling: false,
      contextWindowTokens: this.contextWindowTokens,
      executionBackend: false,
      determinism: 'seed',
      ...(this.lineage !== undefined ? { lineage: this.lineage } : {}),
    };
  }

  async send(req: AgentRequest): Promise<AgentResponse> {
    // Survivability faults raise a typed AdapterError BEFORE any replay/compose so
    // the source records the breaker failure and re-routes (REQ-3.1). No self-retry.
    if (this.fault === 'throw_quota_limited') {
      throw new AdapterError('quota_limited', `fake fault: quota_limited (${this.id})`);
    }
    if (this.fault === 'throw_transport') {
      throw new AdapterError('transport', `fake fault: transport (${this.id})`);
    }
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
    // A DIAGNOSING round (REQ-5.1): return testable hypotheses as data — NOT a task
    // result. Core validates the shape, caps probes, and runs each probe itself.
    if (req.agentRole === 'diagnostician') return this.diagnose(attempt);

    const d = parseDirective(req.taskContract.objective);
    const budgetLow = req.budget.costUnits <= 1;
    // `repairable` (REQ-5 production): the first implementer write plants the WRONG
    // marker so T1 fails and the loop diagnoses; the write after a confirmed
    // hypothesis plants the correct one so the re-verify passes.
    let writeContent = this.writeContent;
    if (this.behavior === 'repairable') {
      this.implWrites += 1;
      writeContent = this.implWrites === 1 ? 'wrong\n' : 'correct\n';
    }
    const contentRef = this.putContent ? this.putContent(writeContent) : 'blob://fake-correct';

    // Build the structuredResult (task-result shape) per behavior.
    let actionRequests: Action[] = [writeAction('src/impl.txt', contentRef, attempt)];
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

    // P5: an unavailable tool is REQUESTED (as data), never fabricated — for EVERY
    // behavior, so the fabricate_execution saboteur still fails only P6, not P5.
    if (d.probe === 'P5' && d.tool !== undefined) {
      actionRequests = [
        { type: 'REQUEST_TOOL', actionId: 'fake-req-tool', name: d.tool, args: {} },
      ];
      structuredResult = { ...structuredResult, claim: 'WORKING', actionRequests };
    }

    // Saboteur behaviors are directive-gated to the probe they OWN, so each fails
    // EXACTLY its probe (REQ-3.9) — a real targeted defect the probe must catch.
    // double_burn needs no gate: only P8 re-sends the same requestId, so it fails
    // nowhere else. schema_fail_first is a compliant-model-with-a-mistake fixture.
    switch (this.behavior) {
      case 'prose_only':
        if (d.probe === 'P2') {
          actionRequests = [];
          structuredResult = { prose: 'here is what I would do, in words' };
        }
        break;
      case 'ignore_schema':
        if (d.probe === 'P1' || d.probe === 'P3') {
          structuredResult = { nonsense: true }; // missing required `claim`/`actionRequests`
        }
        break;
      case 'fabricate_execution':
        if (d.probe === 'P6') {
          toolUseCount = 1;
          structuredResult = {
            ...structuredResult,
            executionOutput: 'ran the tests: 42 passed', // claimed execution — forbidden (P6)
          };
        }
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

  /**
   * A diagnostician round's response: a testable hypothesis whose single probe
   * (`cat src/impl.txt`, expected substring `wrong`) CONFIRMS while the pre-fix
   * marker is still on disk — the source lifts `structuredResult.hypotheses` into
   * `Proposal.hypotheses` (REQ-5 production) and core runs the probe itself. The
   * task-result fields (claim, actionRequests) are present so the response still
   * satisfies the wire schema; the diagnostician proposes nothing to execute.
   */
  private diagnose(attempt: number): AgentResponse {
    const hypotheses = [
      {
        statement: 'src/impl.txt still holds the pre-fix marker instead of the required token',
        probes: [{ cmd: 'cat src/impl.txt', expected: 'wrong' }],
        ifConfirmed: {
          patchPlan: 'overwrite src/impl.txt so it contains the token "correct"',
          estimatedBlastRadius: '1 file',
        },
      },
    ];
    return {
      structuredResult: { claim: 'WORKING', actionRequests: [], hypotheses },
      actionRequests: [],
      usage: { costUnits: 2, raw: { attempt, role: 'diagnostician' } },
      rawTranscriptRef: null,
      adapterMeta: {
        adapterId: this.id,
        modelVersion: this.modelVersion,
        interactive: false,
        toolUseCount: 0,
      },
    };
  }
}
