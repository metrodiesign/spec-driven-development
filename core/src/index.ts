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
export { canaryTripped } from './security/canary.ts';
export {
  checkDataPolicy,
  type ProviderDataPolicy,
  type DataPolicyResult,
  type DataPolicyViolation,
} from './security/data-policy.ts';
export {
  CrashInjected,
  createExecutor,
  packageInstallAllowed,
  recoverWorktree,
  type DepInstallPolicy,
  type ExecuteOutcome,
  type Executor,
  type Failpoints,
  type RecoveryReport,
  type ToolHandler,
} from './executor/executor.ts';
export { createGateRunner, type GateRunner } from './gates/runner.ts';
export { computeGoldenManifest, verifyGoldenManifest, type GoldenVerdict } from './gates/golden.ts';
export { createBudget, type BudgetTracker } from './budget/budget.ts';
export { ACTIVE_STATES, resumeTransition, transition, type TransitionResult, type Trigger } from './orchestrator/machine.ts';
export { createLoopController, type LoopController } from './orchestrator/control.ts';
export {
  runTaskLoop,
  type LoopOptions,
  type LoopResult,
  type RepairPolicy,
} from './orchestrator/loop.ts';
export {
  evaluateHypotheses,
  summarizeHypothesisLog,
  type HypothesisEngineDeps,
  type HypothesisOutcome,
} from './repair/hypothesis.ts';
export { scanForSecret, type SecretHit } from './context/secret-scan.ts';
export {
  buildContext,
  computeContextMetrics,
  serializeBundle,
  SecretInContextError,
  type ContextBuildInput,
  type ContextBuildResult,
} from './context/builder.ts';
export {
  freezeContract,
  contractChanged,
  ContractInvalidError,
  type TaskContract,
} from './contract/contract.ts';
export {
  approveProposal,
  applyGovernanceApproval,
  computePolicySnapshot,
  ensureGovernanceApproved,
  listPendingProposals,
  pendingQuarantines,
  proposeFlakyQuarantine,
  readGovernanceLog,
  seedFixtureSnapshot,
  snapshotHash,
  POLICY_FILES,
  type GovernanceKind,
  type GovernanceProposal,
  type GovernanceRecord,
  type GovernanceChangeRecord,
  type PolicySnapshot,
  type EnsureResult,
  type ApproveResult,
  type DecidedBy,
} from './governance/policy.ts';
export { redactSecrets } from './human/redact.ts';
export {
  attestationsFor,
  buildApprovalPackage,
  type ApprovalPackage,
  type ApprovalInput,
  type ApprovalResult,
  type RiskClass,
} from './human/approval.ts';
export {
  handleHumanRequest,
  createHumanPlaneServer,
  type HandlerDeps,
  type HttpLike,
  type HttpResult,
  type HumanPlaneServer,
} from './human/api.ts';
export {
  runDeployStage,
  runManualRollback,
  type DeployClock,
  type DeployOutcome,
  type DeployRootCause,
  type DeployRootCauseTrigger,
  type DeployStageDeps,
  type DeployState,
  type DeployTrigger,
} from './deploy/stage.ts';
export {
  computeCalibration,
  computeFusionCalibration,
  type CalibrationInput,
  type CalibrationResult,
  type FusionCalibrationInput,
  type FusionCalibrationResult,
} from './calibration/calibration.ts';
export {
  loadCalibrationCorpus,
  CORPUS_MIN_TASKS,
  type CalibrationCorpus,
  type CorpusTask,
} from './calibration/corpus.ts';
export {
  decideAutoApprove,
  matchesDepManifest,
  auditSampleValue,
  reproduces,
  runAutoMerge,
  runApprovedMerge,
  type AutoApproveInput,
  type AutoApproveDecision,
  type AutoApproveReason,
  type AutoMergeOutcome,
  type ApprovedMergeOptions,
  type ApprovedMergeOutcome,
  type MappedAc,
  type RunAutoMergeOptions,
} from './merge/auto-merge.ts';
export {
  createMergeQueue,
  type MergeCandidate,
  type MergeQueue,
  type MergeQueueOptions,
  type MergeQueueResult,
} from './merge/queue.ts';
export {
  runOobAudit,
  selectAuditTargets,
  type OobAuditorOptions,
  type OobVerdict,
} from './audit/oob.ts';
