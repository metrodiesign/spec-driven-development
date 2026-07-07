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
  // `auto_approved` (Phase 2, REQ-7.2) is fired by core/merge policy ONLY. It has
  // no ports.ts doorway, so no agent claim can reach it (REQ-7.3, INV-2).
  | 'auto_approved'
  | 'merge_queued'
  | 'audited'
  | 'completed'
  | 'block'
  | 'escalate'
  | 'cancel'
  | 'roll_back'
  | 'quarantine'
  | 'pause';

// MERGE_QUEUED and AUDITED are ACTIVE (REQ-7.8) so `escalate`/`roll_back` are legal
// from them — the merge_conflict (REQ-7.5) and audit_mismatch (REQ-8.3) paths.
// Exported: PAUSED is entered from EVERY active state (REQ-10.2) and resume must
// restore one of these (REQ-10.3); the steering property test iterates the set.
export const ACTIVE_STATES: TaskState[] = [
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
  'MERGE_QUEUED',
  'AUDITED',
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
  REVIEWING: {
    changes_requested: 'CHANGES_REQUESTED',
    human_approved: 'APPROVED',
    auto_approved: 'APPROVED',
  },
  CHANGES_REQUESTED: { repair: 'REPAIRING' },
  APPROVED: { merge_queued: 'MERGE_QUEUED' },
  MERGE_QUEUED: { audited: 'AUDITED' },
  AUDITED: { completed: 'COMPLETED' },
};

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
  const universal = UNIVERSAL[trigger];
  if (universal !== undefined) {
    // Universal escapes are legal from every active state and from PAUSED — a paused
    // task can still be killed/escalated (REQ-10.7: kill while paused terminates via
    // `cancel`), never from a terminal state.
    if (ACTIVE_STATES.includes(state) || state === 'PAUSED') return { ok: true, next: universal };
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

/**
 * Resume from a pause (REQ-10.3). The target is DATA — the pre-pause state recorded
 * in `PAUSE_REQUESTED {prePauseState}` — not a static trigger, so it lives beside
 * `transition()`. Legal ONLY from PAUSED and ONLY to a member of ACTIVE_STATES
 * (PAUSED is a dead-end in the table otherwise; a terminal is never a resume target).
 */
export function resumeTransition(state: TaskState, prePauseState: TaskState): TransitionResult {
  if (state !== 'PAUSED') {
    return { ok: false, reason: 'illegal_transition', detail: `resume not allowed from ${state}` };
  }
  if (!ACTIVE_STATES.includes(prePauseState)) {
    return { ok: false, reason: 'illegal_transition', detail: `resume target ${prePauseState} is not an active state` };
  }
  return { ok: true, next: prePauseState };
}
