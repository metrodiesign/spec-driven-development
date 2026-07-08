// Ring 1 public surface (Agent Abstraction Layer — vendor-neutral by law, INV-7).
export const RING = 1 as const;

export * from './protocol.ts';
export { FakeAdapter, type FakeAdapterOptions, type FakeBehavior, type FakeFault } from './fake-adapter.ts';
export {
  proposeWithRepair,
  validateAgainstSchema,
  type RepairOutcome,
} from './repair.ts';
export {
  createBreaker,
  breakerKey,
  DEFAULT_BREAKER_OPTIONS,
  type Breaker,
  type BreakerOptions,
  type BreakerState,
  type BreakerSink,
  type BreakerTransition,
} from './breaker.ts';
export {
  createRegistry,
  type Registry,
  type RegisteredAdapter,
  type RegistryOptions,
  type HealthChange,
  type AdapterHealth,
} from './registry.ts';
export { createRouter, NoCapacityError, type Router, type RouteHints } from './router.ts';
export { createTokenBucket, type TokenBucket, type TokenBucketOptions } from './ratelimit.ts';
export {
  createDispatcher,
  type DispatcherOptions,
  type DispatchItem,
  type DispatchResult,
} from './dispatch.ts';
export {
  loadRoutingConfig,
  parseRoutingConfig,
  DEFAULT_ROUTING_CONFIG,
  type RoutingConfig,
  type RoutingBucketConfig,
} from './routing-config.ts';
export { createAALProposalSource, type AALSourceDeps } from './source.ts';
export {
  runProbe,
  runP7,
  runConformanceSuite,
  type ProbeContext,
  type P7Result,
} from './conformance/harness.ts';
// Fusion plane (Ring 1, §7.5; REQ-8/9/10). Pure orchestration — executes nothing;
// candidate gate evidence arrives through the CandidateEvidenceRunner port (INV-1/2).
export {
  loadFusionProfiles,
  parseFusionProfiles,
  parseFusionProfile,
  RESOLVE_FOR,
  FusionProfileError,
  type FusionArtifact,
  type ResolveRule,
  type FusionProfile,
  type PanelDiversity,
} from './fusion/profiles.ts';
export {
  DELIBERATION_ANALYSIS_SCHEMA,
  DELIBERATION_KEYS,
  asDeliberation,
  type DeliberationAnalysis,
} from './fusion/schema.ts';
export {
  resolveCodeDiff,
  resolveTests,
  resolveHypotheses,
  resolveReviews,
  resolvePlan,
  resolveMechanical,
  judgeLoadBearing,
  type PanelCandidate,
  type Resolution,
  type DissentItem,
} from './fusion/resolve.ts';
export {
  runFusion,
  type FusionDeps,
  type FusionOutcome,
  type FusionEscalateReason,
  type CandidateEvidenceRunner,
} from './fusion/run.ts';
