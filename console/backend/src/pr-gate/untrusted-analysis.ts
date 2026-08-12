import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createDefaultCoreCommandExecutor,
  createEvidenceStore,
  mergeEffectivePolicy,
  type DeterministicReport,
  type EvidenceStore,
  type RepositoryId,
  type Sha256Ref,
  type SnapshotManifest,
} from 'core';

import { createPrGateChecksPort } from './checks-port.ts';
import { classifyPinnedChange } from './classification.ts';
import { preparePinnedReviewContext } from './context.ts';
import { createGitHubPullRequestReader } from './github-read.ts';
import { createLocalGitObjectReader, materializeSnapshot } from './local-git.ts';
import { loadPinnedRepositoryPolicy, ORGANIZATION_PR_GATE_FLOOR } from './policy.ts';
import type { TrustedAnalysisArtifact, WorkflowProvenance } from './workflow-artifact.ts';

function blobRef(ref: Sha256Ref): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(ref)) throw new Error(`invalid check evidence ref: ${ref}`);
  return `blob://${ref.slice('sha256:'.length)}`;
}

export function buildWorkflowArtifact(input: {
  provenance: WorkflowProvenance;
  manifest: SnapshotManifest;
  deterministic: DeterministicReport;
  evidence: EvidenceStore;
}): TrustedAnalysisArtifact {
  const refs = [...new Set(input.deterministic.checks.map((check) => check.evidenceRef))].sort();
  return {
    schemaVersion: 1,
    provenance: input.provenance,
    manifest: input.manifest,
    deterministic: input.deterministic,
    evidence: refs.map((ref) => ({ ref, contentBase64: Buffer.from(input.evidence.get(blobRef(ref))).toString('base64') })),
  };
}

/** Unprivileged workflow half: exact Git reads + snapshot + deterministic checks; no provider/reporter adapter is constructed. */
export async function createUntrustedAnalysisArtifact(input: {
  repositoryPath: string;
  stateRoot: string;
  repository: RepositoryId;
  pullRequest: number;
  workflowRunId: number;
  token?: string;
  env: Record<string, string | undefined>;
  now?: () => number;
  fetch?: typeof fetch;
}): Promise<TrustedAnalysisArtifact> {
  if (!Number.isInteger(input.workflowRunId) || input.workflowRunId <= 0) throw new Error('workflow run id must be positive');
  const now = input.now ?? Date.now;
  const root = resolve(input.stateRoot);
  const snapshotRoot = join(root, 'snapshots');
  mkdirSync(snapshotRoot, { recursive: true });
  const evidence = createEvidenceStore(join(root, 'evidence'));
  const reader = createLocalGitObjectReader(input.repositoryPath, {
    ...(input.token === undefined || input.token === '' ? {} : { githubToken: input.token }),
    ...(input.env['GITHUB_SERVER_URL'] === undefined ? {} : { githubServerUrl: input.env['GITHUB_SERVER_URL'] }),
  });
  const github = createGitHubPullRequestReader({
    ...(input.token === undefined || input.token === '' ? {} : { token: input.token }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  const descriptor = await github.getPullRequest(input.repository, input.pullRequest);
  await reader.fetchPullRequest(input.pullRequest);
  const change = await reader.pin(descriptor);
  const layer = await loadPinnedRepositoryPolicy(reader, change, new AbortController().signal);
  const policy = mergeEffectivePolicy(ORGANIZATION_PR_GATE_FLOOR, layer);
  const prepared = await preparePinnedReviewContext(reader, change, new AbortController().signal);
  const plan = classifyPinnedChange(change, policy, prepared.limitations);
  const materialized = await materializeSnapshot({
    reader,
    change,
    workspaceRoot: snapshotRoot,
    ...(plan.profiles.some((profile) => profile.id === 'node-typescript')
      ? { trustedNodeModulesFrom: input.repositoryPath }
      : {}),
    now,
    signal: new AbortController().signal,
  });
  const commandExecutor = createDefaultCoreCommandExecutor({
    evidence,
    environment: { PATH: input.env['PATH'], HOME: input.env['HOME'], COREPACK_HOME: input.env['COREPACK_HOME'] },
    now,
  });
  const checks = createPrGateChecksPort({ reader, changeFor: () => change, evidence, commandExecutor });
  const deterministic = await checks.run(
    plan,
    materialized.manifest,
    materialized.worktreeDir,
    new AbortController().signal,
    materialized.inputRoots,
  );
  return buildWorkflowArtifact({
    provenance: { workflowRunId: input.workflowRunId, repository: input.repository, event: 'pull_request', pullRequest: input.pullRequest, headSha: descriptor.headSha },
    manifest: materialized.manifest,
    deterministic,
    evidence,
  });
}
