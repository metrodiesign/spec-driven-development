import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore, type AnalysisPlan, type CoreCommandExecutor, type PinnedChangeSet, type SnapshotManifest } from 'core';

import { createPrGateChecksPort } from './checks-port.ts';
import type { LocalGitObjectReader } from './local-git.ts';

const identity = {
  repository: 'acme/repo' as const, pullRequest: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40), diffRef: `sha256:${'d'.repeat(64)}` as const, policyRef: `sha256:${'e'.repeat(64)}` as const,
};

test('built-in secret and OpenAPI checks produce immutable blockers without executing PR commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-checks-port-'));
  const tree = join(root, 'tree');
  mkdirSync(join(tree, 'api'), { recursive: true });
  writeFileSync(join(tree, 'leak.txt'), `credential=${['sk', 'unsafecredentialvalue123456789'].join('-')}`);
  writeFileSync(join(tree, 'api', 'openapi.yaml'), 'openapi: 3.1.0\npaths: {}\n');
  const change: PinnedChangeSet = {
    descriptor: { repository: 'acme/repo', number: 1, title: '', description: '', baseRef: 'main', baseSha: identity.baseSha, headSha: identity.headSha, fromFork: false },
    mergeBaseSha: identity.mergeBaseSha, diffRef: identity.diffRef, trustedRepositoryPolicyRef: identity.policyRef,
    files: [{ path: 'leak.txt', status: 'added' }, { path: 'api/openapi.yaml', status: 'modified' }],
  };
  const reader: LocalGitObjectReader = {
    fetchPullRequest: async () => undefined,
    pin: async () => change,
    readDiff: async () => '',
    readBytes: async () => null,
    readText: async (side, path) => path.endsWith('openapi.yaml')
      ? side === 'base'
        ? 'openapi: 3.1.0\npaths:\n  /users:\n    get: {}\n'
        : 'openapi: 3.1.0\npaths: {}\n'
      : null,
    listFiles: async () => [],
    treeRef: async () => `sha256:${'f'.repeat(64)}`,
    materializeTree: async () => `sha256:${'f'.repeat(64)}`,
  };
  const commandExecutor: CoreCommandExecutor = {
    environmentHash: 'test',
    execute: async () => { throw new Error('built-ins must not spawn'); },
  };
  const plan: AnalysisPlan = {
    snapshot: identity,
    analysis: { technologies: ['openapi'], categories: ['API'], components: ['api'], publicContracts: ['api/openapi.yaml'], impactEdges: [], risk: { level: 'HIGH', reasons: [] }, coverage: 'FULL', omittedPaths: [] },
    profiles: [], policyRef: identity.policyRef,
    checks: [
      { id: 'secret-scan', kind: 'security', command: 'builtin:secret-scan', required: true, timeoutMs: 1000, network: 'none', install: false, profiles: [], components: [] },
      { id: 'openapi-contract', kind: 'contract', command: 'builtin:openapi-contract-diff', required: true, timeoutMs: 1000, network: 'none', install: false, profiles: [], components: [] },
    ],
  };
  const manifest: SnapshotManifest = {
    schemaVersion: 1, identity, createdAt: '2026-08-10T00:00:00Z', worktreeRef: `sha256:${'1'.repeat(64)}`,
    changedFiles: [
      { path: 'leak.txt', status: 'added', afterRef: `sha256:${'2'.repeat(64)}` },
      { path: 'api/openapi.yaml', status: 'modified', beforeRef: `sha256:${'3'.repeat(64)}`, afterRef: `sha256:${'4'.repeat(64)}` },
    ], configRefs: [], rulesRefs: [], manifestRef: `sha256:${'5'.repeat(64)}`,
  };
  try {
    const checks = createPrGateChecksPort({ reader, changeFor: () => change, evidence: createEvidenceStore(join(root, 'evidence')), commandExecutor });
    const report = await checks.run(plan, manifest, tree, new AbortController().signal);
    assert.deepEqual(report.checks.map((check) => [check.id, check.status]), [
      ['secret-scan', 'FAILED'], ['openapi-contract', 'FAILED'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
