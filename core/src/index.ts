// Ring 0 public surface (vendor-neutral — INV-7).
export * from './types.ts';
export * from './ports.ts';
export { openEventLog, type EventLog, type ProjectionState } from './state/event-log.ts';
export { createLeaseManager, type LeaseManager } from './state/lease.ts';
export { createEvidenceStore, type EvidenceStore } from './evidence/store.ts';
export {
  createDefaultPathPolicy,
  type PathPolicy,
  type PolicyDecision,
} from './executor/path-policy.ts';
export { denyNetworkSandbox, type SandboxWrap } from './security/sandbox.ts';
export {
  CrashInjected,
  createExecutor,
  recoverWorktree,
  type ExecuteOutcome,
  type Executor,
  type Failpoints,
  type RecoveryReport,
} from './executor/executor.ts';
export { createGateRunner, type GateRunner } from './gates/runner.ts';
export { computeGoldenManifest, verifyGoldenManifest, type GoldenVerdict } from './gates/golden.ts';
export { createBudget, type BudgetTracker } from './budget/budget.ts';
export { transition, type TransitionResult, type Trigger } from './orchestrator/machine.ts';
export { runTaskLoop, type LoopOptions, type LoopResult } from './orchestrator/loop.ts';
