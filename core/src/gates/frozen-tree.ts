import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { runCoreTool } from '../security/command-runner.ts';

export interface FrozenTreeEntry {
  mode: '100644' | '100755' | '120000' | '160000';
  object: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface FrozenTree {
  readonly treeHash: string;
  readonly inventoryHash: string;
  readonly entries: readonly FrozenTreeEntry[];
  materialize(destination: string, operation?: FrozenTreeOperationControl): Promise<void>;
  cleanup(): void;
}

export interface FrozenTreeLimits {
  maxFiles: number;
  maxSingleFileBytes: number;
  maxTotalBytes: number;
  maxGitOutputBytes: number;
}

export const DEFAULT_FROZEN_TREE_LIMITS: Readonly<FrozenTreeLimits> = Object.freeze({
  maxFiles: 200_000,
  maxSingleFileBytes: 268_435_456,
  maxTotalBytes: 2_147_483_648,
  maxGitOutputBytes: 67_108_864,
});

/** Resolve HEAD without spawning target-controlled Git/config/filter/hook code. */
export function readHeadCommit(repoDir: string): string {
  const dotGit = join(repoDir, '.git');
  const dotGitStat = lstatSync(dotGit);
  const gitDir = dotGitStat.isDirectory()
    ? dotGit
    : resolve(
        repoDir,
        readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/u, ''),
      );
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40,64}$/u.test(head)) return head;
  if (!head.startsWith('ref: ')) throw new Error('malformed Git HEAD');
  const ref = head.slice('ref: '.length);
  const loose = join(gitDir, ...ref.split('/'));
  if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
  const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
  const match = packed
    .split('\n')
    .find((line) => !line.startsWith('#') && !line.startsWith('^') && line.endsWith(` ${ref}`));
  if (match === undefined) throw new Error(`Git HEAD ref is unavailable: ${ref}`);
  return match.split(' ')[0] ?? '';
}

const GIT_BIN = '/usr/bin/git';
const PYTHON_BIN = '/usr/bin/python3';
const CORE_TOOL_TIMEOUT_MS = 120_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const DESCRIPTOR_READ_SCRIPT = String.raw`
import json
import hashlib
import os
import stat
import sys

root, relative = sys.argv[1], sys.argv[2]
parts = relative.split("/")
if not parts or any(part in ("", ".", "..") for part in parts):
    raise SystemExit("unsafe relative path")

def write_all(descriptor, content):
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise RuntimeError("descriptor write made no progress")
        offset += written

fds = []
nofollow = getattr(os, "O_NOFOLLOW", 0)
try:
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | nofollow)
    fds.append(root_fd)
    for component in parts[:-1]:
        directory_fd = os.open(
            component,
            os.O_RDONLY | os.O_DIRECTORY | nofollow,
            dir_fd=fds[-1],
        )
        fds.append(directory_fd)
    file_fd = os.open(parts[-1], os.O_RDONLY | nofollow, dir_fd=fds[-1])
    fds.append(file_fd)
    before = os.fstat(file_fd)
    if not stat.S_ISREG(before.st_mode):
        raise RuntimeError("descriptor target is not a regular file")
    digest = hashlib.sha256()
    while True:
        chunk = os.read(file_fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        write_all(1, chunk)
    after = os.fstat(file_fd)
    identity = lambda item: (
        item.st_dev,
        item.st_ino,
        item.st_mode,
        item.st_size,
        item.st_mtime_ns,
        item.st_ctime_ns,
    )
    if identity(before) != identity(after):
        raise RuntimeError("descriptor target changed while reading")
    metadata = {
        "dev": str(before.st_dev),
        "ino": str(before.st_ino),
        "mode": str(before.st_mode),
        "size": str(before.st_size),
        "mtimeNs": str(before.st_mtime_ns),
        "ctimeNs": str(before.st_ctime_ns),
        "sha256": digest.hexdigest(),
    }
    write_all(
        2,
        ("CORE_DESCRIPTOR_METADATA:" + json.dumps(metadata, separators=(",", ":"))).encode("ascii"),
    )
except Exception as error:
    write_all(2, ("descriptor-safe read failed: " + str(error)).encode("utf-8"))
    raise SystemExit(1)
finally:
    for descriptor in reversed(fds):
        try:
            os.close(descriptor)
        except OSError:
            pass
`;
const DESCRIPTOR_SYMLINK_READ_SCRIPT = String.raw`
import hashlib
import json
import os
import stat
import sys

root, relative = sys.argv[1], sys.argv[2]
parts = relative.split("/")
if not parts or any(part in ("", ".", "..") for part in parts):
    raise SystemExit("unsafe relative path")

def write_all(descriptor, content):
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise RuntimeError("descriptor write made no progress")
        offset += written

fds = []
nofollow = getattr(os, "O_NOFOLLOW", 0)
try:
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | nofollow)
    fds.append(root_fd)
    for component in parts[:-1]:
        directory_fd = os.open(
            component,
            os.O_RDONLY | os.O_DIRECTORY | nofollow,
            dir_fd=fds[-1],
        )
        fds.append(directory_fd)
    before = os.stat(parts[-1], dir_fd=fds[-1], follow_symlinks=False)
    if not stat.S_ISLNK(before.st_mode):
        raise RuntimeError("descriptor target is not a symbolic link")
    content = os.fsencode(os.readlink(parts[-1], dir_fd=fds[-1]))
    after = os.stat(parts[-1], dir_fd=fds[-1], follow_symlinks=False)
    identity = lambda item: (
        item.st_dev,
        item.st_ino,
        item.st_mode,
        item.st_size,
        item.st_mtime_ns,
        item.st_ctime_ns,
    )
    if identity(before) != identity(after):
        raise RuntimeError("descriptor symlink changed while reading")
    metadata = {
        "dev": str(before.st_dev),
        "ino": str(before.st_ino),
        "mode": str(before.st_mode),
        "size": str(before.st_size),
        "mtimeNs": str(before.st_mtime_ns),
        "ctimeNs": str(before.st_ctime_ns),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    write_all(1, content)
    write_all(
        2,
        ("CORE_SYMLINK_METADATA:" + json.dumps(metadata, separators=(",", ":"))).encode("ascii"),
    )
except Exception as error:
    write_all(2, ("descriptor-safe symlink read failed: " + str(error)).encode("utf-8"))
    raise SystemExit(1)
finally:
    for descriptor in reversed(fds):
        try:
            os.close(descriptor)
        except OSError:
            pass
`;
const DESCRIPTOR_SHAPE_AUDIT_SCRIPT = String.raw`
import os
import stat
import sys

root = sys.argv[1]
max_files = int(sys.argv[2])
max_single_file_bytes = int(sys.argv[3])
max_total_bytes = int(sys.argv[4])
excluded_roots = set(sys.argv[5:])
nofollow = getattr(os, "O_NOFOLLOW", 0)
stack = []
file_count = 0
total_bytes = 0

def fail(message):
    os.write(2, message.encode("utf-8", "backslashreplace"))
    raise SystemExit(1)

try:
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | nofollow)
    stack.append([root_fd, "", sorted(os.listdir(root_fd)), 0])
    while stack:
        directory_fd, prefix, names, index = stack[-1]
        if index >= len(names):
            os.close(directory_fd)
            stack.pop()
            continue
        name = names[index]
        stack[-1][3] += 1
        relative = name if not prefix else prefix + "/" + name
        if any(relative == root or relative.startswith(root + "/") for root in excluded_roots):
            continue
        try:
            item = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except OSError as error:
            fail("descriptor-safe shape audit failed for " + relative + ": " + str(error))
        if stat.S_ISDIR(item.st_mode):
            child_fd = None
            try:
                child_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_DIRECTORY | nofollow,
                    dir_fd=directory_fd,
                )
                child_names = sorted(os.listdir(child_fd))
            except OSError as error:
                if child_fd is not None:
                    try:
                        os.close(child_fd)
                    except OSError:
                        pass
                fail("descriptor-safe shape audit failed for " + relative + ": " + str(error))
            stack.append([child_fd, relative, child_names, 0])
        elif stat.S_ISREG(item.st_mode) or stat.S_ISLNK(item.st_mode):
            file_count += 1
            if file_count > max_files:
                fail("filesystem shape audit exceeds maxFiles=" + str(max_files))
            if item.st_size > max_single_file_bytes:
                fail(
                    "filesystem shape audit file exceeds maxSingleFileBytes="
                    + str(max_single_file_bytes)
                    + ": "
                    + relative
                )
            total_bytes += item.st_size
            if total_bytes > max_total_bytes:
                fail("filesystem shape audit exceeds maxTotalBytes=" + str(max_total_bytes))
            os.write(1, os.fsencode(relative) + b"\0")
        else:
            fail("unsupported filesystem object in frozen tree: " + relative)
except SystemExit:
    raise
except Exception as error:
    fail("descriptor-safe shape audit failed: " + str(error))
finally:
    for descriptor, _, _, _ in reversed(stack):
        try:
            os.close(descriptor)
        except OSError:
            pass
`;

export interface FrozenTreeCaptureHooks {
  beforeFileOpen?(relativePath: string): void;
  includeIgnoredRoots?: readonly string[];
  captureDomain?: 'git_visible' | 'authoritative_worktree';
  excludedRoots?: readonly string[];
  operation?: FrozenTreeOperationControl;
}

export interface FrozenTreeOperationControl {
  readonly signal: AbortSignal;
  checkpoint(): void;
  remainingMs(maximumMs: number): number;
}

export interface OwnedFrozenTreeOperationControl extends FrozenTreeOperationControl {
  dispose(): void;
}

export class FrozenTreeOperationError extends Error {
  readonly reason: 'timed_out' | 'cancelled';

  constructor(
    reason: 'timed_out' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'FrozenTreeOperationError';
    this.reason = reason;
  }
}

export function createFrozenTreeOperationControl(
  timeoutMs: number,
  externalSignal?: AbortSignal,
  now: () => number = () => performance.now(),
  timeoutDetail = `operation exceeded timeoutMs=${timeoutMs}`,
): OwnedFrozenTreeOperationControl {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('operation timeout must be a positive integer');
  }
  const controller = new AbortController();
  const deadline = now() + timeoutMs;
  const timeoutFailure = new FrozenTreeOperationError(
    'timed_out',
    timeoutDetail,
  );
  const cancellationFailure = new FrozenTreeOperationError(
    'cancelled',
    'operation cancelled by core',
  );
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(timeoutFailure);
  }, timeoutMs);
  const cancel = (): void => {
    if (!controller.signal.aborted) controller.abort(cancellationFailure);
  };
  externalSignal?.addEventListener('abort', cancel, { once: true });
  if (externalSignal?.aborted === true) cancel();

  const checkpoint = (): void => {
    if (externalSignal?.aborted === true && !controller.signal.aborted) cancel();
    if (now() >= deadline && !controller.signal.aborted) controller.abort(timeoutFailure);
    if (!controller.signal.aborted) return;
    const reason = controller.signal.reason;
    throw reason instanceof FrozenTreeOperationError
      ? reason
      : externalSignal?.aborted === true
        ? cancellationFailure
        : timeoutFailure;
  };

  return {
    signal: controller.signal,
    checkpoint,
    remainingMs(maximumMs) {
      checkpoint();
      const remaining = Math.ceil(deadline - now());
      if (remaining <= 0) {
        controller.abort(timeoutFailure);
        throw timeoutFailure;
      }
      return Math.max(1, Math.min(maximumMs, remaining));
    },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancel);
    },
  };
}

async function auditFilesystemShapes(
  repoDir: string,
  limits: Readonly<FrozenTreeLimits>,
  excludedRoots: readonly string[],
  operation?: FrozenTreeOperationControl,
): Promise<string[]> {
  operation?.checkpoint();
  const result = await runCoreTool({
    executable: PYTHON_BIN,
    args: [
      '-I',
      '-c',
      DESCRIPTOR_SHAPE_AUDIT_SCRIPT,
      repoDir,
      String(limits.maxFiles),
      String(limits.maxSingleFileBytes),
      String(limits.maxTotalBytes),
      ...excludedRoots,
    ],
    cwd: repoDir,
    environment: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxOutputBytes: limits.maxGitOutputBytes,
    timeoutMs:
      operation?.remainingMs(CORE_TOOL_TIMEOUT_MS) ??
      CORE_TOOL_TIMEOUT_MS,
    ...(operation === undefined ? {} : { signal: operation.signal }),
  });
  if (result.status !== 'completed' || result.exitCode !== 0) {
    if (result.status === 'timed_out' || result.status === 'cancelled') {
      operation?.checkpoint();
      throw new FrozenTreeOperationError(
        result.status,
        `descriptor-safe shape audit ${result.status === 'timed_out' ? 'timed out' : 'cancelled'}`,
      );
    }
    const detail =
      result.status === 'completed' || result.status === 'signaled'
        ? result.stderr.toString('utf8')
        : result.detail;
    throw new Error(detail || 'descriptor-safe filesystem shape audit failed');
  }
  operation?.checkpoint();
  return nulRecords(result.stdout).map((record) => decodePath(record));
}

export interface DescriptorReadOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function gitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.excludesFile',
    GIT_CONFIG_VALUE_2: '/dev/null',
    ...extra,
  };
}

async function gitBuffer(
  cwd: string,
  args: string[],
  opts?: {
    input?: Uint8Array;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    operation?: FrozenTreeOperationControl;
  },
): Promise<Buffer> {
  opts?.operation?.checkpoint();
  const result = await runCoreTool({
    executable: GIT_BIN,
    args,
    cwd,
    environment: gitEnvironment(opts?.env),
    maxOutputBytes: opts?.maxBuffer ?? DEFAULT_FROZEN_TREE_LIMITS.maxGitOutputBytes,
    timeoutMs:
      opts?.operation?.remainingMs(CORE_TOOL_TIMEOUT_MS) ??
      CORE_TOOL_TIMEOUT_MS,
    ...(opts?.operation === undefined ? {} : { signal: opts.operation.signal }),
    ...(opts?.input === undefined ? {} : { input: opts.input }),
  });
  opts?.operation?.checkpoint();
  if (result.status !== 'completed' || result.exitCode !== 0) {
    if (result.status === 'timed_out' || result.status === 'cancelled') {
      throw new FrozenTreeOperationError(
        result.status,
        `core Git command ${result.status === 'timed_out' ? 'timed out' : 'cancelled'} (${args[0] ?? 'unknown'})`,
      );
    }
    const detail =
      result.status === 'completed'
        ? result.stderr.toString('utf8')
        : result.status === 'signaled'
          ? `terminated by ${String(result.signal)}`
          : result.detail;
    throw new Error(`core Git command failed (${args[0] ?? 'unknown'}): ${detail}`);
  }
  return result.stdout;
}

async function gitText(
  cwd: string,
  args: string[],
  opts?: {
    input?: Uint8Array;
    env?: NodeJS.ProcessEnv;
    operation?: FrozenTreeOperationControl;
  },
): Promise<string> {
  return (await gitBuffer(cwd, args, opts)).toString('utf8').trim();
}

function nulRecords(bytes: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      if (index > start) records.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== bytes.length) throw new Error('Git plumbing returned a non-NUL-terminated record');
  return records;
}

function decodePath(bytes: Uint8Array): string {
  const path = decodeUtf8(bytes, 'path');
  if (path.length === 0 || isAbsolute(path)) throw new Error(`unsafe frozen path: ${path}`);
  const normalized = normalize(path);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`frozen path escapes the tree: ${path}`);
  }
  return path;
}

function decodeUtf8(bytes: Uint8Array, subject: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`frozen tree contains a ${subject} that is not valid UTF-8`);
  }
}

function splitIndexRecord(record: Buffer): {
  mode: string;
  object: string;
  stage: string;
  path: string;
} {
  const tab = record.indexOf(0x09);
  if (tab < 0) throw new Error('malformed Git index record');
  const header = record.subarray(0, tab).toString('ascii').split(' ');
  if (header.length !== 3) throw new Error('malformed Git index header');
  return {
    mode: header[0] ?? '',
    object: header[1] ?? '',
    stage: header[2] ?? '',
    path: decodePath(record.subarray(tab + 1)),
  };
}

function assertContained(root: string, path: string): string {
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`frozen path escapes materialization root: ${path}`);
  }
  return target;
}

function normalizedExcludedRoots(
  roots: readonly string[] | undefined,
): string[] {
  const normalized = [...new Set(roots ?? ['.git'])].sort();
  if (!normalized.includes('.git')) {
    throw new Error('frozen-tree capture must exclude core Git metadata');
  }
  for (const root of normalized) {
    if (decodePath(Buffer.from(root)) !== root) {
      throw new Error(`unsafe frozen-tree excluded root: ${root}`);
    }
  }
  return normalized;
}

async function readFrozenEntryContent(
  repoDir: string,
  path: string,
  limits: Readonly<FrozenTreeLimits>,
  operation?: FrozenTreeOperationControl,
  beforeFileOpen?: (relativePath: string) => void,
): Promise<{
  mode: FrozenTreeEntry['mode'];
  content: Buffer;
}> {
  operation?.checkpoint();
  const source = assertContained(repoDir, path);
  const before = lstatSync(source, { bigint: true });
  if (before.isSymbolicLink()) {
    beforeFileOpen?.(path);
    const descriptorRead = await readSymlinkByDescriptor(
      repoDir,
      path,
      limits.maxSingleFileBytes,
      operation,
    );
    const content = descriptorRead.content;
    const after = descriptorRead.metadata;
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error(`frozen symlink changed while reading: ${path}`);
    }
    return { mode: '120000', content };
  }
  if (!before.isFile()) {
    throw new Error(`unsupported filesystem object in frozen tree: ${path}`);
  }
  if (before.size > BigInt(limits.maxSingleFileBytes)) {
    throw new Error(
      `frozen file ${path} exceeds maxSingleFileBytes=${limits.maxSingleFileBytes}`,
    );
  }
  beforeFileOpen?.(path);
  const descriptorRead = await readRegularFileByDescriptor(
    repoDir,
    path,
    limits.maxSingleFileBytes,
    {
      timeoutMs:
        operation?.remainingMs(CORE_TOOL_TIMEOUT_MS) ??
        CORE_TOOL_TIMEOUT_MS,
      ...(operation === undefined ? {} : { signal: operation.signal }),
    },
  );
  operation?.checkpoint();
  const after = descriptorRead.metadata;
  if (
    after.size !== before.size ||
    after.mode !== before.mode ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  ) {
    throw new Error(`frozen source changed while reading: ${path}`);
  }
  return {
    mode: (before.mode & 0o111n) === 0n ? '100644' : '100755',
    content: descriptorRead.content,
  };
}

async function initializeRepository(
  repoDir: string,
  objectFormat: string,
  operation?: FrozenTreeOperationControl,
): Promise<void> {
  operation?.checkpoint();
  const templateDir = mkdtempSync(join(tmpdir(), 'core-git-template-'));
  try {
    await gitBuffer(repoDir, [
      'init',
      '-q',
      '-b',
      'frozen',
      `--object-format=${objectFormat}`,
      `--template=${templateDir}`,
    ], operation === undefined ? undefined : { operation });
  } finally {
    rmSync(templateDir, { recursive: true, force: true });
  }
}

async function writeIndexEntry(
  repoDir: string,
  indexFile: string,
  entry: FrozenTreeEntry,
  content?: Uint8Array,
  operation?: FrozenTreeOperationControl,
): Promise<void> {
  operation?.checkpoint();
  let object = entry.object;
  if (entry.mode !== '160000') {
    if (content === undefined) throw new Error(`missing blob content for ${entry.path}`);
    object = await gitText(repoDir, ['hash-object', '-w', '--no-filters', '--stdin'], {
      input: content,
      ...(operation === undefined ? {} : { operation }),
    });
    if (object !== entry.object) {
      throw new Error(`materialized blob hash mismatch for ${entry.path}`);
    }
  }
  await gitBuffer(
    repoDir,
    ['update-index', '--add', '--cacheinfo', entry.mode, object, entry.path],
    {
      env: { GIT_INDEX_FILE: indexFile },
      ...(operation === undefined ? {} : { operation }),
    },
  );
}

async function materializeFromSnapshot(
  snapshotRepo: string,
  treeHash: string,
  entries: readonly FrozenTreeEntry[],
  destination: string,
  limits: Readonly<FrozenTreeLimits>,
  operation?: FrozenTreeOperationControl,
): Promise<void> {
  operation?.checkpoint();
  if (entries.some((entry) => entry.mode === '160000')) {
    const gitlink = entries.find((entry) => entry.mode === '160000');
    throw new Error(`submodule/gitlink is unsupported in a frozen gate tree: ${gitlink?.path}`);
  }

  const objectFormat = await gitText(snapshotRepo, ['rev-parse', '--show-object-format'], {
    ...(operation === undefined ? {} : { operation }),
  });
  await initializeRepository(destination, objectFormat, operation);
  const isolatedIndex = join(destination, '.git', 'core-index');
  await gitBuffer(destination, ['read-tree', '--empty'], {
    env: { GIT_INDEX_FILE: isolatedIndex },
    ...(operation === undefined ? {} : { operation }),
  });
  for (const entry of entries) {
    operation?.checkpoint();
    const content = await gitBuffer(snapshotRepo, ['cat-file', 'blob', entry.object], {
      maxBuffer: Math.min(
        limits.maxGitOutputBytes,
        Math.max(entry.bytes + 65_536, 65_536),
      ),
      ...(operation === undefined ? {} : { operation }),
    });
    if (content.byteLength !== entry.bytes) {
      throw new Error(`materialized blob size mismatch for ${entry.path}`);
    }
    if (createHash('sha256').update(content).digest('hex') !== entry.sha256) {
      throw new Error(`materialized blob content mismatch for ${entry.path}`);
    }
    const target = assertContained(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.mode === '120000') {
      const linkTarget = decodeUtf8(content, 'symlink target');
      if (isAbsolute(linkTarget)) {
        throw new Error(`absolute symlink target is unsafe in frozen tree: ${entry.path}`);
      }
      const resolvedTarget = resolve(dirname(target), linkTarget);
      if (
        resolvedTarget !== destination &&
        !resolvedTarget.startsWith(`${destination}${sep}`)
      ) {
        throw new Error(`symlink target escapes frozen tree: ${entry.path} -> ${linkTarget}`);
      }
      symlinkSync(linkTarget, target);
    } else {
      writeFileSync(target, content);
      chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644);
    }
    operation?.checkpoint();
    await writeIndexEntry(destination, isolatedIndex, entry, content, operation);
  }

  const isolatedTree = await gitText(destination, ['write-tree'], {
    env: { GIT_INDEX_FILE: isolatedIndex },
    ...(operation === undefined ? {} : { operation }),
  });
  if (isolatedTree !== treeHash) {
    throw new Error(`isolated materialization tree mismatch: expected ${treeHash}, got ${isolatedTree}`);
  }
  const commit = await gitText(destination, ['commit-tree', isolatedTree, '-m', 'core frozen gate tree'], {
    env: {
      GIT_AUTHOR_NAME: 'Core Gate',
      GIT_AUTHOR_EMAIL: 'core-gate@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'Core Gate',
      GIT_COMMITTER_EMAIL: 'core-gate@example.invalid',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      GIT_INDEX_FILE: isolatedIndex,
    },
    ...(operation === undefined ? {} : { operation }),
  });
  await gitBuffer(
    destination,
    ['update-ref', 'refs/heads/frozen', commit],
    operation === undefined ? undefined : { operation },
  );
  operation?.checkpoint();
  renameSync(isolatedIndex, join(destination, '.git', 'index'));
}

function validateLimits(limits: Readonly<FrozenTreeLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`invalid frozen-tree limit ${name}`);
    }
  }
}

function inventoryHash(entries: readonly FrozenTreeEntry[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        entries.map(({ path, mode, bytes, sha256 }) => ({ path, mode, bytes, sha256 })),
      ),
    )
    .digest('hex');
}

async function readSymlinkByDescriptor(
  repoDir: string,
  relativePath: string,
  maxBytes: number,
  operation?: FrozenTreeOperationControl,
): Promise<{
  content: Buffer;
  metadata: {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    sha256: string;
  };
}> {
  operation?.checkpoint();
  const result = await runCoreTool({
    executable: PYTHON_BIN,
    args: ['-I', '-c', DESCRIPTOR_SYMLINK_READ_SCRIPT, repoDir, relativePath],
    cwd: repoDir,
    environment: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxOutputBytes: maxBytes + 65_536,
    timeoutMs:
      operation?.remainingMs(CORE_TOOL_TIMEOUT_MS) ??
      CORE_TOOL_TIMEOUT_MS,
    ...(operation === undefined ? {} : { signal: operation.signal }),
  });
  if (result.status !== 'completed' || result.exitCode !== 0) {
    if (result.status === 'timed_out' || result.status === 'cancelled') {
      operation?.checkpoint();
      throw new FrozenTreeOperationError(
        result.status,
        `descriptor-safe symlink read ${
          result.status === 'timed_out' ? 'timed out' : 'cancelled'
        } for ${relativePath}`,
      );
    }
    const detail =
      result.status === 'completed' || result.status === 'signaled'
        ? result.stderr.toString('utf8')
        : result.detail;
    throw new Error(
      `descriptor-safe symlink read rejected ${relativePath}: ${detail}`,
    );
  }
  const metadataOutput = result.stderr.toString('utf8');
  const marker = 'CORE_SYMLINK_METADATA:';
  const markerIndex = metadataOutput.lastIndexOf(marker);
  let parsed: Record<string, string>;
  try {
    if (markerIndex < 0) throw new Error('missing metadata marker');
    parsed = JSON.parse(
      metadataOutput.slice(markerIndex + marker.length),
    ) as Record<string, string>;
  } catch {
    throw new Error(
      `descriptor-safe symlink read returned invalid metadata for ${relativePath}: ${metadataOutput}`,
    );
  }
  const required = [
    'dev',
    'ino',
    'mode',
    'size',
    'mtimeNs',
    'ctimeNs',
  ] as const;
  if (
    required.some(
      (key) =>
        typeof parsed[key] !== 'string' || !/^\d+$/u.test(parsed[key]),
    )
  ) {
    throw new Error(
      `descriptor-safe symlink read returned incomplete metadata for ${relativePath}`,
    );
  }
  if (
    typeof parsed['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(parsed['sha256'])
  ) {
    throw new Error(
      `descriptor-safe symlink read returned an invalid digest for ${relativePath}`,
    );
  }
  if (
    BigInt(result.stdout.byteLength) !== BigInt(parsed['size'] as string) ||
    createHash('sha256').update(result.stdout).digest('hex') !==
      parsed['sha256']
  ) {
    throw new Error(
      `descriptor-safe symlink read content identity mismatch for ${relativePath}`,
    );
  }
  operation?.checkpoint();
  return {
    content: result.stdout,
    metadata: {
      dev: BigInt(parsed['dev'] as string),
      ino: BigInt(parsed['ino'] as string),
      mode: BigInt(parsed['mode'] as string),
      size: BigInt(parsed['size'] as string),
      mtimeNs: BigInt(parsed['mtimeNs'] as string),
      ctimeNs: BigInt(parsed['ctimeNs'] as string),
      sha256: parsed['sha256'] as string,
    },
  };
}

export async function readRegularFileByDescriptor(
  repoDir: string,
  relativePath: string,
  maxBytes: number,
  options: DescriptorReadOptions = {},
): Promise<{
  content: Buffer;
  metadata: {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    sha256: string;
  };
}> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error('descriptor-safe frozen read timeout must be a positive integer');
  }
  const result = await runCoreTool({
    executable: PYTHON_BIN,
    args: ['-I', '-c', DESCRIPTOR_READ_SCRIPT, repoDir, relativePath],
    cwd: repoDir,
    environment: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxOutputBytes: maxBytes + 65_536,
    timeoutMs: Math.min(options.timeoutMs ?? CORE_TOOL_TIMEOUT_MS, CORE_TOOL_TIMEOUT_MS),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.status !== 'completed' || result.exitCode !== 0) {
    if (result.status === 'timed_out' || result.status === 'cancelled') {
      const reason = options.signal?.reason;
      if (reason instanceof FrozenTreeOperationError) throw reason;
      throw new FrozenTreeOperationError(
        result.status,
        `descriptor-safe frozen read ${result.status === 'timed_out' ? 'timed out' : 'cancelled'} for ${relativePath}`,
      );
    }
    const detail =
      result.status === 'completed' || result.status === 'signaled'
        ? result.stderr.toString('utf8')
        : result.detail;
    throw new Error(`descriptor-safe frozen read rejected ${relativePath}: ${detail}`);
  }
  let parsed: Record<string, string>;
  const metadataOutput = result.stderr.toString('utf8');
  const marker = 'CORE_DESCRIPTOR_METADATA:';
  const markerIndex = metadataOutput.lastIndexOf(marker);
  try {
    if (markerIndex < 0) throw new Error('missing metadata marker');
    parsed = JSON.parse(metadataOutput.slice(markerIndex + marker.length)) as Record<string, string>;
  } catch {
    throw new Error(
      `descriptor-safe frozen read returned invalid metadata for ${relativePath}: ${metadataOutput}`,
    );
  }
  const required = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const;
  if (required.some((key) => typeof parsed[key] !== 'string' || !/^\d+$/u.test(parsed[key]))) {
    throw new Error(`descriptor-safe frozen read returned incomplete metadata for ${relativePath}`);
  }
  if (typeof parsed['sha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(parsed['sha256'])) {
    throw new Error(`descriptor-safe frozen read returned an invalid digest for ${relativePath}`);
  }
  if (
    BigInt(result.stdout.byteLength) !== BigInt(parsed['size'] as string) ||
    createHash('sha256').update(result.stdout).digest('hex') !== parsed['sha256']
  ) {
    throw new Error(`descriptor-safe frozen read content identity mismatch for ${relativePath}`);
  }
  return {
    content: result.stdout,
    metadata: {
      dev: BigInt(parsed['dev'] as string),
      ino: BigInt(parsed['ino'] as string),
      mode: BigInt(parsed['mode'] as string),
      size: BigInt(parsed['size'] as string),
      mtimeNs: BigInt(parsed['mtimeNs'] as string),
      ctimeNs: BigInt(parsed['ctimeNs'] as string),
      sha256: parsed['sha256'] as string,
    },
  };
}

export async function freezeWorkingTree(
  repoDir: string,
  limits: Readonly<FrozenTreeLimits> = DEFAULT_FROZEN_TREE_LIMITS,
  temporaryRoot: string = tmpdir(),
  hooks?: FrozenTreeCaptureHooks,
): Promise<FrozenTree> {
  validateLimits(limits);
  const operation = hooks?.operation;
  operation?.checkpoint();
  const excludedRoots = normalizedExcludedRoots(hooks?.excludedRoots);
  const snapshotRepo = mkdtempSync(join(temporaryRoot, 'gate-snapshot-'));
  try {
    const auditedPaths = await auditFilesystemShapes(
      repoDir,
      limits,
      excludedRoots,
      operation,
    );
    const objectFormat = await gitText(repoDir, ['rev-parse', '--show-object-format'], {
      ...(operation === undefined ? {} : { operation }),
    });
    await initializeRepository(snapshotRepo, objectFormat, operation);
    const snapshotIndex = join(snapshotRepo, '.git', 'core-index');
    await gitBuffer(snapshotRepo, ['read-tree', '--empty'], {
      env: { GIT_INDEX_FILE: snapshotIndex },
      ...(operation === undefined ? {} : { operation }),
    });

    const staged = new Map<string, { mode: string; object: string }>();
    for (const record of nulRecords(
      await gitBuffer(
        repoDir,
        ['ls-files', '--stage', '-z'],
        operation === undefined ? undefined : { operation },
      ),
    )) {
      operation?.checkpoint();
      const parsed = splitIndexRecord(record);
      if (parsed.stage !== '0') {
        throw new Error(`unmerged index entry cannot be frozen: ${parsed.path}`);
      }
      staged.set(parsed.path, { mode: parsed.mode, object: parsed.object });
    }

    let paths: string[];
    if (hooks?.captureDomain === 'authoritative_worktree') {
      const gitlink = [...staged.entries()].find(
        ([path, entry]) =>
          entry.mode === '160000' &&
          !excludedRoots.some(
            (root) => path === root || path.startsWith(`${root}/`),
          ),
      );
      if (gitlink !== undefined) {
        throw new Error(
          `submodule/gitlink is unsupported in an authoritative worktree: ${gitlink[0]}`,
        );
      }
      paths = [...new Set(auditedPaths)].sort();
    } else {
      const pathRecords = nulRecords(
        await gitBuffer(
          repoDir,
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          operation === undefined ? undefined : { operation },
        ),
      );
      const ignoredRoots = hooks?.includeIgnoredRoots ?? [];
      for (const root of ignoredRoots) {
        const normalized = decodePath(Buffer.from(root));
        if (normalized !== root || normalized === '.git' || normalized.startsWith('.git/')) {
          throw new Error(`unsafe ignored frozen-tree root: ${root}`);
        }
        pathRecords.push(
          ...nulRecords(
            await gitBuffer(
              repoDir,
              ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', root],
              operation === undefined ? undefined : { operation },
            ),
          ),
        );
      }
      paths = [...new Set(pathRecords.map((record) => decodePath(record)))].sort();
    }
    if (paths.length > limits.maxFiles) {
      throw new Error(`frozen tree exceeds maxFiles=${limits.maxFiles}`);
    }
    const entries: FrozenTreeEntry[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      operation?.checkpoint();
      const stagedEntry = staged.get(path);
      if (stagedEntry?.mode === '160000') {
        throw new Error(`submodule/gitlink is unsupported in a frozen tree: ${path}`);
      }

      let captured: Awaited<ReturnType<typeof readFrozenEntryContent>>;
      try {
        captured = await readFrozenEntryContent(
          repoDir,
          path,
          limits,
          operation,
          hooks?.beforeFileOpen,
        );
      } catch (error) {
        // Git's cached inventory names a tracked file that is durably deleted
        // from the working tree. The legacy git-visible domain represents that
        // deletion by omitting the entry. The authoritative domain comes from
        // the descriptor audit itself, so disappearance there is capture churn.
        if (
          hooks?.captureDomain !== 'authoritative_worktree' &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          continue;
        }
        throw error;
      }
      const { mode, content } = captured;
      totalBytes += content.byteLength;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(`frozen tree exceeds maxTotalBytes=${limits.maxTotalBytes}`);
      }
      const object = await gitText(snapshotRepo, ['hash-object', '-w', '--no-filters', '--stdin'], {
        input: content,
        ...(operation === undefined ? {} : { operation }),
      });
      const entry: FrozenTreeEntry = {
        mode,
        object,
        path,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
      await writeIndexEntry(snapshotRepo, snapshotIndex, entry, content, operation);
      entries.push(entry);
    }

    if (hooks?.captureDomain === 'authoritative_worktree') {
      const postPaths = [
        ...new Set(
          await auditFilesystemShapes(
            repoDir,
            limits,
            excludedRoots,
            operation,
          ),
        ),
      ].sort();
      if (JSON.stringify(postPaths) !== JSON.stringify(paths)) {
        throw new Error('authoritative worktree path inventory changed during capture');
      }
      for (const entry of entries) {
        operation?.checkpoint();
        const { mode, content } = await readFrozenEntryContent(
          repoDir,
          entry.path,
          limits,
          operation,
        );
        if (
          mode !== entry.mode ||
          content.byteLength !== entry.bytes ||
          createHash('sha256').update(content).digest('hex') !== entry.sha256
        ) {
          throw new Error(
            `authoritative worktree content changed during capture: ${entry.path}`,
          );
        }
      }
    }

    const treeHash = await gitText(snapshotRepo, ['write-tree'], {
      env: { GIT_INDEX_FILE: snapshotIndex },
      ...(operation === undefined ? {} : { operation }),
    });
    operation?.checkpoint();
    const frozenEntries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    return {
      treeHash,
      inventoryHash: inventoryHash(frozenEntries),
      entries: frozenEntries,
      async materialize(destination, materializeOperation) {
        await materializeFromSnapshot(
          snapshotRepo,
          treeHash,
          frozenEntries,
          destination,
          limits,
          materializeOperation,
        );
      },
      cleanup() {
        rmSync(snapshotRepo, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      rmSync(snapshotRepo, { recursive: true, force: true });
    } catch {
      // Preserve the materialization error; a later attempt uses a new exclusive root.
    }
    throw error;
  }
}
