import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FrozenTreeOperationError,
  DEFAULT_FROZEN_TREE_LIMITS,
  freezeWorkingTree,
  readRegularFileByDescriptor,
  type FrozenTreeOperationControl,
  type FrozenTreeEntry,
} from '../gates/frozen-tree.ts';
import { runCoreTool, type CoreToolResult } from '../security/command-runner.ts';
import type { ActionRejection } from '../types.ts';
import {
  applyMutationBatch,
  checkMutationPaths,
  MutationPathError,
  type MutationPathOperation,
} from './mutation-path.ts';

export interface PatchPath {
  oldPath?: string;
  newPath?: string;
}

export interface PreparedPatch {
  bytes: Uint8Array;
  paths: PatchPath[];
  mutations: MutationPathOperation[];
  kind: 'text';
  effect: 'text' | 'noop' | 'copy';
}

type PatchReason = Extract<
  ActionRejection['reason'],
  | 'evidence_invalid'
  | 'golden_write_denied'
  | 'red_artifact_frozen'
  | 'patch_malformed'
  | 'patch_unsupported'
  | 'patch_conflict'
  | 'patch_noop'
  | 'path_outside_allowlist'
>;

export class PatchRejected extends Error {
  readonly reason: PatchReason;

  constructor(reason: PatchReason, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

const GIT_BIN = '/usr/bin/git';
const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_BYTES = 67_108_864;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function gitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.excludesFile',
    GIT_CONFIG_VALUE_2: '/dev/null',
    GIT_AUTHOR_NAME: 'Core Patch Inspector',
    GIT_AUTHOR_EMAIL: 'core-patch@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Core Patch Inspector',
    GIT_COMMITTER_EMAIL: 'core-patch@example.invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    ...extra,
  };
}

function rethrowOperationFailure(error: unknown): void {
  if (error instanceof FrozenTreeOperationError) throw error;
}

function commandDetail(result: CoreToolResult): string {
  if (result.status === 'completed') return result.stderr.toString('utf8').trim();
  if (result.status === 'signaled') return `terminated by ${result.signal}`;
  return result.detail;
}

async function git(
  cwd: string,
  args: readonly string[],
  operation?: FrozenTreeOperationControl,
  input?: Uint8Array,
  extraEnvironment?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  operation?.checkpoint();
  const result = await runCoreTool({
    executable: GIT_BIN,
    args,
    cwd,
    environment: gitEnvironment(extraEnvironment),
    maxOutputBytes: GIT_OUTPUT_BYTES,
    timeoutMs: operation?.remainingMs(GIT_TIMEOUT_MS) ?? GIT_TIMEOUT_MS,
    ...(operation === undefined ? {} : { signal: operation.signal }),
    ...(input === undefined ? {} : { input }),
  });
  operation?.checkpoint();
  if (result.status === 'timed_out' || result.status === 'cancelled') {
    throw new FrozenTreeOperationError(
      result.status,
      `core patch Git command ${
        result.status === 'timed_out' ? 'timed out' : 'cancelled'
      } (${args[0] ?? 'unknown'})`,
    );
  }
  if (result.status !== 'completed' || result.exitCode !== 0) {
    throw new Error(commandDetail(result));
  }
  return result.stdout;
}

async function inspectPatchSyntax(
  worktreeDir: string,
  bytes: Uint8Array,
  operation?: FrozenTreeOperationControl,
): Promise<PatchPath[]> {
  let forwardOutput: Buffer;
  let reverseOutput: Buffer;
  try {
    forwardOutput = await git(
      worktreeDir,
      ['apply', '--numstat', '-z', '--whitespace=nowarn', '-'],
      operation,
      bytes,
    );
    reverseOutput = await git(
      worktreeDir,
      ['apply', '--numstat', '-z', '--reverse', '--whitespace=nowarn', '-'],
      operation,
      bytes,
    );
  } catch (error) {
    rethrowOperationFailure(error);
    throw new PatchRejected(
      'patch_malformed',
      `patch syntax is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (forwardOutput.length === 0 || reverseOutput.length === 0) {
    throw new PatchRejected('patch_noop', 'patch contains no textual changes');
  }
  const forwardPaths = parseNumstatPaths(forwardOutput);
  // Git emits the file records in reverse order under `--reverse`; restore the
  // original patch order before pairing each reverse source with its forward
  // destination.
  const reversePaths = parseNumstatPaths(reverseOutput).reverse();
  if (forwardPaths.length !== reversePaths.length) {
    throw new PatchRejected(
      'patch_malformed',
      'Git returned inconsistent forward and reverse patch path metadata',
    );
  }
  return forwardPaths.map((forward, index) => {
    const reverse = reversePaths[index];
    if (reverse === undefined) {
      throw new PatchRejected('patch_malformed', 'Git omitted a reverse patch path');
    }
    const oldPath = reverse.newPath ?? reverse.oldPath;
    const newPath = forward.newPath ?? forward.oldPath;
    if (oldPath === undefined || newPath === undefined) {
      throw new PatchRejected('patch_malformed', 'Git omitted a declared patch path');
    }
    // `git apply --numstat -z` reports the destination for extended
    // rename/copy metadata. The same Git parser under `--reverse` reports its
    // source. Pairing those NUL-delimited records preserves both declared paths
    // without parsing quoted patch headers ourselves.
    return { oldPath, newPath };
  });
}

function parseNumstatPaths(output: Buffer): PatchPath[] {
  const paths: PatchPath[] = [];
  let offset = 0;
  const readRecord = (): Buffer => {
    const end = output.indexOf(0, offset);
    if (end < 0) {
      throw new PatchRejected('patch_malformed', 'Git path output is not NUL-terminated');
    }
    const record = output.subarray(offset, end);
    offset = end + 1;
    return record;
  };
  while (offset < output.length) {
    const record = readRecord();
    const firstTab = record.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : record.indexOf(0x09, firstTab + 1);
    if (firstTab <= 0 || secondTab < firstTab + 1) {
      throw new PatchRejected('patch_malformed', 'Git returned malformed patch statistics');
    }
    const additions = record.subarray(0, firstTab).toString('ascii');
    const deletions = record.subarray(firstTab + 1, secondTab).toString('ascii');
    if (additions === '-' || deletions === '-') {
      throw new PatchRejected('patch_unsupported', 'binary patches are unsupported in Phase 0');
    }
    if (!/^\d+$/u.test(additions) || !/^\d+$/u.test(deletions)) {
      throw new PatchRejected('patch_malformed', 'Git returned malformed patch statistics');
    }
    const inlinePath = record.subarray(secondTab + 1);
    if (inlinePath.length > 0) {
      const path = decodePath(inlinePath);
      // Numstat does not distinguish add/update/delete in this record. Checking
      // the same declared path as both old and new is conservative; effective
      // raw metadata is parsed separately below.
      paths.push({ oldPath: path, newPath: path });
      continue;
    }
    const oldPath = decodePath(readRecord());
    const newPath = decodePath(readRecord());
    paths.push({ oldPath, newPath });
  }
  if (paths.length === 0) {
    throw new PatchRejected('patch_noop', 'patch contains no declared paths');
  }
  return paths;
}

function nulRecords(buffer: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) {
    throw new PatchRejected('patch_malformed', 'Git path output is not NUL-terminated');
  }
  return records.filter((record) => record.length > 0);
}

function decodePath(bytes: Buffer): string {
  let path: string;
  try {
    path = UTF8.decode(bytes);
  } catch {
    throw new PatchRejected('patch_unsupported', 'patch path is not valid UTF-8');
  }
  if (path.length === 0 || path.includes('\0')) {
    throw new PatchRejected('patch_malformed', 'patch contains an empty or invalid path');
  }
  return path;
}

function parseRawPaths(output: Buffer): PatchPath[] {
  const records = nulRecords(output);
  const paths: PatchPath[] = [];
  let index = 0;
  while (index < records.length) {
    const header = records[index]?.toString('ascii') ?? '';
    index += 1;
    const match =
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])([0-9]*)$/u.exec(
        header,
      );
    if (match === null) {
      throw new PatchRejected('patch_malformed', 'Git returned malformed raw patch metadata');
    }
    const oldMode = match[1] as string;
    const newMode = match[2] as string;
    const status = match[5] as string;
    if (status === 'C') {
      throw new PatchRejected('patch_unsupported', 'copy patches are unsupported in Phase 0');
    }
    if (
      (oldMode !== '000000' && oldMode !== '100644' && oldMode !== '100755') ||
      (newMode !== '000000' && newMode !== '100644' && newMode !== '100755')
    ) {
      throw new PatchRejected(
        'patch_unsupported',
        'symlink-bearing or non-regular-file patches are unsupported in Phase 0',
      );
    }
    const firstPathBytes = records[index];
    if (firstPathBytes === undefined) {
      throw new PatchRejected('patch_malformed', 'Git omitted an affected patch path');
    }
    index += 1;
    const firstPath = decodePath(firstPathBytes);
    if (status === 'R') {
      const secondPathBytes = records[index];
      if (secondPathBytes === undefined) {
        throw new PatchRejected('patch_malformed', 'Git omitted a rename destination');
      }
      index += 1;
      paths.push({ oldPath: firstPath, newPath: decodePath(secondPathBytes) });
    } else if (status === 'A') {
      paths.push({ newPath: firstPath });
    } else if (status === 'D') {
      paths.push({ oldPath: firstPath });
    } else {
      paths.push({ oldPath: firstPath, newPath: firstPath });
    }
  }
  if (paths.length === 0) {
    throw new PatchRejected('patch_noop', 'patch produces no artifact change');
  }
  return paths;
}

function samePathPair(left: PatchPath, right: PatchPath): boolean {
  return left.oldPath === right.oldPath && left.newPath === right.newPath;
}

function classifyEffect(
  declaredPaths: readonly PatchPath[],
  effectivePaths: readonly PatchPath[],
): PreparedPatch['effect'] {
  const effectiveRenames = effectivePaths.filter(
    (path) =>
      path.oldPath !== undefined &&
      path.newPath !== undefined &&
      path.oldPath !== path.newPath,
  );
  const hasCopyMetadata = declaredPaths.some(
    (path) =>
      path.oldPath !== undefined &&
      path.newPath !== undefined &&
      path.oldPath !== path.newPath &&
      !effectiveRenames.some((rename) => samePathPair(path, rename)),
  );
  if (hasCopyMetadata) return 'copy';
  return effectivePaths.length === 0 ? 'noop' : 'text';
}

function classifyApplyFailure(detail: string): PatchRejected {
  if (/invalid path|outside.*working area|outside a symbolic link/iu.test(detail)) {
    return new PatchRejected('path_outside_allowlist', `patch path is unsafe: ${detail}`);
  }
  if (/symbolic link|symlink/iu.test(detail)) {
    return new PatchRejected('patch_unsupported', `symlink-bearing patch is unsupported: ${detail}`);
  }
  return new PatchRejected('patch_conflict', `patch does not apply cleanly: ${detail}`);
}

function expectedEntry(
  entry: FrozenTreeEntry | undefined,
): MutationPathOperation['expected'] {
  if (entry === undefined) return { kind: 'absent' };
  if (entry.mode !== '100644' && entry.mode !== '100755') {
    throw new PatchRejected(
      'patch_unsupported',
      `patch precondition is not a regular file: ${entry.path}`,
    );
  }
  return {
    kind: 'regular',
    sha256: entry.sha256,
    mode: entry.mode,
  };
}

async function patchMutations(
  inspectionRoot: string,
  before: readonly FrozenTreeEntry[],
  after: readonly FrozenTreeEntry[],
  paths: readonly PatchPath[],
  operation?: FrozenTreeOperationControl,
): Promise<MutationPathOperation[]> {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  const affected = new Set<string>();
  for (const path of paths) {
    if (path.oldPath !== undefined) affected.add(path.oldPath);
    if (path.newPath !== undefined) affected.add(path.newPath);
  }
  const mutations: MutationPathOperation[] = [];
  for (const path of [...affected].sort()) {
    operation?.checkpoint();
    const prior = beforeMap.get(path);
    const next = afterMap.get(path);
    if (
      prior?.mode === next?.mode &&
      prior?.sha256 === next?.sha256 &&
      prior?.bytes === next?.bytes
    ) {
      continue;
    }
    if (next === undefined) {
      mutations.push({
        path,
        expected: expectedEntry(prior),
        desired: { kind: 'absent' },
      });
      continue;
    }
    if (next.mode !== '100644' && next.mode !== '100755') {
      throw new PatchRejected(
        'patch_unsupported',
        `patch result is not a regular file: ${path}`,
      );
    }
    const content = (
      await readRegularFileByDescriptor(
        inspectionRoot,
        path,
        DEFAULT_FROZEN_TREE_LIMITS.maxSingleFileBytes,
        operation,
      )
    ).content;
    mutations.push({
      path,
      expected: expectedEntry(prior),
      desired: { kind: 'regular', content, mode: next.mode },
    });
  }
  return mutations;
}

export async function preparePatch(
  worktreeDir: string,
  bytes: Uint8Array,
  operation?: FrozenTreeOperationControl,
): Promise<PreparedPatch> {
  if (bytes.byteLength === 0) {
    throw new PatchRejected('patch_noop', 'patch is empty');
  }

  const frozen = await freezeWorkingTree(
    worktreeDir,
    DEFAULT_FROZEN_TREE_LIMITS,
    tmpdir(),
    operation === undefined ? undefined : { operation },
  );
  const inspectionRoot = mkdtempSync(join(tmpdir(), 'patch-inspection-'));
  let appliedTree:
    | Awaited<ReturnType<typeof freezeWorkingTree>>
    | undefined;
  try {
    await frozen.materialize(inspectionRoot, operation);
    await git(inspectionRoot, ['init', '-q'], operation);
    const declaredPaths = await inspectPatchSyntax(inspectionRoot, bytes, operation);
    await git(inspectionRoot, ['add', '-A'], operation);
    const tree = (await git(inspectionRoot, ['write-tree'], operation))
      .toString('ascii')
      .trim();
    const commit = (
      await git(
        inspectionRoot,
        ['commit-tree', tree, '-m', 'core patch inspection'],
        operation,
      )
    )
      .toString('ascii')
      .trim();
    await git(inspectionRoot, ['update-ref', 'HEAD', commit], operation);
    try {
      await git(
        inspectionRoot,
        ['apply', '--index', '--whitespace=nowarn', '-'],
        operation,
        bytes,
      );
    } catch (error) {
      rethrowOperationFailure(error);
      throw classifyApplyFailure(error instanceof Error ? error.message : String(error));
    }
    const raw = await git(
      inspectionRoot,
      ['diff', '--cached', '--raw', '-z', '--no-abbrev', '-M0', 'HEAD'],
      operation,
    );
    const effectivePaths = raw.length === 0 ? [] : parseRawPaths(raw);
    appliedTree = await freezeWorkingTree(
      inspectionRoot,
      DEFAULT_FROZEN_TREE_LIMITS,
      tmpdir(),
      operation === undefined ? undefined : { operation },
    );
    return {
      bytes,
      paths: declaredPaths,
      mutations: await patchMutations(
        inspectionRoot,
        frozen.entries,
        appliedTree.entries,
        effectivePaths,
        operation,
      ),
      kind: 'text',
      effect: classifyEffect(declaredPaths, effectivePaths),
    };
  } finally {
    appliedTree?.cleanup();
    rmSync(inspectionRoot, { recursive: true, force: true });
    frozen.cleanup();
  }
}

export async function checkPatch(
  worktreeDir: string,
  prepared: PreparedPatch,
  allowedRoots: readonly string[],
  operation: FrozenTreeOperationControl | undefined,
): Promise<void> {
  try {
    await checkMutationPaths({
      worktreeDir,
      operations: prepared.mutations,
      allowedRoots,
      ...(operation === undefined ? {} : { operation }),
    });
  } catch (error) {
    rethrowOperationFailure(error);
    if (error instanceof MutationPathError) {
      throw classifyApplyFailure(error.message);
    }
    throw error;
  }
}

export async function applyPatch(
  worktreeDir: string,
  prepared: PreparedPatch,
  allowedRoots: readonly string[],
  operation?: FrozenTreeOperationControl,
): Promise<void> {
  try {
    await applyMutationBatch({
      worktreeDir,
      operations: prepared.mutations,
      allowedRoots,
      ...(operation === undefined ? {} : { operation }),
    });
  } catch (error) {
    rethrowOperationFailure(error);
    if (error instanceof MutationPathError) {
      throw classifyApplyFailure(error.message);
    }
    throw classifyApplyFailure(error instanceof Error ? error.message : String(error));
  }
}
