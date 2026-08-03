import { execFileSync } from 'node:child_process';

import {
  ReportIntegrityError,
  type GateReportIdentity,
  type ReportIntegrity,
} from '../gates/report-integrity.ts';
import type { AuthenticatedGateReport, GateReport } from '../types.ts';

export interface ArtifactBindingContext extends GateReportIdentity {
  repoDir: string;
  taskBranch: string;
  mainBranch: string;
}

function gitOut(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch (error) {
    throw new ReportIntegrityError(
      'artifact_identity_missing',
      `cannot resolve immutable Git artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function unsigned(report: AuthenticatedGateReport): GateReport {
  const copy = { ...report } as Record<string, unknown>;
  delete copy['auth'];
  return copy as unknown as GateReport;
}

function mismatch(message: string): never {
  throw new ReportIntegrityError('artifact_identity_mismatch', message);
}

function verifyMergeTopology(
  verified: AuthenticatedGateReport,
  mergeCommit: string,
  context: ArtifactBindingContext,
): void {
  if (typeof verified.artifactCommitHash !== 'string') {
    throw new ReportIntegrityError('artifact_identity_missing', 'merge report is missing its task artifact commit');
  }
  if (typeof verified.baseCommitHash !== 'string') {
    throw new ReportIntegrityError('artifact_identity_missing', 'merge report is missing its signed base commit');
  }
  const parents = gitOut(context.repoDir, 'rev-list', '--parents', '-1', mergeCommit).split(/\s+/).slice(1);
  if (parents[0] !== verified.baseCommitHash) {
    mismatch(
      `merge commit ${mergeCommit} first parent ${String(parents[0])} does not match signed base commit ${verified.baseCommitHash}`,
    );
  }
  if (!parents.slice(1).includes(verified.artifactCommitHash)) {
    mismatch(`merge commit ${mergeCommit} does not contain signed task parent ${verified.artifactCommitHash}`);
  }
}

/** Bind a freshly authenticated gate report to the current immutable task tip. */
export function bindGateReportToTaskArtifact(
  report: GateReport,
  integrity: ReportIntegrity,
  context: ArtifactBindingContext,
): AuthenticatedGateReport {
  const verified = integrity.verifyGateReport(report, context);
  const taskCommit = gitOut(context.repoDir, 'rev-parse', context.taskBranch);
  const baseCommit = gitOut(context.repoDir, 'rev-parse', context.mainBranch);
  const taskTree = gitOut(context.repoDir, 'rev-parse', `${taskCommit}^{tree}`);
  if (taskTree !== verified.worktreeHash) {
    mismatch(`signed worktree ${verified.worktreeHash} does not match task commit ${taskCommit} tree ${taskTree}`);
  }
  if (verified.artifactCommitHash !== undefined && verified.artifactCommitHash !== taskCommit) {
    mismatch(`signed task commit ${verified.artifactCommitHash} does not match current ${context.taskBranch} tip ${taskCommit}`);
  }
  if (verified.baseCommitHash !== undefined && verified.baseCommitHash !== baseCommit) {
    mismatch(`signed base commit ${verified.baseCommitHash} does not match current ${context.mainBranch} tip ${baseCommit}`);
  }
  if (verified.artifactCommitHash === taskCommit && verified.baseCommitHash === baseCommit) return verified;
  return integrity.signGateReport({
    ...unsigned(verified),
    artifactCommitHash: taskCommit,
    baseCommitHash: baseCommit,
  }, context);
}

/** Re-verify a previously bound task report immediately before approval or merge. */
export function verifyTaskArtifactBinding(
  report: GateReport,
  integrity: ReportIntegrity,
  context: ArtifactBindingContext,
): AuthenticatedGateReport {
  const verified = integrity.verifyGateReport(report, context);
  if (typeof verified.artifactCommitHash !== 'string' || verified.artifactCommitHash.length === 0) {
    throw new ReportIntegrityError('artifact_identity_missing', 'gate report is not bound to an immutable task commit');
  }
  if (typeof verified.baseCommitHash !== 'string' || verified.baseCommitHash.length === 0) {
    throw new ReportIntegrityError('artifact_identity_missing', 'gate report is not bound to an immutable target base commit');
  }
  gitOut(context.repoDir, 'cat-file', '-e', `${verified.baseCommitHash}^{commit}`);
  const currentBase = gitOut(context.repoDir, 'rev-parse', context.mainBranch);
  if (currentBase !== verified.baseCommitHash) {
    mismatch(`current ${context.mainBranch} tip ${currentBase} does not match signed base commit ${verified.baseCommitHash}`);
  }
  const currentTip = gitOut(context.repoDir, 'rev-parse', context.taskBranch);
  if (currentTip !== verified.artifactCommitHash) {
    mismatch(`current ${context.taskBranch} tip ${currentTip} does not match signed task commit ${verified.artifactCommitHash}`);
  }
  const taskTree = gitOut(context.repoDir, 'rev-parse', `${verified.artifactCommitHash}^{tree}`);
  if (taskTree !== verified.worktreeHash) {
    mismatch(`signed task commit ${verified.artifactCommitHash} tree ${taskTree} does not match gated tree ${verified.worktreeHash}`);
  }
  return verified;
}

/** Add the immutable merge commit to an already verified task-bound report. */
export function bindGateReportToMerge(
  report: AuthenticatedGateReport,
  mergeCommit: string,
  integrity: ReportIntegrity,
  context: ArtifactBindingContext,
): AuthenticatedGateReport {
  const verified = integrity.verifyGateReport(report, context);
  if (typeof verified.artifactCommitHash !== 'string') {
    throw new ReportIntegrityError('artifact_identity_missing', 'cannot bind merge without a task artifact commit');
  }
  verifyMergeTopology(verified, mergeCommit, context);
  return integrity.signGateReport({ ...unsigned(verified), mergedCommitHash: mergeCommit }, context);
}

/** Re-verify the final signed report against an immutable merge object. */
export function verifyMergedArtifactBinding(
  report: GateReport,
  integrity: ReportIntegrity,
  context: ArtifactBindingContext,
  expectedMergeCommit: string,
  requireCurrentRef?: string,
): AuthenticatedGateReport {
  const verified = integrity.verifyGateReport(report, context);
  if (verified.mergedCommitHash !== expectedMergeCommit) {
    const code = verified.mergedCommitHash === undefined ? 'artifact_identity_missing' : 'artifact_identity_mismatch';
    throw new ReportIntegrityError(
      code,
      `signed merge commit ${String(verified.mergedCommitHash)} does not match expected ${expectedMergeCommit}`,
    );
  }
  if (typeof verified.artifactCommitHash !== 'string') {
    throw new ReportIntegrityError('artifact_identity_missing', 'final report is missing its task artifact commit');
  }
  const taskTree = gitOut(context.repoDir, 'rev-parse', `${verified.artifactCommitHash}^{tree}`);
  if (taskTree !== verified.worktreeHash) {
    mismatch(`signed task commit ${verified.artifactCommitHash} tree ${taskTree} does not match gated tree ${verified.worktreeHash}`);
  }
  verifyMergeTopology(verified, expectedMergeCommit, context);
  if (requireCurrentRef !== undefined) {
    const current = gitOut(context.repoDir, 'rev-parse', requireCurrentRef);
    if (current !== expectedMergeCommit) {
      mismatch(`current ${requireCurrentRef} tip ${current} does not match signed merge commit ${expectedMergeCommit}`);
    }
  }
  return verified;
}
