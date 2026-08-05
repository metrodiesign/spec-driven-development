// Deterministic executor (spec §6.1, REQ-1/2/6). Exactly-once semantics:
// snapshot-before-intent (git commit on the task worktree) -> ACTION_INTENT
// {snapshotRef, action} -> apply -> ACTION_APPLIED{resultHash}. Recovery is
// rollback-then-rerun, which is sound even for non-idempotent RUN_COMMAND.
// Duplicate actionIds skip idempotently. Out-of-policy proposals become
// structured rejections — never a crash, never a silent drop.

import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { LeaseFenceError, type EventLog, type FencedEventClaim } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { normalizeWorktreeRelativePath, type PathPolicy } from './path-policy.ts';
import type { FrozenRedArtifactIndex } from '../gates/red-provenance.ts';
import type { SandboxWrap } from '../security/sandbox.ts';
import {
  createCommandRunner,
  MAX_COMMAND_TIMEOUT_MS,
  runCoreTool,
  type CommandRunner,
} from '../security/command-runner.ts';
import { denyNetworkSandbox } from '../security/sandbox.ts';
import {
  createFrozenTreeOperationControl,
  DEFAULT_FROZEN_TREE_LIMITS,
  freezeWorkingTree,
  FrozenTreeOperationError,
  readRegularFileByDescriptor,
  type FrozenTreeOperationControl,
  type OwnedFrozenTreeOperationControl,
} from '../gates/frozen-tree.ts';
import {
  createCoreCommandExecutor,
  type CommandEvidence,
  type CoreCommandExecutor,
  type OfflineDependencyPolicy,
} from './command-executor.ts';
import {
  applyPatch,
  checkPatch,
  PatchRejected,
  preparePatch,
  type PreparedPatch,
} from './patch.ts';
import {
  applyMutationBatch,
  checkMutationPaths,
  MutationPathError,
  type MutationPathOperation,
} from './mutation-path.ts';
import type {
  Action,
  ActionRejection,
  Clock,
  PlatformEvent,
  Role,
} from '../types.ts';

export type ExecuteOutcome =
  | {
      status: 'applied';
      actionId: string;
      resultHash: string;
      outputRef?: string;
      exitCode?: number;
      /** True when the command ran inside the deny-network sandbox (egress denied by construction). */
      egressBlocked?: boolean;
      signal?: NodeJS.Signals | null;
      commandEvidence?: CommandEvidence;
    }
  | { status: 'skipped_duplicate'; actionId: string }
  | { status: 'rejected'; rejection: ActionRejection };

/** Deterministic failure injection for the crash-recovery scenarios (DoD#6). */
export interface Failpoints {
  crashAfterIntent?: boolean;
  crashAfterApply?: boolean;
  /** Deterministic race seam immediately before descriptor-safe mutation commit. */
  mutationBeforeCommit?: (paths: readonly string[]) => void;
}

export class CrashInjected extends Error {
  constructor(point: string) {
    super(`crash injected: ${point}`);
  }
}

export interface Executor {
  execute(action: Action, role: Role): Promise<ExecuteOutcome>;
}

/**
 * Composition-root handler for a named REQUEST_TOOL (§7.5 fusion entry point). Core
 * cannot import aal/runFusion (INV-8 forbids the downward dep), so the fusion trigger
 * + the per-task depth counter (REQ-10.9) live at the composition root and are
 * injected here. The handler owns its own logging and returns a normal ExecuteOutcome
 * (a `rejected` with reason `depth_exceeded` on a second activation). Absent map =
 * every REQUEST_TOOL keeps the blanket propose-only rejection (existing behavior).
 */
export type ToolHandler = (
  action: Extract<Action, { type: 'REQUEST_TOOL' }>,
  role: Role,
) => Promise<ExecuteOutcome>;

export interface ExecutorOptions {
  worktreeDir: string;
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  policy: PathPolicy;
  sandbox?: SandboxWrap;
  /** Shared child-process boundary. Defaults to the production command runner. */
  commandRunner?: CommandRunner;
  /** The sole core-owned RUN_COMMAND lifecycle owner. */
  coreCommandExecutor?: CoreCommandExecutor;
  /** Core-owned cancellation signal propagated to the child-process boundary. */
  commandSignal?: AbortSignal;
  clock: Clock;
  failpoints?: Failpoints;
  /** Core-owned finite bounds for complete authoritative worktree identity. */
  artifactIdentityPolicy?: Readonly<ArtifactIdentityPolicy>;
  /** Deterministic capture seam used only by fault tests. */
  artifactIdentityBeforeFileOpen?: (relativePath: string) => void;
  /** Minimal Phase 0, role-scoped, exact-hash offline dependency policy. */
  offlineDependencyPolicy?: OfflineDependencyPolicy;
  /** Core-owned RED provenance index; implementer writes are denied at every mutator surface. */
  redArtifacts?: FrozenRedArtifactIndex;
  /**
   * Named REQUEST_TOOL handlers wired at the composition root (fusion.deliberate,
   * REQ-10.9). A REQUEST_TOOL whose `name` has no handler keeps the existing
   * propose-only rejection. Absent map = Phase-1/2 behavior byte-identical.
   */
  toolHandlers?: Record<string, ToolHandler>;
  /** Current owner generation; mutating lifecycle events are committed through an atomic fence. */
  fence?: () => FencedEventClaim;
}

export interface RecoveryReport {
  action: 'none' | 'replayed_intent' | 'rolled_back';
  detail: string;
  coherent: boolean;
  source:
    | 'consistent'
    | 'dangling_intent'
    | 'artifact_mismatch'
    | 'failed_closed';
}

const GIT_BIN = '/usr/bin/git';

function gitEnvironment(
  extra?: NodeJS.ProcessEnv,
  filters: readonly string[] = [],
): NodeJS.ProcessEnv {
  const config: Array<[string, string]> = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['core.excludesFile', '/dev/null'],
  ];
  for (const filter of filters) {
    config.push(
      [`filter.${filter}.clean`, '/bin/cat'],
      [`filter.${filter}.smudge`, '/bin/cat'],
      [`filter.${filter}.process`, ''],
      [`filter.${filter}.required`, 'false'],
    );
  }
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: String(config.length),
    ...extra,
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

const CORE_GIT_TIMEOUT_MS = 120_000;
const CORE_GIT_OUTPUT_BYTES = 67_108_864;

export interface ArtifactIdentityPolicy {
  version: 1;
  maxFiles: number;
  maxSingleFileBytes: number;
  maxTotalBytes: number;
  captureTimeoutMs: number;
}

export const PHASE0_ARTIFACT_IDENTITY_POLICY: Readonly<ArtifactIdentityPolicy> =
  Object.freeze({
    version: 1,
    maxFiles: DEFAULT_FROZEN_TREE_LIMITS.maxFiles,
    maxSingleFileBytes: DEFAULT_FROZEN_TREE_LIMITS.maxSingleFileBytes,
    maxTotalBytes: DEFAULT_FROZEN_TREE_LIMITS.maxTotalBytes,
    captureTimeoutMs: 300_000,
  });

const AUTHORITATIVE_ARTIFACT_EXCLUDED_ROOTS = Object.freeze([
  '.ai/runs',
  '.git',
] as const);

async function configuredFilters(
  cwd: string,
  operation?: FrozenTreeOperationControl,
): Promise<string[]> {
  operation?.checkpoint();
  let names = '';
  try {
    const result = await runCoreTool({
      executable: GIT_BIN,
      args: ['config', '--includes', '--local', '--name-only', '--get-regexp', '^filter\\.'],
      cwd,
      environment: gitEnvironment(),
      maxOutputBytes: CORE_GIT_OUTPUT_BYTES,
      timeoutMs:
        operation?.remainingMs(CORE_GIT_TIMEOUT_MS) ??
        CORE_GIT_TIMEOUT_MS,
      ...(operation === undefined ? {} : { signal: operation.signal }),
    });
    if (result.status === 'timed_out' || result.status === 'cancelled') {
      operation?.checkpoint();
      throw new FrozenTreeOperationError(
        result.status,
        `core Git filter discovery ${result.status === 'timed_out' ? 'timed out' : 'cancelled'}`,
      );
    }
    if (result.status !== 'completed' || (result.exitCode !== 0 && result.exitCode !== 1)) {
      return [];
    }
    names = result.stdout.toString('utf8');
  } catch (error) {
    if (error instanceof FrozenTreeOperationError) throw error;
    return [];
  }
  operation?.checkpoint();
  return [
    ...new Set(
      names
        .split('\n')
        .flatMap((name) => {
          const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(name.trim());
          return match?.[1] === undefined ? [] : [match[1]];
        }),
    ),
  ].sort();
}

async function git(
  cwd: string,
  args: string[],
  extraEnvironment?: NodeJS.ProcessEnv,
  operation?: FrozenTreeOperationControl,
): Promise<string> {
  operation?.checkpoint();
  const result = await runCoreTool({
    executable: GIT_BIN,
    args,
    cwd,
    environment: gitEnvironment(extraEnvironment, await configuredFilters(cwd, operation)),
    maxOutputBytes: CORE_GIT_OUTPUT_BYTES,
    timeoutMs:
      operation?.remainingMs(CORE_GIT_TIMEOUT_MS) ??
      CORE_GIT_TIMEOUT_MS,
    ...(operation === undefined ? {} : { signal: operation.signal }),
  });
  if (result.status === 'timed_out' || result.status === 'cancelled') {
    operation?.checkpoint();
    throw new FrozenTreeOperationError(
      result.status,
      `core Git command ${result.status === 'timed_out' ? 'timed out' : 'cancelled'} (${args[0] ?? 'unknown'})`,
    );
  }
  if (result.status !== 'completed' || result.exitCode !== 0) {
    const detail =
      result.status === 'completed'
        ? result.stderr.toString('utf8')
        : result.status === 'signaled'
          ? `terminated by ${String(result.signal)}`
          : result.detail;
    throw new Error(`core Git command failed (${args[0] ?? 'unknown'}): ${detail}`);
  }
  operation?.checkpoint();
  return result.stdout.toString('utf8');
}

/** Commit tracked/non-ignored state; declared ignored roots are snapshotted separately. */
async function snapshotWorktree(
  worktreeDir: string,
  label: string,
  operation?: FrozenTreeOperationControl,
): Promise<string> {
  const temporary = mkdtempSync(join(tmpdir(), 'executor-index-'));
  const index = join(temporary, 'index');
  try {
    const head = (await git(worktreeDir, ['rev-parse', 'HEAD'], undefined, operation)).trim();
    await git(worktreeDir, ['read-tree', head], { GIT_INDEX_FILE: index }, operation);
    await git(worktreeDir, ['add', '-A'], { GIT_INDEX_FILE: index }, operation);
    const tree = (
      await git(worktreeDir, ['write-tree'], { GIT_INDEX_FILE: index }, operation)
    ).trim();
    return (await git(
      worktreeDir,
      ['commit-tree', tree, '-p', head, '-m', `core-snapshot: ${label}`],
      {
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: 'Core Executor',
        GIT_AUTHOR_EMAIL: 'core-executor@example.invalid',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_NAME: 'Core Executor',
        GIT_COMMITTER_EMAIL: 'core-executor@example.invalid',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
      operation,
    )).trim();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

interface PersistentSnapshotEntry {
  path: string;
  mode: '100644' | '100755';
  bytes: number;
  sha256: string;
  contentRef: string;
}

interface PersistentSnapshotManifest {
  version: 1;
  roots: string[];
  entries: PersistentSnapshotEntry[];
}

interface ArtifactSnapshotEntry {
  path: string;
  mode: '100644' | '100755' | '120000';
  bytes: number;
  sha256: string;
  contentRef: string;
}

interface ArtifactSnapshotManifest {
  version: 2;
  domain: 'authoritative_worktree';
  excludedRoots: string[];
  resultHash: string;
  entries: ArtifactSnapshotEntry[];
}

interface ActionSnapshot {
  snapshotRef: string;
  persistentSnapshotRef: string;
  artifactSnapshotRef?: string;
}

class ArtifactIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactIdentityError';
  }
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function persistentRoots(opts: ExecutorOptions): string[] {
  const roots = opts.offlineDependencyPolicy?.persistentOutputRoots ?? [];
  const normalized = [...new Set(roots)].sort();
  for (const root of normalized) {
    if (
      !isSafeRelativePath(root) ||
      root === '.git' ||
      root.startsWith('.git/')
    ) {
      throw new Error(`unsafe persistent output root: ${root}`);
    }
  }
  return normalized;
}

function insidePersistentRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function insideAuthoritativeExclusion(path: string): boolean {
  return AUTHORITATIVE_ARTIFACT_EXCLUDED_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function artifactIdentityPolicy(
  opts: ExecutorOptions,
): Readonly<ArtifactIdentityPolicy> {
  const policy = opts.artifactIdentityPolicy ?? PHASE0_ARTIFACT_IDENTITY_POLICY;
  if (policy.version !== 1) {
    throw new ArtifactIdentityError('unsupported artifact identity policy version');
  }
  for (const [name, value] of Object.entries(policy)) {
    if (name === 'version') continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ArtifactIdentityError(
        `invalid artifact identity policy bound ${name}`,
      );
    }
  }
  return policy;
}

function artifactIdentityTimeoutMs(opts: ExecutorOptions): number {
  return artifactIdentityPolicy(opts).captureTimeoutMs;
}

function artifactIdentityLimits(opts: ExecutorOptions) {
  const policy = artifactIdentityPolicy(opts);
  return {
    maxFiles: policy.maxFiles,
    maxSingleFileBytes: policy.maxSingleFileBytes,
    maxTotalBytes: policy.maxTotalBytes,
    maxGitOutputBytes: DEFAULT_FROZEN_TREE_LIMITS.maxGitOutputBytes,
  };
}

function emptyPersistentSnapshotRef(opts: ExecutorOptions): string {
  const manifest: PersistentSnapshotManifest = {
    version: 1,
    roots: persistentRoots(opts),
    entries: [],
  };
  return opts.evidence.put(JSON.stringify(manifest));
}

function actionSnapshotFromPayload(
  opts: ExecutorOptions,
  payload: Record<string, unknown>,
): ActionSnapshot {
  const snapshotRef = payload['snapshotRef'];
  if (typeof snapshotRef !== 'string' || !/^[0-9a-f]{40,64}$/u.test(snapshotRef)) {
    throw new Error('recovery intent has an invalid Git snapshot ref');
  }
  const persistentSnapshotRef = payload['persistentSnapshotRef'];
  const artifactSnapshotRef = payload['artifactSnapshotRef'];
  if (
    artifactSnapshotRef !== undefined &&
    (typeof artifactSnapshotRef !== 'string' ||
      !artifactSnapshotRef.startsWith('blob://'))
  ) {
    throw new Error('recovery intent has an invalid artifact snapshot ref');
  }
  if (typeof persistentSnapshotRef === 'string') {
    return {
      snapshotRef,
      persistentSnapshotRef,
      ...(typeof artifactSnapshotRef === 'string'
        ? { artifactSnapshotRef }
        : {}),
    };
  }
  if (persistentRoots(opts).length !== 0) {
    throw new Error('recovery intent is missing its persistent-output snapshot ref');
  }
  // Compatibility for Phase-0 intents emitted before persistent roots existed.
  return { snapshotRef, persistentSnapshotRef: emptyPersistentSnapshotRef(opts) };
}

async function captureArtifactState(
  opts: ExecutorOptions,
  operation?: FrozenTreeOperationControl,
  persistSnapshot = false,
): Promise<{
  resultHash: string;
  persistentSnapshotRef?: string;
  artifactSnapshotRef?: string;
}> {
  operation?.checkpoint();
  let tree;
  try {
    tree = await freezeWorkingTree(
      opts.worktreeDir,
      artifactIdentityLimits(opts),
      tmpdir(),
      {
        captureDomain: 'authoritative_worktree',
        excludedRoots: AUTHORITATIVE_ARTIFACT_EXCLUDED_ROOTS,
        ...(opts.artifactIdentityBeforeFileOpen === undefined
          ? {}
          : { beforeFileOpen: opts.artifactIdentityBeforeFileOpen }),
        ...(operation === undefined ? {} : { operation }),
      },
    );
  } catch (error) {
    if (error instanceof FrozenTreeOperationError) throw error;
    throw new ArtifactIdentityError(
      `authoritative artifact identity capture failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  let materialized = '';
  try {
    try {
      const resultHash = createHash('sha256')
        .update(
          JSON.stringify({
            version: 2,
            domain: 'authoritative_worktree',
            treeHash: tree.treeHash,
            inventoryHash: tree.inventoryHash,
            excludedRoots: AUTHORITATIVE_ARTIFACT_EXCLUDED_ROOTS,
          }),
        )
        .digest('hex');
      if (!persistSnapshot) return { resultHash };

      materialized = mkdtempSync(join(tmpdir(), 'executor-artifact-snapshot-'));
      await tree.materialize(materialized, operation);
      const entries: ArtifactSnapshotEntry[] = [];
      for (const entry of tree.entries) {
        operation?.checkpoint();
        if (
          entry.mode !== '100644' &&
          entry.mode !== '100755' &&
          entry.mode !== '120000'
        ) {
          throw new ArtifactIdentityError(
            `unsupported artifact snapshot shape: ${entry.path}`,
          );
        }
        const materializedPath = join(materialized, entry.path);
        const content =
          entry.mode === '120000'
            ? Buffer.from(readlinkSync(materializedPath))
            : readFileSync(materializedPath);
        const digest = createHash('sha256').update(content).digest('hex');
        if (content.byteLength !== entry.bytes || digest !== entry.sha256) {
          throw new ArtifactIdentityError(
            `artifact snapshot content mismatch: ${entry.path}`,
          );
        }
        entries.push({
          path: entry.path,
          mode: entry.mode,
          bytes: entry.bytes,
          sha256: entry.sha256,
          contentRef: opts.evidence.put(content),
        });
      }
      const manifest: ArtifactSnapshotManifest = {
        version: 2,
        domain: 'authoritative_worktree',
        excludedRoots: [...AUTHORITATIVE_ARTIFACT_EXCLUDED_ROOTS],
        resultHash,
        entries,
      };
      const artifactSnapshotRef = opts.evidence.put(JSON.stringify(manifest));
      return {
        resultHash,
        artifactSnapshotRef,
        // Retain the historical field while all new intents move to the complete
        // authoritative artifact domain. Old readers and audit tools remain usable.
        persistentSnapshotRef: artifactSnapshotRef,
      };
    } finally {
      if (materialized !== '') {
        rmSync(materialized, { recursive: true, force: true });
      }
      tree.cleanup();
    }
  } catch (error) {
    if (
      error instanceof FrozenTreeOperationError ||
      error instanceof ArtifactIdentityError
    ) {
      throw error;
    }
    throw new ArtifactIdentityError(
      `authoritative artifact snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function loadArtifactSnapshot(
  opts: ExecutorOptions,
  artifactSnapshotRef: string,
): {
  manifest: ArtifactSnapshotManifest;
  validated: Array<{
    entry: ArtifactSnapshotEntry;
    content: Uint8Array;
  }>;
} {
  const parsed = JSON.parse(
    opts.evidence.getText(artifactSnapshotRef),
  ) as Partial<ArtifactSnapshotManifest>;
  if (
    parsed.version !== 2 ||
    parsed.domain !== 'authoritative_worktree' ||
    JSON.stringify(parsed.excludedRoots) !==
      JSON.stringify(AUTHORITATIVE_ARTIFACT_EXCLUDED_ROOTS) ||
    typeof parsed.resultHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(parsed.resultHash) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new ArtifactIdentityError(
      'artifact snapshot manifest is invalid for this executor policy',
    );
  }
  const policy = artifactIdentityPolicy(opts);
  if (parsed.entries.length > policy.maxFiles) {
    throw new ArtifactIdentityError(
      `artifact snapshot exceeds maxFiles=${policy.maxFiles}`,
    );
  }
  const validated: Array<{
    entry: ArtifactSnapshotEntry;
    content: Uint8Array;
  }> = [];
  let previousPath = '';
  let totalBytes = 0;
  for (const candidate of parsed.entries) {
    const entry = candidate as Partial<ArtifactSnapshotEntry>;
    if (
      typeof entry.path !== 'string' ||
      !isSafeRelativePath(entry.path) ||
      insideAuthoritativeExclusion(entry.path) ||
      entry.path <= previousPath ||
      (entry.mode !== '100644' &&
        entry.mode !== '100755' &&
        entry.mode !== '120000') ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      (entry.bytes as number) > policy.maxSingleFileBytes ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      typeof entry.contentRef !== 'string'
    ) {
      throw new ArtifactIdentityError('artifact snapshot entry is invalid');
    }
    totalBytes += entry.bytes as number;
    if (totalBytes > policy.maxTotalBytes) {
      throw new ArtifactIdentityError(
        `artifact snapshot exceeds maxTotalBytes=${policy.maxTotalBytes}`,
      );
    }
    const content = opts.evidence.get(entry.contentRef);
    if (
      content.byteLength !== entry.bytes ||
      createHash('sha256').update(content).digest('hex') !== entry.sha256
    ) {
      throw new ArtifactIdentityError(
        `artifact snapshot entry content mismatch: ${entry.path}`,
      );
    }
    if (entry.mode === '120000') {
      let target: string;
      try {
        target = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch (error) {
        throw new ArtifactIdentityError(
          `artifact snapshot symlink target is invalid UTF-8: ${entry.path}`,
          { cause: error },
        );
      }
      const destination = resolve(opts.worktreeDir, entry.path);
      const resolvedTarget = resolve(dirname(destination), target);
      if (
        isAbsolute(target) ||
        (resolvedTarget !== resolve(opts.worktreeDir) &&
          !resolvedTarget.startsWith(`${resolve(opts.worktreeDir)}${sep}`))
      ) {
        throw new ArtifactIdentityError(
          `artifact snapshot symlink target escapes worktree: ${entry.path}`,
        );
      }
    }
    previousPath = entry.path;
    validated.push({
      entry: entry as ArtifactSnapshotEntry,
      content,
    });
  }
  return {
    manifest: parsed as ArtifactSnapshotManifest,
    validated,
  };
}

function loadPersistentSnapshot(
  opts: ExecutorOptions,
  persistentSnapshotRef: string,
): {
  roots: string[];
  validated: Array<{
    entry: PersistentSnapshotEntry;
    content: Uint8Array;
  }>;
} {
  const parsed = JSON.parse(opts.evidence.getText(persistentSnapshotRef)) as Partial<
    PersistentSnapshotManifest
  >;
  const roots = persistentRoots(opts);
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.roots) ||
    JSON.stringify(parsed.roots) !== JSON.stringify(roots) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error('persistent snapshot manifest is invalid for this executor policy');
  }
  const validated: Array<{
    entry: PersistentSnapshotEntry;
    content: Uint8Array;
  }> = [];
  let previousPath = '';
  for (const candidate of parsed.entries) {
    const entry = candidate as Partial<PersistentSnapshotEntry>;
    if (
      typeof entry.path !== 'string' ||
      !isSafeRelativePath(entry.path) ||
      !insidePersistentRoot(entry.path, roots) ||
      entry.path <= previousPath ||
      (entry.mode !== '100644' && entry.mode !== '100755') ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      typeof entry.contentRef !== 'string'
    ) {
      throw new Error('persistent snapshot entry is invalid');
    }
    const content = opts.evidence.get(entry.contentRef);
    if (
      content.byteLength !== entry.bytes ||
      createHash('sha256').update(content).digest('hex') !== entry.sha256
    ) {
      throw new Error(`persistent snapshot entry content mismatch: ${entry.path}`);
    }
    previousPath = entry.path;
    validated.push({
      entry: entry as PersistentSnapshotEntry,
      content,
    });
  }
  return { roots, validated };
}

function frozenExpected(
  entry: { mode: string; sha256: string } | undefined,
): MutationPathOperation['expected'] {
  if (entry === undefined) return { kind: 'absent' };
  if (entry.mode === '100644' || entry.mode === '100755') {
    return {
      kind: 'regular',
      sha256: entry.sha256,
      mode: entry.mode,
    };
  }
  return { kind: 'any_artifact' };
}

function obsoleteArtifactDirectories(
  currentPaths: readonly string[],
  desiredPaths: ReadonlySet<string>,
): string[] {
  const directories = new Set<string>();
  const retainedDirectories = new Set<string>();
  for (const desiredPath of desiredPaths) {
    let retained = dirname(desiredPath);
    while (retained !== '.' && retained !== '/') {
      retainedDirectories.add(retained);
      retained = dirname(retained);
    }
  }
  for (const path of currentPaths) {
    let parent = dirname(path);
    while (parent !== '.' && parent !== '/') {
      if (!retainedDirectories.has(parent)) {
        directories.add(parent);
      }
      parent = dirname(parent);
    }
  }
  return [...directories].sort(
    (left, right) =>
      right.split('/').length - left.split('/').length ||
      right.localeCompare(left),
  );
}

async function restorePersistentSnapshot(
  opts: ExecutorOptions,
  persistentSnapshotRef: string,
  operation?: FrozenTreeOperationControl,
): Promise<void> {
  const { roots, validated } = loadPersistentSnapshot(
    opts,
    persistentSnapshotRef,
  );
  const current = await freezeWorkingTree(
    opts.worktreeDir,
    DEFAULT_FROZEN_TREE_LIMITS,
    tmpdir(),
    {
      includeIgnoredRoots: roots,
      ...(operation === undefined ? {} : { operation }),
    },
  );
  try {
    const currentMap = new Map(
      current.entries
        .filter((entry) => insidePersistentRoot(entry.path, roots))
        .map((entry) => [entry.path, entry]),
    );
    const desiredMap = new Map(
      validated.map(({ entry, content }) => [
        entry.path,
        { entry, content },
      ]),
    );
    const blockerPaths = new Set(
      [...currentMap.keys()].filter(
        (currentPath) =>
          !desiredMap.has(currentPath) &&
          [...desiredMap.keys()].some((desiredPath) =>
            desiredPath.startsWith(`${currentPath}/`),
          ),
      ),
    );
    const paths = [...new Set([...currentMap.keys(), ...desiredMap.keys()])].sort();
    const mutations: MutationPathOperation[] = paths.flatMap((path) => {
      const prior = currentMap.get(path);
      const next = desiredMap.get(path);
      if (
        prior?.mode === next?.entry.mode &&
        prior?.sha256 === next?.entry.sha256 &&
        prior?.bytes === next?.entry.bytes
      ) {
        return [];
      }
      return [
        {
          path,
          expected: frozenExpected(prior),
          desired:
            blockerPaths.has(path)
              ? { kind: 'directory' as const }
              : next === undefined
              ? { kind: 'absent' as const }
              : {
                  kind: 'regular' as const,
                  content: next.content,
                  mode: next.entry.mode,
                },
        },
      ];
    });
    for (const path of obsoleteArtifactDirectories(
      [...currentMap.keys()],
      new Set(desiredMap.keys()),
    )) {
      mutations.push({
        path,
        expected: { kind: 'directory' },
        desired: { kind: 'absent' },
      });
    }
    await applyMutationBatch({
      worktreeDir: opts.worktreeDir,
      operations: mutations,
      allowedRoots: roots,
      allowSymlinkArtifacts: true,
      ...(operation === undefined ? {} : { operation }),
    });
  } finally {
    current.cleanup();
  }
}

async function restoreArtifactSnapshot(
  opts: ExecutorOptions,
  artifactSnapshotRef: string,
  operation?: FrozenTreeOperationControl,
): Promise<void> {
  const { manifest, validated } = loadArtifactSnapshot(
    opts,
    artifactSnapshotRef,
  );
  operation?.checkpoint();
  const current = await freezeWorkingTree(
    opts.worktreeDir,
    // A just-applied mutation may be the reason the policy bound was exceeded.
    // Cleanup therefore uses the separate, still-finite core recovery ceiling;
    // otherwise the policy rejection itself could make exact rollback impossible.
    DEFAULT_FROZEN_TREE_LIMITS,
    tmpdir(),
    {
      captureDomain: 'authoritative_worktree',
      excludedRoots: AUTHORITATIVE_ARTIFACT_EXCLUDED_ROOTS,
      ...(operation === undefined ? {} : { operation }),
    },
  );
  try {
    const currentMap = new Map(current.entries.map((entry) => [entry.path, entry]));
    const desiredMap = new Map(
      validated.map(({ entry, content }) => [
        entry.path,
        { entry, content },
      ]),
    );
    const blockerPaths = new Set(
      [...currentMap.keys()].filter(
        (currentPath) =>
          !desiredMap.has(currentPath) &&
          [...desiredMap.keys()].some((desiredPath) =>
            desiredPath.startsWith(`${currentPath}/`),
          ),
      ),
    );
    const paths = [...new Set([...currentMap.keys(), ...desiredMap.keys()])].sort();
    const mutations: MutationPathOperation[] = paths.flatMap((path) => {
      const prior = currentMap.get(path);
      const next = desiredMap.get(path);
      if (
        prior?.mode === next?.entry.mode &&
        prior?.sha256 === next?.entry.sha256 &&
        prior?.bytes === next?.entry.bytes
      ) {
        return [];
      }
      let desired: MutationPathOperation['desired'];
      if (blockerPaths.has(path)) {
        desired = { kind: 'directory' };
      } else if (next === undefined) {
        desired = { kind: 'absent' };
      } else if (next.entry.mode === '120000') {
        desired = {
          kind: 'symlink',
          target: new TextDecoder('utf-8', { fatal: true }).decode(next.content),
        };
      } else {
        desired = {
          kind: 'regular',
          content: next.content,
          mode: next.entry.mode,
        };
      }
      return [
        {
          path,
          expected: frozenExpected(prior),
          desired,
        },
      ];
    });
    for (const path of obsoleteArtifactDirectories(
      [...currentMap.keys()],
      new Set(desiredMap.keys()),
    )) {
      mutations.push({
        path,
        expected: { kind: 'directory' },
        desired: { kind: 'absent' },
      });
    }
    const allowedRoots = [
      ...new Set(
        mutations.map((mutation) => mutation.path.split('/')[0] as string),
      ),
    ];
    await applyMutationBatch({
      worktreeDir: opts.worktreeDir,
      operations: mutations,
      allowedRoots,
      allowSymlinkArtifacts: true,
      ...(operation === undefined ? {} : { operation }),
    });
  } finally {
    current.cleanup();
  }
  const restored = await captureArtifactState(opts, operation);
  if (restored.resultHash !== manifest.resultHash) {
    throw new ArtifactIdentityError(
      'restored authoritative artifact identity does not match its snapshot',
    );
  }
}

async function createActionSnapshot(
  opts: ExecutorOptions,
  label: string,
  operation?: FrozenTreeOperationControl,
): Promise<ActionSnapshot> {
  const snapshotRef = await snapshotWorktree(opts.worktreeDir, label, operation);
  const artifact = await captureArtifactState(opts, operation, true);
  if (artifact.persistentSnapshotRef === undefined) {
    throw new Error('persistent snapshot manifest was not created');
  }
  if (artifact.artifactSnapshotRef === undefined) {
    throw new Error('authoritative artifact snapshot manifest was not created');
  }
  return {
    snapshotRef,
    persistentSnapshotRef: artifact.persistentSnapshotRef,
    artifactSnapshotRef: artifact.artifactSnapshotRef,
  };
}

async function rollbackTo(
  opts: ExecutorOptions,
  snapshot: ActionSnapshot,
  operation?: FrozenTreeOperationControl,
): Promise<void> {
  if (snapshot.artifactSnapshotRef !== undefined) {
    await restoreArtifactSnapshot(opts, snapshot.artifactSnapshotRef, operation);
    return;
  }
  // Legacy intents have no complete content-addressed artifact manifest. Never
  // reintroduce target-Git path mutation here: accept the compatibility case only
  // when the non-persistent tree is already identical, otherwise fail closed.
  const currentSnapshot = await snapshotWorktree(
    opts.worktreeDir,
    'legacy-recovery-verification',
    operation,
  );
  const [expectedTree, currentTree] = await Promise.all([
    git(
      opts.worktreeDir,
      ['rev-parse', `${snapshot.snapshotRef}^{tree}`],
      undefined,
      operation,
    ),
    git(
      opts.worktreeDir,
      ['rev-parse', `${currentSnapshot}^{tree}`],
      undefined,
      operation,
    ),
  ]);
  if (expectedTree.trim() !== currentTree.trim()) {
    throw new ArtifactIdentityError(
      'legacy recovery snapshot differs and has no descriptor-safe artifact manifest',
    );
  }
  operation?.checkpoint();
  await restorePersistentSnapshot(
    opts,
    snapshot.persistentSnapshotRef,
    operation,
  );
}

async function reconcileAfterFailure(
  opts: ExecutorOptions,
  snapshot: ActionSnapshot,
  operation?: FrozenTreeOperationControl,
): Promise<void> {
  try {
    await rollbackTo(opts, snapshot, operation);
  } catch (error) {
    if (!(error instanceof FrozenTreeOperationError)) throw error;
    // Active work has stopped. A bounded core-only rollback must still reconcile a
    // promotion when the shared signal/deadline itself is the failure.
    const reconciliation = createFrozenTreeOperationControl(
      Math.min(CORE_GIT_TIMEOUT_MS, artifactIdentityTimeoutMs(opts)),
      undefined,
      undefined,
      'core artifact reconciliation exceeded its finite timeout',
    );
    try {
      await rollbackTo(opts, snapshot, reconciliation);
    } finally {
      reconciliation.dispose();
    }
  }
}

function validate(action: Action): string | null {
  if (typeof action.actionId !== 'string' || action.actionId.length === 0) {
    return 'actionId must be a non-empty string';
  }
  switch (action.type) {
    case 'WRITE_FILE':
      // `path` is model-authored and UNTRUSTED (INV-1/INV-2): a falsy check let
      // `42`, `true`, `[]` and `{}` through to the path layer, which threw a
      // TypeError out of execute(). Type-check it here so it is a schema
      // violation at the boundary instead.
      if (typeof action.path !== 'string' || action.path.length === 0 || !action.contentRef) {
        return 'WRITE_FILE requires a non-empty string path and contentRef';
      }
      return null;
    case 'APPLY_PATCH':
      if (!action.diffRef) return 'APPLY_PATCH requires diffRef';
      return null;
    case 'RUN_COMMAND':
      // `cmd` is model-authored and UNTRUSTED like `path`: the falsy check let
      // `42`, `true`, `['true']` and `{}` through, and the command layer coerced
      // them to a string and RAN the result (`['true']` -> `true` actually
      // executed; `42` reached the shell as exit 127). Type-check it here so an
      // ill-typed command is a schema violation instead of an executed one. The
      // falsy cases ('' / 0 / false / null / undefined) reject exactly as before.
      if (typeof action.cmd !== 'string' || action.cmd.length === 0) {
        return 'RUN_COMMAND requires cmd';
      }
      // `network` is model-authored and UNTRUSTED like `path`, and the prompt
      // never advertises the field, so it is routinely MISSING. `.startsWith()`
      // on a non-string threw a TypeError from inside validate() itself, which
      // executeOnce calls OUTSIDE its try — the throw left execute() entirely.
      // Type-check before dereferencing; a missing/ill-typed grant is a schema
      // violation, never defaulted to 'none' (that would be core silently
      // deciding a network-scope contract on the model's behalf).
      if (
        typeof action.network !== 'string' ||
        (action.network !== 'none' && !action.network.startsWith('allowlist:'))
      ) {
        return 'network must be "none" or "allowlist:<name>"';
      }
      // Same untrusted reasoning for `cwd`: it is a path field validate() never
      // checked, and resolveContained() -> resolve() throws on a non-string.
      if (action.cwd !== undefined && (typeof action.cwd !== 'string' || action.cwd.length === 0)) {
        return 'RUN_COMMAND cwd must be a non-empty string when present';
      }
      if (
        action.timeoutMs !== undefined &&
        (!Number.isFinite(action.timeoutMs) ||
          !Number.isInteger(action.timeoutMs) ||
          action.timeoutMs <= 0 ||
          action.timeoutMs > MAX_COMMAND_TIMEOUT_MS)
      ) {
        return `timeoutMs must be a finite positive integer no greater than ${MAX_COMMAND_TIMEOUT_MS}`;
      }
      return null;
    case 'READ_FILE':
      // Same untrusted-`path` reasoning as WRITE_FILE above.
      if (typeof action.path !== 'string' || action.path.length === 0) {
        return 'READ_FILE requires a non-empty string path';
      }
      return null;
    case 'REQUEST_TOOL':
      if (!action.name) return 'REQUEST_TOOL requires name';
      return null;
    default:
      return 'unknown action type';
  }
}

/** Resolve a worktree-relative path and enforce realpath containment (symlink escapes). */
function resolveContained(worktreeDir: string, relPath: string): string | null {
  const abs = resolve(worktreeDir, relPath);
  const rootReal = realpathSync(worktreeDir);
  if (!abs.startsWith(rootReal + '/') && abs !== rootReal) {
    // resolve() escaped lexically (e.g. ../)
    if (!abs.startsWith(resolve(worktreeDir) + '/')) return null;
  }
  // Walk to the nearest existing ancestor and verify ITS realpath stays inside.
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (real !== rootReal && !real.startsWith(rootReal + '/')) return null;
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return abs;
}

export function createExecutor(opts: ExecutorOptions): Executor {
  const sandbox = opts.sandbox ?? denyNetworkSandbox(process.platform);
  const policy: PathPolicy = opts.redArtifacts === undefined
    ? opts.policy
    : {
        ...opts.policy,
        frozenRedArtifacts: opts.redArtifacts,
        checkWrite(role, path) {
          const decision = opts.policy.checkWrite(role, path);
          if (!decision.allowed) return decision;
          const normalizedPath = normalizeWorktreeRelativePath(path);
          if (role === 'implementer' && normalizedPath !== null && opts.redArtifacts?.get(normalizedPath) !== undefined) {
            return { allowed: false, reason: 'red_artifact_frozen' };
          }
          return decision;
        },
      };
  const commandRunner =
    opts.commandRunner ?? createCommandRunner({ sandbox, evidence: opts.evidence });
  const coreCommandExecutor =
    opts.coreCommandExecutor ??
    createCoreCommandExecutor({
      evidence: opts.evidence,
      policy,
      sandbox,
      commandRunner,
      ...(opts.offlineDependencyPolicy === undefined
        ? {}
        : { offlineDependencyPolicy: opts.offlineDependencyPolicy }),
    });
  const effectiveOpts: ExecutorOptions = { ...opts, policy };
  return {
    async execute(action, role) {
      return executeOnce(effectiveOpts, coreCommandExecutor, action, role);
    },
  };
}

/** Append a lifecycle event only while the current task lease generation is still authoritative. */
function appendCoreEvent(
  opts: ExecutorOptions,
  event: Parameters<EventLog['append']>[0],
): ReturnType<EventLog['append']> {
  if (opts.fence === undefined) return opts.log.append(event);
  const appended = opts.log.appendFenced(event, opts.fence(), opts.clock.now());
  if (appended === null) throw new LeaseFenceError();
  return appended;
}

function reject(
  opts: ExecutorOptions,
  actionId: string,
  reason: ActionRejection['reason'],
  detail: string,
  metadata?: Record<string, unknown>,
): ExecuteOutcome {
  const rejection: ActionRejection = { actionId, reason, detail };
  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'ACTION_REJECTED',
    payload: { ...rejection, ...metadata },
  });
  return { status: 'rejected', rejection };
}

const AVAILABLE_PATHS_HINT_LIMIT = 20;

/**
 * READ_FILE-not-found rejection hint (REQ-5.4, backlog: rejected-feedback): the
 * real paths the executor can see from the worktree root, bounded and sorted so
 * the next round has a signal instead of guessing blind. `.git` is skipped — its
 * internal object names are never a valid READ_FILE target.
 */
function listExistingPaths(root: string, limit = AVAILABLE_PATHS_HINT_LIMIT): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit) return;
      if (entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) found.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return found.slice(0, limit);
}

function patchPolicyRejection(
  opts: ExecutorOptions,
  prepared: PreparedPatch,
  role: Role,
  operation?: FrozenTreeOperationControl,
): { reason: ActionRejection['reason']; detail: string } | undefined {
  const denials: Array<{ reason: ActionRejection['reason']; path: string }> = [];
  for (const affected of prepared.paths) {
    for (const path of [affected.oldPath, affected.newPath]) {
      operation?.checkpoint();
      if (path === undefined) continue;
      const decision = opts.policy.checkWrite(role, path);
      if (!decision.allowed) {
        denials.push({
          reason: decision.reason as ActionRejection['reason'],
          path,
        });
      } else if (resolveContained(opts.worktreeDir, path) === null) {
        denials.push({ reason: 'path_outside_allowlist', path });
      }
    }
  }
  operation?.checkpoint();
  const denial =
    denials.find((candidate) => candidate.reason === 'golden_write_denied') ??
    denials[0];
  return denial === undefined
    ? undefined
    : {
        reason: denial.reason,
        detail: `patch path ${denial.path} denied for role ${role}`,
      };
}

async function preparePatchAction(
  opts: ExecutorOptions,
  action: Extract<Action, { type: 'APPLY_PATCH' }>,
  role: Role,
  operation?: FrozenTreeOperationControl,
): Promise<PreparedPatch> {
  let patchBytes: Uint8Array;
  try {
    operation?.checkpoint();
    patchBytes = opts.evidence.get(action.diffRef);
    operation?.checkpoint();
  } catch (error) {
    if (error instanceof FrozenTreeOperationError) throw error;
    throw new PatchRejected(
      'evidence_invalid',
      `patch evidence is missing or invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const prepared = await preparePatch(
    opts.worktreeDir,
    patchBytes,
    operation,
  );
  const policyRejection = patchPolicyRejection(opts, prepared, role, operation);
  if (policyRejection !== undefined) {
    throw new PatchRejected(
      policyRejection.reason as
        | 'golden_write_denied'
        | 'red_artifact_frozen'
        | 'path_outside_allowlist',
      policyRejection.detail,
    );
  }
  if (prepared.effect === 'copy') {
    throw new PatchRejected('patch_unsupported', 'copy patches are unsupported in Phase 0');
  }
  if (prepared.effect === 'noop') {
    throw new PatchRejected('patch_noop', 'patch produces no artifact change');
  }
  await checkPatch(
    opts.worktreeDir,
    prepared,
    opts.policy.writeRoots(role),
    operation,
  );
  return prepared;
}

interface MutatingIntentGeneration {
  intent: PlatformEvent;
  terminals: PlatformEvent[];
}

function mutatingIntentHistory(
  opts: Pick<ExecutorOptions, 'log' | 'runId' | 'taskId'>,
): MutatingIntentGeneration[] {
  const events = opts.log
    .all({ taskId: opts.taskId })
    .filter((event) => event.runId === opts.runId);
  return events
    .filter((event) => event.type === 'ACTION_INTENT')
    .map((intent) => ({
      intent,
      terminals: events.filter(
        (event) =>
          event.seq > intent.seq &&
          (event.type === 'ACTION_APPLIED' ||
            event.type === 'ACTION_REJECTED') &&
          event.payload['actionId'] === intent.payload['actionId'] &&
          event.payload['intentSeq'] === intent.seq,
      ),
    }));
}

function danglingMutatingIntents(
  opts: Pick<ExecutorOptions, 'log' | 'runId' | 'taskId'>,
): MutatingIntentGeneration[] {
  return mutatingIntentHistory(opts).filter(
    (generation) => generation.terminals.length === 0,
  );
}

function activeAppliedEvents(opts: ExecutorOptions) {
  const events = opts.log.all({ taskId: opts.taskId });
  return events
    .filter(
      (event) =>
        event.runId === opts.runId &&
        event.type === 'ACTION_APPLIED' &&
        event.payload['duplicate'] !== true,
    )
    .filter(
      (applied) =>
        !events.some(
          (event) =>
            event.runId === opts.runId &&
            event.seq > applied.seq &&
            event.type === 'ACTION_REJECTED' &&
            event.payload['actionId'] === applied.payload['actionId'] &&
            event.payload['invalidatesAppliedSeq'] === applied.seq,
        ),
    )
    .sort((left, right) => {
      const leftIntentSeq =
        typeof left.payload['intentSeq'] === 'number'
          ? left.payload['intentSeq']
          : left.seq;
      const rightIntentSeq =
        typeof right.payload['intentSeq'] === 'number'
          ? right.payload['intentSeq']
          : right.seq;
      return leftIntentSeq - rightIntentSeq || left.seq - right.seq;
    });
}

function alreadyApplied(opts: ExecutorOptions, actionId: string) {
  const applieds = activeAppliedEvents(opts);
  for (let index = applieds.length - 1; index >= 0; index -= 1) {
    const event = applieds[index];
    if (
      event?.payload['actionId'] === actionId &&
      typeof event.payload['resultHash'] === 'string'
    ) {
      return event;
    }
  }
  return undefined;
}

async function executeOnce(
  opts: ExecutorOptions,
  coreCommandExecutor: CoreCommandExecutor,
  action: Action,
  role: Role,
): Promise<ExecuteOutcome> {
  // `action` is UNTRUSTED at this public boundary (INV-1) and its static type
  // lies: the wire normalizer forwards a non-object entry of `actionRequests`
  // untouched and the production outputSchema constrains that array to
  // `type: 'array'` with no item schema. A `null` element used to throw a
  // TypeError on `action.actionId` instead of being rejected, so widen to
  // `unknown` and decide it here, before anything dereferences a field.
  const raw: unknown = action;
  const isObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  const rawId = isObject ? (raw as { actionId?: unknown }).actionId : undefined;
  const actionId = typeof rawId === 'string' ? rawId : '(missing)';
  if (!isObject) {
    return reject(opts, actionId, 'schema_violation', 'action must be an object');
  }
  const invalid = validate(action);
  if (invalid !== null) {
    return reject(opts, actionId, 'schema_violation', invalid);
  }

  const operation =
    action.type !== 'READ_FILE' && action.type !== 'REQUEST_TOOL'
      ? createFrozenTreeOperationControl(
          Math.min(
            action.type === 'RUN_COMMAND'
              ? action.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS
              : MAX_COMMAND_TIMEOUT_MS,
            artifactIdentityTimeoutMs(opts),
          ),
          opts.commandSignal,
        )
      : undefined;
  try {
    operation?.checkpoint();
    return await executeValidAction(
      opts,
      coreCommandExecutor,
      action,
      role,
      operation,
    );
  } catch (error) {
    if (error instanceof LeaseFenceError) {
      return reject(opts, action.actionId, 'cancelled', error.message, { reasonCode: error.code });
    }
    if (error instanceof FrozenTreeOperationError) {
      return reject(opts, action.actionId, error.reason, error.message);
    }
    throw error;
  } finally {
    operation?.dispose();
  }
}

async function executeValidAction(
  opts: ExecutorOptions,
  coreCommandExecutor: CoreCommandExecutor,
  action: Action,
  role: Role,
  operation?: FrozenTreeOperationControl,
): Promise<ExecuteOutcome> {
  let admissionRecovery: RecoveryReport | undefined;
  if (action.type !== 'READ_FILE' && action.type !== 'REQUEST_TOOL') {
    try {
      admissionRecovery = await recoverWorktree(opts, operation);
    } catch (error) {
      if (error instanceof FrozenTreeOperationError) throw error;
      return reject(
        opts,
        action.actionId,
        'command_artifact_unavailable',
        `mutating action admission reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const stillDangling = danglingMutatingIntents(opts);
    if (!admissionRecovery.coherent || stillDangling.length > 0) {
      return reject(
        opts,
        action.actionId,
        'command_artifact_unavailable',
        `mutating action refused after ${admissionRecovery.source} reconciliation: ${admissionRecovery.detail}; dangling=${stillDangling.length}`,
      );
    }
  }
  let preparedPatch: PreparedPatch | undefined;
  const priorApplied = alreadyApplied(opts, action.actionId);
  if (priorApplied !== undefined) {
    if (admissionRecovery?.source === 'artifact_mismatch') {
      return reject(
        opts,
        action.actionId,
        'command_artifact_unavailable',
        `duplicate action refused because admission reconciled a stale ACTION_APPLIED artifact identity: ${admissionRecovery.detail}`,
      );
    }
    appendCoreEvent(opts, {
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ACTION_APPLIED',
      payload: { actionId: action.actionId, duplicate: true },
    });
    return { status: 'skipped_duplicate', actionId: action.actionId };
  }

  // Policy gates before any side effect.
  if (action.type === 'WRITE_FILE') {
    const decision = opts.policy.checkWrite(role, action.path);
    if (!decision.allowed) {
      return reject(
        opts,
        action.actionId,
        decision.reason as ActionRejection['reason'],
        `write to ${action.path} denied for role ${role}`,
      );
    }
    if (resolveContained(opts.worktreeDir, action.path) === null) {
      return reject(opts, action.actionId, 'path_outside_allowlist', `path escapes worktree: ${action.path}`);
    }
    try {
      const content = opts.evidence.get(action.contentRef);
      await checkMutationPaths({
        worktreeDir: opts.worktreeDir,
        allowedRoots: opts.policy.writeRoots(role),
        operations: [
          {
            path: action.path,
            expected: { kind: 'regular_or_absent' },
            desired: { kind: 'regular', content, mode: '100644' },
          },
        ],
        ...(operation === undefined ? {} : { operation }),
      });
    } catch (error) {
      if (error instanceof FrozenTreeOperationError) throw error;
      if (error instanceof MutationPathError) {
        return reject(
          opts,
          action.actionId,
          'path_outside_allowlist',
          error.message,
        );
      }
      return reject(
        opts,
        action.actionId,
        'evidence_invalid',
        `write evidence is missing or invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (action.type === 'READ_FILE') {
    const decision = opts.policy.checkRead(role, action.path);
    if (!decision.allowed) {
      return reject(opts, action.actionId, 'path_outside_allowlist', `read of ${action.path} denied`);
    }
  }
  if (action.type === 'APPLY_PATCH') {
    try {
      preparedPatch = await preparePatchAction(opts, action, role, operation);
    } catch (error) {
      if (error instanceof FrozenTreeOperationError) throw error;
      if (error instanceof PatchRejected) {
        return reject(opts, action.actionId, error.reason, error.message);
      }
      return reject(
        opts,
        action.actionId,
        'patch_unsupported',
        `patch inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (action.type === 'REQUEST_TOOL') {
    // A composition-root handler (fusion.deliberate, REQ-10.9) takes precedence; core
    // executes nothing itself. Unhandled tool names keep the propose-only rejection.
    const handler = opts.toolHandlers?.[action.name];
    if (handler !== undefined) return handler(action, role);
    return reject(
      opts,
      action.actionId,
      'unsupported_action_phase0',
      `no tool handlers enabled in this phase (requested: ${action.name})`,
    );
  }
  if (action.type === 'RUN_COMMAND') {
    if (action.network !== 'none') {
      return reject(
        opts,
        action.actionId,
        'network_grant_unavailable',
        'Phase 0 rejects every network grant before command spawn',
      );
    }
    if (action.cwd !== undefined && resolveContained(opts.worktreeDir, action.cwd) === null) {
      return reject(opts, action.actionId, 'path_outside_allowlist', `cwd escapes worktree: ${action.cwd}`);
    }
  }

  // Non-mutating actions need no snapshot/INTENT (REQ-6.1).
  if (action.type === 'READ_FILE') {
    const abs = resolveContained(opts.worktreeDir, action.path);
    if (abs === null) {
      return reject(opts, action.actionId, 'path_outside_allowlist', `path escapes worktree: ${action.path}`);
    }
    let content: Uint8Array;
    try {
      const normalizedPath = relative(resolve(opts.worktreeDir), abs);
      content = (
        await readRegularFileByDescriptor(
          opts.worktreeDir,
          normalizedPath,
          DEFAULT_FROZEN_TREE_LIMITS.maxSingleFileBytes,
        )
      ).content;
    } catch (error) {
      // Operational failures (spawn timeout/cancellation) are not "file not
      // found" — propagate like every other catch in this file instead of
      // mislabeling them (backlog: rejected-feedback nit).
      if (error instanceof FrozenTreeOperationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // The descriptor-safe reader spawns a Python helper; its stderr surfaces
      // Python's OSError text, so `[Errno 2]` is the only ENOENT signal we get.
      // Anything else (permission denied, non-regular file, ...) is a real read
      // failure and must not carry the available-paths hint — that hint says
      // "here is what actually exists," which is misleading when the requested
      // path exists but couldn't be read (backlog: rejected-feedback nit).
      if (/\[Errno 2\]/.test(message)) {
        const available = listExistingPaths(opts.worktreeDir);
        return reject(
          opts,
          action.actionId,
          'schema_violation',
          `file not found: ${action.path} | available: ${available.join(', ')}`,
        );
      }
      return reject(opts, action.actionId, 'schema_violation', `read failed: ${message}`);
    }
    const outputRef = opts.evidence.put(content);
    appendCoreEvent(opts, {
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ACTION_APPLIED',
      payload: { actionId: action.actionId, resultHash: outputRef, outputRef, duplicate: false },
    });
    return { status: 'applied', actionId: action.actionId, resultHash: outputRef, outputRef };
  }

  // Mutating path: one public operation control owns outer snapshot, inner
  // lifecycle, final identity, and every child launched along that path.
  let snapshot: ActionSnapshot | undefined;
  let intentAppended = false;
  let intentSeq: number | undefined;
  try {
    operation?.checkpoint();
    snapshot = await createActionSnapshot(opts, action.actionId, operation);
    operation?.checkpoint();
    const intent = appendCoreEvent(opts, {
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ACTION_INTENT',
      payload: {
        actionId: action.actionId,
        snapshotRef: snapshot.snapshotRef,
        persistentSnapshotRef: snapshot.persistentSnapshotRef,
        artifactSnapshotRef: snapshot.artifactSnapshotRef,
        action: { ...action },
        role,
      },
    });
    intentAppended = true;
    intentSeq = intent.seq;

    if (opts.failpoints?.crashAfterIntent) throw new CrashInjected('after_intent');

    const applied = await performApply(
      opts,
      coreCommandExecutor,
      action,
      role,
      operation,
      preparedPatch,
    );

    if ('rejected' in applied) {
      await reconcileAfterFailure(opts, snapshot, operation);
      return reject(
        opts,
        action.actionId,
        applied.rejected.reason,
        applied.rejected.detail,
        { intentSeq },
      );
    }

    operation?.checkpoint();
    if (opts.failpoints?.crashAfterApply) throw new CrashInjected('after_apply');

    appendCoreEvent(opts, {
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ACTION_APPLIED',
      payload: { actionId: action.actionId, intentSeq, duplicate: false, ...applied },
    });
    return { status: 'applied', actionId: action.actionId, ...applied };
  } catch (error) {
    if (error instanceof CrashInjected) throw error;
    if (intentAppended && snapshot !== undefined) {
      await reconcileAfterFailure(opts, snapshot, operation);
    }
    if (error instanceof LeaseFenceError) {
      return reject(opts, action.actionId, 'cancelled', error.message, {
        ...(intentSeq === undefined ? {} : { intentSeq }),
        reasonCode: error.code,
      });
    }
    if (error instanceof FrozenTreeOperationError) {
      return reject(opts, action.actionId, error.reason, error.message, {
        ...(intentSeq === undefined ? {} : { intentSeq }),
      });
    }
    if (!(error instanceof ArtifactIdentityError)) throw error;
    return reject(
      opts,
      action.actionId,
      'command_artifact_unavailable',
      error.message,
      {
      ...(intentSeq === undefined ? {} : { intentSeq }),
      },
    );
  }
}

async function performApply(
  opts: ExecutorOptions,
  coreCommandExecutor: CoreCommandExecutor,
  action: Extract<Action, { type: 'WRITE_FILE' | 'APPLY_PATCH' | 'RUN_COMMAND' }>,
  role: Role,
  operation?: FrozenTreeOperationControl,
  preparedPatch?: PreparedPatch,
): Promise<
  | {
      resultHash: string;
      outputRef?: string;
      exitCode?: number;
      egressBlocked?: boolean;
      signal?: NodeJS.Signals | null;
      commandEvidence?: CommandEvidence;
    }
  | {
      rejected: {
        reason: ActionRejection['reason'];
        detail: string;
      };
    }
> {
  if (action.type === 'WRITE_FILE') {
    try {
      opts.failpoints?.mutationBeforeCommit?.([action.path]);
      await applyMutationBatch({
        worktreeDir: opts.worktreeDir,
        allowedRoots: opts.policy.writeRoots(role),
        operations: [
          {
            path: action.path,
            expected: { kind: 'regular_or_absent' },
            desired: {
              kind: 'regular',
              content: opts.evidence.get(action.contentRef),
              mode: '100644',
            },
          },
        ],
        ...(operation === undefined ? {} : { operation }),
      });
    } catch (error) {
      if (error instanceof MutationPathError) {
        return {
          rejected: {
            reason: 'path_outside_allowlist',
            detail: error.message,
          },
        };
      }
      throw error;
    }
    return { resultHash: (await captureArtifactState(opts, operation)).resultHash };
  }
  if (action.type === 'APPLY_PATCH') {
    if (preparedPatch === undefined) {
      return {
        rejected: {
          reason: 'patch_malformed',
          detail: 'verified patch bytes are unavailable',
        },
      };
    }
    try {
      opts.failpoints?.mutationBeforeCommit?.(
        preparedPatch.mutations.map((mutation) => mutation.path),
      );
      await applyPatch(
        opts.worktreeDir,
        preparedPatch,
        opts.policy.writeRoots(role),
        operation,
      );
    } catch (error) {
      if (error instanceof PatchRejected) {
        return {
          rejected: {
            reason: error.reason,
            detail: error.message,
          },
        };
      }
      throw error;
    }
    return { resultHash: (await captureArtifactState(opts, operation)).resultHash };
  }

  const res = await coreCommandExecutor.execute(action, {
    worktreeDir: opts.worktreeDir,
    role,
    classification: role === 'diagnostician' ? 'read_only_probe' : 'artifact_mutation',
    ...(operation === undefined
      ? opts.commandSignal === undefined
        ? {}
        : { signal: opts.commandSignal }
      : { signal: operation.signal, operation }),
  });
  if (
    res.status === 'preflight_rejected' ||
    res.status === 'capture_rejected'
  ) {
    return {
      rejected: {
        reason: res.reason,
        detail: `${res.reason}: ${res.detail}; evidence=${res.evidenceRef}`,
      },
    };
  }
  if (res.status === 'sandbox_violation') {
    return {
      rejected: {
        reason: 'sandbox_violation',
        detail: `sandbox_violation; evidence=${res.evidence.outputRef}`,
      },
    };
  }
  if (res.status === 'command_failed') {
    return {
      rejected: {
        reason: 'command_failed',
        detail: `command_failed: exit=${String(res.exitCode)} signal=${String(
          res.signal,
        )}; evidence=${res.evidence.outputRef}`,
      },
    };
  }
  if (res.status === 'signaled') {
    return {
      rejected: {
        reason: 'command_failed',
        detail: `command_failed: signal=${res.signal}; evidence=${res.evidence.outputRef}`,
      },
    };
  }
  const exitCode = res.status === 'completed' ? res.exitCode : res.capture.exitCode;
  const commandEvidence = res.evidence;
  operation?.checkpoint();
  return {
    // Recovery compares ACTION_APPLIED.resultHash to the complete artifact identity. The
    // promoted diff hash remains capture evidence, not a substitute for final
    // authoritative-tree identity.
    resultHash: (await captureArtifactState(opts, operation)).resultHash,
    outputRef: commandEvidence.outputRef,
    exitCode,
    egressBlocked: true,
    signal: null,
    commandEvidence,
  };
}

/** Replay-based crash recovery (spec §6.2, REQ-6.2/6.4). */
export async function recoverWorktree(
  opts: Omit<ExecutorOptions, 'failpoints'>,
  admissionOperation?: FrozenTreeOperationControl,
): Promise<RecoveryReport> {
  const sandbox = opts.sandbox ?? denyNetworkSandbox(process.platform);
  const commandRunner =
    opts.commandRunner ?? createCommandRunner({ sandbox, evidence: opts.evidence });
  const coreCommandExecutor =
    opts.coreCommandExecutor ??
    createCoreCommandExecutor({
      evidence: opts.evidence,
      policy: opts.policy,
      sandbox,
      commandRunner,
      ...(opts.offlineDependencyPolicy === undefined
        ? {}
        : { offlineDependencyPolicy: opts.offlineDependencyPolicy }),
    });
  const intentHistory = mutatingIntentHistory(opts);
  const intents = intentHistory.map((generation) => generation.intent);
  let recoveryBoundaryIndex = intentHistory.findIndex(
    (generation) => generation.terminals.length === 0,
  );
  let recoverySource: RecoveryReport['source'] =
    recoveryBoundaryIndex >= 0 ? 'dangling_intent' : 'consistent';
  let identityMismatchDetail: string | undefined;

  if (recoveryBoundaryIndex >= 0) {
    const danglingIntent = intentHistory[recoveryBoundaryIndex]?.intent;
    const precedingApplied = activeAppliedEvents(opts)
      .filter(
        (event) =>
          typeof event.payload['resultHash'] === 'string' &&
          !String(event.payload['resultHash']).startsWith('blob://') &&
          typeof event.payload['intentSeq'] === 'number' &&
          danglingIntent !== undefined &&
          event.payload['intentSeq'] < danglingIntent.seq,
      )
      .at(-1);
    if (precedingApplied !== undefined) {
      const precedingIntentSeq = precedingApplied.payload['intentSeq'];
      const precedingIndex = intentHistory.findIndex(
        (generation) => generation.intent.seq === precedingIntentSeq,
      );
      if (precedingIndex < 0) {
        reject(
          opts,
          String(precedingApplied.payload['actionId']),
          'command_artifact_unavailable',
          'preceding ACTION_APPLIED has no matching recovery intent',
        );
        return {
          action: 'none',
          detail:
            'preceding ACTION_APPLIED has no matching recovery intent; dangling reconciliation refused',
          coherent: false,
          source: 'failed_closed',
        };
      }
      // A legacy dangling snapshot may already contain unlogged tamper. Rewind
      // through the preceding accepted generation so its exact resultHash, not
      // the later snapshot bytes, remains the causal admission boundary.
      recoveryBoundaryIndex = precedingIndex;
    }
  }

  if (recoveryBoundaryIndex < 0) {
    const applieds = activeAppliedEvents(opts).filter(
      (event) =>
        typeof event.payload['resultHash'] === 'string' &&
        !String(event.payload['resultHash']).startsWith('blob://'),
    );
    const lastApplied = applieds[applieds.length - 1];
    if (lastApplied === undefined) {
      return {
        action: 'none',
        detail: 'log and worktree consistent',
        coherent: true,
        source: 'consistent',
      };
    }
    const appliedIntentSeq = lastApplied.payload['intentSeq'];
    const matchingIntent =
      typeof appliedIntentSeq === 'number'
        ? intents.find((event) => event.seq === appliedIntentSeq)
        : undefined;
    if (matchingIntent === undefined) {
      reject(
        opts,
        String(lastApplied.payload['actionId']),
        'command_artifact_unavailable',
        'last ACTION_APPLIED has no matching recovery intent',
      );
      return {
        action: 'none',
        detail: 'last ACTION_APPLIED has no matching recovery intent; reconciliation refused',
        coherent: false,
        source: 'failed_closed',
      };
    }
    const loggedAction = matchingIntent.payload['action'] as Action | undefined;
    const ownedIdentityOperation: OwnedFrozenTreeOperationControl | undefined =
      admissionOperation === undefined
        ? createFrozenTreeOperationControl(
            Math.min(
              loggedAction?.type === 'RUN_COMMAND'
                ? loggedAction.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS
                : MAX_COMMAND_TIMEOUT_MS,
              artifactIdentityTimeoutMs(opts),
            ),
            opts.commandSignal,
          )
        : undefined;
    const identityOperation = admissionOperation ?? ownedIdentityOperation;
    if (identityOperation === undefined) {
      throw new Error('artifact identity reconciliation has no operation control');
    }
    let current: string | undefined;
    let identityFailure: unknown;
    try {
      current = (await captureArtifactState(opts, identityOperation)).resultHash;
    } catch (error) {
      if (
        admissionOperation !== undefined &&
        error instanceof FrozenTreeOperationError
      ) {
        throw error;
      }
      identityFailure = error;
    } finally {
      ownedIdentityOperation?.dispose();
    }
    const expected = String(lastApplied.payload['resultHash']);
    if (current === expected) {
      return {
        action: 'none',
        detail: 'log and worktree consistent',
        coherent: true,
        source: 'consistent',
      };
    }
    recoveryBoundaryIndex = intentHistory.findIndex(
      (generation) => generation.intent.seq === matchingIntent.seq,
    );
    if (recoveryBoundaryIndex < 0) {
      reject(
        opts,
        String(lastApplied.payload['actionId']),
        'command_artifact_unavailable',
        'last ACTION_APPLIED recovery intent is absent from mutating history',
      );
      return {
        action: 'none',
        detail: 'last ACTION_APPLIED recovery intent is absent from mutating history',
        coherent: false,
        source: 'failed_closed',
      };
    }
    recoverySource = 'artifact_mismatch';
    identityMismatchDetail =
      identityFailure instanceof Error
        ? `artifact identity capture failed: ${identityFailure.message}`
        : 'artifact identity hash disagreed';
  }

  if (recoveryBoundaryIndex >= 0) {
    type MutatingAction = Extract<
      Action,
      { type: 'WRITE_FILE' | 'APPLY_PATCH' | 'RUN_COMMAND' }
    >;
    type ReplayGeneration = MutatingIntentGeneration & {
      action: MutatingAction;
      role: Role;
      snapshot: ActionSnapshot;
      terminal?: PlatformEvent;
    };
    type PendingTerminal =
      | {
          generation: ReplayGeneration;
          type: 'ACTION_APPLIED';
          applied: Exclude<
            Awaited<ReturnType<typeof performApply>>,
            { rejected: unknown }
          >;
        }
      | {
          generation: ReplayGeneration;
          type: 'ACTION_REJECTED';
          reason: ActionRejection['reason'];
          detail: string;
        };

    const suffix = intentHistory.slice(recoveryBoundaryIndex);
    const earliestIntent = suffix[0]?.intent;
    if (earliestIntent === undefined) {
      throw new Error('recovery history lost its dangling intent boundary');
    }
    let earliestSnapshot: ActionSnapshot;
    try {
      earliestSnapshot = actionSnapshotFromPayload(
        opts,
        earliestIntent.payload,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        action: 'none',
        detail: `recovery failed closed before rollback; dangling suffix remains: ${detail}`,
        coherent: false,
        source: 'failed_closed',
      };
    }

    const roleFromPayload = (payload: Record<string, unknown>): Role | null => {
      const rawRole = payload['role'];
      return rawRole === 'planner' ||
        rawRole === 'test_designer' ||
        rawRole === 'implementer' ||
        rawRole === 'diagnostician' ||
        rawRole === 'reviewer'
        ? rawRole
        : null;
    };
    const operationFor = (
      action: MutatingAction,
    ): FrozenTreeOperationControl | undefined =>
      admissionOperation ??
      createFrozenTreeOperationControl(
        Math.min(
          action.type === 'RUN_COMMAND'
            ? action.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS
            : MAX_COMMAND_TIMEOUT_MS,
          artifactIdentityTimeoutMs(opts),
        ),
        opts.commandSignal,
      );
    const disposeOperation = (
      operation: FrozenTreeOperationControl | undefined,
    ): void => {
      if (operation !== admissionOperation) {
        (operation as OwnedFrozenTreeOperationControl | undefined)?.dispose();
      }
    };
    const pending: PendingTerminal[] = [];
    let replayedCount = 0;
    let rejectedCount = 0;

    try {
      const replayGenerations: ReplayGeneration[] = [];
      for (const generation of suffix) {
        if (generation.terminals.length > 1) {
          throw new Error(
            `intentSeq=${generation.intent.seq} has multiple causal terminal events`,
          );
        }
        const rawAction = generation.intent.payload['action'];
        if (
          typeof rawAction !== 'object' ||
          rawAction === null ||
          !('type' in rawAction) ||
          (rawAction.type !== 'WRITE_FILE' &&
            rawAction.type !== 'APPLY_PATCH' &&
            rawAction.type !== 'RUN_COMMAND')
        ) {
          throw new Error(
            `intentSeq=${generation.intent.seq} has an invalid mutating action`,
          );
        }
        const action = rawAction as MutatingAction;
        const validation = validate(action);
        if (
          validation !== null ||
          action.actionId !== generation.intent.payload['actionId']
        ) {
          throw new Error(
            `intentSeq=${generation.intent.seq} action failed recovery validation: ${
              validation ?? 'actionId mismatch'
            }`,
          );
        }
        const role = roleFromPayload(generation.intent.payload);
        if (role === null) {
          throw new Error(
            `intentSeq=${generation.intent.seq} has a missing or invalid recovery role`,
          );
        }
        const snapshot = actionSnapshotFromPayload(
          opts,
          generation.intent.payload,
        );
        const terminal = generation.terminals[0];
        if (terminal?.type !== 'ACTION_REJECTED') {
          if (snapshot.artifactSnapshotRef !== undefined) {
            loadArtifactSnapshot(opts, snapshot.artifactSnapshotRef);
          } else {
            loadPersistentSnapshot(opts, snapshot.persistentSnapshotRef);
          }
          if (action.type === 'WRITE_FILE') {
            opts.evidence.get(action.contentRef);
          } else if (action.type === 'APPLY_PATCH') {
            opts.evidence.get(action.diffRef);
          }
        }
        if (
          terminal?.type === 'ACTION_APPLIED' &&
          (typeof terminal.payload['resultHash'] !== 'string' ||
            terminal.payload['resultHash'].startsWith('blob://'))
        ) {
          throw new Error(
            `intentSeq=${generation.intent.seq} has unusable applied artifact evidence`,
          );
        }
        replayGenerations.push({
          ...generation,
          action,
          role,
          snapshot,
          ...(terminal === undefined ? {} : { terminal }),
        });
      }

      const boundaryOperation = operationFor(replayGenerations[0]!.action);
      try {
        await reconcileAfterFailure(
          opts,
          earliestSnapshot,
          boundaryOperation,
        );
      } finally {
        disposeOperation(boundaryOperation);
      }

      let finalResultHash: string | undefined;
      for (const generation of replayGenerations) {
        if (generation.terminal?.type === 'ACTION_REJECTED') {
          continue;
        }
        const operation = operationFor(generation.action);
        try {
          let preparedPatch: PreparedPatch | undefined;
          if (generation.action.type === 'APPLY_PATCH') {
            try {
              preparedPatch = await preparePatchAction(
                opts,
                generation.action,
                generation.role,
                operation,
              );
            } catch (error) {
              if (!(error instanceof PatchRejected)) throw error;
              if (generation.terminal?.type === 'ACTION_APPLIED') {
                throw new Error(
                  `intentSeq=${generation.intent.seq} replay was rejected despite its ACTION_APPLIED: ${error.message}`,
                );
              }
              pending.push({
                generation,
                type: 'ACTION_REJECTED',
                reason: error.reason,
                detail: error.message,
              });
              rejectedCount += 1;
              continue;
            }
          }
          const applied = await performApply(
            opts,
            coreCommandExecutor,
            generation.action,
            generation.role,
            operation,
            preparedPatch,
          );
          if ('rejected' in applied) {
            await reconcileAfterFailure(opts, generation.snapshot, operation);
            if (generation.terminal?.type === 'ACTION_APPLIED') {
              throw new Error(
                `intentSeq=${generation.intent.seq} replay failed despite its ACTION_APPLIED: ${applied.rejected.detail}`,
              );
            }
            pending.push({
              generation,
              type: 'ACTION_REJECTED',
              reason: applied.rejected.reason,
              detail: applied.rejected.detail,
            });
            rejectedCount += 1;
            continue;
          }
          if (
            generation.terminal?.type === 'ACTION_APPLIED' &&
            applied.resultHash !==
              String(generation.terminal.payload['resultHash'])
          ) {
            throw new Error(
              `intentSeq=${generation.intent.seq} replay artifact identity disagreed with ACTION_APPLIED`,
            );
          }
          finalResultHash = applied.resultHash;
          replayedCount += 1;
          if (generation.terminal === undefined) {
            pending.push({
              generation,
              type: 'ACTION_APPLIED',
              applied,
            });
          }
        } finally {
          disposeOperation(operation);
        }
      }

      if (finalResultHash !== undefined) {
        const finalIdentityOperation =
          admissionOperation ??
          createFrozenTreeOperationControl(
            artifactIdentityTimeoutMs(opts),
            opts.commandSignal,
          );
        let finalIdentity: string;
        try {
          finalIdentity = (
            await captureArtifactState(opts, finalIdentityOperation)
          ).resultHash;
        } finally {
          if (finalIdentityOperation !== admissionOperation) {
            (
              finalIdentityOperation as OwnedFrozenTreeOperationControl
            ).dispose();
          }
        }
        if (finalIdentity !== finalResultHash) {
          throw new Error(
            'replayed suffix final artifact identity disagreed with its accepted history',
          );
        }
      }
      for (const terminal of pending) {
        if (terminal.type === 'ACTION_APPLIED') {
          appendCoreEvent(opts, {
            runId: opts.runId,
            taskId: opts.taskId,
            type: 'ACTION_APPLIED',
            payload: {
              actionId: terminal.generation.action.actionId,
              intentSeq: terminal.generation.intent.seq,
              duplicate: false,
              recovered: true,
              ...terminal.applied,
            },
          });
        } else {
          reject(
            opts,
            terminal.generation.action.actionId,
            terminal.reason,
            terminal.detail,
            { intentSeq: terminal.generation.intent.seq },
          );
        }
      }
      return {
        action: replayedCount > 0 ? 'replayed_intent' : 'rolled_back',
        detail: `${
          identityMismatchDetail === undefined
            ? ''
            : `${identityMismatchDetail}; `
        }restored ${earliestSnapshot.snapshotRef} and replayed ${replayedCount} accepted mutation(s); ${rejectedCount} dangling mutation(s) rejected`,
        coherent: true,
        source: recoverySource,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const operationError =
        error instanceof FrozenTreeOperationError ? error : undefined;
      const rollbackOperation = createFrozenTreeOperationControl(
        Math.min(MAX_COMMAND_TIMEOUT_MS, artifactIdentityTimeoutMs(opts)),
      );
      try {
        await reconcileAfterFailure(
          opts,
          earliestSnapshot,
          rollbackOperation,
        );
      } finally {
        rollbackOperation.dispose();
      }
      for (const generation of suffix) {
        const applied = generation.terminals.find(
          (terminal) => terminal.type === 'ACTION_APPLIED',
        );
        if (applied !== undefined) {
          reject(
            opts,
            String(applied.payload['actionId']),
            'command_artifact_unavailable',
            `recovery invalidated accepted suffix event ${applied.seq}: ${detail}`,
            { invalidatesAppliedSeq: applied.seq },
          );
        }
        if (generation.terminals.length === 0) {
          reject(
            opts,
            String(generation.intent.payload['actionId']),
            'command_artifact_unavailable',
            `recovery failed closed for intentSeq=${generation.intent.seq}: ${detail}`,
            { intentSeq: generation.intent.seq },
          );
        }
      }
      if (operationError !== undefined) {
        throw operationError;
      }
      return {
        action: 'rolled_back',
        detail: `rolled back to ${earliestSnapshot.snapshotRef}; suffix replay failed closed: ${detail}`,
        coherent: false,
        source: 'failed_closed',
      };
    }
  }

  return {
    action: 'none',
    detail: 'log and worktree consistent',
    coherent: true,
    source: 'consistent',
  };
}
