// AALProposalSource (§7.1, REQ-5) — the Ring-1 implementation of core's
// ProposalSource port (INV-8: core's port/orchestrator are unchanged). Each
// round it builds context (core/context), refreshes adapter health, records a
// PROPOSAL_INTENT before the adapter call so crash-replay reuses the requestId
// (P8), routes to an eligible adapter, drives the bounded repair loop, and — on
// an AdapterError — records the failure with the breaker and re-routes ONCE to
// the next eligible adapter before a clean BLOCKED(no_capacity) (REQ-3).

import { buildContext, computeContextMetrics, canaryTripped, checkDataPolicy, loadApprovedLessons } from 'core';
import { SecretInContextError } from 'core';
import { breakerKey, type Breaker } from './breaker.ts';
import { AdapterError } from './protocol.ts';
import { proposeWithRepair, type RepairOutcome } from './repair.ts';
import type { RegisteredAdapter } from './registry.ts';
import type { RouteHints, Router } from './router.ts';
import type { EvidenceStore, ProviderDataPolicy } from 'core';
import type {
  Action,
  ContextBundle,
  EventLog,
  Hypothesis,
  LessonRecord,
  Proposal,
  ProposalClaim,
  ProposalInput,
  ProposalSource,
  TaskContractExcerpt,
} from 'core';

export interface AALSourceDeps {
  runId: string;
  taskId: string;
  router: Router;
  /** Records send outcomes per adapter+model key; the router alone never sees the send (REQ-3.1). */
  breaker: Breaker;
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
  /** The task's real remaining budget, sent in AgentRequest.budget (REQ-6.3). */
  budgetRemaining?: () => number;
  /**
   * Provider data policy for the routed adapter (REQ-11.5/11.8). Absent = no check
   * (Phase-1 parity); the composition root builds it from
   * `.ai/policies/provider-data-policy.json`. A violation escalates
   * `data_policy_violation` and sends NOTHING.
   */
  dataPolicyFor?: (adapterId: string) => ProviderDataPolicy | undefined;
  /**
   * Composition-supplied routing hints per round (REQ-5). The composition root
   * builds these from role/lineage and `.ai/policies/routing.json`: the
   * susceptibility cap for low-trust content (REQ-5.6) and the test_designer !=
   * implementer lineage rule (REQ-5.5, a HARD rule — the source never re-routes
   * without the hint, so an empty filtered set is a clean BLOCKED, never a silent
   * relax). Absent → Phase-2 routing, byte-identical (REQ-5.1).
   */
  routeHints?: (input: ProposalInput) => RouteHints;
  /**
   * Approved-lessons injection (REQ-12). Absent -> no lessons pipeline (Phase-1
   * parity, byte-identical). Loaded ONCE at construction — approved lessons are
   * static for the life of a run, and this is also where the REQ-11.3 offline-
   * approval reconciler runs (a lesson_promote approved via the CLI while no run
   * was live has its file moved here, on the next source that loads).
   */
  lessons?: { dir: string; governanceLogPath?: string; maxLessons?: number; maxBytes?: number };
  /**
   * REQ-16.5: the planner-fusion plan the composition resolved BEFORE this source
   * was even constructed (a single pre-loop dispatch, not a per-round lookup —
   * unlike lessons, there is no directory to load from here). Absent -> no
   * planner-fusion trigger fired this run (Phase-3 parity, byte-identical).
   */
  plan?: { id: string; content: string };
}

function pathOf(a: Action): string | null {
  if (a.type === 'WRITE_FILE' || a.type === 'READ_FILE') return a.path;
  return null;
}

function asClaim(v: unknown): ProposalClaim {
  return v === 'READY_FOR_VERIFICATION' || v === 'BLOCKED' ? v : 'WORKING';
}

/**
 * Lift a diagnostician response's `structuredResult.hypotheses` into
 * `Proposal.hypotheses` (REQ-5.1 production). The array is UNTRUSTED — core's
 * hypothesis engine validates each entry's shape and caps probes (REQ-5.7); the
 * source only extracts the array (a non-array yields none).
 */
function asHypotheses(structuredResult: unknown): Hypothesis[] {
  const h = (structuredResult as { hypotheses?: unknown } | null)?.hypotheses;
  return Array.isArray(h) ? (h as Hypothesis[]) : [];
}

const keyOf = (r: RegisteredAdapter): string => breakerKey(r.record.adapterId, r.record.modelVersion);

export function createAALProposalSource(deps: AALSourceDeps): ProposalSource {
  // Paths the model has legitimately requested via READ_FILE accumulate across
  // rounds and expand the provenance-allowed set (REQ-5.4).
  const readRequested = new Set<string>();

  // REQ-12: load once — approved lessons don't change mid-run (also runs the
  // REQ-11.3 offline reconciler exactly once per source construction).
  const approvedLessons: LessonRecord[] = deps.lessons === undefined
    ? []
    : loadApprovedLessons({
        dir: deps.lessons.dir,
        ...(deps.lessons.governanceLogPath !== undefined ? { governanceLogPath: deps.lessons.governanceLogPath } : {}),
        cap: { maxLessons: deps.lessons.maxLessons ?? 5, maxBytes: deps.lessons.maxBytes ?? 8192 },
        log: deps.log,
        runId: deps.runId,
        taskId: deps.taskId,
      });

  return {
    async propose(input: ProposalInput): Promise<Proposal> {
      const role = input.role; // per-call role, not a construction-time bind (REQ-4.1)

      // Build context; a secret in a piece BLOCKS the build (REQ-7.3).
      let bundle: ContextBundle;
      let manifestRef: string;
      let lessonsInjected: { id: string; evidenceRefs: string[] }[] = [];
      let lessonsBlocked: { id: string; kind: string }[] = [];
      let planBlocked = false;
      try {
        const built = buildContext({
          taskId: deps.taskId,
          taskContract: deps.taskContract,
          worktreeDir: deps.worktreeDir,
          seedPaths: deps.seedPaths,
          canaryToken: deps.ids.canary(),
          evidence: deps.evidence,
          ...(deps.excludePath ? { excludePath: deps.excludePath } : {}),
          ...(approvedLessons.length > 0 ? { lessons: approvedLessons } : {}),
          ...(deps.plan !== undefined ? { plan: deps.plan } : {}),
        });
        bundle = built.bundle;
        manifestRef = built.manifestRef;
        lessonsInjected = built.lessonsInjected;
        lessonsBlocked = built.lessonsBlocked;
        planBlocked = built.planBlocked;
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
      // REQ-12.3: a secret-bearing lesson is blocked and recorded, per lesson —
      // never the whole-build abort a repo-file secret triggers above.
      for (const b of lessonsBlocked) {
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'ERROR',
          payload: { reason: 'lesson_secret_blocked', lessonId: b.id, kind: b.kind },
        });
      }
      // REQ-16.5: a secret-bearing plan is blocked per-item, same as a lesson — never
      // the whole-build abort a repo-file secret triggers above.
      if (planBlocked) {
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'ERROR',
          payload: { reason: 'plan_secret_blocked', planId: deps.plan?.id },
        });
      }
      // REQ-12.5: every injection (this round's bundle actually carrying lessons) is recorded.
      if (lessonsInjected.length > 0) {
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'LESSON_INJECTED',
          payload: { ids: lessonsInjected.map((l) => l.id), refs: lessonsInjected.flatMap((l) => l.evidenceRefs) },
        });
      }

      // Refresh adapter health once per round BEFORE routing; emit QUOTA_PROBE on
      // change (labeled estimate — INV-13). Probes are timeout-bounded in the
      // registry, so this await never hangs the loop (AZ-14).
      const healthChanges = await deps.router.refreshHealth();
      for (const c of healthChanges) {
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'QUOTA_PROBE',
          payload: {
            adapterId: c.adapterId,
            ok: c.health.ok,
            reason: c.health.reason ?? null,
            fiveHourPct: c.health.windows?.fiveHourPct ?? null,
            weeklyPct: c.health.windows?.weeklyPct ?? null,
            estimate: true,
          },
        });
      }

      // Routing hints (REQ-5): the susceptibility cap applies ONLY to a bundle
      // carrying untrusted file content (REQ-5.6); lineage exclusion (REQ-5.5)
      // applies regardless. Absent callback -> Phase-2 routing (REQ-5.1).
      let hints = deps.routeHints?.(input);
      if (hints?.maxSusceptibility !== undefined && !bundle.pieces.some((p) => p.kind === 'file')) {
        const { maxSusceptibility: _capDropped, ...rest } = hints;
        hints = rest;
      }

      // The ordered eligible set (breaker-, health-, and hint-filtered). Empty ->
      // clean BLOCKED(no_capacity), NO retry (REQ-3.3/REQ-5.4/REQ-6.2).
      const eligible = deps.router.eligibleAdapters(role, hints);
      if (eligible.length === 0) {
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'ESCALATED',
          payload: { why: 'no_capacity', role },
        });
        return { claim: 'BLOCKED', actions: [], costUnits: 0 };
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
        payload: { requestId, role },
      });

      const req = {
        requestId,
        agentRole: role,
        taskContract: deps.taskContract,
        contextBundle: bundle,
        manifestRef,
        outputSchema: deps.outputSchema,
        toolDefs: [],
        // Real remaining budget replaces the hardcoded 500 (REQ-6.3); P4 degraded
        // behavior now reacts to truth.
        budget: { costUnits: deps.budgetRemaining ? deps.budgetRemaining() : 500 },
      };

      // Send with a single degraded re-route on AdapterError (REQ-3.2): record the
      // failure with the breaker, then try the next eligible adapter EXCLUDING every
      // key that already failed this round regardless of breaker state (AZ-4).
      const failed = new Set<string>();
      let chosen = eligible[0] as RegisteredAdapter;
      let rerouted = false;
      let out: RepairOutcome;
      for (;;) {
        const key = keyOf(chosen);
        // Data-govern (REQ-11.5/11.8): no bundle leaves for an adapter whose provider
        // policy any piece violates. All-or-nothing — escalate + send NOTHING.
        const dataPolicy = deps.dataPolicyFor?.(chosen.record.adapterId);
        if (dataPolicy !== undefined) {
          const verdict = checkDataPolicy(bundle.pieces, dataPolicy);
          if (!verdict.ok) {
            deps.log.append({
              runId: deps.runId,
              taskId: deps.taskId,
              type: 'DATA_POLICY_VIOLATION',
              payload: { adapterId: chosen.record.adapterId, ...verdict.violation },
            });
            deps.log.append({
              runId: deps.runId,
              taskId: deps.taskId,
              type: 'ESCALATED',
              payload: { why: 'data_policy_violation', adapterId: chosen.record.adapterId, ...verdict.violation },
            });
            return { claim: 'BLOCKED', actions: [], costUnits: 0 };
          }
        }
        try {
          out = await proposeWithRepair(chosen.adapter, req, deps.maxRepairRounds);
          deps.breaker.recordSuccess(key);
          break;
        } catch (err) {
          if (!(err instanceof AdapterError)) throw err;
          deps.breaker.recordFailure(key, err.kind);
          failed.add(key);
          const next = rerouted ? undefined : eligible.find((a) => !failed.has(keyOf(a)));
          if (next === undefined) {
            // No eligible left, or the single re-route also failed -> clean BLOCKED (REQ-3.3).
            deps.log.append({
              runId: deps.runId,
              taskId: deps.taskId,
              type: 'ESCALATED',
              payload: { why: 'no_capacity', role, detail: 'adapter_failure', kind: err.kind },
            });
            return { claim: 'BLOCKED', actions: [], costUnits: 0 };
          }
          rerouted = true;
          chosen = next;
        }
      }

      const costUnits = out.totalUsage.costUnits;

      // Runtime injection canary (REQ-11.1): the round's token surfacing in the
      // model's own output is the signature of a prompt injection — reject the
      // proposal as structured feedback, consume the round, never crash.
      if (canaryTripped(out.response, bundle.canaryToken)) {
        deps.log.append({
          runId: deps.runId,
          taskId: deps.taskId,
          type: 'CANARY_TRIPPED',
          payload: { requestId, adapterId: chosen.record.adapterId },
        });
        return { claim: 'WORKING', actions: [], costUnits };
      }

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

      // Diagnostician round (REQ-5.1): the response carries hypotheses, not a task
      // result — lift them for core to probe. No provenance/action handling applies;
      // core never executes the agent's actions (INV-1), it runs the probes itself.
      if (role === 'diagnostician') {
        return { claim: 'WORKING', actions: [], hypotheses: asHypotheses(out.response.structuredResult), costUnits };
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
