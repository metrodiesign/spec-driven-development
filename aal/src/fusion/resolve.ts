// Pure fusion resolve rules (§7.5, §16; REQ-10.1..10.6). Adversarially unit-tested:
// a judge can NEVER overrule gate evidence, a code_diff winner is ALWAYS exactly one
// candidate's actions (chimera ban), and dissent is captured, never voted away. The
// judge does not participate in code_diff/tests/hypotheses resolution at all — gate
// evidence and mechanical unions decide those — so a hostile or invalid judge cannot
// move the outcome (the pipeline uses the judge only for dissent/analysis capture and
// for plan/reviews, which escalate when it is unavailable).

import type { FusionArtifact, ResolveRule } from './profiles.ts';
import type { Action, GateReport } from 'core';

export interface PanelCandidate {
  /** Panel position — the blind label (C0, C1, ...) the judge sees; carries no adapter identity. */
  index: number;
  requestId: string;
  /** Provenance only — NEVER serialized into the judge's anonymized view (REQ-9.3). */
  adapterId: string;
  lineage: string;
  /** Untrusted model output (INV-3). */
  structuredResult: unknown;
  actions: Action[];
  usage: { costUnits: number };
  /** Core-produced evidence for code_diff/tests candidates (REQ-9.2); absent otherwise. */
  gate?: GateReport;
}

/** A finding not raised by every candidate — captured as FUSION_DISSENT with evidence refs (REQ-10.6). */
export interface DissentItem {
  finding: string;
  raisedBy: number[];
  detail: Record<string, unknown>;
}

export type EscalateReason = 'no_gate_survivor' | 'judge_invalid' | 'budget_cap' | 'panel_degraded' | 'depth_exceeded';

export interface Resolution {
  winner: { structuredResult: unknown; actions: Action[] } | null;
  resolved: ResolveRule;
  escalateReason?: EscalateReason;
  dissent: DissentItem[];
  /** Reviews-only: candidates disagreed on the severity/blocking of a shared finding (REQ-10.5). */
  escalationMarker?: boolean;
}

function gateGreen(c: PanelCandidate): boolean {
  return c.gate?.pass === true;
}

/**
 * code_diff (REQ-10.1/10.2): gate-first tournament. A candidate whose GateReport is
 * not pass:true can NEVER win regardless of any judge ranking (the judge is not even
 * consulted here). The winner is exactly ONE candidate's actions — never a merge.
 */
export function resolveCodeDiff(candidates: PanelCandidate[]): Resolution {
  const green = candidates.filter(gateGreen);
  const winner = green[0];
  if (winner === undefined) {
    return { winner: null, resolved: 'evidence_tournament', escalateReason: 'no_gate_survivor', dissent: [] };
  }
  return {
    winner: { structuredResult: winner.structuredResult, actions: winner.actions },
    resolved: 'evidence_tournament',
    dissent: [],
  };
}

/**
 * tests (REQ-10.3): union of the gate-green candidates' test WRITE_FILEs, deduped by
 * path, each flagged for downstream RED-check verification. Union is legal for tests
 * (unlike code_diff's chimera ban) — more independent tests is strictly more signal.
 */
export function resolveTests(candidates: PanelCandidate[]): Resolution {
  const green = candidates.filter(gateGreen);
  if (green.length === 0) {
    return { winner: null, resolved: 'union_red_check', escalateReason: 'no_gate_survivor', dissent: [] };
  }
  const byPath = new Map<string, Action>();
  for (const c of green) {
    for (const a of c.actions) {
      if (a.type === 'WRITE_FILE' && !byPath.has(a.path)) byPath.set(a.path, a);
    }
  }
  const actions = [...byPath.values()];
  const tests = [...byPath.keys()].map((path) => ({ path, redCheckRequired: true }));
  return {
    winner: { structuredResult: { tests }, actions },
    resolved: 'union_red_check',
    dissent: [],
  };
}

interface RawHypothesis {
  statement: string;
  probes: unknown[];
}

function asHypotheses(structuredResult: unknown): RawHypothesis[] {
  const h = (structuredResult as { hypotheses?: unknown } | null)?.hypotheses;
  if (!Array.isArray(h)) return [];
  return h
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      statement: typeof x['statement'] === 'string' ? (x['statement'] as string) : JSON.stringify(x),
      probes: Array.isArray(x['probes']) ? (x['probes'] as unknown[]) : [],
    }));
}

/**
 * hypotheses (REQ-10.4): union across candidates deduped by statement, ranked by
 * probe count ascending (cheapest-to-test first). Mechanical — the judge is never
 * load-bearing here, so this resolves identically in the judge-invalid fallback.
 */
export function resolveHypotheses(candidates: PanelCandidate[]): Resolution {
  const byStatement = new Map<string, RawHypothesis>();
  for (const c of candidates) {
    for (const h of asHypotheses(c.structuredResult)) {
      if (!byStatement.has(h.statement)) byStatement.set(h.statement, h);
    }
  }
  const ranked = [...byStatement.values()].sort((a, b) => a.probes.length - b.probes.length);
  return {
    winner: { structuredResult: { hypotheses: ranked }, actions: [] },
    resolved: 'union_rank_probe_cost',
    dissent: [],
  };
}

interface RawFinding {
  key: string;
  severity: string;
  blocking: boolean;
}

function asFindings(structuredResult: unknown): RawFinding[] {
  const f = (structuredResult as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(f)) return [];
  return f
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      key: typeof x['id'] === 'string' ? (x['id'] as string) : typeof x['description'] === 'string' ? (x['description'] as string) : JSON.stringify(x),
      severity: typeof x['severity'] === 'string' ? (x['severity'] as string) : 'unspecified',
      blocking: x['blocking'] === true,
    }));
}

/**
 * reviews (REQ-10.5/10.6): equal-weight ensemble. A finding survives if ANY candidate
 * raises it (majority never silences a minority). An escalation marker fires when
 * candidates disagree on the severity OR blocking status of a shared finding. A
 * finding not raised by every candidate is captured as dissent. Weights stay
 * equal in Phase 3; calibration-derived weights are Phase 4.
 */
export function resolveReviews(candidates: PanelCandidate[]): Resolution {
  const raised = new Map<string, { raisedBy: number[]; severities: Set<string>; blockings: Set<boolean> }>();
  for (const c of candidates) {
    for (const f of asFindings(c.structuredResult)) {
      const entry = raised.get(f.key) ?? { raisedBy: [], severities: new Set(), blockings: new Set() };
      entry.raisedBy.push(c.index);
      entry.severities.add(f.severity);
      entry.blockings.add(f.blocking);
      raised.set(f.key, entry);
    }
  }
  const total = candidates.length;
  let escalationMarker = false;
  const dissent: DissentItem[] = [];
  const findings: Record<string, unknown>[] = [];
  for (const [key, e] of raised) {
    const disagree = e.severities.size > 1 || e.blockings.size > 1;
    if (disagree) escalationMarker = true;
    findings.push({ key, raisedBy: e.raisedBy, severities: [...e.severities], disagree });
    // Dissent: a finding not raised by ALL candidates (REQ-10.6).
    if (e.raisedBy.length < total) {
      dissent.push({ finding: key, raisedBy: e.raisedBy, detail: { severities: [...e.severities], blockings: [...e.blockings] } });
    }
  }
  return {
    winner: { structuredResult: { findings, escalation: escalationMarker }, actions: [] },
    resolved: 'weighted_ensemble',
    dissent,
    escalationMarker,
  };
}

/**
 * plan (deliberate_synthesis): not pinned by a REQ-10 criterion. Deterministic
 * first-candidate pick with the judge's deliberation captured alongside (the
 * chimera ban generalizes — no silent merge of plan prose). ponytail: true
 * cross-candidate plan synthesis is a Phase-4 calibration concern; a deterministic
 * pick keeps Phase 3 honest. Escalation on an invalid judge is handled in run.ts.
 */
export function resolvePlan(candidates: PanelCandidate[]): Resolution {
  const winner = candidates[0];
  if (winner === undefined) {
    return { winner: null, resolved: 'deliberate_synthesis', escalateReason: 'panel_degraded', dissent: [] };
  }
  return {
    winner: { structuredResult: winner.structuredResult, actions: winner.actions },
    resolved: 'deliberate_synthesis',
    dissent: [],
  };
}

/** Whether the judge round is load-bearing for this artifact (REQ-9.5/10.8 fallback partition, AZ-2). */
export function judgeLoadBearing(artifact: FusionArtifact): boolean {
  return artifact === 'plan' || artifact === 'reviews';
}

/**
 * Mechanical resolve that needs NO judge (code_diff/tests/hypotheses). Used both on
 * the happy path and as the judge-invalid / budget-short fallback for these artifacts.
 */
export function resolveMechanical(artifact: FusionArtifact, candidates: PanelCandidate[]): Resolution {
  switch (artifact) {
    case 'code_diff':
      return resolveCodeDiff(candidates);
    case 'tests':
      return resolveTests(candidates);
    case 'hypotheses':
      return resolveHypotheses(candidates);
    case 'plan':
      return resolvePlan(candidates);
    case 'reviews':
      return resolveReviews(candidates);
  }
}
