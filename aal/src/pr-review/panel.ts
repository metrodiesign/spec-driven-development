import {
  normalizeReviewerResult,
  validateJudgeResult,
  type JudgeResult,
  type JudgedFinding,
  type ReviewerFinding,
  type ReviewerResult,
  type ReviewerStatus,
  type Sha256Ref,
  type SnapshotEvidenceIndex,
  type SnapshotIdentity,
} from 'core';

import { AdapterError } from '../protocol.ts';
import type {
  AdapterInterface,
  AgentCallControl,
  AgentRequest,
  AgentResponse,
  JsonSchema,
} from '../protocol.ts';

const SNAPSHOT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['repository', 'pullRequest', 'baseSha', 'headSha', 'mergeBaseSha', 'diffRef', 'policyRef'],
  properties: {
    repository: { type: 'string' }, pullRequest: { type: 'integer', minimum: 1 }, baseSha: { type: 'string' },
    headSha: { type: 'string' }, mergeBaseSha: { type: 'string' }, diffRef: { type: 'string' }, policyRef: { type: 'string' },
  },
};

const EMPTY_ACTION_SCHEMA: JsonSchema = { type: 'object', additionalProperties: false, properties: {}, required: [] };

export const REVIEWER_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['snapshot', 'findings', 'actionRequests'],
  properties: {
    snapshot: SNAPSHOT_SCHEMA,
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'category', 'severity', 'title', 'finding', 'rootCause', 'evidence', 'trigger', 'impact', 'suggestedFix', 'confidence'],
        properties: {
          id: { type: 'string' }, category: { type: 'string' }, severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          title: { type: 'string' }, finding: { type: 'string' }, rootCause: { type: 'string' }, trigger: { type: 'string' },
          impact: { type: 'string' }, suggestedFix: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence: {
            type: 'array', minItems: 1, items: {
              type: 'object', additionalProperties: false, required: ['path', 'startLine', 'endLine', 'excerptHash'],
              properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, excerptHash: { type: 'string' } },
            },
          },
        },
      },
    },
    actionRequests: { type: 'array', maxItems: 0, items: EMPTY_ACTION_SCHEMA },
  },
};

export const JUDGE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['snapshot', 'findings', 'actionRequests'],
  properties: {
    snapshot: SNAPSHOT_SCHEMA,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'canonicalFindingKey',
          'sourceFindingIds',
          'classification',
          'severity',
          'evidenceRefs',
          'rationale',
        ],
        properties: {
          canonicalFindingKey: { type: 'string' },
          sourceFindingIds: { type: 'array', items: { type: 'string' } },
          classification: { type: 'string', enum: ['VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'FALSE_POSITIVE'] },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
      },
    },
    actionRequests: { type: 'array', maxItems: 0, items: EMPTY_ACTION_SCHEMA },
  },
};

export interface ReviewSlot {
  adapter: AdapterInterface;
  requestId: string;
  /** Set only after the adapter's deny-all-tools conformance probe passes. */
  reasoningOnlyConformant: boolean;
}

export interface BlindPanelInput {
  slots: readonly ReviewSlot[];
  request: Omit<AgentRequest, 'requestId'>;
  snapshot: SnapshotIdentity;
  evidence: SnapshotEvidenceIndex;
  control: AgentCallControl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function echoesCanary(value: unknown, canaryToken: string): boolean {
  try {
    return JSON.stringify(value).includes(canaryToken);
  } catch {
    return true;
  }
}

function asSnapshot(value: unknown): SnapshotIdentity | null {
  if (!isRecord(value)) return null;
  const strings = ['repository', 'baseSha', 'headSha', 'mergeBaseSha', 'diffRef', 'policyRef'] as const;
  if (!strings.every((key) => typeof value[key] === 'string')) return null;
  if (!Number.isInteger(value['pullRequest']) || Number(value['pullRequest']) <= 0) return null;
  return value as unknown as SnapshotIdentity;
}

function transcriptRef(value: string | null): Sha256Ref | null {
  return value?.startsWith('sha256:') ? value as Sha256Ref : null;
}

function emptyResult(slot: ReviewSlot, snapshot: SnapshotIdentity, status: ReviewerStatus): ReviewerResult {
  const manifest = slot.adapter.manifest();
  return {
    requestId: slot.requestId,
    adapterId: manifest.adapterId,
    modelVersion: 'unknown',
    snapshot,
    status,
    findings: [],
    usage: { costUnits: 0 },
    transcriptRef: null,
    actionRequests: [],
    toolUseCount: 0,
  };
}

function errorStatus(error: AdapterError): ReviewerStatus {
  switch (error.kind) {
    case 'timed_out': return 'TIMED_OUT';
    case 'quota_limited': return 'RATE_LIMITED';
    case 'auth_unavailable': return 'AUTH_FAILED';
    case 'context_limited': return 'CONTEXT_LIMITED';
    case 'unavailable': return 'UNAVAILABLE';
    case 'cancelled': return 'CANCELLED';
    case 'invalid_response': return 'INVALID_RESPONSE';
    case 'transport': return 'FAILED';
  }
}

function normalizeResponse(
  slot: ReviewSlot,
  response: AgentResponse,
  snapshot: SnapshotIdentity,
  evidence: SnapshotEvidenceIndex,
  canaryToken: string,
  maxCostUnits: number,
): ReviewerResult {
  const body = isRecord(response.structuredResult) ? response.structuredResult : null;
  const responseSnapshot = asSnapshot(body?.['snapshot']);
  const rawFindings = body?.['findings'];
  const findings = Array.isArray(rawFindings) && rawFindings.every(isRecord) ? rawFindings as unknown as ReviewerFinding[] : null;
  const validCost = Number.isFinite(response.usage.costUnits) && response.usage.costUnits >= 0 && response.usage.costUnits <= maxCostUnits;
  if (
    responseSnapshot === null || findings === null || echoesCanary(body, canaryToken) || !validCost
  ) {
    return {
      ...emptyResult(slot, snapshot, 'INVALID_RESPONSE'),
      modelVersion: response.adapterMeta.modelVersion,
      usage: { costUnits: validCost ? response.usage.costUnits : maxCostUnits },
      transcriptRef: transcriptRef(response.rawTranscriptRef),
      actionRequests: response.actionRequests,
      toolUseCount: response.adapterMeta.toolUseCount,
    };
  }
  return normalizeReviewerResult({
    requestId: slot.requestId,
    adapterId: response.adapterMeta.adapterId,
    modelVersion: response.adapterMeta.modelVersion,
    snapshot: responseSnapshot,
    status: 'SUCCEEDED',
    findings,
    usage: { costUnits: response.usage.costUnits },
    transcriptRef: transcriptRef(response.rawTranscriptRef),
    actionRequests: response.actionRequests,
    toolUseCount: response.adapterMeta.toolUseCount,
  }, snapshot, evidence);
}

/** Dispatches all slots together; one provider failure never hides peer results. */
export async function runBlindReviewPanel(input: BlindPanelInput): Promise<ReviewerResult[]> {
  return Promise.all(input.slots.map(async (slot) => {
    const manifest = slot.adapter.manifest();
    if (!slot.reasoningOnlyConformant || manifest.toolCalling || manifest.executionBackend) {
      return emptyResult(slot, input.snapshot, 'UNAVAILABLE');
    }
    const request: AgentRequest = {
      ...input.request,
      requestId: slot.requestId,
      agentRole: 'reviewer',
      outputSchema: REVIEWER_OUTPUT_SCHEMA,
      toolDefs: [],
    };
    let abortedAt: number | null = input.control.signal.aborted ? performance.now() : null;
    const markAbort = (): void => { abortedAt ??= performance.now(); };
    input.control.signal.addEventListener('abort', markAbort, { once: true });
    try {
      const response = await slot.adapter.send(request, input.control);
      return normalizeResponse(
        slot,
        response,
        input.snapshot,
        input.evidence,
        input.request.contextBundle.canaryToken,
        input.request.budget.costUnits,
      );
    } catch (error) {
      const typed = error instanceof AdapterError ? error : new AdapterError('transport', String(error));
      const result = emptyResult(slot, input.snapshot, errorStatus(typed));
      return typed.kind === 'cancelled' && abortedAt !== null
        ? { ...result, cancellationLatencyMs: Math.max(0, performance.now() - abortedAt) }
        : result;
    } finally {
      input.control.signal.removeEventListener('abort', markAbort);
    }
  }));
}

export interface EvidenceJudgeInput {
  adapter: AdapterInterface;
  requestId: string;
  reasoningOnlyConformant: boolean;
  snapshot: SnapshotIdentity;
  reviewerResults: readonly ReviewerResult[];
  evidenceContext: AgentRequest['contextBundle'];
  manifestRef: string;
  budget: AgentRequest['budget'];
  control: AgentCallControl;
  putEvidence(content: string): Sha256Ref;
}

export interface EvidenceJudgeOutcome {
  status: ReviewerStatus;
  result: JudgeResult | null;
  costUnits: number;
  sourceFindingIds: ReadonlySet<string>;
  evidenceRefs: ReadonlySet<Sha256Ref>;
}

function judgeCandidates(results: readonly ReviewerResult[]): {
  candidates: unknown[];
  sourceFindingIds: Set<string>;
  evidenceRefs: Set<Sha256Ref>;
} {
  const sourceFindingIds = new Set<string>();
  const evidenceRefs = new Set<Sha256Ref>();
  const candidates = results.map((result, index) => ({
    label: `C${index}`,
    findings: result.status === 'SUCCEEDED' ? result.findings.map((finding) => {
      const id = `C${index}:${finding.id}`;
      sourceFindingIds.add(id);
      for (const citation of finding.evidence) evidenceRefs.add(citation.excerptHash);
      return { ...finding, id };
    }) : [],
  }));
  return { candidates, sourceFindingIds, evidenceRefs };
}

function parseJudgedFindings(value: unknown, putEvidence: (content: string) => Sha256Ref, evidenceRefs: Set<Sha256Ref>): JudgedFinding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: JudgedFinding[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['rationale'] !== 'string' || entry.rationale.trim() === '') return null;
    const rationaleRef = putEvidence(entry.rationale);
    evidenceRefs.add(rationaleRef);
    findings.push({
      canonicalFindingKey: entry['canonicalFindingKey'] as string,
      sourceFindingIds: entry['sourceFindingIds'] as string[],
      classification: entry['classification'] as JudgedFinding['classification'],
      severity: entry['severity'] as JudgedFinding['severity'],
      evidenceRefs: entry['evidenceRefs'] as Sha256Ref[],
      rationaleRef,
    });
  }
  return findings;
}

export async function runEvidenceJudge(input: EvidenceJudgeInput): Promise<EvidenceJudgeOutcome> {
  const { candidates, sourceFindingIds, evidenceRefs } = judgeCandidates(input.reviewerResults);
  const unavailable = (): EvidenceJudgeOutcome => ({ status: 'UNAVAILABLE', result: null, costUnits: 0, sourceFindingIds, evidenceRefs });
  const manifest = input.adapter.manifest();
  if (!input.reasoningOnlyConformant || manifest.toolCalling || manifest.executionBackend) return unavailable();

  const candidateContent = JSON.stringify({ snapshot: input.snapshot, candidates });
  const contextBundle = {
    ...input.evidenceContext,
    pieces: [...input.evidenceContext.pieces, {
      id: 'pr-gate-judge-candidates',
      kind: 'feedback' as const,
      content: candidateContent,
      reason: 'anonymous validated reviewer candidates',
    }],
    stats: {
      bytes: input.evidenceContext.stats.bytes + Buffer.byteLength(candidateContent),
      pieceCount: input.evidenceContext.stats.pieceCount + 1,
    },
  };
  const request: AgentRequest = {
    requestId: input.requestId,
    agentRole: 'reviewer',
    taskContract: {
      goalId: 'universal-pr-quality-gate',
      title: 'Evidence Judge',
      objective: 'Classify anonymous findings using cited immutable evidence. Keep distinct defects separate.',
      acceptanceCriteria: [],
    },
    contextBundle,
    manifestRef: input.manifestRef,
    outputSchema: JUDGE_OUTPUT_SCHEMA,
    toolDefs: [],
    budget: input.budget,
  };

  let response: AgentResponse;
  try {
    response = await input.adapter.send(request, input.control);
  } catch (error) {
    const typed = error instanceof AdapterError ? error : new AdapterError('transport', String(error));
    return { status: errorStatus(typed), result: null, costUnits: 0, sourceFindingIds, evidenceRefs };
  }
  const body = isRecord(response.structuredResult) ? response.structuredResult : null;
  const validCost = Number.isFinite(response.usage.costUnits) && response.usage.costUnits >= 0 && response.usage.costUnits <= input.budget.costUnits;
  const responseSnapshot = asSnapshot(body?.['snapshot']);
  if (body === null || echoesCanary(body, input.evidenceContext.canaryToken) || !validCost) {
    return {
      status: 'INVALID_RESPONSE', result: null,
      costUnits: validCost ? response.usage.costUnits : input.budget.costUnits,
      sourceFindingIds, evidenceRefs,
    };
  }
  const findings = parseJudgedFindings(body?.['findings'], input.putEvidence, evidenceRefs);
  if (responseSnapshot === null || findings === null) {
    return { status: 'INVALID_RESPONSE', result: null, costUnits: response.usage.costUnits, sourceFindingIds, evidenceRefs };
  }
  const result: JudgeResult = {
    snapshot: responseSnapshot,
    findings,
    actionRequests: response.actionRequests,
    toolUseCount: response.adapterMeta.toolUseCount,
  };
  const verdict = validateJudgeResult(result, input.snapshot, sourceFindingIds, evidenceRefs);
  return verdict.ok
    ? { status: 'SUCCEEDED', result: { ...result, findings: verdict.findings }, costUnits: response.usage.costUnits, sourceFindingIds, evidenceRefs }
    : { status: 'INVALID_RESPONSE', result: null, costUnits: response.usage.costUnits, sourceFindingIds, evidenceRefs };
}
