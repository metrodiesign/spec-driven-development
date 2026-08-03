import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { ReportIntegrityError } from '../gates/report-integrity.ts';
import { git, makeFixture, makeReportIntegrity } from '../../test/helpers/fixture.ts';
import {
  bindGateReportToMerge,
  verifyMergedArtifactBinding,
  verifyTaskArtifactBinding,
} from './artifact-binding.ts';

test('final merge binding rejects a signed report whose gated tree differs from its task parent', () => {
  const fix = makeFixture();
  try {
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    writeFileSync(join(fix.worktree, 'src', 'impl.txt'), 'correct\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'task work');
    const artifactCommitHash = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    const baseCommitHash = git(fix.worktree, 'rev-parse', 'main').trim();
    const wrongTree = git(fix.worktree, 'rev-parse', `${baseCommitHash}^{tree}`).trim();
    git(fix.worktree, 'checkout', '-q', 'main');
    git(fix.worktree, 'merge', '--no-ff', '--no-edit', 'task/T-1');
    const mergedCommitHash = git(fix.worktree, 'rev-parse', 'main').trim();

    const evidence = createEvidenceStore(fix.evidenceDir);
    const integrity = makeReportIntegrity(fix, evidence);
    const report = integrity.signGateReport({
      tier: 'T1',
      pass: true,
      gateConfigHash: 'gate',
      commitHash: artifactCommitHash,
      worktreeHash: wrongTree,
      envHash: 'env',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: evidence.put('green') }],
      scopeNote: 'fixture',
      artifactCommitHash,
      baseCommitHash,
      mergedCommitHash,
    }, { runId: 'RUN-1', taskId: 'T-1' });

    assert.throws(
      () => verifyMergedArtifactBinding(report, integrity, {
        runId: 'RUN-1',
        taskId: 'T-1',
        repoDir: fix.worktree,
        taskBranch: 'task/T-1',
        mainBranch: 'main',
      }, mergedCommitHash, 'main'),
      (error: unknown) =>
        error instanceof ReportIntegrityError && error.code === 'artifact_identity_mismatch',
    );
  } finally {
    fix.cleanup();
  }
});

test('merge binding cannot re-sign a task report that was mutated after authorization', () => {
  const fix = makeFixture();
  try {
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    writeFileSync(join(fix.worktree, 'src', 'impl.txt'), 'correct\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'task work');
    const artifactCommitHash = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    const artifactTree = git(fix.worktree, 'rev-parse', 'HEAD^{tree}').trim();
    const baseCommitHash = git(fix.worktree, 'rev-parse', 'main').trim();
    git(fix.worktree, 'checkout', '-q', 'main');
    git(fix.worktree, 'merge', '--no-ff', '--no-edit', 'task/T-1');
    const mergedCommitHash = git(fix.worktree, 'rev-parse', 'main').trim();

    const evidence = createEvidenceStore(fix.evidenceDir);
    const integrity = makeReportIntegrity(fix, evidence);
    const report = integrity.signGateReport({
      tier: 'T1',
      pass: true,
      gateConfigHash: 'gate',
      commitHash: artifactCommitHash,
      worktreeHash: artifactTree,
      envHash: 'env',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: evidence.put('green') }],
      scopeNote: 'fixture',
      artifactCommitHash,
      baseCommitHash,
    }, { runId: 'RUN-1', taskId: 'T-1' });

    assert.throws(
      () => bindGateReportToMerge(
        { ...report, pass: false },
        mergedCommitHash,
        integrity,
        {
          runId: 'RUN-1',
          taskId: 'T-1',
          repoDir: fix.worktree,
          taskBranch: 'task/T-1',
          mainBranch: 'main',
        },
      ),
      (error: unknown) =>
        error instanceof ReportIntegrityError && error.code === 'signature_mismatch',
    );
  } finally {
    fix.cleanup();
  }
});

test('task binding rejects approval after the target base branch advances', () => {
  const fix = makeFixture();
  try {
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    writeFileSync(join(fix.worktree, 'src', 'impl.txt'), 'correct\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'task work');
    const artifactCommitHash = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    const artifactTree = git(fix.worktree, 'rev-parse', 'HEAD^{tree}').trim();
    const baseCommitHash = git(fix.worktree, 'rev-parse', 'main').trim();

    const evidence = createEvidenceStore(fix.evidenceDir);
    const integrity = makeReportIntegrity(fix, evidence);
    const report = integrity.signGateReport({
      tier: 'T1',
      pass: true,
      gateConfigHash: 'gate',
      commitHash: artifactCommitHash,
      worktreeHash: artifactTree,
      envHash: 'env',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: evidence.put('green') }],
      scopeNote: 'fixture',
      artifactCommitHash,
      baseCommitHash,
    }, { runId: 'RUN-1', taskId: 'T-1' });

    git(fix.worktree, 'checkout', '-q', 'main');
    writeFileSync(join(fix.worktree, 'src', 'base-advanced.txt'), 'concurrent\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'advance target base');
    git(fix.worktree, 'checkout', '-q', 'task/T-1');

    assert.throws(
      () => verifyTaskArtifactBinding(report, integrity, {
        runId: 'RUN-1',
        taskId: 'T-1',
        repoDir: fix.worktree,
        taskBranch: 'task/T-1',
        mainBranch: 'main',
      }),
      (error: unknown) =>
        error instanceof ReportIntegrityError && error.code === 'artifact_identity_mismatch',
    );
  } finally {
    fix.cleanup();
  }
});

test('merge binding rejects a merge whose first parent is not the signed base commit', () => {
  const fix = makeFixture();
  try {
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    writeFileSync(join(fix.worktree, 'src', 'impl.txt'), 'correct\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'task work');
    const artifactCommitHash = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    const artifactTree = git(fix.worktree, 'rev-parse', 'HEAD^{tree}').trim();
    const baseCommitHash = git(fix.worktree, 'rev-parse', 'main').trim();

    git(fix.worktree, 'checkout', '-q', 'main');
    writeFileSync(join(fix.worktree, 'src', 'concurrent.txt'), 'concurrent base\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'concurrent main advance');
    const concurrentCommit = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    git(fix.worktree, 'merge', '--no-ff', '--no-edit', artifactCommitHash);
    const mergedCommitHash = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    assert.equal(
      git(fix.worktree, 'rev-list', '--parents', '-1', mergedCommitHash).trim().split(/\s+/)[1],
      concurrentCommit,
      'fixture merge first parent is the concurrent commit, not the signed base',
    );

    const evidence = createEvidenceStore(fix.evidenceDir);
    const integrity = makeReportIntegrity(fix, evidence);
    const report = integrity.signGateReport({
      tier: 'T1',
      pass: true,
      gateConfigHash: 'gate',
      commitHash: artifactCommitHash,
      worktreeHash: artifactTree,
      envHash: 'env',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: evidence.put('green') }],
      scopeNote: 'fixture',
      artifactCommitHash,
      baseCommitHash,
    }, { runId: 'RUN-1', taskId: 'T-1' });

    assert.throws(
      () => bindGateReportToMerge(report, mergedCommitHash, integrity, {
        runId: 'RUN-1',
        taskId: 'T-1',
        repoDir: fix.worktree,
        taskBranch: 'task/T-1',
        mainBranch: 'main',
      }),
      (error: unknown) =>
        error instanceof ReportIntegrityError && error.code === 'artifact_identity_mismatch',
    );

    const { auth: _auth, ...unsignedReport } = report;
    const forgedFinal = integrity.signGateReport({
      ...unsignedReport,
      mergedCommitHash,
    }, { runId: 'RUN-1', taskId: 'T-1' });
    assert.throws(
      () => verifyMergedArtifactBinding(forgedFinal, integrity, {
        runId: 'RUN-1',
        taskId: 'T-1',
        repoDir: fix.worktree,
        taskBranch: 'task/T-1',
        mainBranch: 'main',
      }, mergedCommitHash, 'main'),
      (error: unknown) =>
        error instanceof ReportIntegrityError && error.code === 'artifact_identity_mismatch',
    );
  } finally {
    fix.cleanup();
  }
});
