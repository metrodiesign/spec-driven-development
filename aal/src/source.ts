// AALProposalSource (§7.1, REQ-5) — the Ring-1 implementation of core's
// ProposalSource port (INV-8: core's port/orchestrator are unchanged). Each
// round it builds context (core/context), records a PROPOSAL_INTENT before the
// adapter call so crash-replay reuses the requestId (P8), routes to an eligible
// adapter, drives the bounded repair loop, enforces action-path provenance
// (context_violation), and records CONTEXT_BUILT with recall/waste counters.

import { buildContext, computeContextMetrics } from 'core';
import { SecretInContextError } from 'core';
import { proposeWithRepair } from './repair.ts';
import { NoCapacityError, type Router } from './router.ts';
import type { EvidenceStore } from 'core';
import type {
  Action,
  ContextBundle,
  EventLog,
  Proposal,
  ProposalClaim,
  ProposalInput,
  ProposalSource,
  Role,
  TaskContractExcerpt,
} from 'core';

export interface AALSourceDeps {
  runId: string;
  taskId: string;
  role: Role;
  router: Router;
  worktreeDir: string;
  taskContract: TaskContractExcerpt;
  seedPaths: string[];
  evidence: EvidenceStore;
  log: EventLog;
  /** Injectable ids for determinism in tests (requestId + per-request canary). */
  ids: { requestId(): string; canary(): string };
  outputSchema: Record<string, unknown>;
  maxRepairRounds: number;
  excludePath?: (relPath: string) => boolean;
}

function pathOf(a: Action): string | null {
  if (a.type === 'WRITE_FILE' || a.type === 'READ_FILE') return a.path;
  return null;
}

function asClaim(v: unknown): ProposalClaim {
  return v === 'READY_FOR_VERIFICATION' || v === 'BLOCKED' ? v : 'WORKING';
}

export function createAALProposalSource(deps: AALSourceDeps): ProposalSource {
  // Paths the model has legitimately requested via READ_FILE accumulate across
  // rounds and expand the provenance-allowed set (REQ-5.4).
  const readRequested = new Set<string>();

  return {
    async propose(input: ProposalInput): Promise<Proposal> {
      // Build context; a secret in a piece BLOCKS the build (REQ-7.3).
      let bundle: ContextBundle;
      let manifestRef: string;
      try {
        const built = buildContext({
          taskId: deps.taskId,
          taskContract: deps.taskContract,
          worktreeDir: deps.worktreeDir,
          seedPaths: deps.seedPaths,
          canaryToken: deps.ids.canary(),
          evidence: deps.evidence,
          ...(deps.excludePath ? { excludePath: deps.excludePath } : {}),
        });
        bundle = built.bundle;
        manifestRef = built.manifestRef;
      } catch (err) {
        if (err instanceof SecretInContextError) {
          deps.log.append({
            runId: deps.runId,
            taskId: deps.taskId,
            type: 'ESCALATED',
            payload: { why: 'secret_in_context', file: err.file, kind: err.kind },
          });
          return { claim: 'BLOCKED', actions: [], costUnits: 0 };
        }
        throw err;
      }

      // Route; nothing eligible -> BLOCKED(no_capacity), NO retry (REQ-6.2).
      let adapter;
      try {
        adapter = deps.router.route(deps.role);
      } catch (err) {
        if (err instanceof NoCapacityError) {
          deps.log.append({
            runId: deps.runId,
            taskId: deps.taskId,
            type: 'ESCALATED',
            payload: { why: 'no_capacity', role: deps.role },
          });
          return { claim: 'BLOCKED', actions: [], costUnits: 0 };
        }
        throw err;
      }

      // Fold prior-round feedback in as an untrusted-data piece (marked, not free text upstream).
      if (input.feedback !== null) {
        bundle = {
          ...bundle,
          pieces: [
            ...bundle.pieces,
            {
              id: 'feedback',
              kind: 'feedback',
              content: JSON.stringify(input.feedback),
              reason: 'previous-round structured feedback',
            },
          ],
        };
      }

      const requestId = deps.ids.requestId();
      // P8/crash-safety: record intent BEFORE the call so replay reuses the id (REQ-5.2).
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'PROPOSAL_INTENT',
        payload: { requestId, role: deps.role },
      });

      const out = await proposeWithRepair(
        adapter,
        {
          requestId,
          agentRole: deps.role,
          taskContract: deps.taskContract,
          contextBundle: bundle,
          manifestRef,
          outputSchema: deps.outputSchema,
          toolDefs: [],
          budget: { costUnits: 500 },
        },
        deps.maxRepairRounds,
      );
      const costUnits = out.response.usage.costUnits;

      if (!out.valid) {
        // Repair exhausted -> structured invalid_response; the round still counts (REQ-1.5).
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'ERROR',
          payload: { reason: 'invalid_response', errors: out.errors, repairRounds: out.repairRounds },
        });
        return { claim: 'BLOCKED', actions: [], costUnits };
      }

      // Provenance: a WRITE to a path neither in the bundle nor previously READ is
      // rejected as context_violation; the whole result is rejected (REQ-5.4).
      const allowed = new Set<string>([
        ...bundle.pieces.map((p) => p.path).filter((p): p is string => p !== undefined),
        ...readRequested,
      ]);
      const actions = out.response.actionRequests;
      for (const a of actions) if (a.type === 'READ_FILE') readRequested.add(a.path);
      const violations = actions.filter(
        (a) => a.type === 'WRITE_FILE' && !allowed.has(a.path),
      );
      if (violations.length > 0) {
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'ACTION_REJECTED',
          payload: {
            reason: 'context_violation',
            paths: violations.map((a) => pathOf(a)),
            detail: 'action path not in context bundle and never READ_FILE-requested',
          },
        });
        return { claim: 'WORKING', actions: [], costUnits };
      }

      // Recall/waste vs the paths this round proposes to touch (§9.4, REQ-7.6).
      const touched = actions.map(pathOf).filter((p): p is string => p !== null);
      const metrics = computeContextMetrics(bundle, touched);
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'CONTEXT_BUILT',
        payload: { manifestRef, recall: metrics.recall, waste: metrics.waste, requestId },
      });

      const claim = asClaim((out.response.structuredResult as { claim?: unknown }).claim);
      return { claim, actions, costUnits };
    },
  };
}
