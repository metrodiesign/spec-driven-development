import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type {
  ChangedFile,
  PinnedChangeSet,
  PullRequestDescriptor,
  Sha256Ref,
  SnapshotIdentity,
  SnapshotManifest,
} from 'core';
import { canonicalEvidenceBytes } from 'core';

const GIT = '/usr/bin/git';
const MAX_GIT_BYTES = 128 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function sha256Ref(content: string | Uint8Array): Sha256Ref {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function safePath(path: string): string {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) throw new Error(`unsafe repository path: ${path}`);
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error(`unsafe repository path: ${path}`);
  return path;
}

function validateSha(sha: string): string {
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) throw new Error(`invalid Git object id: ${sha}`);
  return sha;
}

function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  };
}

function runGit(repoDir: string, args: readonly string[], signal?: AbortSignal, extraEnvironment?: NodeJS.ProcessEnv): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      GIT,
      ['-C', repoDir, ...args],
      { encoding: 'buffer', env: gitEnv(extraEnvironment), maxBuffer: MAX_GIT_BYTES, signal },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args[0] ?? ''} failed: ${Buffer.from(stderr).toString('utf8').trim() || error.message}`));
          return;
        }
        resolvePromise(Uint8Array.from(stdout));
      },
    );
  });
}

function parseChangedFiles(bytes: Uint8Array): ChangedFile[] {
  const tokens = UTF8.decode(bytes).split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const files: ChangedFile[] = [];
  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index++];
    if (statusToken === undefined) break;
    const kind = statusToken[0];
    if (kind === 'R' || kind === 'C') {
      const previousPath = safePath(tokens[index++] ?? '');
      const path = safePath(tokens[index++] ?? '');
      files.push({ path, previousPath, status: 'renamed' });
      continue;
    }
    const path = safePath(tokens[index++] ?? '');
    const status = kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified';
    files.push({ path, status });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

interface TreeEntry {
  mode: '100644' | '100755' | '120000';
  object: string;
  path: string;
}

function parseTree(bytes: Uint8Array): TreeEntry[] {
  const records = UTF8.decode(bytes).split('\0');
  if (records.at(-1) === '') records.pop();
  return records.map((record) => {
    const tab = record.indexOf('\t');
    const header = record.slice(0, tab).split(' ');
    const path = safePath(record.slice(tab + 1));
    const mode = header[0];
    const object = header[2];
    if ((mode !== '100644' && mode !== '100755' && mode !== '120000') || !/^[0-9a-f]{40,64}$/u.test(object ?? '')) {
      throw new Error(`unsupported Git tree entry: ${record.slice(0, tab)}`);
    }
    return { mode, object: object!, path };
  });
}

function ensureParent(root: string, relativePath: string): string {
  const parts = relativePath.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current);
    if (!lstatSync(current).isDirectory()) throw new Error(`snapshot parent is not a directory: ${relativePath}`);
  }
  return join(root, ...parts);
}

async function hydrateTrustedNodeModules(input: {
  repositoryPath: string;
  snapshotPath: string;
  signal: AbortSignal;
}): Promise<string[]> {
  const sourceRoot = resolve(input.repositoryPath);
  const snapshotRoot = resolve(input.snapshotPath);
  const tracked = UTF8.decode(await runGit(sourceRoot, ['ls-files', '-z'], input.signal))
    .split('\0')
    .filter((path) => path === 'package.json' || path.endsWith('/package.json'));
  const candidates = [...new Set(tracked.map((path) => {
    const parent = dirname(path);
    return parent === '.' ? 'node_modules' : `${parent}/node_modules`;
  }))].sort();
  const copied: string[] = [];
  for (const relativePath of candidates) {
    if (input.signal.aborted) throw input.signal.reason;
    const source = join(sourceRoot, safePath(relativePath));
    if (!existsSync(source)) continue;
    if (!lstatSync(source).isDirectory()) throw new Error(`trusted dependency root is not a directory: ${relativePath}`);
    const target = ensureParent(snapshotRoot, relativePath);
    if (existsSync(target)) throw new Error(`snapshot dependency root already exists: ${relativePath}`);
    cpSync(source, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_FICLONE,
    });
    copied.push(relativePath);
  }
  return copied;
}

export interface LocalGitObjectReader {
  fetchPullRequest(number: number, signal?: AbortSignal): Promise<void>;
  pin(descriptor: PullRequestDescriptor, signal?: AbortSignal): Promise<PinnedChangeSet>;
  readDiff(pinned: PinnedChangeSet, maxBytes: number, signal?: AbortSignal): Promise<string>;
  readBytes(side: 'base' | 'head', path: string, pinned: PinnedChangeSet, signal?: AbortSignal): Promise<Uint8Array | null>;
  readText(side: 'base' | 'head', path: string, pinned: PinnedChangeSet, maxBytes: number, signal?: AbortSignal): Promise<string | null>;
  listFiles(side: 'base' | 'head', pinned: PinnedChangeSet, signal?: AbortSignal): Promise<string[]>;
  treeRef(headSha: string, signal?: AbortSignal): Promise<Sha256Ref>;
  materializeTree(headSha: string, destination: string, signal?: AbortSignal): Promise<Sha256Ref>;
}

export function createLocalGitObjectReader(
  repositoryPath: string,
  options: { githubToken?: string; githubServerUrl?: string } = {},
): LocalGitObjectReader {
  const repoDir = resolve(repositoryPath);
  if (!lstatSync(repoDir).isDirectory()) throw new Error(`repository path is not a directory: ${repoDir}`);
  const fetchEnvironment = (() => {
    if (options.githubToken === undefined || options.githubToken === '') return undefined;
    const server = new URL(options.githubServerUrl ?? 'https://github.com');
    if (server.protocol !== 'https:' || server.username !== '' || server.password !== '' || server.search !== '' || server.hash !== '') {
      throw new Error('GitHub server URL must be credential-free HTTPS');
    }
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${server.origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.githubToken}`).toString('base64')}`,
    };
  })();

  const readObject = async (sha: string, path: string, signal?: AbortSignal): Promise<Uint8Array | null> => {
    try {
      return await runGit(repoDir, ['show', `${validateSha(sha)}:${safePath(path)}`], signal);
    } catch (error) {
      if (error instanceof Error && /does not exist|exists on disk, but not in|Path .* does not exist/u.test(error.message)) return null;
      throw error;
    }
  };

  return {
    async fetchPullRequest(number, signal) {
      if (!Number.isInteger(number) || number <= 0) throw new Error('invalid pull request fetch identity');
      await runGit(repoDir, [
        'fetch', '--no-tags', 'origin',
        `+refs/pull/${number}/head:refs/pr-quality/pull/${number}`,
      ], signal, fetchEnvironment);
    },

    async readDiff(pinned, maxBytes, signal) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('pinned diff maxBytes must be a positive integer');
      const bytes = await runGit(
        repoDir,
        ['diff', '--no-ext-diff', '--no-textconv', '--binary', validateSha(pinned.descriptor.baseSha), validateSha(pinned.descriptor.headSha)],
        signal,
      );
      if (bytes.byteLength > maxBytes) throw new Error(`pinned diff exceeds ${maxBytes} bytes`);
      if (sha256Ref(bytes) !== pinned.diffRef) throw new Error('pinned diff hash mismatch');
      return UTF8.decode(bytes);
    },

    async pin(descriptor, signal) {
      validateSha(descriptor.baseSha);
      validateSha(descriptor.headSha);
      await runGit(repoDir, ['cat-file', '-e', `${descriptor.baseSha}^{commit}`], signal);
      await runGit(repoDir, ['cat-file', '-e', `${descriptor.headSha}^{commit}`], signal);
      const mergeBaseSha = UTF8.decode(await runGit(repoDir, ['merge-base', descriptor.baseSha, descriptor.headSha], signal)).trim();
      validateSha(mergeBaseSha);
      const diff = await runGit(
        repoDir,
        ['diff', '--no-ext-diff', '--no-textconv', '--binary', descriptor.baseSha, descriptor.headSha],
        signal,
      );
      const names = await runGit(
        repoDir,
        ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', descriptor.baseSha, descriptor.headSha],
        signal,
      );
      const policy = await readObject(descriptor.baseSha, '.ai/policies/pr-quality-gate.json', signal);
      return {
        descriptor: { ...descriptor },
        mergeBaseSha,
        diffRef: sha256Ref(diff),
        files: parseChangedFiles(names),
        trustedRepositoryPolicyRef: sha256Ref(policy ?? 'absent'),
      };
    },

    readBytes(side, path, pinned, signal) {
      return readObject(side === 'base' ? pinned.descriptor.baseSha : pinned.descriptor.headSha, path, signal);
    },

    async readText(side, path, pinned, maxBytes, signal) {
      const bytes = await this.readBytes(side, path, pinned, signal);
      if (bytes === null) return null;
      if (bytes.byteLength > maxBytes) throw new Error(`pinned read exceeds ${maxBytes} bytes: ${path}`);
      return UTF8.decode(bytes);
    },

    async listFiles(side, pinned, signal) {
      const sha = side === 'base' ? pinned.descriptor.baseSha : pinned.descriptor.headSha;
      const bytes = await runGit(repoDir, ['ls-tree', '-r', '-z', '--name-only', validateSha(sha)], signal);
      const paths = UTF8.decode(bytes).split('\0').filter(Boolean).map(safePath);
      return paths.sort();
    },

    async treeRef(headSha, signal) {
      const treeBytes = await runGit(repoDir, ['ls-tree', '-r', '-z', validateSha(headSha)], signal);
      return sha256Ref(treeBytes);
    },

    async materializeTree(headSha, destination, signal) {
      validateSha(headSha);
      const treeBytes = await runGit(repoDir, ['ls-tree', '-r', '-z', validateSha(headSha)], signal);
      const root = resolve(destination);
      mkdirSync(root, { recursive: false });
      for (const entry of parseTree(treeBytes)) {
        if (signal?.aborted) throw signal.reason;
        const content = await runGit(repoDir, ['cat-file', 'blob', entry.object], signal);
        const path = ensureParent(root, entry.path);
        if (entry.mode === '120000') {
          symlinkSync(UTF8.decode(content), path);
        } else {
          writeFileSync(path, content, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
          chmodSync(path, entry.mode === '100755' ? 0o755 : 0o644);
        }
      }
      return sha256Ref(treeBytes);
    },
  };
}

async function changedFileBindings(
  reader: LocalGitObjectReader,
  change: PinnedChangeSet,
  signal: AbortSignal,
): Promise<SnapshotManifest['changedFiles']> {
  const changedFiles: SnapshotManifest['changedFiles'] = [];
  for (const file of change.files) {
    const before = file.status === 'added' ? null : await reader.readBytes('base', file.previousPath ?? file.path, change, signal);
    const after = file.status === 'deleted' ? null : await reader.readBytes('head', file.path, change, signal);
    changedFiles.push({
      ...file,
      ...(before === null ? {} : { beforeRef: sha256Ref(before) }),
      ...(after === null ? {} : { afterRef: sha256Ref(after) }),
    });
  }
  return changedFiles;
}

function contentRefs(changedFiles: SnapshotManifest['changedFiles']): Pick<SnapshotManifest, 'configRefs' | 'rulesRefs'> {
  return {
    configRefs: changedFiles
      .filter((file) => /(?:^|\/)(?:\.[^/]+|[^/]+\.(?:json|ya?ml|toml))$/u.test(file.path))
      .flatMap((file) => (file.afterRef === undefined ? [] : [file.afterRef])),
    rulesRefs: changedFiles
      .filter((file) => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$|^\.ai\/shared\//u.test(file.path))
      .flatMap((file) => (file.afterRef === undefined ? [] : [file.afterRef])),
  };
}

export async function verifySnapshotManifestSource(input: {
  reader: LocalGitObjectReader;
  change: PinnedChangeSet;
  manifest: SnapshotManifest;
  signal: AbortSignal;
}): Promise<void> {
  const identity: SnapshotIdentity = {
    repository: input.change.descriptor.repository,
    pullRequest: input.change.descriptor.number,
    baseSha: input.change.descriptor.baseSha,
    headSha: input.change.descriptor.headSha,
    mergeBaseSha: input.change.mergeBaseSha,
    diffRef: input.change.diffRef,
    policyRef: input.change.trustedRepositoryPolicyRef,
  };
  const changedFiles = await changedFileBindings(input.reader, input.change, input.signal);
  const refs = contentRefs(changedFiles);
  const worktreeRef = await input.reader.treeRef(input.change.descriptor.headSha, input.signal);
  if (
    JSON.stringify(input.manifest.identity) !== JSON.stringify(identity) ||
    input.manifest.worktreeRef !== worktreeRef ||
    JSON.stringify(input.manifest.changedFiles) !== JSON.stringify(changedFiles) ||
    JSON.stringify(input.manifest.configRefs) !== JSON.stringify(refs.configRefs) ||
    JSON.stringify(input.manifest.rulesRefs) !== JSON.stringify(refs.rulesRefs)
  ) throw new Error('snapshot manifest does not match pinned Git source');
}

export async function materializeSnapshot(input: {
  reader: LocalGitObjectReader;
  change: PinnedChangeSet;
  workspaceRoot: string;
  trustedNodeModulesFrom?: string;
  now: () => number;
  signal: AbortSignal;
}): Promise<{ manifest: SnapshotManifest; worktreeDir: string; inputRoots?: string[] }> {
  mkdirSync(input.workspaceRoot, { recursive: true });
  const worktreeDir = mkdtempSync(join(resolve(input.workspaceRoot), 'pr-snapshot-'));
  const emptyDir = join(worktreeDir, 'tree');
  const worktreeRef = await input.reader.materializeTree(input.change.descriptor.headSha, emptyDir, input.signal);
  const inputRoots = input.trustedNodeModulesFrom === undefined
    ? []
    : await hydrateTrustedNodeModules({
        repositoryPath: input.trustedNodeModulesFrom,
        snapshotPath: emptyDir,
        signal: input.signal,
      });
  const changedFiles = await changedFileBindings(input.reader, input.change, input.signal);
  const identity: SnapshotIdentity = {
    repository: input.change.descriptor.repository,
    pullRequest: input.change.descriptor.number,
    baseSha: input.change.descriptor.baseSha,
    headSha: input.change.descriptor.headSha,
    mergeBaseSha: input.change.mergeBaseSha,
    diffRef: input.change.diffRef,
    policyRef: input.change.trustedRepositoryPolicyRef,
  };
  const withoutRef = {
    schemaVersion: 1 as const,
    identity,
    createdAt: new Date(input.now()).toISOString(),
    worktreeRef,
    changedFiles,
    ...contentRefs(changedFiles),
  };
  const manifest: SnapshotManifest = {
    ...withoutRef,
    manifestRef: sha256Ref(canonicalEvidenceBytes(withoutRef)),
  };
  return {
    manifest,
    worktreeDir: emptyDir,
    ...(inputRoots.length === 0 ? {} : { inputRoots }),
  };
}

export function headIsStale(expectedHeadSha: string, currentHeadSha: string): boolean {
  return expectedHeadSha !== currentHeadSha;
}
