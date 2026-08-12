import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CoreCommandExecutor, DeterministicCheckSpec } from 'core';

import { createCorePlannedCheckExecutor } from './deterministic.ts';

const check: DeterministicCheckSpec = {
  id: 'test',
  kind: 'test',
  command: 'pnpm test',
  cwd: 'packages/app',
  required: true,
  timeoutMs: 1000,
  network: 'none',
  install: false,
  profiles: ['node'],
  components: ['app'],
};

describe('core planned-check adapter', () => {
  it('REQ-4 passes exact trusted command through gate_check with network denied', async () => {
    let observed: unknown;
    const executor: CoreCommandExecutor = {
      environmentHash: 'env',
      async execute(action, context) {
        observed = { action, context: { ...context, signal: undefined } };
        return {
          status: 'completed',
          exitCode: 0,
          signal: null,
          evidence: {
            outputRef: `blob://${'a'.repeat(64)}`,
            networkPolicyHash: 'network',
            environmentHash: 'env',
            backend: {
              inheritedFilesystemAndNetworkPolicy: true,
              denialObservation: 'direct_only',
              revocableDescendantContainment: false,
              descendantTermination: 'unproven_new_session',
            },
            observedViolation: null,
          },
        };
      },
    };
    const result = await createCorePlannedCheckExecutor({ executor, worktreeDir: '/snapshot', additionalInputRoots: ['node_modules'], now: () => 5 }).execute(
      check,
      new AbortController().signal,
    );
    assert.deepEqual(observed, {
      action: {
        type: 'RUN_COMMAND',
        actionId: 'pr-check-fc79fbdf737f83ae',
        cmd: 'pnpm test',
        cwd: 'packages/app',
        network: 'none',
        timeoutMs: 1000,
      },
      context: {
        worktreeDir: '/snapshot',
        role: 'implementer',
        classification: 'gate_check',
        additionalInputRoots: ['node_modules'],
        signal: undefined,
      },
    });
    assert.equal(result.status, 'PASSED');
    assert.equal(result.evidenceRef, `sha256:${'a'.repeat(64)}`);
  });

  it('REQ-4 maps sandbox unavailability to infrastructure failure', async () => {
    const executor: CoreCommandExecutor = {
      environmentHash: undefined,
      async execute() {
        return {
          status: 'preflight_rejected',
          reason: 'sandbox_unavailable',
          detail: 'unavailable',
          evidenceRef: `blob://${'b'.repeat(64)}`,
        };
      },
    };
    const result = await createCorePlannedCheckExecutor({ executor, worktreeDir: '/snapshot' }).execute(
      check,
      new AbortController().signal,
    );
    assert.equal(result.status, 'INFRASTRUCTURE_FAILURE');
  });
});
