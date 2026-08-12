import type { EvidenceStore } from '../evidence/store.ts';
import { denyNetworkSandbox } from '../security/sandbox.ts';
import { createCommandRunner } from '../security/command-runner.ts';
import { createCoreCommandExecutor, type CoreCommandExecutor } from './command-executor.ts';
import { createDefaultPathPolicy } from './path-policy.ts';

/** Production-safe composition: callers cannot substitute a permissive sandbox or path policy. */
export function createDefaultCoreCommandExecutor(input: {
  evidence: EvidenceStore;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}): CoreCommandExecutor {
  const sandbox = denyNetworkSandbox(process.platform);
  return createCoreCommandExecutor({
    evidence: input.evidence,
    policy: createDefaultPathPolicy(),
    sandbox,
    commandRunner: createCommandRunner({
      sandbox,
      evidence: input.evidence,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
