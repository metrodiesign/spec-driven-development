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
    raw: root,
  };
}

export function contractChanged(rawBytes: Uint8Array, frozenHash: string): boolean {
  return sha256Hex(rawBytes) !== frozenHash;
}
