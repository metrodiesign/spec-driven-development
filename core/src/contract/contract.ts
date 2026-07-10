// Goal contract — frozen at the edge (spec §11.1, REQ-8). YAML is parsed by the
// composition root (console/backend); core receives the PRE-PARSED object plus
// the RAW bytes and records sha256(raw bytes) as the frozen-contract hash, so
// core stays zero-runtime-dependency. Mid-run byte-hash changes are detectable
// (-> ESCALATED contract_changed).

import { createHash } from 'node:crypto';

import type { BudgetLimits } from '../types.ts';

export interface TaskContract {
  hash: string;
  goal: { id: string; title: string; objective: string };
  acceptanceCriteria: { id: string; description: string; verification?: string; golden?: boolean }[];
  budget: BudgetLimits;
  approvalPolicy: string[];
  /** Optional canary-deploy stage (design "B. Deploy plane", REQ-4). Absent -> no deploy stage. */
  deploy?: {
    canaryCmd: string;
    observeCmd: string;
    expandCmd: string;
    rollbackCmd: string;
    observe: { probes: number; failureThreshold: number; intervalMs: number };
  };
  raw: Record<string, unknown>;
}

export class ContractInvalidError extends Error {
  constructor(message: string) {
    super(`invalid goal contract: ${message}`);
    this.name = 'ContractInvalidError';
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ContractInvalidError(`${what} must be an object`);
  }
  return v as Record<string, unknown>;
}

function req<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null) throw new ContractInvalidError(`missing ${what}`);
  return v;
}

function reqNonEmptyStr(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new ContractInvalidError(`missing ${what}`);
  return v;
}

function reqNum(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractInvalidError(`${what} must be a number`);
  return v;
}

export function freezeContract(rawBytes: Uint8Array, parsed: unknown): TaskContract {
  const root = asRecord(parsed, 'contract');
  const goal = asRecord(root['goal'], 'goal');
  const goalId = req(goal['id'] as string | undefined, 'goal.id');

  const acRaw = root['acceptance_criteria'];
  if (!Array.isArray(acRaw) || acRaw.length === 0) {
    throw new ContractInvalidError('acceptance_criteria must be a non-empty array');
  }
  const acceptanceCriteria = acRaw.map((entry, i) => {
    const ac = asRecord(entry, `acceptance_criteria[${i}]`);
    const out: TaskContract['acceptanceCriteria'][number] = {
      id: req(ac['id'] as string | undefined, `acceptance_criteria[${i}].id`),
      description: req(ac['description'] as string | undefined, `acceptance_criteria[${i}].description`),
    };
    if (typeof ac['verification'] === 'string') out.verification = ac['verification'];
    if (typeof ac['golden'] === 'boolean') out.golden = ac['golden'];
    return out;
  });

  const budgetRaw = asRecord(req(root['budget'], 'budget'), 'budget');
  const budget: BudgetLimits = {
    maxIterations: Number(req(budgetRaw['max_iterations_per_task'] as number | undefined, 'budget.max_iterations_per_task')),
    maxCostUnits: Number(req(budgetRaw['max_cost_units_per_task'] as number | undefined, 'budget.max_cost_units_per_task')),
    maxWallclockMs:
      Number(req(budgetRaw['max_wallclock_per_task_min'] as number | undefined, 'budget.max_wallclock_per_task_min')) *
      60_000,
  };

  let approvalPolicy: string[] = [];
  const ap = root['approval_policy'];
  if (ap !== undefined) {
    const apObj = asRecord(ap, 'approval_policy');
    const list = apObj['require_human_approval'];
    if (Array.isArray(list)) approvalPolicy = list.map(String);
  }

  // Optional deploy stage (REQ-4). No network-enabling knob is ever read here
  // (REQ-4.5) — only these five keys reach the frozen contract.
  let deploy: TaskContract['deploy'];
  const deployRaw = root['deploy'];
  if (deployRaw !== undefined) {
    const d = asRecord(deployRaw, 'deploy');
    const observeRaw = asRecord(req(d['observe'], 'deploy.observe'), 'deploy.observe');
    const probes = reqNum(observeRaw['probes'], 'deploy.observe.probes');
    const failureThreshold = reqNum(observeRaw['failure_threshold'], 'deploy.observe.failure_threshold');
    const intervalMs = reqNum(observeRaw['interval_ms'], 'deploy.observe.interval_ms');
    // AZ-3: a threshold a rollback could never exceed is refused at freeze time,
    // never mid-stage. probes/failure_threshold must be whole counts — a negative or
    // fractional value slips past the `failedProbes > failureThreshold` compare and
    // rolls a healthy deploy back (e.g. `0 > -1`), so reject both here (PR #50 review).
    if (!Number.isInteger(probes) || probes < 1) {
      throw new ContractInvalidError('deploy.observe.probes must be a positive integer');
    }
    if (!Number.isInteger(failureThreshold) || failureThreshold < 0) {
      throw new ContractInvalidError('deploy.observe.failure_threshold must be a non-negative integer');
    }
    if (failureThreshold >= probes) {
      throw new ContractInvalidError('deploy.observe.failure_threshold must be less than probes');
    }
    deploy = {
      canaryCmd: reqNonEmptyStr(d['canary_cmd'], 'deploy.canary_cmd'),
      observeCmd: reqNonEmptyStr(d['observe_cmd'], 'deploy.observe_cmd'),
      expandCmd: reqNonEmptyStr(d['expand_cmd'], 'deploy.expand_cmd'),
      rollbackCmd: reqNonEmptyStr(d['rollback_cmd'], 'deploy.rollback_cmd'),
      observe: { probes, failureThreshold, intervalMs },
    };
  }

  return {
    hash: sha256Hex(rawBytes),
    goal: {
      id: goalId,
      title: String(goal['title'] ?? goalId),
      objective: String(goal['objective'] ?? ''),
    },
    acceptanceCriteria,
    budget,
    approvalPolicy,
    ...(deploy !== undefined ? { deploy } : {}),
    raw: root,
  };
}

export function contractChanged(rawBytes: Uint8Array, frozenHash: string): boolean {
  return sha256Hex(rawBytes) !== frozenHash;
}
