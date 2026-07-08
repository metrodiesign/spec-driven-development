// Merge queue (spec §6.5, REQ-13). Serializes candidate merges through the
// single-writer lease, runs T2 on the merged tree in a persistent integration
// worktree, and advances main only on a T2 pass. Batch size is 1 — attribution
// is always the one candidate; bisection only matters once batching exists
// (recorded ceiling, YAGNI now).

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { GateRunner } from '../gates/runner.ts';
import type { EventLog } from '../state/event-log.ts';
import type { LeaseManager } from '../state/lease.ts';
import type { GateReport } from '../types.ts';

const MERGE_QUEUE_LEASE_KEY = 'merge-queue';
// Generous ceiling for a full T2 run (build+scopedE2e+secretScan+fullGolden);
// no renewal — a single claim/release brackets one candidate.
const MERGE_QUEUE_LEASE_TTL_MS = 600_000;

export interface MergeCandidate {
  taskId: string;
  taskBranch: string;
  approvalBasis: 'auto_approved' | 'human_approved';
  originalReport: GateReport;
}

export interface MergeQueueOptions {
  runId: string;
  repoDir: string;
  mainBranch: string;
  /** Persistent integration worktree dir — created on first use, hard-reset+clean before every candidate (REQ-13.10). */
  worktreeDir: string;
  /** Bound to worktreeDir and this candidate's taskId (construct fresh per candidate). */
  gates: GateRunner;
  log: EventLog;
  lease: LeaseManager;
}

export interface MergeQueueResult {
  taskId: string;
  outcome: 'merged' | 'rejected_t2' | 'merge_conflict';
  mergeCommit: string | null;
  t2Report: GateReport | null;
  attribution: string;
}

export interface MergeQueue {
  process(candidate: MergeCandidate): Promise<MergeQueueResult>;
}

function git(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Reset the integration worktree to main's current head (REQ-13.10), before
 * EVERY candidate including after a prior abort. The worktree itself is set up
 * once ahead of time (`git worktree add`, alongside constructing `gates` —
 * both must exist before the queue's first `process()` call); this only
 * resets + cleans an existing one.
 */
function ensureWorktreeAtMainHead(opts: Pick<MergeQueueOptions, 'repoDir' | 'mainBranch' | 'worktreeDir'>): void {
  if (!existsSync(join(opts.worktreeDir, '.git'))) {
    throw new Error(
      `merge queue: integration worktree not set up at ${opts.worktreeDir} (expected \`git worktree add\` ahead of time)`,
    );
  }
  const mainHead = gitOut(opts.repoDir, 'rev-parse', opts.mainBranch);
  git(opts.worktreeDir, 'reset', '--hard', mainHead);
  git(opts.worktreeDir, 'clean', '-fdx');
  const status = gitOut(opts.worktreeDir, 'status', '--porcelain');
  if (status !== '') {
    throw new Error(`merge queue: integration worktree not clean after reset: ${status}`);
  }
}

export function createMergeQueue(opts: MergeQueueOptions): MergeQueue {
  return {
    async process(candidate: MergeCandidate): Promise<MergeQueueResult> {
      const ownerId = candidate.taskId;
      const claimed = opts.lease.claim(MERGE_QUEUE_LEASE_KEY, ownerId, MERGE_QUEUE_LEASE_TTL_MS);
      if (!claimed) {
        throw new Error(
          `merge queue: lease contention — another candidate holds the merge-queue lease (rejected ${candidate.taskId})`,
        );
      }
      try {
        opts.log.append({
          runId: opts.runId,
          taskId: candidate.taskId,
          type: 'MERGE_ENQUEUED',
          payload: {
            taskBranch: candidate.taskBranch,
            approvalBasis: candidate.approvalBasis,
            originalTier: candidate.originalReport.tier,
          },
        });

        ensureWorktreeAtMainHead(opts);

        const merge = git(opts.worktreeDir, 'merge', '--no-ff', '--no-edit', candidate.taskBranch);
        if (merge.code !== 0) {
          git(opts.worktreeDir, 'merge', '--abort');
          const result: MergeQueueResult = {
            taskId: candidate.taskId,
            outcome: 'merge_conflict',
            mergeCommit: null,
            t2Report: null,
            attribution: candidate.taskId,
          };
          opts.log.append({
            runId: opts.runId,
            taskId: candidate.taskId,
            type: 'MERGE_RESULT',
            payload: { outcome: result.outcome, attribution: result.attribution },
          });
          return result;
        }

        const t2Report = await opts.gates.run('T2');
        // Not-enabled T2 never blocks the merge — only a REAL, executed T2
        // failure does (AZ-7 posture carried into the queue).
        if (t2Report.pass === false) {
          const result: MergeQueueResult = {
            taskId: candidate.taskId,
            outcome: 'rejected_t2',
            mergeCommit: null,
            t2Report,
            attribution: candidate.taskId,
          };
          opts.log.append({
            runId: opts.runId,
            taskId: candidate.taskId,
            type: 'MERGE_RESULT',
            payload: { outcome: result.outcome, attribution: result.attribution, tier: 't2' },
          });
          return result;
        }

        const newCommit = gitOut(opts.worktreeDir, 'rev-parse', 'HEAD');
        git(opts.repoDir, 'update-ref', `refs/heads/${opts.mainBranch}`, newCommit);
        const tier = t2Report.pass === 'not_enabled' ? 't1_only' : 't2';
        const result: MergeQueueResult = {
          taskId: candidate.taskId,
          outcome: 'merged',
          mergeCommit: newCommit,
          t2Report,
          attribution: candidate.taskId,
        };
        opts.log.append({
          runId: opts.runId,
          taskId: candidate.taskId,
          type: 'MERGE_RESULT',
          payload: { outcome: result.outcome, mergeCommit: newCommit, tier },
        });
        return result;
      } finally {
        opts.lease.release(MERGE_QUEUE_LEASE_KEY, ownerId);
      }
    },
  };
}
