import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalEvidenceBytes } from 'core';
import type { PinnedChangeSet, PullRequestDescriptor, Sha256Ref } from 'core';

import { readWorkflowArtifactProvenance, verifyTrustedAnalysisArtifact, type TrustedAnalysisArtifact, type WorkflowProvenance } from './workflow-artifact.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const DIFF = `sha256:${'d'.repeat(64)}` as Sha256Ref;
const POLICY = `sha256:${'e'.repeat(64)}` as Sha256Ref;

function ref(value: unknown): Sha256Ref {
  return `sha256:${createHash('sha256').update(canonicalEvidenceBytes(value)).digest('hex')}`;
}

function fixture(): { artifact: TrustedAnalysisArtifact; expected: WorkflowProvenance; pinned: PinnedChangeSet } {
  const descriptor: PullRequestDescriptor = {
    repository: 'acme/repo', number: 9, title: 'x', description: 'y', baseRef: 'main', baseSha: BASE, headSha: HEAD, fromFork: true,
  };
  const pinned: PinnedChangeSet = { descriptor, mergeBaseSha: MERGE, diffRef: DIFF, files: [], trustedRepositoryPolicyRef: POLICY };
  const identity = { repository: descriptor.repository, pullRequest: 9, baseSha: BASE, headSha: HEAD, mergeBaseSha: MERGE, diffRef: DIFF, policyRef: POLICY };
  const unsignedManifest = { schemaVersion: 1 as const, identity, createdAt: '2026-08-10T00:00:00.000Z', worktreeRef: `sha256:${'f'.repeat(64)}` as Sha256Ref, changedFiles: [], configRefs: [], rulesRefs: [] };
  const manifest = { ...unsignedManifest, manifestRef: ref(unsignedManifest) };
  const unsignedReport = { snapshot: identity, checks: [] };
  const deterministic = { ...unsignedReport, reportRef: ref(unsignedReport) };
  const expected: WorkflowProvenance = { workflowRunId: 123, repository: 'acme/repo', event: 'pull_request', pullRequest: 9, headSha: HEAD };
  return { artifact: { schemaVersion: 1, provenance: expected, manifest, deterministic, evidence: [] }, expected, pinned };
}

test('trusted workflow independently verifies provenance, source, policy, manifest, and deterministic report', () => {
  const value = fixture();
  assert.deepEqual(readWorkflowArtifactProvenance(value.artifact), value.expected);
  assert.equal(verifyTrustedAnalysisArtifact(value), value.artifact);
});

test('self-asserted artifact cannot bypass a policy/source mismatch', () => {
  const value = fixture();
  value.artifact.manifest.identity.policyRef = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyTrustedAnalysisArtifact(value), /source or policy binding mismatch/);
});

test('trusted workflow binds artifact PR through source workflow merge SHA without PR-head checkout', () => {
  const root = join(import.meta.dirname, '..', '..', '..', '..');
  const analysis = readFileSync(join(root, '.github', 'workflows', 'pr-quality-analysis.yml'), 'utf8');
  const finalize = readFileSync(join(root, '.github', 'workflows', 'pr-quality-finalize.yml'), 'utf8');
  assert.doesNotMatch(`${analysis}\n${finalize}`, /pull_request_target/u);
  assert.match(analysis, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.doesNotMatch(analysis, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.ok((`${analysis}\n${finalize}`.match(/persist-credentials: false/gu) ?? []).length >= 2);
  assert.doesNotMatch(finalize, /pull_requests\[0\]/u);
  assert.match(finalize, /--source-head "\$SOURCE_WORKFLOW_HEAD_SHA"/u);
  assert.match(finalize, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/u);
  assert.match(analysis, /BOOTSTRAP_BASE_SHA: 926cc2053115bc358979049499964260d0b77419/u);
  assert.match(analysis, /grep -Fq "if \(rest\[0\] === 'analyze'\)"/u);
  assert.match(analysis, /Trusted base missing pr-gate analyze outside pinned bootstrap commit/u);
  assert.equal((analysis.match(/if: steps\.trusted_gate\.outputs\.available == 'true'/gu) ?? []).length, 5);
});
