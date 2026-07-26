// Fusion composition root (§7.5; REQ-9.2, REQ-10.9, REQ-10.10). aal/fusion is pure
// orchestration and executes nothing (INV-1/2); THIS layer supplies the two things
// that must touch the machine: the CandidateEvidenceRunner (core-run gates in an
// ISOLATED git worktree per candidate) and the fusion.deliberate REQUEST_TOOL handler
// (the per-task depth<=1 counter). Core cannot import aal/runFusion (INV-8), so the
// depth counter + the fusion trigger live here and are injected into the executor
// through its toolHandlers seam.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createGateRunner, type Clock, type EventLog, type EvidenceStore, type ExecuteOutcome, type GateReport, type ToolHandler } from 'core';
import {
  runFusion,
  validateAgainstSchema,
  type AgentRequest,
  type CandidateEvidenceRunner,
  type createDispatcher,
  type FusionDeps,
  type FusionOutcome,
  type FusionProfile,
  type Router,
} from 'aal';
import type { LiveGuardDecision } from './loop-cli.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

export interface CandidateRunnerOptions {
  /** The live repo (a git worktree) fusion candidates are measured against. */
  repoDir: string;
  /** Ladder policy path RELATIVE to the repo root (present in every checkout). */
  configRelPath: string;
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  clock: Clock;
  /** Which tier to prove per candidate (default T1 — the fixture's meaningful gate). */
  tier?: GateReport['tier'];
}

/**
 * REQ-9.2: measure each candidate in a SEPARATE worktree so panel candidates never
 * see each other's writes and the live repo is never mutated. Adds a detached
 * worktree at HEAD, applies the candidate's WRITE_FILEs, runs core's gate runner,
 * then removes the worktree. The GateReport is CORE-produced — the judge never
 * touches it (INV-1/2, REQ-10.1).
 */
export function createCandidateEvidenceRunner(opts: CandidateRunnerOptions): CandidateEvidenceRunner {
  const tier = opts.tier ?? 'T1';
  return {
    async run({ actions }) {
      const wt = mkdtempSync(join(tmpdir(), 'fusion-cand-'));
      try {
        git(opts.repoDir, 'worktree', 'add', '--detach', '-q', wt, 'HEAD');
        for (const a of actions) {
          if (a.type !== 'WRITE_FILE') continue;
          const abs = join(wt, a.path);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, opts.evidence.get(a.contentRef));
        }
        const gates = createGateRunner({
          worktreeDir: wt,
          configPath: join(wt, opts.configRelPath),
          runId: opts.runId,
          taskId: opts.taskId,
          log: opts.log,
          evidence: opts.evidence,
          clock: opts.clock,
        });
        return await gates.run(tier);
      } finally {
        // --force: the worktree has uncommitted candidate writes we intentionally discard.
        try { git(opts.repoDir, 'worktree', 'remove', '--force', wt); } catch { /* best-effort cleanup */ }
      }
    },
  };
}

export interface FusionToolHandlerOptions {
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  /** Runs the actual fusion activation (composition supplies profile + deps + request). */
  activate: () => Promise<FusionOutcome>;
}

/**
 * REQ-10.9: the fusion.deliberate REQUEST_TOOL handler with a per-task depth<=1
 * counter. The FIRST activation runs fusion and records its outcome ref; a SECOND
 * fusion.deliberate for the same task is rejected as structured feedback
 * (`depth_exceeded`) — mirrors the executor's out-of-authority rejection pattern,
 * never a crash. One handler instance is created per task at the composition root,
 * so the counter is genuinely per-task.
 */
export function createFusionToolHandler(opts: FusionToolHandlerOptions): ToolHandler {
  let consumed = false;
  return async (action): Promise<ExecuteOutcome> => {
    if (consumed) {
      const rejection = { actionId: action.actionId, reason: 'depth_exceeded' as const, detail: 'task already consumed its single fusion activation (depth <= 1)' };
      opts.log.append({ runId: opts.runId, taskId: opts.taskId, type: 'ACTION_REJECTED', payload: { ...rejection } });
      return { status: 'rejected', rejection };
    }
    consumed = true;
    const outcome = await opts.activate();
    const ref = opts.evidence.put(JSON.stringify({
      resolved: outcome.resolved,
      winner: outcome.winner !== null,
      escalateReason: outcome.escalateReason ?? null,
      deliberationRef: outcome.deliberationRef,
      dissentRefs: outcome.dissentRefs,
      usage: outcome.usage,
    }));
    opts.log.append({ runId: opts.runId, taskId: opts.taskId, type: 'ACTION_APPLIED', payload: { actionId: action.actionId, resultHash: ref, outputRef: ref, duplicate: false } });
    return { status: 'applied', actionId: action.actionId, resultHash: ref, outputRef: ref };
  };
}

/**
 * REQ-10.10: fusion (4-5x quota per activation) activates ONLY on a confirmed live
 * run — never on the CI-safe stub path and never on a --live refusal (which fires in
 * CI). So `decideLiveRun` structurally keeps fusion off under CI: no confirm, no
 * fusion handler installed.
 */
export function fusionActive(decision: LiveGuardDecision): boolean {
  return decision.action === 'confirm';
}

/**
 * REQ-16.5: structural, validateAgainstSchema-compatible copy of
 * `.ai/schemas/plan.schema.json` — a co-located test in fusion.test.ts asserts the
 * required-property set stays byte-equivalent. validateAgainstSchema only
 * understands type/required/properties/enum (no $ref/minItems/additionalProperties),
 * so this copy is necessarily flatter than the governance artifact — the same split
 * hypothesis.schema.json and deliberation-analysis.schema.json already establish.
 */
export const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['approach', 'steps'],
  properties: {
    approach: { type: 'string' },
    steps: { type: 'array' },
    risks: { type: 'array' },
  },
};

export interface PlannerFusionOptions {
  runId: string;
  /**
   * null in multi-task mode (phase5-stage4): this dispatch is per-RUN and happens
   * before any task is selected, so its events carry no task id rather than a real
   * graph task's — same shape KILL_REQUESTED already uses. Single-task passes 'T-1'.
   */
  taskId: string | null;
  /** SAME router instance the task loop uses — whatever mode governance pinned (AZ-13). */
  router: Router;
  dispatcher: ReturnType<typeof createDispatcher>;
  /** The `plan` artifact profile from fusion-profiles.json (deliberate_synthesis, REQ-16.2). */
  profile: FusionProfile;
  evidence: EvidenceStore;
  log: EventLog;
  ids: { requestId(): string; canary(): string };
  /** Panel input is pinned to the frozen contract's goal + ACs — nothing else (REQ-16.2). */
  taskContract: { goalId: string; title: string; objective: string; acceptanceCriteria: { id: string; description: string }[] };
  /**
   * The frozen task graph, serialized (phase5-stage4 REQ-5.1) — present only in
   * multi-task mode, where it becomes the panel's single context piece. Absent ->
   * the empty bundle below, byte-identical to the single-task behavior (REQ-5.2).
   */
  taskGraphJson?: string;
}

export interface PlannerFusionResult {
  /** null when fusion escalated (no winner) or the winner failed PLAN_SCHEMA — never blocks the task loop (structural validation only, REQ-16.5). */
  plan: { id: string; content: string } | null;
  outcome: FusionOutcome;
}

/**
 * REQ-16.2/16.5: dispatch role 'planner' through fusion BEFORE the task loop. The
 * CALLER gates whether this ever runs — REQ-16.3's two independent switches
 * (`triggers.plannerRole` from the governance-hashed policy file AND the
 * composition's own option) are the caller's job, same separation
 * `createFusionToolHandler`/`fusionActive` already establish for the mid-task
 * fusion.deliberate seam; this function itself unconditionally dispatches once
 * called. PLAN_RESOLVED is appended regardless of outcome so the event log always
 * records whether resolution produced a usable plan — a `winner:false` (escalate,
 * or a structurally invalid winner) never blocks the task loop, it simply proceeds
 * without a plan piece.
 *
 * The plan itself stays ADVISORY: it is validated structurally against PLAN_SCHEMA
 * and nothing more (phase5-stage4 REQ-5.3). The deterministic planning gate that
 * CAN stop a run lives elsewhere — `freezeTaskGraph` (core/src/graph/) gates the
 * promoted task graph before any dispatch (§11.2: uncovered ACs, orphan tasks,
 * cycles, per-task diff budget), which is also what supplies the graph piece below.
 */
export async function runPlannerFusion(opts: PlannerFusionOptions): Promise<PlannerFusionResult> {
  const canaryToken = opts.ids.canary();
  const manifestRef = opts.evidence.put(JSON.stringify({ taskId: opts.taskId, canaryToken, rules: [] }));
  const base: AgentRequest = {
    requestId: opts.ids.requestId(),
    agentRole: 'planner',
    taskContract: opts.taskContract,
    // Pinned to the frozen goal+ACs (REQ-16.2), never repo/file context. Multi-task
    // mode adds exactly ONE piece: the frozen task graph the run is executing
    // (phase5-stage4 REQ-5.1), MARKed as data under this request's canary like any
    // other piece. `kind: 'contract'` is a pathless kind (provider-data-policy.json),
    // so the graph travels without a path allowlist entry; it is not run through the
    // context builder's secret scan — acceptable because a graph is an artifact a
    // human promoted by hand. Single-task keeps the empty bundle (REQ-5.2).
    contextBundle:
      opts.taskGraphJson === undefined
        ? { pieces: [], canaryToken, stats: { bytes: 0, pieceCount: 0 } }
        : {
            pieces: [{ id: 'task-graph', kind: 'contract', content: opts.taskGraphJson, reason: 'task_graph' }],
            canaryToken,
            stats: { bytes: opts.taskGraphJson.length, pieceCount: 1 },
          },
    manifestRef,
    outputSchema: PLAN_SCHEMA,
    toolDefs: [],
    // The fusion profile's OWN cap, not the task's remaining run budget — this
    // dispatch happens BEFORE the task loop starts spending, so there is no task
    // budget yet to reference (deviation from source.ts's budgetRemaining() pattern).
    budget: { costUnits: opts.profile.budgetCapCostUnits },
  };
  const deps: FusionDeps = {
    runId: opts.runId,
    taskId: opts.taskId,
    router: opts.router,
    dispatcher: opts.dispatcher,
    evidence: opts.evidence,
    log: opts.log,
    ids: { requestId: opts.ids.requestId },
  };
  const outcome = await runFusion(deps, opts.profile, base);

  let plan: { id: string; content: string } | null = null;
  if (outcome.winner !== null) {
    const check = validateAgainstSchema(outcome.winner.structuredResult, PLAN_SCHEMA);
    if (check.valid) {
      const content = JSON.stringify(outcome.winner.structuredResult);
      opts.evidence.put(content); // stored as evidence (REQ-16.5)
      plan = { id: `plan-${opts.taskId ?? 'run'}`, content };
    }
  }
  // Best-effort panel size (REQ-16.5's PLAN_RESOLVED.panelSize): the FUSION_PANEL
  // THIS call itself just appended, 0 when fusion escalated before a panel ever
  // formed (budget_cap/panel_degraded pre-dispatch).
  const panelSize =
    (opts.log
      .all({ ...(opts.taskId !== null ? { taskId: opts.taskId } : {}), type: 'FUSION_PANEL' })
      .at(-1)?.payload['size'] as number | undefined) ?? 0;
  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'PLAN_RESOLVED',
    payload: { winner: plan !== null, panelSize, costUnits: outcome.usage.costUnits },
  });
  return { plan, outcome };
}
