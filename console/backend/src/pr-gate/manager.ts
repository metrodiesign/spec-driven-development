import { createHash } from 'node:crypto';

import {
  applyUsage,
  assertDeterministicReportMatchesPlan,
  classifyReviewerCoverage,
  decideQuality,
  mergeEffectivePolicy,
  transitionPrGateState,
  type AnalysisPlan,
  type ConsensusSummary,
  type DeterministicReport,
  type EffectivePolicy,
  type EventLog,
  type HumanOverride,
  type JudgeResult,
  type JudgedFinding,
  type PinnedChangeSet,
  type PolicyLayer,
  type PrGateRunState,
  type PullRequestDescriptor,
  type QualityDecision,
  type QualityDecisionReport,
  type RepositoryId,
  type ReviewerResult,
  type ReviewerStatus,
  type Sha256Ref,
  type SnapshotManifest,
  type UsageProjection,
} from 'core';

import type { PrGateArtifactSession } from './artifacts.ts';

const TERMINAL = new Set<PrGateRunState>([
  'COMPLETED',
  'CANCELLED_STALE',
  'CANCELLED',
  'FAILED_INFRASTRUCTURE',
  'REPORTING_FAILED',
  'FAILED_INTERNAL',
]);

export interface PullRequestReadPort {
  getPullRequest(repository: RepositoryId, number: number): Promise<PullRequestDescriptor>;
  getCurrentHead(repository: RepositoryId, number: number): Promise<string>;
}

export interface GitObjectReadPort {
  pin(descriptor: PullRequestDescriptor, signal?: AbortSignal): Promise<PinnedChangeSet>;
}

export interface PrGatePolicyPort {
  load(change: PinnedChangeSet, signal: AbortSignal): Promise<PolicyLayer>;
}

export interface PrGateClassificationPort {
  classify(change: PinnedChangeSet, policy: EffectivePolicy, signal: AbortSignal): Promise<AnalysisPlan>;
}

export interface PrGateSnapshotPort {
  materialize(change: PinnedChangeSet, policy: EffectivePolicy, signal: AbortSignal): Promise<{
    manifest: SnapshotManifest;
    worktreeDir?: string;
    inputRoots?: string[];
  }>;
}

export interface PrGateChecksPort {
  run(plan: AnalysisPlan, manifest: SnapshotManifest, worktreeDir: string | undefined, signal: AbortSignal, inputRoots?: readonly string[]): Promise<DeterministicReport>;
}

export interface ReviewerPanelPort {
  review(input: {
    plan: AnalysisPlan;
    manifest: SnapshotManifest;
    contextRef: Sha256Ref;
    policy: EffectivePolicy;
    remainingCostUnits: number;
    signal: AbortSignal;
  }): Promise<ReviewerResult[]>;
}

export interface EvidenceJudgePort {
  judge(input: {
    snapshot: SnapshotManifest['identity'];
    reviewerResults: readonly ReviewerResult[];
    policy: EffectivePolicy;
    remainingCostUnits: number;
    signal: AbortSignal;
  }): Promise<{
    status: ReviewerStatus;
    requestId: string;
    costUnits: number;
    result: JudgeResult | null;
  }>;
}

export interface GitHubReportPort {
  start(descriptor: PullRequestDescriptor, runId: string): Promise<string>;
  cancel(checkRunId: string, descriptor: PullRequestDescriptor, reason: string): Promise<void>;
  complete(
    checkRunId: string,
    descriptor: PullRequestDescriptor,
    report: QualityDecisionReport,
    options?: { effectiveDecision?: QualityDecision; override?: HumanOverride },
  ): Promise<void>;
}

export interface PrGateProjection {
  runId: string;
  repository: RepositoryId | null;
  pullRequest: number | null;
  headSha: string | null;
  state: PrGateRunState;
  systemDecision: QualityDecision | null;
  effectiveDecision: QualityDecision | null;
  reportRef: Sha256Ref | null;
  checkRunId: string | null;
  publication: 'NOT_STARTED' | 'IN_PROGRESS' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';
  reviewerStatuses: Array<{ adapterId: string; status: ReviewerStatus; resultRef: Sha256Ref }>;
  overrideRefs: Sha256Ref[];
  updatedAt: string | null;
}

export interface PrGateRunDetail extends PrGateProjection {
  systemReport: QualityDecisionReport | null;
  deterministicReport: DeterministicReport | null;
  judgedFindings: JudgedFinding[];
  overrideHistory: HumanOverride[];
}

export interface PrGateManager {
  start(input: { repository: RepositoryId; pullRequest: number }): { runId: string; completion: Promise<PrGateProjection> };
  run(input: { repository: RepositoryId; pullRequest: number }): Promise<PrGateProjection>;
  runVerified(input: {
    change: PinnedChangeSet;
    plan: AnalysisPlan;
    manifest: SnapshotManifest;
    deterministic: DeterministicReport;
  }): Promise<PrGateProjection>;
  cancel(runId: string): Promise<PrGateProjection | null>;
  list(limit?: number): PrGateProjection[];
  detail(runId: string): PrGateRunDetail | null;
  headStatus(runId: string): Promise<{
    reviewedHeadSha: string;
    currentHeadSha: string;
    stale: boolean;
    publication: PrGateProjection['publication'];
  } | null>;
  override(input: {
    runId: string;
    actor: string;
    idempotencyKey: string;
    headSha: string;
    action: 'APPROVE' | 'REJECT';
    reason: string;
    findingIds: string[];
  }): Promise<HumanOverride>;
  recoverInterrupted(): PrGateProjection[];
}

export interface PrGateManagerDeps {
  log: EventLog;
  organizationPolicy: EffectivePolicy;
  read: PullRequestReadPort;
  git: GitObjectReadPort;
  policy: PrGatePolicyPort;
  classification: PrGateClassificationPort;
  snapshot: PrGateSnapshotPort;
  checks: PrGateChecksPort;
  reviewers: ReviewerPanelPort;
  judge: EvidenceJudgePort;
  reporter?: GitHubReportPort;
  artifacts(runId: string, recovering: boolean): PrGateArtifactSession;
  now?: () => number;
  nextRunId?: () => string;
  nextOverrideId?: () => string;
}

interface ActiveRun {
  controller: AbortController;
  operatorCancelled: boolean;
  deadlineExpired: boolean;
  completion: Promise<PrGateProjection>;
}

class StaleRunError extends Error {
  readonly currentHead: string;

  constructor(currentHead: string) {
    super(`PR head changed to ${currentHead}`);
    this.currentHead = currentHead;
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectionFromEvents(runId: string, log: EventLog): PrGateProjection | null {
  const events = log.all().filter((event) => event.runId === runId && event.type.startsWith('PR_'));
  if (events.length === 0) return null;
  const projection: PrGateProjection = {
    runId,
    repository: null,
    pullRequest: null,
    headSha: null,
    state: 'QUEUED',
    systemDecision: null,
    effectiveDecision: null,
    reportRef: null,
    checkRunId: null,
    publication: 'NOT_STARTED',
    reviewerStatuses: [],
    overrideRefs: [],
    updatedAt: null,
  };
  for (const event of events) {
    projection.updatedAt = event.ts;
    if (event.type === 'PR_GATE_STATE') {
      projection.state = event.payload['state'] as PrGateRunState;
      if (typeof event.payload['repository'] === 'string') projection.repository = event.payload['repository'] as RepositoryId;
      if (Number.isInteger(event.payload['pullRequest'])) projection.pullRequest = Number(event.payload['pullRequest']);
    }
    if (event.type === 'PR_SOURCE_PINNED') {
      projection.headSha = typeof event.payload['headSha'] === 'string' ? event.payload['headSha'] : projection.headSha;
      if (typeof event.payload['checkRunId'] === 'string') {
        projection.checkRunId = event.payload['checkRunId'];
        projection.publication = 'IN_PROGRESS';
      }
    }
    if (event.type === 'PR_REVIEW_RESULT') {
      projection.reviewerStatuses.push({
        adapterId: String(event.payload['adapterId']),
        status: event.payload['status'] as ReviewerStatus,
        resultRef: event.payload['resultRef'] as Sha256Ref,
      });
    }
    if (event.type === 'PR_GATE_DECIDED') {
      projection.systemDecision = event.payload['decision'] as QualityDecision;
      projection.effectiveDecision = projection.systemDecision;
      if (typeof event.payload['reportRef'] === 'string') projection.reportRef = event.payload['reportRef'] as Sha256Ref;
    }
    if (event.type === 'PR_HUMAN_DECISION') {
      projection.effectiveDecision = event.payload['action'] === 'APPROVE' ? 'PASS' : 'FAIL';
      projection.overrideRefs.push(event.payload['overrideRef'] as Sha256Ref);
    }
    if (event.type === 'PR_GATE_REPORTED') {
      projection.publication = event.payload['status'] === 'FAILED' ? 'FAILED' : 'PUBLISHED';
    }
    if (event.type === 'PR_RUN_CANCELLED') projection.publication = 'CANCELLED';
    if (projection.state === 'REPORTING_FAILED') projection.publication = 'FAILED';
  }
  return projection;
}

function sameIdentity(left: SnapshotManifest['identity'], right: SnapshotManifest['identity']): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function consensus(reviewers: readonly ReviewerResult[], findings: readonly JudgedFinding[]): ConsensusSummary {
  const { coverage, available } = classifyReviewerCoverage(reviewers);
  const findingsByClass: ConsensusSummary['findingsByClass'] = {
    VERIFIED: 0,
    PARTIALLY_VERIFIED: 0,
    UNVERIFIED: 0,
    FALSE_POSITIVE: 0,
  };
  const uniqueDiscoveriesByReviewer: Record<string, number> = {};
  for (const finding of findings) {
    findingsByClass[finding.classification] += 1;
    if (finding.sourceFindingIds.length === 1) {
      const reviewer = finding.sourceFindingIds[0]?.split(':', 1)[0] ?? 'unknown';
      uniqueDiscoveriesByReviewer[reviewer] = (uniqueDiscoveriesByReviewer[reviewer] ?? 0) + 1;
    }
  }
  return {
    reviewerCoverage: coverage,
    availableReviewers: available,
    findingsByClass,
    uniqueDiscoveriesByReviewer,
    dissentRefs: [],
  };
}

export function createPrGateManager(deps: PrGateManagerDeps): PrGateManager {
  const now = deps.now ?? Date.now;
  let runCounter = 0;
  let overrideCounter = 0;
  const nextRunId = deps.nextRunId ?? (() => `prg-${now()}-${++runCounter}`);
  const nextOverrideId = deps.nextOverrideId ?? (() => `pro-${now()}-${++overrideCounter}`);
  const active = new Map<string, ActiveRun>();

  const appendState = (runId: string, current: PrGateRunState, next: PrGateRunState, decision?: QualityDecision): PrGateRunState => {
    const transition = transitionPrGateState(current, next, decision);
    if (!transition.ok) throw new Error(`invalid PR gate transition ${current} -> ${next}`);
    deps.log.append({ runId, taskId: null, type: 'PR_GATE_STATE', payload: { state: next } });
    return next;
  };

  const assertCurrentHead = async (descriptor: PullRequestDescriptor): Promise<void> => {
    const current = await deps.read.getCurrentHead(descriptor.repository, descriptor.number);
    if (current !== descriptor.headSha) throw new StaleRunError(current);
  };

  async function execute(
    runId: string,
    input: { repository: RepositoryId; pullRequest: number; expectedHeadSha?: string },
    activeRun: ActiveRun,
    verified?: { change: PinnedChangeSet; plan: AnalysisPlan; manifest: SnapshotManifest; deterministic: DeterministicReport },
  ): Promise<PrGateProjection> {
    let state: PrGateRunState = 'QUEUED';
    let descriptor: PullRequestDescriptor | undefined;
    let checkRunId: string | undefined;
    let deterministic: DeterministicReport | undefined;
    let manifest: SnapshotManifest | undefined;
    let plan: AnalysisPlan | undefined;
    let systemDecision: QualityDecision | undefined;
    const artifact = deps.artifacts(runId, false);
    const deadlineMs = Math.min(deps.organizationPolicy.runDeadlineMs, 1_800_000);
    const deadline = setTimeout(() => {
      activeRun.deadlineExpired = true;
      activeRun.controller.abort(new Error(`PR gate deadline exceeded after ${deadlineMs}ms`));
    }, deadlineMs);

    const terminal = (next: Extract<PrGateRunState, 'CANCELLED_STALE' | 'CANCELLED' | 'FAILED_INFRASTRUCTURE' | 'FAILED_INTERNAL'>): void => {
      if (!TERMINAL.has(state)) state = appendState(runId, state, next);
    };

    try {
      state = appendState(runId, state, 'ACQUIRING');
      descriptor = verified?.change.descriptor ?? await deps.read.getPullRequest(input.repository, input.pullRequest);
      if (descriptor.repository !== input.repository || descriptor.number !== input.pullRequest) throw new Error('pull request identity mismatch');
      if (input.expectedHeadSha !== undefined && descriptor.headSha !== input.expectedHeadSha) {
        throw new Error(`replacement run expected head ${input.expectedHeadSha} but acquired ${descriptor.headSha}`);
      }
      const change = verified?.change ?? await deps.git.pin(descriptor, activeRun.controller.signal);
      const repositoryPolicy = await deps.policy.load(change, activeRun.controller.signal);
      const policy = mergeEffectivePolicy(deps.organizationPolicy, repositoryPolicy);
      const sourceRef = artifact.put('pinned-change-set', change);
      if (deps.reporter !== undefined) checkRunId = await deps.reporter.start(descriptor, runId);
      deps.log.append({
        runId,
        taskId: null,
        type: 'PR_SOURCE_PINNED',
        payload: {
          sourceRef,
          repository: descriptor.repository,
          pullRequest: descriptor.number,
          baseSha: descriptor.baseSha,
          headSha: descriptor.headSha,
          mergeBaseSha: change.mergeBaseSha,
          diffRef: change.diffRef,
          policyRef: change.trustedRepositoryPolicyRef,
          ...(checkRunId === undefined ? {} : { checkRunId }),
        },
      });
      await assertCurrentHead(descriptor);

      state = appendState(runId, state, 'CLASSIFYING');
      plan = verified?.plan ?? await deps.classification.classify(change, policy, activeRun.controller.signal);
      if (
        plan.snapshot.repository !== descriptor.repository ||
        plan.snapshot.pullRequest !== descriptor.number ||
        plan.snapshot.headSha !== descriptor.headSha ||
        plan.snapshot.policyRef !== change.trustedRepositoryPolicyRef
      ) throw new Error('classification identity mismatch');
      const planRef = artifact.put('analysis-plan', plan);
      deps.log.append({
        runId,
        taskId: null,
        type: 'PR_CLASSIFIED',
        payload: {
          planRef,
          risk: plan.analysis.risk.level,
          coverage: plan.analysis.coverage,
          technologies: plan.analysis.technologies,
          categories: plan.analysis.categories,
          profiles: plan.profiles.map((profile) => profile.id),
        },
      });

      state = appendState(runId, state, 'SNAPSHOT_ATTESTING');
      const materialized = verified === undefined
        ? await deps.snapshot.materialize(change, policy, activeRun.controller.signal)
        : { manifest: verified.manifest, worktreeDir: undefined, inputRoots: undefined };
      manifest = materialized.manifest;
      if (!sameIdentity(manifest.identity, plan.snapshot)) throw new Error('snapshot identity mismatch');
      const manifestRef = artifact.put('snapshot-manifest', manifest);
      deps.log.append({ runId, taskId: null, type: 'PR_SNAPSHOT_ATTESTED', payload: { manifestRef, worktreeRef: manifest.worktreeRef } });
      await assertCurrentHead(descriptor);

      state = appendState(runId, state, 'CHECKING');
      deterministic = verified?.deterministic ?? await deps.checks.run(
        plan,
        manifest,
        materialized.worktreeDir,
        activeRun.controller.signal,
        materialized.inputRoots,
      );
      if (!sameIdentity(deterministic.snapshot, manifest.identity)) throw new Error('deterministic report identity mismatch');
      assertDeterministicReportMatchesPlan(plan.checks, deterministic);
      const deterministicRef = artifact.put('deterministic-report', deterministic);
      deps.log.append({ runId, taskId: null, type: 'PR_CHECK_RESULT', payload: { reportRef: deterministicRef, integrityRef: deterministic.reportRef } });

      state = appendState(runId, state, 'REVIEWING');
      await assertCurrentHead(descriptor);
      const rawReviewers = policy.maxCostUnits === 0
        ? []
        : await deps.reviewers.review({
            plan,
            manifest,
            contextRef: manifestRef,
            policy,
            remainingCostUnits: policy.maxCostUnits,
            signal: activeRun.controller.signal,
          });
      let usage: UsageProjection = { runId, headSha: descriptor.headSha, costUnits: 0, requestCosts: {} };
      const reviewers: ReviewerResult[] = [];
      for (const result of rawReviewers) {
        const applied = applyUsage(usage, {
          runId,
          headSha: descriptor.headSha,
          requestId: result.requestId,
          costUnits: result.usage.costUnits,
        });
        const accepted = applied.ok && !applied.replay && applied.projection.costUnits <= policy.maxCostUnits;
        let reservedCost = 0;
        if (!accepted && (!applied.ok || !applied.replay)) {
          reservedCost = Math.max(0, policy.maxCostUnits - usage.costUnits);
          const reserved = applyUsage(usage, {
            runId,
            headSha: descriptor.headSha,
            requestId: result.requestId,
            costUnits: reservedCost,
          });
          if (reserved.ok && !reserved.replay) usage = reserved.projection;
        }
        const normalized = accepted
          ? result
          : { ...result, status: 'INVALID_RESPONSE' as const, findings: [], usage: { costUnits: reservedCost } };
        if (accepted) usage = applied.projection;
        reviewers.push(normalized);
        const resultRef = artifact.put('reviewer-result', normalized);
        deps.log.append({
          runId,
          taskId: null,
          type: 'PR_REVIEW_RESULT',
          payload: {
            resultRef,
            requestIdHash: sha(normalized.requestId),
            adapterId: normalized.adapterId,
            modelVersion: normalized.modelVersion,
            status: normalized.status,
            costUnits: normalized.usage.costUnits,
            ...(normalized.cancellationLatencyMs === undefined ? {} : { cancellationLatencyMs: normalized.cancellationLatencyMs }),
          },
        });
      }

      if (activeRun.operatorCancelled) throw activeRun.controller.signal.reason;
      state = appendState(runId, state, 'JUDGING');
      let judgeAvailable = false;
      let judgedFindings: JudgedFinding[] = [];
      if (!activeRun.deadlineExpired && usage.costUnits < policy.maxCostUnits) {
        const judged = await deps.judge.judge({
          snapshot: manifest.identity,
          reviewerResults: reviewers,
          policy,
          remainingCostUnits: policy.maxCostUnits - usage.costUnits,
          signal: activeRun.controller.signal,
        });
        const applied = applyUsage(usage, {
          runId,
          headSha: descriptor.headSha,
          requestId: judged.requestId,
          costUnits: judged.costUnits,
        });
        const withinCap = applied.ok && !applied.replay && applied.projection.costUnits <= policy.maxCostUnits;
        let normalizedJudged = judged;
        if (withinCap) {
          usage = applied.projection;
        } else {
          let reservedCost = 0;
          if (!applied.ok || !applied.replay) {
            reservedCost = Math.max(0, policy.maxCostUnits - usage.costUnits);
            const reserved = applyUsage(usage, {
              runId,
              headSha: descriptor.headSha,
              requestId: judged.requestId,
              costUnits: reservedCost,
            });
            if (reserved.ok && !reserved.replay) usage = reserved.projection;
          }
          normalizedJudged = { ...judged, status: 'INVALID_RESPONSE', costUnits: reservedCost, result: null };
        }
        judgeAvailable = judged.status === 'SUCCEEDED' && judged.result !== null && withinCap;
        judgedFindings = judgeAvailable ? judged.result!.findings : [];
        const judgeRef = artifact.put('judge-result', normalizedJudged);
        deps.log.append({ runId, taskId: null, type: 'PR_JUDGE_RESULT', payload: { judgeRef, status: normalizedJudged.status, costUnits: normalizedJudged.costUnits } });
      } else {
        const judgeRef = artifact.put('judge-result', { status: activeRun.deadlineExpired ? 'TIMED_OUT' : 'CANCELLED', result: null });
        deps.log.append({ runId, taskId: null, type: 'PR_JUDGE_RESULT', payload: { judgeRef, status: activeRun.deadlineExpired ? 'TIMED_OUT' : 'CANCELLED', costUnits: 0 } });
      }

      state = appendState(runId, state, 'DECIDING');
      if (!activeRun.deadlineExpired) await assertCurrentHead(descriptor);
      const decision = decideQuality({
        deterministic,
        risk: plan.analysis.risk.level,
        analysisCoverage: plan.analysis.coverage,
        reviewerResults: reviewers,
        judgedFindings,
        judgeAvailable,
        requireHumanApproval: policy.requireHumanApproval,
        blockingSeverity: policy.blockingSeverity,
      });
      systemDecision = activeRun.deadlineExpired && decision.decision !== 'FAIL' ? 'INFRASTRUCTURE_FAILURE' : decision.decision;
      const consensusValue = consensus(reviewers, judgedFindings);
      const consensusRef = artifact.put('consensus', consensusValue);
      const judgedFindingRefs = judgedFindings.map((finding) => artifact.put('judged-finding', finding));
      const reportPayload: Omit<QualityDecisionReport, 'reportRef'> = {
        runId,
        snapshot: manifest.identity,
        decision: systemDecision,
        reasons: activeRun.deadlineExpired ? [...new Set([...decision.reasons, 'run_deadline_exceeded'])] : decision.reasons,
        profiles: plan.profiles.map((profile) => profile.id),
        risk: plan.analysis.risk.level,
        analysisCoverage: plan.analysis.coverage,
        reviewerCoverage: consensusValue.reviewerCoverage,
        deterministicReportRef: deterministicRef,
        judgedFindingRefs,
        consensusRef,
        policyRef: manifest.identity.policyRef,
        costUnits: usage.costUnits,
        durationMs: Math.max(0, now() - Date.parse(manifest.createdAt)),
      };
      const reportRef = artifact.put('quality-decision-report', reportPayload);
      const report: QualityDecisionReport = { ...reportPayload, reportRef };
      deps.log.append({ runId, taskId: null, type: 'PR_GATE_DECIDED', payload: { reportRef, decision: systemDecision, costUnits: usage.costUnits } });

      state = appendState(runId, state, 'REPORTING', systemDecision);
      await assertCurrentHead(descriptor);
      try {
        if (deps.reporter !== undefined && checkRunId !== undefined) await deps.reporter.complete(checkRunId, descriptor, report);
      } catch (error) {
        state = appendState(runId, state, 'REPORTING_FAILED', systemDecision);
        deps.log.append({ runId, taskId: null, type: 'PR_GATE_REPORTED', payload: { status: 'FAILED', reportRef, errorRef: artifact.put('reporting-error', { message: String(error) }) } });
        return projectionFromEvents(runId, deps.log)!;
      }
      if (deps.reporter !== undefined && checkRunId !== undefined) {
        deps.log.append({ runId, taskId: null, type: 'PR_GATE_REPORTED', payload: { status: 'PUBLISHED', reportRef, checkRunId } });
      }
      state = systemDecision === 'HUMAN_REVIEW_REQUIRED'
        ? appendState(runId, state, 'AWAITING_HUMAN', systemDecision)
        : appendState(runId, state, 'COMPLETED', systemDecision);
      return projectionFromEvents(runId, deps.log)!;
    } catch (error) {
      if (error instanceof StaleRunError) {
        activeRun.controller.abort(error);
        if (deps.reporter !== undefined && descriptor !== undefined && checkRunId !== undefined) {
          await deps.reporter.cancel(checkRunId, descriptor, 'head SHA changed').catch(() => {});
        }
        terminal('CANCELLED_STALE');
        deps.log.append({ runId, taskId: null, type: 'PR_RUN_CANCELLED', payload: { reason: 'stale_head', currentHead: error.currentHead } });
        if (descriptor !== undefined) {
          if (verified === undefined) {
            const replacement = begin({
              repository: descriptor.repository,
              pullRequest: descriptor.number,
              expectedHeadSha: error.currentHead,
            });
            deps.log.append({
              runId,
              taskId: null,
              type: 'PR_REPLACEMENT_ENQUEUED',
              payload: { replacementRunId: replacement.runId, currentHead: error.currentHead, mode: 'internal' },
            });
          } else {
            deps.log.append({
              runId,
              taskId: null,
              type: 'PR_REPLACEMENT_ENQUEUED',
              payload: { currentHead: error.currentHead, mode: 'pull_request_synchronize' },
            });
          }
        }
      } else if (activeRun.operatorCancelled) {
        if (deps.reporter !== undefined && descriptor !== undefined && checkRunId !== undefined) {
          await deps.reporter.cancel(checkRunId, descriptor, 'operator cancelled').catch(() => {});
        }
        terminal('CANCELLED');
        deps.log.append({ runId, taskId: null, type: 'PR_RUN_CANCELLED', payload: { reason: 'operator' } });
      } else {
        const deterministicBlocker = deterministic?.checks.some((check) => check.required && (check.status === 'FAILED' || check.status === 'TIMED_OUT')) ?? false;
        systemDecision = deterministicBlocker ? 'FAIL' : 'INFRASTRUCTURE_FAILURE';
        terminal('FAILED_INFRASTRUCTURE');
        const errorRef = artifact.put('run-error', { message: error instanceof Error ? error.message : String(error) });
        deps.log.append({ runId, taskId: null, type: 'PR_GATE_DECIDED', payload: { decision: systemDecision, errorRef } });
        if (deps.reporter !== undefined && descriptor !== undefined && checkRunId !== undefined) {
          await deps.reporter.cancel(checkRunId, descriptor, systemDecision).catch(() => {});
        }
      }
      return projectionFromEvents(runId, deps.log)!;
    } finally {
      clearTimeout(deadline);
      active.delete(runId);
    }
  }

  const begin = (
    input: { repository: RepositoryId; pullRequest: number; expectedHeadSha?: string },
    verified?: { change: PinnedChangeSet; plan: AnalysisPlan; manifest: SnapshotManifest; deterministic: DeterministicReport },
  ): { runId: string; completion: Promise<PrGateProjection> } => {
      if (!/^[^/\s]+\/[^/\s]+$/u.test(input.repository) || !Number.isInteger(input.pullRequest) || input.pullRequest <= 0) {
        throw new Error('invalid repository or pull request number');
      }
      const runId = nextRunId();
      deps.log.append({
        runId,
        taskId: null,
        type: 'PR_GATE_STATE',
        payload: { state: 'QUEUED', repository: input.repository, pullRequest: input.pullRequest },
      });
      const activeRun: ActiveRun = {
        controller: new AbortController(),
        operatorCancelled: false,
        deadlineExpired: false,
        completion: Promise.resolve(null as never),
      };
      activeRun.completion = execute(runId, input, activeRun, verified);
      active.set(runId, activeRun);
      return { runId, completion: activeRun.completion };
  };

  const manager: PrGateManager = {
    start(input) {
      return begin(input);
    },
    run(input) {
      return this.start(input).completion;
    },
    runVerified(input) {
      return begin({ repository: input.change.descriptor.repository, pullRequest: input.change.descriptor.number }, input).completion;
    },
    async cancel(runId) {
      const running = active.get(runId);
      if (running === undefined) return projectionFromEvents(runId, deps.log);
      running.operatorCancelled = true;
      running.controller.abort(new Error('operator cancelled'));
      return running.completion;
    },
    list(limit = 50) {
      const ids = [...new Set(deps.log.all().filter((event) => event.type === 'PR_GATE_STATE').map((event) => event.runId))];
      return ids
        .map((id) => projectionFromEvents(id, deps.log))
        .filter((value): value is PrGateProjection => value !== null)
        .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
        .slice(0, Math.max(1, Math.min(100, limit)));
    },
    detail(runId) {
      const projection = projectionFromEvents(runId, deps.log);
      if (projection === null) return null;
      if (projection.reportRef === null && projection.overrideRefs.length === 0) {
        return { ...projection, systemReport: null, deterministicReport: null, judgedFindings: [], overrideHistory: [] };
      }
      const artifacts = deps.artifacts(runId, true);
      const systemReport = projection.reportRef === null
        ? null
        : { ...artifacts.get<Omit<QualityDecisionReport, 'reportRef'>>(projection.reportRef, 'quality-decision-report'), reportRef: projection.reportRef };
      const deterministicReport = systemReport === null
        ? null
        : artifacts.get<DeterministicReport>(systemReport.deterministicReportRef, 'deterministic-report');
      const judgedFindings = systemReport?.judgedFindingRefs.map((ref) => artifacts.get<JudgedFinding>(ref, 'judged-finding')) ?? [];
      const overrideHistory = projection.overrideRefs.map((ref) => artifacts.get<HumanOverride>(ref, 'human-override'));
      return { ...projection, systemReport, deterministicReport, judgedFindings, overrideHistory };
    },
    async headStatus(runId) {
      const projection = projectionFromEvents(runId, deps.log);
      if (projection === null || projection.repository === null || projection.pullRequest === null || projection.headSha === null) return null;
      const currentHeadSha = await deps.read.getCurrentHead(projection.repository, projection.pullRequest);
      return {
        reviewedHeadSha: projection.headSha,
        currentHeadSha,
        stale: currentHeadSha !== projection.headSha,
        publication: projection.publication,
      };
    },
    async override(input) {
      const projection = projectionFromEvents(input.runId, deps.log);
      if (projection === null || projection.repository === null || projection.pullRequest === null || projection.headSha === null || projection.reportRef === null) {
        throw new Error('run has no durable decision');
      }
      if (!input.idempotencyKey.trim() || !input.actor.trim() || !input.reason.trim()) throw new Error('override identity, key, and reason are required');
      const artifacts = deps.artifacts(input.runId, true);
      const currentHead = await deps.read.getCurrentHead(projection.repository, projection.pullRequest);
      if (input.headSha !== currentHead || input.headSha !== projection.headSha) throw new StaleRunError(currentHead);
      const keyHash = sha(input.idempotencyKey);
      const replay = deps.log.all().find((event) => event.runId === input.runId && event.type === 'PR_HUMAN_DECISION' && event.payload['idempotencyKeyHash'] === keyHash);
      const findingIds = [...new Set(input.findingIds)].sort();
      let record: HumanOverride;
      let overrideRef: Sha256Ref;
      if (replay === undefined) {
        record = {
          overrideId: nextOverrideId(),
          idempotencyKey: input.idempotencyKey,
          runId: input.runId,
          actor: input.actor,
          headSha: input.headSha,
          action: input.action,
          reason: input.reason,
          findingIds,
          createdAt: new Date(now()).toISOString(),
        };
        overrideRef = artifacts.put('human-override', record);
        deps.log.append({
          runId: input.runId,
          taskId: null,
          type: 'PR_HUMAN_DECISION',
          payload: { overrideRef, overrideId: record.overrideId, idempotencyKeyHash: keyHash, action: record.action, headSha: record.headSha },
        });
      } else {
        overrideRef = replay.payload['overrideRef'] as Sha256Ref;
        record = artifacts.get<HumanOverride>(overrideRef, 'human-override');
        if (
          record.idempotencyKey !== input.idempotencyKey || record.actor !== input.actor || record.headSha !== input.headSha ||
          record.action !== input.action || record.reason !== input.reason || JSON.stringify(record.findingIds) !== JSON.stringify(findingIds)
        ) throw new Error('idempotency key reused with different override input');
      }
      const alreadyPublished = deps.log.all().some((event) =>
        event.runId === input.runId && event.type === 'PR_GATE_REPORTED' &&
        event.payload['status'] === 'PUBLISHED' && event.payload['overrideRef'] === overrideRef,
      );
      if (deps.reporter !== undefined && projection.checkRunId !== null && !alreadyPublished) {
        const payload = artifacts.get<Omit<QualityDecisionReport, 'reportRef'>>(projection.reportRef, 'quality-decision-report');
        try {
          await deps.reporter.complete(projection.checkRunId, {
            repository: projection.repository,
            number: projection.pullRequest,
            title: '',
            description: '',
            baseRef: '',
            baseSha: payload.snapshot.baseSha,
            headSha: projection.headSha,
            fromFork: false,
          }, { ...payload, reportRef: projection.reportRef }, { effectiveDecision: record.action === 'APPROVE' ? 'PASS' : 'FAIL', override: record });
          deps.log.append({ runId: input.runId, taskId: null, type: 'PR_GATE_REPORTED', payload: { status: 'PUBLISHED', reportRef: projection.reportRef, overrideRef } });
        } catch (error) {
          deps.log.append({
            runId: input.runId,
            taskId: null,
            type: 'PR_GATE_REPORTED',
            payload: { status: 'FAILED', reportRef: projection.reportRef, overrideRef, errorRef: artifacts.put('reporting-error', { message: String(error) }) },
          });
          throw error;
        }
      }
      const latest = projectionFromEvents(input.runId, deps.log)!;
      if (latest.state === 'AWAITING_HUMAN') {
        const reporting = appendState(input.runId, latest.state, 'REPORTING');
        appendState(input.runId, reporting, 'COMPLETED', record.action === 'APPROVE' ? 'PASS' : 'FAIL');
      }
      return record;
    },
    recoverInterrupted() {
      const recovered: PrGateProjection[] = [];
      for (const projection of this.list(100)) {
        if (TERMINAL.has(projection.state) || projection.state === 'AWAITING_HUMAN') continue;
        deps.log.append({ runId: projection.runId, taskId: null, type: 'PR_GATE_STATE', payload: { state: 'FAILED_INFRASTRUCTURE' } });
        deps.log.append({ runId: projection.runId, taskId: null, type: 'PR_GATE_DECIDED', payload: { decision: 'INFRASTRUCTURE_FAILURE', reason: 'process_restart' } });
        recovered.push(projectionFromEvents(projection.runId, deps.log)!);
      }
      return recovered;
    },
  };
  return manager;
}
