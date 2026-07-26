// Task graph — frozen and gated before any task is dispatched (spec §11.2,
// phase5-stage4 REQ-3). The composition edge validates the file's SHAPE and hands
// core the PRE-PARSED object plus the RAW bytes; freeze records sha256(raw bytes)
// as the graph hash, so core stays zero-runtime-dependency (same split as
// freezeContract). Freeze re-checks the minimum structure itself so it remains
// callable standalone (fault-injection calls it directly), then runs the planning
// gate and bakes the effective risk / diff budget into the frozen graph, so
// selection and the driver never need to consult the contract again.
//
// Unlike freezeContract (fail-fast), every violation is collected into
// TaskGraphGateError.reasons and thrown ONCE: whoever authored the graph should
// see the whole list in a single pass instead of one defect per run.

import { createHash } from 'node:crypto';

import type { TaskContract } from '../contract/contract.ts';
import type { RiskClass } from '../human/approval.ts';

export interface TaskGraphTask {
  id: string;
  title: string;
  satisfies: string[];
  dependsOn: string[];
  enabling: boolean;
  /** EFFECTIVE risk — declared value, else the contract's (resolved at freeze). */
  risk: RiskClass;
  /** EFFECTIVE diff budget — declared value, else checks.maxDiffBudgetPerTask. */
  diffBudget: number;
}

export interface TaskGraph {
  goalId: string;
  tasks: TaskGraphTask[];
  checks: { maxDiffBudgetPerTask: number };
  /** sha256 hex of the raw graph bytes (INV-10). */
  graphHash: string;
}

/** Structured gate outcome that travels with the frozen graph (REQ-3.9) — never free text. */
export interface TaskGraphGateResult {
  graphHash: string;
  taskIds: string[];
  /** Always empty on a pass; a non-empty list is a rejection reason instead. */
  uncoveredAcs: string[];
  orphanTasks: string[];
}

export class TaskGraphGateError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`task graph rejected: ${reasons.join('; ')}`);
    this.reasons = reasons;
    this.name = 'TaskGraphGateError';
  }
}

const RISK_LEVELS: readonly RiskClass[] = ['L0', 'L1', 'L2', 'L3', 'L4'];

/** A task as it survives the structural re-check: declared values, nothing resolved yet. */
interface DeclaredTask {
  id: string;
  title: string;
  satisfies: string[];
  dependsOn: string[];
  enabling: boolean;
  risk: RiskClass | undefined;
  diffBudget: number | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isNonEmptyString);
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

interface DeclaredGraph {
  goalId: string;
  tasks: DeclaredTask[];
  maxDiffBudgetPerTask: number;
}

/**
 * Minimum structural re-check. The edge already ran the JSON Schema, but freeze
 * must stand alone; when anything here fails the semantic checks below would read
 * garbage, so the caller throws immediately on a null return.
 */
function declaredGraph(parsed: unknown, reasons: string[]): DeclaredGraph | null {
  if (!isRecord(parsed)) {
    reasons.push('graph must be an object');
    return null;
  }
  const goalId = parsed['goal_id'];
  if (!isNonEmptyString(goalId)) reasons.push('goal_id must be a non-empty string');

  const checks = parsed['checks'];
  const maxDiffBudgetPerTask = isRecord(checks) ? checks['max_diff_budget_per_task'] : undefined;
  if (!isPosInt(maxDiffBudgetPerTask)) {
    reasons.push('checks.max_diff_budget_per_task must be an integer >= 1');
  }

  const rawTasks = parsed['tasks'];
  const tasks: DeclaredTask[] = [];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    reasons.push('tasks must be a non-empty array');
  } else {
    rawTasks.forEach((entry, i) => {
      if (!isRecord(entry)) {
        reasons.push(`tasks[${i}] must be an object`);
        return;
      }
      const id = entry['id'];
      const title = entry['title'];
      const satisfies = entry['satisfies'];
      const dependsOn = entry['depends_on'] ?? [];
      const enabling = entry['enabling'] ?? false;
      const risk = entry['risk'];
      const diffBudget = entry['diff_budget'];
      if (!isNonEmptyString(id)) reasons.push(`tasks[${i}].id must be a non-empty string`);
      if (!isNonEmptyString(title)) reasons.push(`tasks[${i}].title must be a non-empty string`);
      if (!isStringArray(satisfies)) reasons.push(`tasks[${i}].satisfies must be an array of non-empty strings`);
      if (!isStringArray(dependsOn)) reasons.push(`tasks[${i}].depends_on must be an array of non-empty strings`);
      if (typeof enabling !== 'boolean') reasons.push(`tasks[${i}].enabling must be a boolean`);
      if (risk !== undefined && !RISK_LEVELS.includes(risk as RiskClass)) {
        reasons.push(`tasks[${i}].risk must be one of ${RISK_LEVELS.join('|')}`);
      }
      if (diffBudget !== undefined && !isPosInt(diffBudget)) {
        reasons.push(`tasks[${i}].diff_budget must be an integer >= 1`);
      }
      if (isNonEmptyString(id) && isNonEmptyString(title) && isStringArray(satisfies) && isStringArray(dependsOn) && typeof enabling === 'boolean') {
        tasks.push({
          id,
          title,
          satisfies,
          dependsOn,
          enabling,
          risk: risk === undefined ? undefined : (risk as RiskClass),
          diffBudget: isPosInt(diffBudget) ? diffBudget : undefined,
        });
      }
    });
  }

  if (reasons.length > 0 || !isNonEmptyString(goalId) || !isPosInt(maxDiffBudgetPerTask)) return null;
  return { goalId, tasks, maxDiffBudgetPerTask };
}

/**
 * Kahn's algorithm (REQ-3.12): returns every task id that cannot be topologically
 * ordered — i.e. the ids on a cycle plus anything downstream of one. Self-edges and
 * unknown edges are filtered out by the caller so they are reported as their own,
 * more precise reasons instead of surfacing here as a phantom cycle.
 */
function unorderableTaskIds(ids: string[], deps: Map<string, string[]>): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, deps.get(id)?.length ?? 0);
    dependents.set(id, []);
  }
  for (const [id, list] of deps) {
    for (const dep of list) dependents.get(dep)?.push(id);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const ordered = new Set<string>();
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    if (ordered.has(id)) continue;
    ordered.add(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return ids.filter((id) => !ordered.has(id));
}

/**
 * Freeze + gate a task graph against its frozen contract. Returns the frozen graph
 * (effective values baked) and the structured gate result; throws
 * TaskGraphGateError carrying EVERY violation when any check fails (REQ-3.2..3.14).
 */
export function freezeTaskGraph(
  rawBytes: Uint8Array,
  parsed: unknown,
  contract: TaskContract,
): { graph: TaskGraph; gate: TaskGraphGateResult } {
  const reasons: string[] = [];
  const declared = declaredGraph(parsed, reasons);
  if (declared === null) throw new TaskGraphGateError(reasons);
  const { goalId, tasks, maxDiffBudgetPerTask } = declared;

  // 3.11 duplicate task ids.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) duplicates.add(t.id);
    seen.add(t.id);
  }
  for (const id of duplicates) reasons.push(`duplicate task id: ${id}`);

  // 3.14 the graph binds to exactly one contract — AC ids recur across features.
  if (goalId !== contract.goal.id) {
    reasons.push(`goal_id ${goalId} does not match the frozen contract goal id ${contract.goal.id}`);
  }

  // 3.2 unknown AC ids / 3.3 uncovered ACs.
  const contractAcIds = new Set(contract.acceptanceCriteria.map((ac) => ac.id));
  const cited = new Set<string>();
  const unknownAcs: string[] = [];
  for (const t of tasks) {
    for (const ac of t.satisfies) {
      cited.add(ac);
      if (!contractAcIds.has(ac)) unknownAcs.push(`${t.id} -> ${ac}`);
    }
  }
  if (unknownAcs.length > 0) reasons.push(`unknown acceptance criterion ids: ${unknownAcs.join(', ')}`);
  const uncoveredAcs = [...contractAcIds].filter((id) => !cited.has(id));
  if (uncoveredAcs.length > 0) reasons.push(`uncovered acceptance criteria: ${uncoveredAcs.join(', ')}`);

  // 3.4 orphan tasks — no AC and not declared enabling.
  const orphanTasks = tasks.filter((t) => t.satisfies.length === 0 && !t.enabling).map((t) => t.id);
  if (orphanTasks.length > 0) reasons.push(`orphan tasks (empty satisfies, not enabling): ${orphanTasks.join(', ')}`);

  // 3.5 unknown dependency edge / 3.10 self-reference.
  const knownIds = new Set(tasks.map((t) => t.id));
  const deps = new Map<string, string[]>();
  for (const t of tasks) {
    const resolvable: string[] = [];
    for (const dep of t.dependsOn) {
      if (dep === t.id) {
        reasons.push(`task ${t.id} depends on itself`);
      } else if (!knownIds.has(dep)) {
        reasons.push(`unknown dependency edge: ${t.id} -> ${dep}`);
      } else {
        resolvable.push(dep);
      }
    }
    deps.set(t.id, resolvable);
  }

  // 3.12 the artifact must be a DAG.
  const onCycle = unorderableTaskIds(
    tasks.map((t) => t.id),
    deps,
  );
  if (onCycle.length > 0) reasons.push(`dependency cycle involving: ${onCycle.join(', ')}`);

  // 3.6 first runtime consumer of the contract's max_total_tasks cap.
  if (tasks.length > contract.budget.maxTotalTasks) {
    reasons.push(`task count ${tasks.length} exceeds budget.max_total_tasks ${contract.budget.maxTotalTasks}`);
  }

  // 3.7 per-task diff budget ceiling (keeps tasks small at the source).
  for (const t of tasks) {
    if (t.diffBudget !== undefined && t.diffBudget > maxDiffBudgetPerTask) {
      reasons.push(`task ${t.id} diff_budget ${t.diffBudget} exceeds checks.max_diff_budget_per_task ${maxDiffBudgetPerTask}`);
    }
  }

  // 3.8 planning-time risk ceiling; the runtime approval flow is unchanged.
  const ceiling = RISK_LEVELS.indexOf(contract.risk);
  for (const t of tasks) {
    if (t.risk !== undefined && RISK_LEVELS.indexOf(t.risk) > ceiling) {
      reasons.push(`task ${t.id} risk ${t.risk} exceeds contract risk ${contract.risk}`);
    }
  }

  // 3.13 multi-task deploy semantics are undefined this stage — recorded ceiling.
  if (contract.deploy !== undefined) {
    reasons.push('contract carries a deploy block; a deploy goal cannot run as a task graph this stage');
  }

  if (reasons.length > 0) throw new TaskGraphGateError(reasons);

  const graphHash = createHash('sha256').update(rawBytes).digest('hex');
  const frozen: TaskGraphTask[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    satisfies: t.satisfies,
    dependsOn: t.dependsOn,
    enabling: t.enabling,
    risk: t.risk ?? contract.risk,
    diffBudget: t.diffBudget ?? maxDiffBudgetPerTask,
  }));

  return {
    graph: { goalId, tasks: frozen, checks: { maxDiffBudgetPerTask }, graphHash },
    gate: { graphHash, taskIds: frozen.map((t) => t.id), uncoveredAcs: [], orphanTasks: [] },
  };
}
