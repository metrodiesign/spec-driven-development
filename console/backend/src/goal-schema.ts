// Goal Contract shape validation at the composition root (platform-phase5-stage2
// REQ-2). Embedded here so the edge validates without reading the repo at runtime
// (REQ-2.5); the governance copy lives at `.ai/schemas/goal.schema.json` and MUST
// stay deep-equal (co-located test asserts full equality — REQ-6.1). Shape only:
// cross-field semantics (failure_threshold < probes, risk default) stay in core
// `freezeContract`, which remains the final gate (REQ-2.4). Unknown keys are
// rejected — this deliberately supersedes Phase-1 REQ-8.4 preserve-and-ignore at
// the load edge; forward-compat proceeds via schema amendment (REQ-2.6).

import { Ajv, type ValidateFunction } from 'ajv';

export const GOAL_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'goal.schema.json',
  $comment:
    'Goal Contract governance schema (unified-platform-spec.md §11.1, platform-phase5-stage2 REQ-1). Shape only: cross-field rules (failure_threshold < probes) stay in core freezeContract (REQ-1.8/REQ-2.4). Strict everywhere (additionalProperties:false) with exactly one exception: constraints.stack is a free-form string map (REQ-1.2). Supersedes Phase-1 REQ-8.4 preserve-and-ignore at the load edge: unknown keys are rejected, forward-compat proceeds via schema amendment (REQ-2.6). The embedded copy GOAL_SCHEMA in console/backend/src/goal-schema.ts MUST stay deep-equal to this file; the co-located test asserts full deep equality (REQ-6.1).',
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'acceptance_criteria', 'budget'],
  properties: {
    goal: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string' },
        objective: { type: 'string' },
      },
    },
    business_outcomes: {
      type: 'array',
      items: { type: 'string' },
    },
    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include: { type: 'array', items: { type: 'string' } },
        exclude: { type: 'array', items: { type: 'string' } },
      },
    },
    constraints: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stack: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        forbidden: { type: 'array', items: { type: 'string' } },
      },
    },
    acceptance_criteria: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description'],
        properties: {
          id: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          verification: { type: 'string' },
          golden: { type: 'boolean' },
        },
      },
    },
    quality_gates: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ladder: { type: 'string' },
        mutation: {
          type: 'object',
          additionalProperties: false,
          properties: {
            min_score_on_changed_files: { type: 'number' },
            tier: { type: 'string' },
          },
        },
        security: { type: 'string' },
        fusion: { type: 'string' },
      },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      required: [
        'max_iterations_per_task',
        'max_hypotheses_per_failure',
        'max_total_tasks',
        'max_parallel_agents',
        'max_cost_units_per_task',
        'max_wallclock_per_task_min',
      ],
      properties: {
        max_iterations_per_task: { type: 'integer', minimum: 1 },
        max_hypotheses_per_failure: { type: 'integer', minimum: 1 },
        max_total_tasks: { type: 'integer', minimum: 1 },
        max_parallel_agents: { type: 'integer', minimum: 1 },
        max_cost_units_per_task: { type: 'integer', minimum: 1 },
        max_wallclock_per_task_min: { type: 'integer', minimum: 1 },
      },
    },
    approval_policy: {
      type: 'object',
      additionalProperties: false,
      required: ['require_human_approval'],
      properties: {
        require_human_approval: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
    deploy: {
      type: 'object',
      additionalProperties: false,
      required: ['canary_cmd', 'observe_cmd', 'expand_cmd', 'rollback_cmd', 'observe'],
      properties: {
        canary_cmd: { type: 'string', minLength: 1 },
        observe_cmd: { type: 'string', minLength: 1 },
        expand_cmd: { type: 'string', minLength: 1 },
        rollback_cmd: { type: 'string', minLength: 1 },
        observe: {
          type: 'object',
          additionalProperties: false,
          required: ['probes', 'failure_threshold', 'interval_ms'],
          properties: {
            probes: { type: 'integer' },
            failure_threshold: { type: 'integer' },
            interval_ms: { type: 'number' },
          },
        },
      },
    },
    risk: { enum: ['L0', 'L1', 'L2', 'L3', 'L4'] },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['spec_path', 'requirements_commit', 'generated_at'],
      properties: {
        spec_path: { type: 'string', minLength: 1 },
        requirements_commit: { type: 'string', minLength: 1 },
        requirements_sha256: { type: 'string', minLength: 1 },
        generated_at: { type: 'string', minLength: 1 },
      },
    },
  },
};

// Compiled once at module load; ajv is edge-only (console/backend) — core/aal gain
// no dependency (REQ-2.3).
const ajv = new Ajv({ allErrors: true });
const validate: ValidateFunction = ajv.compile(GOAL_SCHEMA);

/**
 * Validate a parsed goal.yaml object against the Goal Contract schema. Returns []
 * when valid; otherwise one entry per failure — EVERY failing instance path, not
 * just the first (REQ-2.2). Unknown-property failures name the offending key.
 */
export function validateGoalShape(parsed: unknown): string[] {
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
