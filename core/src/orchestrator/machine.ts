// State machine (spec §6.3, REQ-7) as a pure transition table. No code path lets
// an agent claim set COMPLETED (INV-2); post-REVIEWING transitions are phase-gated.

import type { TaskState } from '../types.ts';

export type TransitionResult =
  | { ok: true; next: TaskState }
  | {
      ok: false;
      reason: 'illegal_transition' | 'not_enabled_phase0' | 'not_enabled_phase1';
      detail: string;
    };

/** Trigger names are core-internal facts (gate results, human acts) — never agent claims. */
export type Trigger =
  | 'analyze'
  | 'ready'
  | 'start_implementing'
  | 'verify'
  | 'gate_failed'
  | 'gate_passed'
  | 'diagnose'
  | 'repair'
  | 'review'
  | 'changes_requested'
  | 'human_approved'
  | 'merge_queued'
  | 'audited'
  | 'completed'
  | 'block'
  | 'escalate'
  | 'cancel'
  | 'roll_back'
  | 'quarantine'
  | 'pause';

const ACTIVE_STATES: TaskState[] = [
  'PROPOSED',
  'ANALYZING',
  'READY',
  'IMPLEMENTING',
  'VERIFYING',
  'FAILED',
  'DIAGNOSING',
  'REPAIRING',
  'PASSED',
  'REVIEWING',
  'CHANGES_REQUESTED',
];

const TABLE: Partial<Record<TaskState, Partial<Record<Trigger, TaskState>>>> = {
  PROPOSED: { analyze: 'ANALYZING' },
  ANALYZING: { ready: 'READY' },
  READY: { start_implementing: 'IMPLEMENTING' },
  IMPLEMENTING: { verify: 'VERIFYING' },
  VERIFYING: { gate_failed: 'FAILED', gate_passed: 'PASSED' },
  FAILED: { diagnose: 'DIAGNOSING' },
  DIAGNOSING: { repair: 'REPAIRING' },
  REPAIRING: { verify: 'VERIFYING' },
  PASSED: { review: 'REVIEWING' },
  REVIEWING: { changes_requested: 'CHANGES_REQUESTED', human_approved: 'APPROVED' },
  CHANGES_REQUESTED: { repair: 'REPAIRING' },
  APPROVED: { merge_queued: 'MERGE_QUEUED' },
  MERGE_QUEUED: { audited: 'AUDITED' },
  AUDITED: { completed: 'COMPLETED' },
};

// Phase 1 ENABLES human_approved (REVIEWING -> APPROVED) via the Human Plane API
// (REQ-10.2). Post-APPROVED integration (merge queue / auditor) stays gated —
// Phase 3 (REQ-11.5). Listing them keeps refusal explicit, never silent.
const PHASE_GATED: ReadonlySet<Trigger> = new Set(['merge_queued', 'audited', 'completed']);

/** Special transitions available from every active state (spec §6.3). */
const UNIVERSAL: Partial<Record<Trigger, TaskState>> = {
  block: 'BLOCKED',
  escalate: 'ESCALATED',
  cancel: 'CANCELLED',
  roll_back: 'ROLLED_BACK',
  quarantine: 'QUARANTINED',
  pause: 'PAUSED',
};

export function transition(state: TaskState, trigger: Trigger): TransitionResult {
  if (PHASE_GATED.has(trigger)) {
    return {
      ok: false,
      reason: 'not_enabled_phase1',
      detail: `trigger ${trigger} is enabled in a later phase (REQ-11.5)`,
    };
  }
  const universal = UNIVERSAL[trigger];
  if (universal !== undefined) {
    if (ACTIVE_STATES.includes(state)) return { ok: true, next: universal };
    return {
      ok: false,
      reason: 'illegal_transition',
      detail: `${trigger} not allowed from terminal state ${state}`,
    };
  }
  const next = TABLE[state]?.[trigger];
  if (next === undefined) {
    return {
      ok: false,
      reason: 'illegal_transition',
      detail: `no transition for trigger ${trigger} from state ${state}`,
    };
  }
  return { ok: true, next };
}
