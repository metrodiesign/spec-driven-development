// Deterministic executor (spec §6.1, REQ-1/2/6). Exactly-once semantics:
// snapshot-before-intent (git recovery ref) -> ACTION_INTENT{snapshotRef} ->
// apply -> ACTION_APPLIED{resultHash}. Recovery is rollback-then-rerun, which is
// sound even for non-idempotent RUN_COMMAND. Duplicate actionIds skip idempotently.

import type { EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { PathPolicy } from './path-policy.ts';
import type { SandboxWrap } from '../security/sandbox.ts';
import type { Action, ActionRejection, Clock, Role } from '../types.ts';

export type ExecuteOutcome =
  | {
      status: 'applied';
      actionId: string;
      resultHash: string;
      outputRef?: string;
      exitCode?: number;
      /** True when the command ran inside the deny-network sandbox (egress denied by construction). */
      egressBlocked?: boolean;
    }
  | { status: 'skipped_duplicate'; actionId: string }
  | { status: 'rejected'; rejection: ActionRejection };

/** Deterministic failure injection for the crash-recovery scenarios (DoD#6). */
export interface Failpoints {
  crashAfterIntent?: boolean;
  crashAfterApply?: boolean;
}

export class CrashInjected extends Error {
  constructor(point: string) {
    super(`crash injected: ${point}`);
  }
}

export interface Executor {
  execute(action: Action, role: Role): Promise<ExecuteOutcome>;
}

export interface ExecutorOptions {
  worktreeDir: string;
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  policy: PathPolicy;
  sandbox: SandboxWrap;
  clock: Clock;
  failpoints?: Failpoints;
}

export function createExecutor(_opts: ExecutorOptions): Executor {
  throw new Error('NotImplemented: createExecutor');
}

export interface RecoveryReport {
  action: 'none' | 'replayed_intent' | 'rolled_back';
  detail: string;
}

/** Replay-based crash recovery (spec §6.2, REQ-6.2/6.4). */
export function recoverWorktree(_opts: Omit<ExecutorOptions, 'failpoints' | 'sandbox' | 'policy'> & {
  policy: PathPolicy;
  sandbox: SandboxWrap;
}): Promise<RecoveryReport> {
  throw new Error('NotImplemented: recoverWorktree');
}
