// Fusion pipeline (§7.5; REQ-9/10). Ring 1 orchestration only — it executes NOTHING
// itself: candidate gates come from core through the CandidateEvidenceRunner PORT
// (INV-1/2, the port inverts the dependency so aal never imports the executor). The
// pipeline: budget-cap + panel-degraded pre-checks -> PANEL fan-out via the bounded
// dispatcher -> per-candidate gate evidence (code_diff/tests) -> blind judge round
// with one bounded repair -> RESOLVE per the fixed §7.5 rule -> CAPTURE dissent. A
// hostile/invalid judge can never move a code_diff/tests/hypotheses outcome (gate
// evidence + mechanical unions decide those); plan/reviews escalate when the judge
// is unavailable.

import { NoCapacityError } from '../router.ts';
import { proposeWithRepair } from '../repair.ts';
import { AdapterError } from '../protocol.ts';
import { asDeliberation, DELIBERATION_ANALYSIS_SCHEMA } from './schema.ts';
import { judgeLoadBearing, resolveMechanical, type PanelCandidate, type Resolution } from './resolve.ts';
import type { FusionProfile } from './profiles.ts';
import type { ResolveRule } from './profiles.ts';
import type { AdapterInterface, AgentRequest } from '../protocol.ts';
import type { RegisteredAdapter } from '../registry.ts';
import type { Router } from '../router.ts';
import type { createDispatcher, DispatchItem } from '../dispatch.ts';
import type { Action, ContextBundle, EventLog, EvidenceStore, GateReport } from 'core';

/** Core-produced gate evidence per candidate (REQ-9.2) — the port that keeps core the sole measurer. */
export interface CandidateEvidenceRunner {
  run(candidate: { actions: Action[] }): Promise<GateReport>;
}

export interface FusionDeps {
  runId: string;
  taskId: string;
  router: Router;
  dispatcher: ReturnType<typeof createDispatcher>;
  /** REQUIRED for code_diff/tests artifacts (gate evidence per candidate). */
  evidenceRunner?: CandidateEvidenceRunner;
  evidence: EvidenceStore;
  log: EventLog;
  ids: { requestId(): string };
}

export type FusionEscalateReason =
  | 'budget_cap'
  | 'depth_exceeded'
  | 'no_gate_survivor'
  | 'judge_invalid'
  | 'panel_degraded';

export interface FusionOutcome {
  winner: { structuredResult: unknown; actions: Action[] } | null;
  /** blob:// of the validated deliberation-analysis (or an {judge:...} marker when absent). */
  deliberationRef: string;
  dissentRefs: string[];
  usage: { costUnits: number };
  resolved: ResolveRule;
  escalateReason?: FusionEscalateReason;
}

interface PanelSlot {
  adapter: AdapterInterface;
  request: AgentRequest;
  lineage: string;
}

/** Escalate before/instead of resolving — winner null, reason recorded, deliberation marker stored. */
function escalate(deps: FusionDeps, profile: FusionProfile, reason: FusionEscalateReason, usage: number): FusionOutcome {
  const deliberationRef = deps.evidence.put(JSON.stringify({ judge: 'not_reached', reason }));
  deps.log.append({
    runId: deps.runId,
    taskId: deps.taskId,
    type: 'FUSION_RESOLVED',
    payload: { artifact: profile.artifact, resolved: profile.resolve, winner: false, escalateReason: reason },
  });
  return { winner: null, deliberationRef, dissentRefs: [], usage: { costUnits: usage }, resolved: profile.resolve, escalateReason: reason };
}

/** Build the N panel slots per the profile diversity, or null when a required lineage is unavailable (REQ-9.7). */
function planPanel(deps: FusionDeps, profile: FusionProfile, base: AgentRequest, size: number): PanelSlot[] | null {
  const role = base.agentRole;
  const eligible = deps.router.eligibleAdapters(role);
  const slot = (adapter: RegisteredAdapter, i: number, seed?: number): PanelSlot => ({
    adapter: adapter.adapter,
    lineage: adapter.lineage,
    request: {
      ...base,
      requestId: `${base.requestId}#fp${i}`, // distinct, derived from the base (REQ-9.1)
      ...(seed !== undefined ? { determinismHint: { ...(base.determinismHint ?? {}), seed } } : {}),
    },
  });

  if (profile.panel.diversity.kind === 'self') {
    const only = eligible[0];
    if (only === undefined) return null;
    const seeds = profile.panel.diversity.seeds;
    // A panel this size needs a DISTINCT seed per slot — cycling short of that via
    // modulo used to silently reuse seeds (duplicate/degenerate candidates) instead
    // of the diversity the panel exists to produce; fail fast like cross_lineage's
    // missing-lineage case instead (PR #50 review). Length alone is not enough — the
    // FIRST `size` seeds actually consumed must themselves be distinct (e.g. [2,2]
    // has length 2 but seats two identical slots).
    if (seeds.length < size || new Set(seeds.slice(0, size)).size < size) return null;
    return Array.from({ length: size }, (_, i) => slot(only, i, seeds[i]));
  }

  // cross_lineage (REQ-9.1/9.7): one candidate per named lineage; a lineage with NO
  // eligible adapter fails fast pre-dispatch (panel_degraded), never a same-lineage
  // substitute that would make uplift meaningless.
  const lineages = profile.panel.diversity.lineages.slice(0, size);
  const slots: PanelSlot[] = [];
  for (let i = 0; i < lineages.length; i += 1) {
    const match = eligible.find((e) => e.lineage === lineages[i]);
    if (match === undefined) return null;
    slots.push(slot(match, i));
  }
  return slots;
}

/** Anonymized judge request (REQ-9.3): candidates by index only — no adapterId, no persuasion text. */
function buildJudgeRequest(deps: FusionDeps, base: AgentRequest, candidates: PanelCandidate[]): AgentRequest {
  const pieces = candidates.map((c) => ({
    id: `candidate-${c.index}`,
    kind: 'excerpt' as const,
    content: JSON.stringify({ candidate: c.index, structuredResult: c.structuredResult, actions: c.actions }),
    reason: 'fusion-candidate-anonymized',
  }));
  const bytes = pieces.reduce((n, p) => n + p.content.length, 0);
  const bundle: ContextBundle = {
    pieces,
    canaryToken: base.contextBundle.canaryToken,
    stats: { bytes, pieceCount: pieces.length },
  };
  return {
    ...base,
    requestId: deps.ids.requestId(),
    agentRole: 'reviewer',
    contextBundle: bundle,
    outputSchema: DELIBERATION_ANALYSIS_SCHEMA,
  };
}

export async function runFusion(deps: FusionDeps, profile: FusionProfile, base: AgentRequest): Promise<FusionOutcome> {
  const estimate = profile.estimateCostUnitsPerCandidate;

  // REQ-10.7 pre-panel budget cap: N x per-candidate estimate must fit the profile
  // cap, else shrink; a panel that cannot even seat 2 candidates escalates budget_cap
  // (a single-candidate "panel" makes uplift meaningless, AZ-8).
  let size = profile.panel.size;
  if (size * estimate > profile.budgetCapCostUnits) {
    const fit = Math.floor(profile.budgetCapCostUnits / estimate);
    if (fit < 2) return escalate(deps, profile, 'budget_cap', 0);
    size = fit;
  }

  const slots = planPanel(deps, profile, base, size);
  if (slots === null || slots.length < 2) return escalate(deps, profile, 'panel_degraded', 0);

  deps.log.append({
    runId: deps.runId,
    taskId: deps.taskId,
    type: 'FUSION_PANEL',
    payload: {
      artifact: profile.artifact,
      size: slots.length,
      diversity: profile.panel.diversity.kind,
      requestIds: slots.map((s) => s.request.requestId),
    },
  });

  const items: DispatchItem[] = slots.map((s) => ({ adapter: s.adapter, request: s.request }));
  const results = await deps.dispatcher.dispatchAll(items);

  const candidates: PanelCandidate[] = [];
  let usage = 0;
  results.forEach((r, i) => {
    const slot = slots[i] as PanelSlot;
    if (r.outcome.ok) {
      const resp = r.outcome.response;
      usage += resp.usage.costUnits;
      candidates.push({
        index: candidates.length,
        requestId: slot.request.requestId,
        adapterId: resp.adapterMeta.adapterId,
        lineage: slot.lineage,
        structuredResult: resp.structuredResult,
        actions: resp.actionRequests,
        usage: { costUnits: resp.usage.costUnits },
      });
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'FUSION_CANDIDATE',
        payload: { index: candidates.length - 1, requestId: slot.request.requestId, adapterId: resp.adapterMeta.adapterId, ok: true, costUnits: resp.usage.costUnits },
      });
    } else {
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'FUSION_CANDIDATE',
        payload: { requestId: slot.request.requestId, ok: false, errorKind: r.outcome.error.kind },
      });
    }
  });

  // REQ-9.8: fewer than two surviving candidates after AdapterErrors -> escalate,
  // never resolve a one-candidate "panel".
  if (candidates.length < 2) return escalate(deps, profile, 'panel_degraded', usage);

  // REQ-9.2: core-produced gate evidence per candidate for code_diff/tests, in
  // separate worktrees (the runner owns worktree isolation). Absent runner = cannot
  // measure -> no_gate_survivor (defensive; the composition always supplies one).
  const needsGate = profile.artifact === 'code_diff' || profile.artifact === 'tests';
  if (needsGate) {
    if (deps.evidenceRunner === undefined) return escalate(deps, profile, 'no_gate_survivor', usage);
    for (const c of candidates) {
      c.gate = await deps.evidenceRunner.run({ actions: c.actions });
    }
  }

  // Budget pre-judge (REQ-10.8): the judge round must fit the remaining budget, else
  // resolve on gate evidence alone (code_diff/tests), mechanically (hypotheses), or
  // escalate (plan/reviews).
  const remaining = base.budget.costUnits - usage;
  let judgeValid = false;
  let judgeAnalysisRef: string | undefined;
  if (remaining >= estimate) {
    try {
      const judgeAdapter = deps.router.route('reviewer');
      const judgeReq = buildJudgeRequest(deps, base, candidates);
      const outcome = await proposeWithRepair(judgeAdapter, judgeReq, 1); // one bounded repair round (REQ-9.4)
      usage += outcome.totalUsage.costUnits;
      if (outcome.valid) {
        judgeValid = true;
        judgeAnalysisRef = deps.evidence.put(JSON.stringify(asDeliberation(outcome.response.structuredResult)));
      }
    } catch (err) {
      // No reviewer adapter (NoCapacityError) or a transport failure -> judge unavailable.
      if (!(err instanceof NoCapacityError) && !(err instanceof AdapterError)) throw err;
    }
  }

  // RESOLVE (REQ-10): judge-load-bearing artifacts (plan/reviews) escalate when the
  // judge is unavailable; the others resolve mechanically regardless of the judge.
  let resolution: Resolution;
  let judgeMarker: Record<string, unknown> | undefined;
  if (judgeLoadBearing(profile.artifact) && !judgeValid) {
    const reason: FusionEscalateReason = remaining >= estimate ? 'judge_invalid' : 'budget_cap';
    resolution = { winner: null, resolved: profile.resolve, escalateReason: reason, dissent: [] };
    judgeMarker = { judge: 'unavailable', reason };
  } else {
    resolution = resolveMechanical(profile.artifact, candidates);
    judgeMarker = judgeValid ? undefined : { judge: 'not_load_bearing' };
  }

  // A valid judge round always gets referenced by its OWN real analysis blob —
  // a marker is only a stand-in for when no analysis exists at all (PR #47 review
  // finding: this used to always re-put a tiny {judge:'valid'} marker and silently
  // drop the real ref, leaving audit consumers unable to inspect the deliberation
  // that was actually produced and paid for).
  const deliberationRef = judgeAnalysisRef ?? deps.evidence.put(JSON.stringify(judgeMarker));

  // CAPTURE dissent (REQ-10.6): each finding not raised by all candidates becomes a
  // FUSION_DISSENT event with an evidence ref.
  const dissentRefs = resolution.dissent.map((d) => {
    const ref = deps.evidence.put(JSON.stringify(d));
    deps.log.append({
      runId: deps.runId,
      taskId: deps.taskId,
      type: 'FUSION_DISSENT',
      payload: { finding: d.finding, raisedBy: d.raisedBy, evidenceRef: ref },
    });
    return ref;
  });

  deps.log.append({
    runId: deps.runId,
    taskId: deps.taskId,
    type: 'FUSION_RESOLVED',
    payload: {
      artifact: profile.artifact,
      resolved: resolution.resolved,
      winner: resolution.winner !== null,
      ...(resolution.escalateReason !== undefined ? { escalateReason: resolution.escalateReason } : {}),
      ...(resolution.escalationMarker === true ? { escalationMarker: true } : {}),
      dissentCount: dissentRefs.length,
    },
  });

  return {
    winner: resolution.winner,
    deliberationRef,
    dissentRefs,
    usage: { costUnits: usage },
    resolved: resolution.resolved,
    ...(resolution.escalateReason !== undefined ? { escalateReason: resolution.escalateReason } : {}),
  };
}
