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
export { createRouter, NoCapacityError, type Router } from './router.ts';
export { createAALProposalSource, type AALSourceDeps } from './source.ts';
export {
  runProbe,
  runP7,
  runConformanceSuite,
  type ProbeContext,
  type P7Result,
} from './conformance/harness.ts';
