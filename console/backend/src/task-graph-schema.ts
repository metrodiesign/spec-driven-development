// Task Graph shape validation at the composition root (platform-phase5-stage4
// REQ-1). Embedded here so the edge validates without reading the repo at runtime;
// the governance copy lives at `.ai/schemas/task-graph.schema.json` and MUST stay
// deep-equal (co-located test asserts full equality — REQ-1.2). Shape only: the
// planning gate (uncovered ACs, orphans, cycles, ceilings, goal binding) stays in
// core `freezeTaskGraph`, which remains the final gate (REQ-3). Unknown keys are
// rejected at every level, same posture as the goal schema (REQ-1.4).

import { Ajv, type ValidateFunction } from 'ajv';

export const TASK_GRAPH_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'task-graph.schema.json',
  $comment:
    'Task Graph governance schema (unified-platform-spec.md §11.2, platform-phase5-stage4 REQ-1). Shape only: the planning gate (unknown/uncovered ACs, orphan tasks, dependency cycles, budget/risk ceilings, goal_id binding) stays in core freezeTaskGraph (REQ-3). Strict everywhere (additionalProperties:false); an empty `satisfies` array is shape-legal because orphan tasks are decided at freeze, not here (REQ-3.4). Task ids (and the `depends_on` entries naming them) are constrained to a branch-safe charset because each id becomes a `task/<id>` branch; the remaining ref rules a charset cannot express (`..`, a `.lock` suffix) are checked at freeze (REQ-1.1/3.15). The embedded copy TASK_GRAPH_SCHEMA in console/backend/src/task-graph-schema.ts MUST stay deep-equal to this file; the co-located test asserts full deep equality (REQ-1.2).',
  type: 'object',
  additionalProperties: false,
  required: ['goal_id', 'tasks', 'checks'],
  properties: {
    goal_id: { type: 'string', minLength: 1 },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'satisfies'],
        properties: {
          id: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
          title: { type: 'string', minLength: 1 },
          satisfies: { type: 'array', items: { type: 'string', minLength: 1 } },
          depends_on: { type: 'array', items: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' } },
          enabling: { type: 'boolean' },
          risk: { enum: ['L0', 'L1', 'L2', 'L3', 'L4'] },
          diff_budget: { type: 'integer', minimum: 1 },
        },
      },
    },
    checks: {
      type: 'object',
      additionalProperties: false,
      required: ['max_diff_budget_per_task'],
      properties: {
        max_diff_budget_per_task: { type: 'integer', minimum: 1 },
      },
    },
  },
};

// Compiled once at module load; this file owns its own ajv instance so the goal
// schema's compiled validator is untouched. ajv is edge-only (console/backend) —
// core/aal gain no dependency (INV-7).
const ajv = new Ajv({ allErrors: true });
const validate: ValidateFunction = ajv.compile(TASK_GRAPH_SCHEMA);

/**
 * Validate a parsed task-graph.json object against the Task Graph schema. Returns
 * [] when valid; otherwise one entry per failure — EVERY failing instance path,
 * not just the first (REQ-1.3). Unknown-property failures name the offending key.
 */
export function validateTaskGraphShape(parsed: unknown): string[] {
  if (validate(parsed) === true) return [];
  return (validate.errors ?? []).map((e) => {
    const path = e.instancePath === '' ? '/' : e.instancePath;
    const extra =
      e.keyword === 'additionalProperties' && typeof e.params['additionalProperty'] === 'string'
        ? ` (${e.params['additionalProperty']})`
        : '';
    return `${path}: ${e.message ?? 'invalid'}${extra}`;
  });
}
