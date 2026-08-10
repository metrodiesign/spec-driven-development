import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { PullRequestDescriptor } from 'core';

import { createLocalGitObjectReader, headIsStale, materializeSnapshot, verifySnapshotManifestSource } from './local-git.ts';

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

describe('pinned Git source and immutable snapshot', () => {
  let repo = '';
  let workspace = '';
  let baseSha = '';
  let headSha = '';

  before(() => {
    repo = tempRoot('pr-git-repo');
    workspace = tempRoot('pr-git-workspace');
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'fixture@example.test');
    git(repo, 'config', 'user.name', 'Fixture');
    mkdirSync(join(repo, '.ai', 'policies'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repo, '.ai', 'policies', 'pr-quality-gate.json'), '{"version":1}\n');
    writeFileSync(join(repo, 'package.json'), '{"name":"fixture","private":true}\n');
    writeFileSync(join(repo, 'app.ts'), 'export const value = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');
    baseSha = git(repo, 'rev-parse', 'HEAD');

    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'app.ts'), 'export const value = 2;\n');
    writeFileSync(join(repo, 'docs', 'readme.md'), '# Docs\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'head');
    headSha = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(repo, 'node_modules', 'fixture-dependency'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'fixture-dependency', 'index.js'), 'module.exports = 42;\n');
    git(repo, 'remote', 'add', 'origin', repo);
    git(repo, 'update-ref', 'refs/pull/42/head', headSha);
  });

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('REQ-1 pins refs/diff/policy and never follows the mutable checkout', async () => {
    const descriptor: PullRequestDescriptor = {
      repository: 'owner/repo',
      number: 42,
      title: 'Change value',
      description: 'fixture',
      baseRef: 'main',
      baseSha,
      headSha,
      fromFork: true,
    };
    const reader = createLocalGitObjectReader(repo);
    const pinned = await reader.pin(descriptor);
    assert.equal(pinned.mergeBaseSha, baseSha);
    assert.deepEqual(pinned.files.map((file) => file.path), ['app.ts', 'docs/readme.md']);
    assert.match(pinned.diffRef, /^sha256:[0-9a-f]{64}$/u);
    assert.match(pinned.trustedRepositoryPolicyRef, /^sha256:[0-9a-f]{64}$/u);

    git(repo, 'checkout', '--detach', baseSha);
    assert.equal(await reader.readText('head', 'app.ts', pinned, 1_000), 'export const value = 2;\n');
    assert.equal(await reader.readText('base', 'app.ts', pinned, 1_000), 'export const value = 1;\n');
    assert.match(await reader.readDiff(pinned, 1_000_000), /export const value = 2/u);
    await assert.rejects(reader.readText('head', '../outside', pinned, 1_000), /unsafe repository path/u);
  });

  it('REQ-1 materializes exact head bytes and binds every changed file hash', async () => {
    const descriptor: PullRequestDescriptor = {
      repository: 'owner/repo',
      number: 42,
      title: 'Change value',
      description: 'fixture',
      baseRef: 'main',
      baseSha,
      headSha,
      fromFork: true,
    };
    const reader = createLocalGitObjectReader(repo);
    const pinned = await reader.pin(descriptor);
    const result = await materializeSnapshot({
      reader,
      change: pinned,
      workspaceRoot: workspace,
      trustedNodeModulesFrom: repo,
      now: () => Date.UTC(2026, 7, 10),
      signal: new AbortController().signal,
    });
    assert.equal(readFileSync(join(result.worktreeDir, 'app.ts'), 'utf8'), 'export const value = 2;\n');
    assert.equal(readFileSync(join(result.worktreeDir, 'node_modules', 'fixture-dependency', 'index.js'), 'utf8'), 'module.exports = 42;\n');
    assert.deepEqual(result.inputRoots, ['node_modules']);
    assert.equal(result.manifest.identity.headSha, headSha);
    assert.equal(result.manifest.changedFiles.every((file) => file.afterRef !== undefined), true);
    assert.match(result.manifest.manifestRef, /^sha256:[0-9a-f]{64}$/u);
    await assert.doesNotReject(verifySnapshotManifestSource({
      reader, change: pinned, manifest: result.manifest, signal: new AbortController().signal,
    }));
    const tampered = {
      ...result.manifest,
      changedFiles: result.manifest.changedFiles.map((file, index) => index === 0 ? { ...file, afterRef: `sha256:${'0'.repeat(64)}` as const } : file),
    };
    await assert.rejects(
      verifySnapshotManifestSource({ reader, change: pinned, manifest: tampered, signal: new AbortController().signal }),
      /does not match pinned Git source/u,
    );
  });

  it('REQ-1 stale comparison is exact', () => {
    assert.equal(headIsStale(headSha, headSha), false);
    assert.equal(headIsStale(headSha, baseSha), true);
  });

  it('trusted workflow fetches a PR object without checking out untrusted head', async () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    const token = 'scoped-test-token';
    const reader = createLocalGitObjectReader(repo, { githubToken: token });
    await reader.fetchPullRequest(42);
    assert.equal(git(repo, 'rev-parse', 'refs/pr-quality/pull/42'), headSha);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    const config = readFileSync(join(repo, '.git', 'config'), 'utf8');
    assert.doesNotMatch(config, new RegExp(token, 'u'));
    assert.doesNotMatch(config, new RegExp(Buffer.from(`x-access-token:${token}`).toString('base64'), 'u'));
  });
});
