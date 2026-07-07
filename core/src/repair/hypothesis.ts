// Hypothesis engine (spec §9.3, REQ-5). A DIAGNOSING round hands core a list of
// testable hypotheses as UNTRUSTED data; this engine validates the shape, caps
// probes per hypothesis, and runs each probe ITSELF through the executor
// (RUN_COMMAND, network:'none', diagnostician role — the agent never executes,
// INV-1). Probes run cheapest-first and the engine stops at the first confirming
// probe (REQ-5.3/5.4). A probe that errors/times out marks its hypothesis
// `undecided` — an execution error is not evidence, so it never counts as a
// refutation (REQ-5.8). Every probe run and every verdict is an event; refuted
// hypotheses are always recorded (feeds escalation, kills repeat guessing).

import type { BudgetTracker } from '../budget/budget.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { Executor } from '../executor/executor.ts';
import type { EventLog } from '../state/event-log.ts';
import type { Action, Hypothesis, HypothesisProbe, HypothesisVerdict, IdSource } from '../types.ts';

export interface HypothesisEngineDeps {
  runId: string;
  taskId: string;
  executor: Executor;
  evidence: EvidenceStore;
  log: EventLog;
  /** Checked BETWEEN probes, not only between rounds (REQ-5.9). */
  budget: BudgetTracker;
  ids: IdSource;
  /** Bounds the diagnose cycle (REQ-5.6); the frozen contract's max_hypotheses_per_failure. */
  maxHypotheses: number;
  /** Policy cap on probes per hypothesis (default 5); over-cap = structured reject (REQ-5.7). */
  maxProbesPerHypothesis: number;
  /** Policy-pinned per-probe timeout in ms (REQ-5.8). */
  probeTimeoutMs: number;
}

export type HypothesisOutcome =
  | { status: 'confirmed'; hypothesis: Hypothesis; log: HypothesisVerdict[] }
  | {
      status: 'exhausted';
      reason: 'all_refuted' | 'max_hypotheses' | 'budget' | 'wallclock';
      log: HypothesisVerdict[];
    };

interface ProbeRun {
  output: string;
  exit: number | null;
  ref: string;
  errored: boolean;
}

function budgetStop(deps: HypothesisEngineDeps): 'budget' | 'wallclock' | null {
  const over = deps.budget.exceeded();
  if (over === false) return null;
  return over.limit === 'wallclock' ? 'wallclock' : 'budget';
}

/** Structural validation of one untrusted hypothesis; returns a reason string when unusable. */
function validateHypothesis(h: unknown, maxProbes: number): { ok: true } | { ok: false; reason: string } {
  if (typeof h !== 'object' || h === null) return { ok: false, reason: 'hypothesis_not_object' };
  const rec = h as Record<string, unknown>;
  if (typeof rec['statement'] !== 'string' || rec['statement'].length === 0) {
    return { ok: false, reason: 'missing_statement' };
  }
  const probes = rec['probes'];
  if (!Array.isArray(probes) || probes.length === 0) return { ok: false, reason: 'missing_probes' };
  // Untrusted input cannot demand unbounded execution (REQ-5.7).
  if (probes.length > maxProbes) return { ok: false, reason: 'probe_cap_exceeded' };
  for (const p of probes) {
    if (typeof p !== 'object' || p === null) return { ok: false, reason: 'probe_not_object' };
    const pr = p as Record<string, unknown>;
    if (typeof pr['cmd'] !== 'string' || pr['cmd'].length === 0) return { ok: false, reason: 'probe_missing_cmd' };
    if (typeof pr['expected'] !== 'string' || pr['expected'].length === 0) {
      return { ok: false, reason: 'probe_missing_expected' };
    }
  }
  const ic = rec['ifConfirmed'];
  if (typeof ic !== 'object' || ic === null) return { ok: false, reason: 'missing_ifConfirmed' };
  const icr = ic as Record<string, unknown>;
  if (typeof icr['patchPlan'] !== 'string' || icr['patchPlan'].length === 0) {
    return { ok: false, reason: 'missing_patchPlan' };
  }
  return { ok: true };
}

async function runProbe(probe: HypothesisProbe, deps: HypothesisEngineDeps): Promise<ProbeRun> {
  const base = {
    type: 'RUN_COMMAND' as const,
    actionId: deps.ids.next('probe'),
    cmd: probe.cmd,
    network: 'none' as const,
    timeoutMs: deps.probeTimeoutMs,
  };
  // exactOptionalPropertyTypes: only carry cwd when the probe actually set it.
  const action: Action = probe.cwd !== undefined ? { ...base, cwd: probe.cwd } : base;

  const outcome = await deps.executor.execute(action, 'diagnostician');
  if (outcome.status === 'applied') {
    const ref = outcome.outputRef ?? deps.evidence.put(`exit:${outcome.exitCode ?? 'null'}`);
    const output = deps.evidence.getText(ref);
    const exit = outcome.exitCode ?? null;
    // A spawn failure / timeout kill has no clean exit status (executor: res.status ?? -1),
    // so a negative/absent code is an execution error, not evidence (REQ-5.8).
    return { output, exit, ref, errored: exit === null || exit < 0 };
  }
  // rejected (sandbox denial / policy) or skipped — the probe could not run.
  const detail = outcome.status === 'rejected' ? outcome.rejection.reason : outcome.status;
  const ref = deps.evidence.put(JSON.stringify({ probe_error: detail }));
  return { output: '', exit: null, ref, errored: true };
}

export async function evaluateHypotheses(
  hypotheses: Hypothesis[],
  deps: HypothesisEngineDeps,
): Promise<HypothesisOutcome> {
  deps.log.append({
    runId: deps.runId,
    taskId: deps.taskId,
    type: 'HYPOTHESIS_PROPOSED',
    payload: { count: hypotheses.length },
  });

  const verdicts: HypothesisVerdict[] = [];
  let evaluated = 0;

  for (const hypothesis of hypotheses) {
    // The count exceeds the per-failure cap -> stop, exhausted (REQ-5.6).
    if (evaluated >= deps.maxHypotheses) {
      return { status: 'exhausted', reason: 'max_hypotheses', log: verdicts };
    }
    const stop = budgetStop(deps);
    if (stop !== null) return { status: 'exhausted', reason: stop, log: verdicts };

    const valid = validateHypothesis(hypothesis, deps.maxProbesPerHypothesis);
    if (!valid.ok) {
      // Reject the untrusted proposal as structured feedback; undecided, never a
      // refutation, but counts toward the cap (REQ-5.7/5.8).
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'ACTION_REJECTED',
        payload: { reason: valid.reason, statement: hypothesis.statement ?? null },
      });
      verdicts.push({ hypothesis, verdict: 'undecided', probeOutputs: [], probeRefs: [] });
      evaluated += 1;
      continue;
    }

    const probeOutputs: string[] = [];
    const probeRefs: string[] = [];
    let verdict: HypothesisVerdict['verdict'] = 'refuted';
    let confirmRef: string | undefined;

    for (const probe of hypothesis.probes) {
      const between = budgetStop(deps);
      if (between !== null) return { status: 'exhausted', reason: between, log: verdicts };

      const run = await runProbe(probe, deps);
      probeOutputs.push(run.output);
      probeRefs.push(run.ref);
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'PROBE_RUN',
        payload: { cmd: probe.cmd, exit: run.exit, evidenceRef: run.ref, error: run.errored },
      });

      if (run.errored) {
        verdict = 'undecided';
        break; // an execution error is not evidence — stop this hypothesis (REQ-5.8)
      }
      if (run.output.includes(probe.expected)) {
        verdict = 'confirmed';
        confirmRef = run.ref;
        break; // first confirming probe wins (REQ-5.3)
      }
      // else: this probe did not confirm; try the next (still 'refuted' so far).
    }

    if (verdict === 'confirmed') {
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'HYPOTHESIS_CONFIRMED',
        payload: { statement: hypothesis.statement, evidenceRef: confirmRef },
      });
      verdicts.push({ hypothesis, verdict, probeOutputs, probeRefs });
      return { status: 'confirmed', hypothesis, log: verdicts };
    }

    if (verdict === 'refuted') {
      const ref = deps.evidence.put(
        JSON.stringify({ statement: hypothesis.statement, probeRefs }),
      );
      deps.log.append({
        runId: deps.runId,
        taskId: deps.taskId,
        type: 'HYPOTHESIS_REFUTED',
        payload: { statement: hypothesis.statement, evidenceRef: ref },
      });
    }
    verdicts.push({ hypothesis, verdict, probeOutputs, probeRefs });
    evaluated += 1;
  }

  return { status: 'exhausted', reason: 'all_refuted', log: verdicts };
}

/** Compact, dump-free escalation view of a diagnose cycle (REQ-5.6). */
export function summarizeHypothesisLog(
  log: HypothesisVerdict[],
): { statement: string; verdict: string; probeRefs: string[] }[] {
  return log.map((v) => ({
    statement: v.hypothesis.statement,
    verdict: v.verdict,
    probeRefs: v.probeRefs,
  }));
}
