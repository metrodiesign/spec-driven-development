// State machine (spec §6.3, REQ-7) as a pure transition table. No code path lets
// an agent claim set COMPLETED (INV-2); post-REVIEWING transitions are phase-gated.

import type { TaskState } from '../types.ts';

export type TransitionResult =
  | { ok: true; next: TaskState }
  | { ok: false; reason: 'illegal_transition' | 'not_enabled_phase0'; detail: string };

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
  | 'pause'
  | 'resume';

export function transition(_state: TaskState, _trigger: Trigger): TransitionResult {
  throw new Error('NotImplemented: transition');
}
