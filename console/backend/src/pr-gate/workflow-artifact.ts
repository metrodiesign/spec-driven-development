import { createHash } from 'node:crypto';

import { canonicalEvidenceBytes } from 'core';
import type {
  DeterministicReport,
  PinnedChangeSet,
  RepositoryId,
  Sha256Ref,
  SnapshotManifest,
} from 'core';

export interface WorkflowProvenance {
  workflowRunId: number;
  repository: RepositoryId;
  event: 'pull_request';
  pullRequest: number;
  headSha: string;
}

export interface WorkflowInvocation {
  workflowRunId: number;
  repository: RepositoryId;
  event: 'pull_request';
  sourceWorkflowHeadSha: string;
}

export interface TrustedAnalysisArtifact {
  schemaVersion: 1;
  provenance: WorkflowProvenance;
  manifest: SnapshotManifest;
  deterministic: DeterministicReport;
  evidence: Array<{ ref: Sha256Ref; contentBase64: string }>;
}

function ref(value: unknown): Sha256Ref {
  return `sha256:${createHash('sha256').update(canonicalEvidenceBytes(value)).digest('hex')}`;
}

function sameIdentity(left: SnapshotManifest['identity'], right: DeterministicReport['snapshot']): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRef(value: unknown): value is Sha256Ref {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function verifyShape(value: unknown): asserts value is TrustedAnalysisArtifact {
  if (!object(value) || value['schemaVersion'] !== 1 || !object(value['provenance']) || !object(value['manifest']) || !object(value['deterministic'])) {
    throw new Error('workflow artifact schema mismatch');
  }
  const provenance = value['provenance'];
  if (
    !Number.isInteger(provenance['workflowRunId']) || Number(provenance['workflowRunId']) <= 0 ||
    typeof provenance['repository'] !== 'string' || provenance['event'] !== 'pull_request' ||
    !Number.isInteger(provenance['pullRequest']) || Number(provenance['pullRequest']) <= 0 || typeof provenance['headSha'] !== 'string'
  ) throw new Error('workflow artifact provenance schema mismatch');
  const manifest = value['manifest'];
  if (
    manifest['schemaVersion'] !== 1 || !object(manifest['identity']) || typeof manifest['createdAt'] !== 'string' || !Number.isFinite(Date.parse(manifest['createdAt'])) ||
    !validRef(manifest['worktreeRef']) || !Array.isArray(manifest['changedFiles']) || !Array.isArray(manifest['configRefs']) ||
    !Array.isArray(manifest['rulesRefs']) || !validRef(manifest['manifestRef'])
  ) throw new Error('workflow snapshot schema mismatch');
  const deterministic = value['deterministic'];
  if (!object(deterministic['snapshot']) || !Array.isArray(deterministic['checks']) || !validRef(deterministic['reportRef'])) {
    throw new Error('workflow deterministic schema mismatch');
  }
  for (const check of deterministic['checks']) {
    if (
      !object(check) || typeof check['id'] !== 'string' ||
      !['PASSED', 'FAILED', 'TIMED_OUT', 'INFRASTRUCTURE_FAILURE'].includes(String(check['status'])) ||
      typeof check['required'] !== 'boolean' || !Number.isFinite(check['durationMs']) || Number(check['durationMs']) < 0 ||
      !validRef(check['evidenceRef'])
    ) throw new Error('workflow deterministic check schema mismatch');
  }
  if (!Array.isArray(value['evidence'])) throw new Error('workflow evidence schema mismatch');
}

export function readWorkflowArtifactProvenance(value: unknown): WorkflowProvenance {
  verifyShape(value);
  return { ...value.provenance };
}

function verifyEvidence(artifact: TrustedAnalysisArtifact): void {
  if (!Array.isArray(artifact.evidence) || artifact.evidence.length > 256) throw new Error('workflow evidence index invalid');
  const byRef = new Map<Sha256Ref, Uint8Array>();
  let total = 0;
  for (const entry of artifact.evidence) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(entry.ref) || typeof entry.contentBase64 !== 'string' || byRef.has(entry.ref)) {
      throw new Error('workflow evidence entry invalid');
    }
    const bytes = Buffer.from(entry.contentBase64, 'base64');
    total += bytes.byteLength;
    if (total > 64 * 1024 * 1024 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== entry.ref) {
      throw new Error('workflow evidence integrity mismatch');
    }
    byRef.set(entry.ref, bytes);
  }
  for (const check of artifact.deterministic.checks) {
    if (!byRef.has(check.evidenceRef)) throw new Error(`workflow evidence missing for check ${check.id}`);
  }
}

/** Independent trust check. Artifact signatures are intentionally not accepted as provenance. */
export function verifyTrustedAnalysisArtifact(input: {
  artifact: TrustedAnalysisArtifact;
  expected: WorkflowProvenance;
  pinned: PinnedChangeSet;
}): TrustedAnalysisArtifact {
  verifyShape(input.artifact);
  const { artifact, expected, pinned } = input;
  if (
    artifact.provenance.workflowRunId !== expected.workflowRunId ||
    artifact.provenance.repository !== expected.repository ||
    artifact.provenance.event !== 'pull_request' ||
    artifact.provenance.pullRequest !== expected.pullRequest ||
    artifact.provenance.headSha !== expected.headSha
  ) {
    throw new Error('workflow artifact provenance mismatch');
  }
  const identity = artifact.manifest.identity;
  if (
    identity.repository !== expected.repository ||
    identity.pullRequest !== expected.pullRequest ||
    identity.headSha !== expected.headSha ||
    identity.baseSha !== pinned.descriptor.baseSha ||
    identity.mergeBaseSha !== pinned.mergeBaseSha ||
    identity.diffRef !== pinned.diffRef ||
    identity.policyRef !== pinned.trustedRepositoryPolicyRef
  ) {
    throw new Error('workflow artifact source or policy binding mismatch');
  }
  if (!sameIdentity(identity, artifact.deterministic.snapshot)) throw new Error('deterministic report snapshot mismatch');
  verifyEvidence(artifact);
  const { manifestRef, ...unsignedManifest } = artifact.manifest;
  if (manifestRef !== ref(unsignedManifest)) throw new Error('snapshot manifest integrity mismatch');
  const { reportRef, ...unsignedReport } = artifact.deterministic;
  if (reportRef !== ref(unsignedReport)) throw new Error('deterministic report integrity mismatch');
  return artifact;
}
