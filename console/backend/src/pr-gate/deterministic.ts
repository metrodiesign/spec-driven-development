import { createHash } from 'node:crypto';

import type {
  CoreCommandExecutor,
  CoreCommandOutcome,
  PlannedCheckExecutor,
  PlannedCheckOutcome,
  Sha256Ref,
} from 'core';

function sha256RefFromEvidence(ref: string): Sha256Ref {
  const contentHash = /^blob:\/\/([0-9a-f]{64})$/u.exec(ref)?.[1];
  return contentHash === undefined
    ? `sha256:${createHash('sha256').update(ref).digest('hex')}`
    : `sha256:${contentHash}`;
}

function evidenceRef(outcome: CoreCommandOutcome): Sha256Ref {
  if (outcome.status === 'preflight_rejected' || outcome.status === 'capture_rejected') {
    return sha256RefFromEvidence(outcome.evidenceRef);
  }
  return sha256RefFromEvidence(outcome.evidence.outputRef);
}

function mapStatus(outcome: CoreCommandOutcome): PlannedCheckOutcome['status'] {
  if (outcome.status === 'completed') return outcome.exitCode === 0 ? 'PASSED' : 'FAILED';
  if (outcome.status === 'preflight_rejected' || outcome.status === 'capture_rejected') {
    if (outcome.reason === 'timed_out') return 'TIMED_OUT';
    if (outcome.reason === 'cancelled') return 'INFRASTRUCTURE_FAILURE';
    return outcome.reason === 'sandbox_unavailable' ? 'INFRASTRUCTURE_FAILURE' : 'FAILED';
  }
  if (outcome.status === 'sandbox_violation') return 'FAILED';
  if (outcome.status === 'signaled' || outcome.status === 'command_failed') return 'FAILED';
  return 'PASSED';
}

export function createCorePlannedCheckExecutor(input: {
  executor: CoreCommandExecutor;
  worktreeDir: string;
  additionalInputRoots?: readonly string[];
  now?: () => number;
}): PlannedCheckExecutor {
  const now = input.now ?? Date.now;
  return {
    async execute(check, signal) {
      const startedAt = now();
      const outcome = await input.executor.execute(
        {
          type: 'RUN_COMMAND',
          actionId: `pr-check-${createHash('sha256').update(`${check.id}\0${check.command}`).digest('hex').slice(0, 16)}`,
          cmd: check.command,
          ...(check.cwd === undefined ? {} : { cwd: check.cwd }),
          network: 'none',
          timeoutMs: check.timeoutMs,
        },
        {
          worktreeDir: input.worktreeDir,
          role: 'implementer',
          classification: 'gate_check',
          ...(input.additionalInputRoots === undefined
            ? {}
            : { additionalInputRoots: input.additionalInputRoots }),
          signal,
        },
      );
      if (signal.aborted && (outcome.status === 'preflight_rejected' || outcome.status === 'capture_rejected')) {
        throw signal.reason;
      }
      return {
        status: mapStatus(outcome),
        durationMs: Math.max(0, now() - startedAt),
        evidenceRef: evidenceRef(outcome),
      };
    },
  };
}
