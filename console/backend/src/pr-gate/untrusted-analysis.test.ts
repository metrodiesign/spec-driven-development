import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalEvidenceBytes, createEvidenceStore, type Sha256Ref } from 'core';

import { buildWorkflowArtifact } from './untrusted-analysis.ts';
import { verifyTrustedAnalysisArtifact } from './workflow-artifact.ts';

const ref = (value: unknown): Sha256Ref => `sha256:${createHash('sha256').update(canonicalEvidenceBytes(value)).digest('hex')}`;

test('untrusted artifact carries every deterministic evidence blob for independent trusted verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'untrusted-artifact-'));
  try {
    const evidence = createEvidenceStore(join(root, 'evidence'));
    const evidenceBlob = evidence.put('deterministic output');
    const evidenceRef = `sha256:${evidenceBlob.slice('blob://'.length)}` as Sha256Ref;
    const identity = { repository: 'acme/repo' as const, pullRequest: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), diffRef: `sha256:${'d'.repeat(64)}` as Sha256Ref, policyRef: `sha256:${'e'.repeat(64)}` as Sha256Ref };
    const unsignedManifest = { schemaVersion: 1 as const, identity, createdAt: '2026-08-10T00:00:00Z', worktreeRef: `sha256:${'f'.repeat(64)}` as Sha256Ref, changedFiles: [], configRefs: [], rulesRefs: [] };
    const manifest = { ...unsignedManifest, manifestRef: ref(unsignedManifest) };
    const unsignedReport = { snapshot: identity, checks: [{ id: 'test', status: 'PASSED' as const, required: true, durationMs: 1, evidenceRef }] };
    const deterministic = { ...unsignedReport, reportRef: ref(unsignedReport) };
    const provenance = { workflowRunId: 1, repository: 'acme/repo' as const, event: 'pull_request' as const, pullRequest: 1, headSha: identity.headSha };
    const artifact = buildWorkflowArtifact({ provenance, manifest, deterministic, evidence });
    assert.equal(artifact.evidence.length, 1);
    assert.equal(verifyTrustedAnalysisArtifact({ artifact, expected: provenance, pinned: { descriptor: { repository: 'acme/repo', number: 1, title: '', description: '', baseRef: 'main', baseSha: identity.baseSha, headSha: identity.headSha, fromFork: true }, mergeBaseSha: identity.mergeBaseSha, diffRef: identity.diffRef, files: [], trustedRepositoryPolicyRef: identity.policyRef } }), artifact);
    artifact.evidence[0]!.contentBase64 = Buffer.from('tampered').toString('base64');
    assert.throws(() => verifyTrustedAnalysisArtifact({ artifact, expected: provenance, pinned: { descriptor: { repository: 'acme/repo', number: 1, title: '', description: '', baseRef: 'main', baseSha: identity.baseSha, headSha: identity.headSha, fromFork: true }, mergeBaseSha: identity.mergeBaseSha, diffRef: identity.diffRef, files: [], trustedRepositoryPolicyRef: identity.policyRef } }), /evidence integrity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
