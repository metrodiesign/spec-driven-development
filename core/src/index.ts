// Ring 0 public surface (vendor-neutral — INV-7).
export * from './types.ts';
export * from './ports.ts';
export {
  openEventLog,
  LeaseFenceError,
  type EventLog,
  type FencedEventClaim,
  type ProjectionState,
} from './state/event-log.ts';
export {
  acquireTaskLease,
  createLeaseManager,
  createTaskLeaseSession,
  isLeaseTtlValid,
  LeaseConfigurationError,
  LEASE_SAFETY_MARGIN_MS,
  type LeaseClaim,
  type LeaseManager,
  type TaskLeaseSession,
} from './state/lease.ts';
export {
  createEvidenceStore,
  EvidenceStoreError,
  type EvidenceStore,
  type EvidenceStoreErrorCode,
} from './evidence/store.ts';
export {
  canonicalEvidenceBytes,
  openEvidenceAuthenticator,
  EvidenceAuthenticationError,
  type EvidenceAuthenticator,
  type EvidenceAuthErrorCode,
  type FrozenRunMetadata,
  type OpenEvidenceAuthenticatorOptions,
} from './evidence/auth.ts';
export {
  createReportIntegrity,
  ReportIntegrityError,
  type GateReportIdentity,
  type ReportIntegrity,
  type ReportIntegrityErrorCode,
} from './gates/report-integrity.ts';
export {
  createDefaultPathPolicy,
  normalizeWorktreeRelativePath,
  type PathPolicy,
  type PolicyDecision,
} from './executor/path-policy.ts';
export {
  createRedArtifactStore,
  createCoreRedObservation,
  RedArtifactError,
  type FrozenRedArtifactIndex,
  type RedArtifactRecord,
  type RedArtifactSourceRole,
  type RedArtifactStore,
  type RedObservation,
} from './gates/red-provenance.ts';
export {
  checkConvention,
  DEFAULT_CONVENTION_POLICY,
  parseConventionPolicy,
  ConventionPolicyError,
  type ConventionAllowedControl,
  type ConventionPolicy,
  type ConventionResult,
  type ConventionRule,
  type ConventionViolation,
} from './gates/convention.ts';
export {
  createCoreCommandExecutor,
  PHASE0_COMMAND_ARTIFACT_POLICY,
  type CapturedCommandArtifact,
  type CommandArtifactPolicy,
  type CommandCaptureFailpoints,
  type CommandCapturePhase,
  type CommandEvidence,
  type CoreCommandExecutor,
  type CoreCommandOutcome,
  type OfflineDependencyPolicy,
  type SandboxBackendCapabilities,
  type TrustedCommandContext,
} from './executor/command-executor.ts';
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
  recoverWorktree,
  type ExecuteOutcome,
  type Executor,
  type Failpoints,
  type RecoveryReport,
  type ToolHandler,
} from './executor/executor.ts';
export { createGateRunner, type GateRunner } from './gates/runner.ts';
export {
  copyOperatorGoldenFixture,
  verifyGoldenManifest,
  verifyGoldenManifests,
  verifyGoldenRoot,
  GoldenFixtureError,
  type GoldenFixtureErrorCode,
  type GoldenFixtureProvenance,
  type GoldenManifestCheckOptions,
  type GoldenManifestsVerdict,
  type GoldenVerdict,
} from './gates/golden.ts';
export {
  addCostUnits,
  createBudget,
  validateCostUnits,
  BudgetUsageError,
  type BudgetTracker,
  type CostValidation,
  type CostValidationReason,
} from './budget/budget.ts';
export { ACTIVE_STATES, resumeTransition, transition, type TransitionResult, type Trigger } from './orchestrator/machine.ts';
export { createLoopController, type LoopController } from './orchestrator/control.ts';
export {
  runTaskLoop,
  DEFAULT_REPAIR_POLICY,
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
  proposeLessonPromotion,
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
  bindGateReportToMerge,
  bindGateReportToTaskArtifact,
  verifyMergedArtifactBinding,
  verifyTaskArtifactBinding,
  type ArtifactBindingContext,
} from './merge/artifact-binding.ts';
export {
  computeCalibration,
  computeGoldenCoverage,
  computeFusionCalibration,
  computeLessonHitRate,
  type CalibrationInput,
  type CalibrationResult,
  type GoldenCoverage,
  type FusionCalibrationInput,
  type FusionCalibrationResult,
  type LessonHitRateStats,
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
export {
  freezeTaskGraph,
  TaskGraphGateError,
  type TaskGraph,
  type TaskGraphGateResult,
  type TaskGraphTask,
} from './graph/graph.ts';
export {
  selectNextTask,
  DEP_SATISFIED_STATES,
  type TaskProjection,
} from './graph/select.ts';
export {
  foldConfirmedHypotheses,
  loadApprovedLessons,
  promoteLesson,
  proposeLessonFromHypothesis,
  type ConfirmedHypothesis,
} from './lessons/lessons.ts';
