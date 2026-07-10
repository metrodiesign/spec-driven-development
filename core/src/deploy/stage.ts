// Deploy stage — Loop 5 canary -> observe -> expand | rollback engine (design
// "B. Deploy plane", REQ-5). A goal-level stage with its OWN small state machine,
// recorded as DEPLOY_STATE events — it never touches the task state machine
// (orchestrator/machine.ts stays untouched; COMPLETED stays terminal for tasks).
// Every command runs through the core executor at network:'none' (command-level
// simulation, §16/B4) with evidence-captured output (INV-1/INV-14).

import type { Clock } from '../types.ts';
import type { Executor } from '../executor/executor.ts';
import type { EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { TaskContract } from '../contract/contract.ts';

export type DeployState =
  | 'PENDING_APPROVAL'
  | 'CANARY'
  | 'OBSERVING'
  | 'EXPANDED'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
  | 'ESCALATED';

export type DeployTrigger =
  | 'start'
  | 'canary_ok'
  | 'canary_failed'
  | 'observe_ok'
  | 'observe_failed'
  | 'expand_ok'
  | 'expand_failed'
  | 'rollback_ok'
  | 'rollback_failed'
  | 'manual_rollback';

export type DeployRootCauseTrigger =
  | 'canary_failed'
  | 'observe_failed'
  | 'expand_failed'
  | 'rollback_failed'
  | 'manual_rollback';

export interface DeployRootCause {
  trigger: DeployRootCauseTrigger;
  failedProbes: number;
  /** Evidence refs behind this rollback: the triggering command(s) + the rollback command itself. */
  refs: string[];
}

export interface DeployOutcome {
  finalState: DeployState;
  probeResults: { pass: boolean; evidenceRef: string }[];
  /** Present on ROLLED_BACK and ESCALATED — absent on EXPANDED (REQ-5.4/5.5/5.6). */
  rootCause?: DeployRootCause;
}

/**
 * Deploy-scoped time source. Core's shared `Clock` (types.ts) is `now()`-only —
 * nothing in core ever performs a real wait. Probe spacing (REQ-5.3) is the first
 * exception, so it stays local to the deploy stage instead of widening the shared
 * interface every other Clock consumer would have to satisfy.
 */
export interface DeployClock extends Clock {
  wait(ms: number): Promise<void>;
}

export interface DeployStageDeps {
  runId: string;
  taskId: string;
  config: NonNullable<TaskContract['deploy']>;
  executor: Executor;
  log: EventLog;
  evidence: EvidenceStore;
  clock: DeployClock;
}

function record(
  deps: DeployStageDeps,
  state: DeployState,
  trigger: DeployTrigger,
  extra?: Record<string, unknown>,
): void {
  deps.log.append({
    runId: deps.runId,
    taskId: deps.taskId,
    type: 'DEPLOY_STATE',
    // simulation:true labels every deploy event as command-level simulation on the
    // target repo, never a production rollout (REQ-5.8, assumption B4).
    payload: { state, trigger, simulation: true, ...extra },
  });
}

interface CommandRun {
  ok: boolean;
  exitCode: number | null;
  ref: string;
}

async function runDeployCommand(deps: DeployStageDeps, actionId: string, cmd: string): Promise<CommandRun> {
  const outcome = await deps.executor.execute(
    { type: 'RUN_COMMAND', actionId, cmd, network: 'none' },
    'diagnostician',
  );
  if (outcome.status === 'applied') {
    const exitCode = outcome.exitCode ?? null;
    const ref = outcome.outputRef ?? deps.evidence.put(`exit:${exitCode ?? 'null'}`);
    return { ok: exitCode === 0, exitCode, ref };
  }
  const detail = outcome.status === 'rejected' ? outcome.rejection : { status: outcome.status };
  return { ok: false, exitCode: null, ref: deps.evidence.put(JSON.stringify(detail)) };
}

interface RollbackResult {
  finalState: 'ROLLED_BACK' | 'ESCALATED';
  rootCause: DeployRootCause;
}

/** ROLLING_BACK -> rollback_cmd -> ROLLED_BACK (exit 0) | ESCALATED (non-zero, no retry — REQ-5.4/5.5). */
async function runRollback(
  deps: DeployStageDeps,
  trigger: Exclude<DeployRootCauseTrigger, 'rollback_failed'>,
  failedProbes: number,
  refs: string[],
): Promise<RollbackResult> {
  record(deps, 'ROLLING_BACK', trigger, { failedProbes, refs });
  const rollback = await runDeployCommand(deps, 'deploy-rollback', deps.config.rollbackCmd);
  const allRefs = [...refs, rollback.ref];
  if (rollback.ok) {
    record(deps, 'ROLLED_BACK', 'rollback_ok', { failedProbes, refs: allRefs });
    return { finalState: 'ROLLED_BACK', rootCause: { trigger, failedProbes, refs: allRefs } };
  }
  record(deps, 'ESCALATED', 'rollback_failed', { failedProbes, refs: allRefs });
  return {
    finalState: 'ESCALATED',
    rootCause: { trigger: 'rollback_failed', failedProbes, refs: allRefs },
  };
}

export async function runDeployStage(deps: DeployStageDeps): Promise<DeployOutcome> {
  const { config } = deps;

  record(deps, 'CANARY', 'start');
  const canary = await runDeployCommand(deps, 'deploy-canary', config.canaryCmd);
  if (!canary.ok) {
    // Canary itself failed -> rollback without ever running observe probes (REQ-5.7).
    const { finalState, rootCause } = await runRollback(deps, 'canary_failed', 0, [canary.ref]);
    return { finalState, probeResults: [], rootCause };
  }
  record(deps, 'OBSERVING', 'canary_ok');

  const probeResults: { pass: boolean; evidenceRef: string }[] = [];
  for (let i = 0; i < config.observe.probes; i++) {
    if (i > 0) await deps.clock.wait(config.observe.intervalMs);
    const probe = await runDeployCommand(deps, `deploy-observe-${i + 1}`, config.observeCmd);
    probeResults.push({ pass: probe.ok, evidenceRef: probe.ref });
    // Reuses the existing PROBE_RUN event type (hypothesis engine's probe loop,
    // repair/hypothesis.ts) — same payload shape, same audit-trail idiom.
    deps.log.append({
      runId: deps.runId,
      taskId: deps.taskId,
      type: 'PROBE_RUN',
      payload: {
        cmd: config.observeCmd,
        exit: probe.exitCode,
        evidenceRef: probe.ref,
        error: probe.exitCode === null,
      },
    });
  }
  const failedProbes = probeResults.filter((p) => !p.pass).length;

  if (failedProbes > config.observe.failureThreshold) {
    const failedRefs = probeResults.filter((p) => !p.pass).map((p) => p.evidenceRef);
    const { finalState, rootCause } = await runRollback(deps, 'observe_failed', failedProbes, failedRefs);
    return { finalState, probeResults, rootCause };
  }

  const expand = await runDeployCommand(deps, 'deploy-expand', config.expandCmd);
  if (!expand.ok) {
    const { finalState, rootCause } = await runRollback(deps, 'expand_failed', failedProbes, [expand.ref]);
    return { finalState, probeResults, rootCause };
  }

  record(deps, 'EXPANDED', 'expand_ok');
  return { finalState: 'EXPANDED', probeResults };
}

/**
 * Manual rollback (REQ-6.8): operator-triggered via POST /deploy/rollback, legal only from
 * EXPANDED (the caller's job to guard — see api.ts). Reuses `runRollback` so there is exactly
 * one rollback code path with identical evidence/state semantics as the automated trigger.
 */
export async function runManualRollback(deps: DeployStageDeps): Promise<DeployOutcome> {
  const { finalState, rootCause } = await runRollback(deps, 'manual_rollback', 0, []);
  return { finalState, probeResults: [], rootCause };
}
