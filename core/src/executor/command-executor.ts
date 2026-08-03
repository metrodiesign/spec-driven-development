import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { EvidenceStore } from '../evidence/store.ts';
import {
  createFrozenTreeOperationControl,
  DEFAULT_FROZEN_TREE_LIMITS,
  freezeWorkingTree,
  FrozenTreeOperationError,
  readRegularFileByDescriptor,
  type FrozenTree,
  type FrozenTreeEntry,
  type FrozenTreeOperationControl,
} from '../gates/frozen-tree.ts';
import type {
  CommandResult,
  CommandRunner,
} from '../security/command-runner.ts';
import type { SandboxWrap } from '../security/sandbox.ts';
import type { Action, Role } from '../types.ts';
import {
  applyMutationBatch,
  type MutationPathOperation,
} from './mutation-path.ts';
import type { PathPolicy } from './path-policy.ts';

type RunCommandAction = Extract<Action, { type: 'RUN_COMMAND' }>;

export interface SandboxBackendCapabilities {
  inheritedFilesystemAndNetworkPolicy: true;
  denialObservation: 'direct_only';
  revocableDescendantContainment: false;
  descendantTermination: 'unproven_new_session';
}

export interface CommandEvidence {
  outputRef: string;
  networkPolicyHash: string;
  environmentHash: string;
  backend: SandboxBackendCapabilities;
  observedViolation: null | {
    source: 'enforcement_owned_direct' | 'backend_owned';
    operation: 'filesystem' | 'network' | 'unknown';
  };
}

export interface OfflineDependencyPolicy {
  version: 1;
  allowedRoles: Role[];
  commands: string[];
  manifestPath: string;
  manifestHash: string;
  lockfilePath: string;
  lockfileHash: string;
  approvedSourceHashes: string[];
  approvedSources: OfflineDependencySource[];
  approvedOutputMetadata?: OfflineDependencyOutputMetadata[];
  persistentOutputRoots: string[];
  lifecycleScripts: 'disabled';
  network: 'none';
}

export interface OfflineDependencySource {
  packageName: string;
  specifier: string;
  targetPath: string;
  sourcePath: string;
  contentHash: string;
}

export interface OfflineDependencyOutputMetadata {
  path: string;
  validator:
    | 'exact_lockfile_v1'
    | 'pnpm_modules_json_v1'
    | 'pnpm_package_map_json_v1'
    | 'pnpm_workspace_state_json_v1';
  packageManager?: string;
}

export interface CommandArtifactPolicy {
  version: 1;
  maxFiles: number;
  maxSingleFileBytes: number;
  maxTotalBytes: number;
  maxDiffBytes: number;
  captureTimeoutMs: number;
}

export const PHASE0_COMMAND_ARTIFACT_POLICY: Readonly<CommandArtifactPolicy> = Object.freeze({
  version: 1,
  maxFiles: 200_000,
  maxSingleFileBytes: 268_435_456,
  maxTotalBytes: 2_147_483_648,
  maxDiffBytes: 2_147_483_648,
  captureTimeoutMs: 300_000,
});

export type CommandCapturePhase =
  | 'freeze_input'
  | 'materialize'
  | 'spawn'
  | 'pre_inventory'
  | 'capture_file_open'
  | 'copy'
  | 'post_inventory'
  | 'capture_inventory'
  | 'diff'
  | 'evidence'
  | 'promote'
  | 'cleanup';

export interface CommandCaptureFailpoints {
  at?(
    phase: CommandCapturePhase,
    state: { workspaceRoot: string; captureRoot?: string; relativePath?: string },
  ): void;
}

export interface CapturedCommandArtifact {
  exitCode: number;
  inputTreeHash: string;
  outputTreeHash: string;
  preCopyInventoryHash: string;
  postCopyInventoryHash: string;
  captureInventoryHash: string;
  diffRef: string;
  diffHash: string;
  affectedPaths: string[];
}

export type CoreCommandOutcome =
  | {
      status: 'promoted';
      capture: CapturedCommandArtifact;
      promotedDiffHash: string;
      evidence: CommandEvidence;
    }
  | {
      status: 'no_changes';
      capture: CapturedCommandArtifact;
      evidence: CommandEvidence;
    }
  | {
      status: 'completed';
      exitCode: number;
      signal: null;
      evidence: CommandEvidence;
    }
  | {
      status: 'signaled';
      exitCode: null;
      signal: NodeJS.Signals;
      evidence: CommandEvidence;
    }
  | {
      status: 'command_failed';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      evidence: CommandEvidence;
    }
  | {
      status: 'sandbox_violation';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      evidence: CommandEvidence;
    }
  | {
      status: 'preflight_rejected';
      reason:
        | 'sandbox_unavailable'
        | 'network_grant_unavailable'
        | 'offline_dependency_unavailable'
        | 'package_install_denied'
        | 'path_outside_allowlist'
        | 'golden_write_denied'
        | 'red_artifact_frozen'
        | 'command_artifact_unavailable'
        | 'command_diff_rejected'
        | 'invalid_request'
        | 'timed_out'
        | 'cancelled'
        | 'output_limit';
      detail: string;
      evidenceRef: string;
    }
  | {
      status: 'capture_rejected';
      reason:
        | 'sandbox_unavailable'
        | 'network_grant_unavailable'
        | 'offline_dependency_unavailable'
        | 'package_install_denied'
        | 'path_outside_allowlist'
        | 'golden_write_denied'
        | 'red_artifact_frozen'
        | 'command_artifact_unavailable'
        | 'command_diff_rejected'
        | 'invalid_request'
        | 'timed_out'
        | 'cancelled'
        | 'output_limit';
      detail: string;
      evidenceRef: string;
    };

export interface TrustedCommandContext {
  worktreeDir: string;
  role: Role;
  classification: 'artifact_mutation' | 'read_only_probe' | 'gate_check';
  signal?: AbortSignal;
  /** Public Executor owns this control so outer snapshot and inner lifecycle share one deadline. */
  operation?: FrozenTreeOperationControl;
}

export interface CoreCommandExecutor {
  readonly environmentHash: string | undefined;
  execute(action: RunCommandAction, context: TrustedCommandContext): Promise<CoreCommandOutcome>;
}

export interface CoreCommandExecutorOptions {
  evidence: EvidenceStore;
  policy: PathPolicy;
  sandbox: SandboxWrap;
  /** Internal execution seam. It is deliberately not re-exported from the core package. */
  commandRunner: CommandRunner;
  offlineDependencyPolicy?: OfflineDependencyPolicy;
  artifactPolicy?: Readonly<CommandArtifactPolicy>;
  temporaryRoot?: string;
  now?: () => number;
  failpoints?: CommandCaptureFailpoints;
}

const BACKEND_CAPABILITIES: SandboxBackendCapabilities = Object.freeze({
  inheritedFilesystemAndNetworkPolicy: true,
  denialObservation: 'direct_only',
  revocableDescendantContainment: false,
  descendantTermination: 'unproven_new_session',
});

const PACKAGE_INSTALL = /^(?:pnpm\s+(?:install|i)|npm\s+(?:ci|install)|yarn\s+install)\b/u;

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function rejectionEvidence(evidence: EvidenceStore, reason: string, detail: string): string {
  return evidence.put(JSON.stringify({ status: 'preflight_rejected', reason, detail }));
}

function checkPolicy(policy: Readonly<CommandArtifactPolicy>): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`invalid command-artifact policy ${name}`);
    }
  }
}

function contained(root: string, relPath: string): string {
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`captured path escapes root: ${relPath}`);
  }
  return target;
}

function fileHash(path: string): string {
  return sha256(readFileSync(path));
}

interface ApprovedSourceSnapshot {
  definition: OfflineDependencySource;
  files: Array<{
    path: string;
    content: Buffer;
    executable: boolean;
    sha256: string;
  }>;
}

interface ApprovedSourceCaptureLimits {
  maxFiles: number;
  maxSingleFileBytes: number;
  maxTotalBytes: number;
  ensureTime(): void;
  operation: CommandOperationControl;
}

interface ApprovedSourceCaptureBudget {
  files: number;
  totalBytes: number;
}

type CommandOperationControl = FrozenTreeOperationControl;

function safeRelativePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.split('/').some((component) => component === '' || component === '.' || component === '..') &&
    path !== '.git' &&
    !path.startsWith('.git/')
  );
}

async function captureApprovedSource(
  definition: OfflineDependencySource,
  limits: ApprovedSourceCaptureLimits,
  budget: ApprovedSourceCaptureBudget,
): Promise<ApprovedSourceSnapshot> {
  limits.ensureTime();
  if (
    typeof definition.packageName !== 'string' ||
    definition.packageName.length === 0 ||
    typeof definition.specifier !== 'string' ||
    typeof definition.sourcePath !== 'string' ||
    typeof definition.contentHash !== 'string' ||
    !safeRelativePath(definition.targetPath) ||
    definition.specifier !== `file:${definition.targetPath}` ||
    !/^[0-9a-f]{64}$/u.test(definition.contentHash) ||
    !definition.sourcePath.startsWith('/')
  ) {
    throw new Error(`approved offline source definition is invalid: ${definition.packageName}`);
  }
  const rootStat = lstatSync(definition.sourcePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`approved offline source is not a core-owned directory: ${definition.packageName}`);
  }
  const relativeFiles: string[] = [];
  const pending = [{ root: definition.sourcePath, prefix: '' }];
  while (pending.length > 0) {
    limits.ensureTime();
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current.root, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      limits.ensureTime();
      const relativePath =
        current.prefix === '' ? entry.name : `${current.prefix}/${entry.name}`;
      if (!safeRelativePath(relativePath) || entry.isSymbolicLink()) {
        throw new Error(`approved offline source contains an unsafe path: ${relativePath}`);
      }
      const absolutePath = join(current.root, entry.name);
      if (entry.isDirectory()) {
        pending.push({ root: absolutePath, prefix: relativePath });
      } else if (entry.isFile()) {
        budget.files += 1;
        if (budget.files > limits.maxFiles) {
          throw new Error(
            `approved offline source exceeds maxFiles=${limits.maxFiles}: ${definition.packageName}`,
          );
        }
        relativeFiles.push(relativePath);
      }
      else throw new Error(`approved offline source contains an unsupported object: ${relativePath}`);
    }
  }
  if (relativeFiles.length === 0) {
    throw new Error(`approved offline source is empty: ${definition.packageName}`);
  }
  const files: ApprovedSourceSnapshot['files'] = [];
  for (const relativePath of relativeFiles.sort()) {
    limits.ensureTime();
    const initial = lstatSync(join(definition.sourcePath, relativePath), { bigint: true });
    if (!initial.isFile() || initial.size > BigInt(limits.maxSingleFileBytes)) {
      throw new Error(`approved offline source file is invalid: ${relativePath}`);
    }
    budget.totalBytes += Number(initial.size);
    if (budget.totalBytes > limits.maxTotalBytes) {
      throw new Error(
        `approved offline source exceeds maxTotalBytes=${limits.maxTotalBytes}: ${definition.packageName}`,
      );
    }
    const captured = await readRegularFileByDescriptor(
      definition.sourcePath,
      relativePath,
      limits.maxSingleFileBytes,
      {
        timeoutMs: limits.operation.remainingMs(120_000),
        signal: limits.operation.signal,
      },
    );
    limits.ensureTime();
    if (
      captured.metadata.dev !== initial.dev ||
      captured.metadata.ino !== initial.ino ||
      captured.metadata.mode !== initial.mode ||
      captured.metadata.size !== initial.size ||
      captured.metadata.mtimeNs !== initial.mtimeNs ||
      captured.metadata.ctimeNs !== initial.ctimeNs
    ) {
      throw new Error(`approved offline source changed while reading: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      content: captured.content,
      executable: (initial.mode & 0o111n) !== 0n,
      sha256: sha256(captured.content),
    });
  }
  const contentHash = sha256(
    JSON.stringify(files.map(({ path, sha256: digest }) => ({ path, sha256: digest }))),
  );
  if (contentHash !== definition.contentHash) {
    throw new Error(`approved offline source content hash mismatch: ${definition.packageName}`);
  }
  const packageFile = files.find((file) => file.path === 'package.json');
  if (packageFile === undefined) {
    throw new Error(`approved offline source has no package.json: ${definition.packageName}`);
  }
  let packageName: unknown;
  try {
    packageName = (JSON.parse(packageFile.content.toString('utf8')) as Record<string, unknown>)['name'];
  } catch {
    throw new Error(`approved offline source package.json is invalid: ${definition.packageName}`);
  }
  if (packageName !== definition.packageName) {
    throw new Error(`approved offline source package name mismatch: ${definition.packageName}`);
  }
  return { definition, files };
}

async function captureApprovedSources(
  policy: OfflineDependencyPolicy,
  limits: ApprovedSourceCaptureLimits,
): Promise<ApprovedSourceSnapshot[]> {
  if (
    policy.approvedSources.length === 0 ||
    policy.approvedSources.length !== policy.approvedSourceHashes.length
  ) {
    throw new Error('offline dependency graph has no complete approved source mapping');
  }
  const snapshots: ApprovedSourceSnapshot[] = [];
  const budget = { files: 0, totalBytes: 0 };
  for (const definition of policy.approvedSources) {
    if (!policy.approvedSourceHashes.includes(definition.contentHash)) {
      throw new Error(`offline source content hash is unapproved: ${definition.contentHash}`);
    }
    snapshots.push(await captureApprovedSource(definition, limits, budget));
  }
  if (
    new Set(snapshots.map((snapshot) => snapshot.definition.packageName)).size !== snapshots.length ||
    new Set(snapshots.map((snapshot) => snapshot.definition.targetPath)).size !== snapshots.length
  ) {
    throw new Error('offline dependency source mapping contains duplicates');
  }
  return snapshots;
}

function materializeApprovedSources(
  workspaceRoot: string,
  snapshots: readonly ApprovedSourceSnapshot[],
  operation: CommandOperationControl,
): void {
  for (const snapshot of snapshots) {
    operation.checkpoint();
    const targetRoot = contained(workspaceRoot, snapshot.definition.targetPath);
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    for (const file of snapshot.files) {
      operation.checkpoint();
      const destination = contained(targetRoot, file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, file.content, {
        flag: 'wx',
        mode: file.executable ? 0o555 : 0o444,
      });
    }
    makeImmutable(targetRoot, operation);
  }
}

async function verifyInstalledApprovedSources(
  workspaceRoot: string,
  snapshots: readonly ApprovedSourceSnapshot[],
  limits: ApprovedSourceCaptureLimits,
): Promise<void> {
  const budget = { files: 0, totalBytes: 0 };
  for (const snapshot of snapshots) {
    const installedRoot = contained(
      workspaceRoot,
      `node_modules/${snapshot.definition.packageName}`,
    );
    const installed = await captureApprovedSource(
      { ...snapshot.definition, sourcePath: installedRoot },
      limits,
      budget,
    );
    if (installed.definition.contentHash !== snapshot.definition.contentHash) {
      throw new Error(
        `installed offline dependency differs from approved source: ${snapshot.definition.packageName}`,
      );
    }
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function parseMetadataObject(
  captureRoot: string,
  entry: FrozenTreeEntry,
): Record<string, unknown> {
  if (entry.mode !== '100644') {
    throw new Error(`approved installed-output metadata has unsafe mode: ${entry.path}`);
  }
  const bytes = readFileSync(contained(captureRoot, entry.path));
  if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw new Error(`approved installed-output metadata changed before validation: ${entry.path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`approved installed-output metadata is invalid JSON: ${entry.path}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`approved installed-output metadata is not an object: ${entry.path}`);
  }
  return parsed as Record<string, unknown>;
}

function validatePnpmModulesMetadata(
  content: Record<string, unknown>,
  snapshots: readonly ApprovedSourceSnapshot[],
  packageManager: string | undefined,
): void {
  if (
    packageManager === undefined ||
    !/^pnpm@\d+\.\d+\.\d+$/u.test(packageManager) ||
    !hasExactKeys(content, [
      'hoistPattern',
      'included',
      'injectedDeps',
      'layoutVersion',
      'hoistedLocations',
      'nodeLinker',
      'packageManager',
      'pendingBuilds',
      'publicHoistPattern',
      'prunedAt',
      'registries',
      'skipped',
      'storeDir',
      'virtualStoreDir',
      'virtualStoreDirMaxLength',
    ])
  ) {
    throw new Error('approved pnpm modules metadata shape is invalid');
  }
  // pnpm records a package under pendingBuilds only when --ignore-scripts
  // skipped a build it would otherwise run. Derive that from the FROZEN
  // approved source bytes (build scripts in package.json, or a root
  // binding.gyp), never from manager output.
  const pendingBuildKeys = snapshots
    .filter((snapshot) => {
      const manifest = snapshot.files.find((file) => file.path === 'package.json');
      let scripts: Record<string, unknown> = {};
      if (manifest !== undefined) {
        try {
          const parsed: unknown = JSON.parse(manifest.content.toString('utf8'));
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const candidate = (parsed as Record<string, unknown>)['scripts'];
            if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
              scripts = candidate as Record<string, unknown>;
            }
          }
        } catch {
          // Unparseable approved manifests derive no expected build entry.
        }
      }
      return (
        ['preinstall', 'install', 'postinstall'].some((name) => name in scripts) ||
        snapshot.files.some((file) => file.path === 'binding.gyp')
      );
    })
    .map((snapshot) => `${snapshot.definition.packageName}@${snapshot.definition.specifier}`)
    .sort();
  const hoistedLocations = Object.fromEntries(
    snapshots
      .map((snapshot) => [
        `${snapshot.definition.packageName}@${snapshot.definition.specifier}`,
        [`node_modules/${snapshot.definition.packageName}`],
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const included = content['included'];
  const prunedAt = content['prunedAt'];
  const storeDir = content['storeDir'];
  const storeMajor = packageManager.match(/^pnpm@(\d+)\./u)?.[1];
  if (
    JSON.stringify(content['hoistPattern']) !== JSON.stringify(['*']) ||
    included === null ||
    typeof included !== 'object' ||
    Array.isArray(included) ||
    JSON.stringify(included) !==
      JSON.stringify({
        dependencies: true,
        devDependencies: true,
        optionalDependencies: true,
      }) ||
    JSON.stringify(content['injectedDeps']) !== '{}' ||
    content['layoutVersion'] !== 5 ||
    JSON.stringify(content['hoistedLocations']) !== JSON.stringify(hoistedLocations) ||
    content['nodeLinker'] !== 'hoisted' ||
    content['packageManager'] !== packageManager ||
    JSON.stringify(content['pendingBuilds']) !== JSON.stringify(pendingBuildKeys) ||
    JSON.stringify(content['publicHoistPattern']) !== '[]' ||
    typeof prunedAt !== 'string' ||
    !Number.isFinite(Date.parse(prunedAt)) ||
    JSON.stringify(content['registries']) !==
      JSON.stringify({
        default: 'https://registry.npmjs.org/',
        '@jsr': 'https://npm.jsr.io/',
      }) ||
    JSON.stringify(content['skipped']) !== '[]' ||
    typeof storeDir !== 'string' ||
    storeMajor === undefined ||
    !storeDir.endsWith(`/pnpm-store/v${storeMajor}`) ||
    !/(?:^|\/)command-scratch-[^/]+\/pnpm-store\/v\d+$/u.test(storeDir) ||
    content['virtualStoreDir'] !== '.pnpm' ||
    content['virtualStoreDirMaxLength'] !== 120
  ) {
    throw new Error('approved pnpm modules metadata content does not match policy');
  }
}

function validatePnpmPackageMapMetadata(
  content: Record<string, unknown>,
  captureRoot: string,
  snapshots: readonly ApprovedSourceSnapshot[],
): void {
  const manifest = JSON.parse(
    readFileSync(contained(captureRoot, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const projectName = manifest['name'];
  if (typeof projectName !== 'string' || projectName.length === 0) {
    throw new Error('captured package manifest has no project identity');
  }
  const rootDependencies = Object.fromEntries(
    [
      [projectName, '.'] as const,
      ...snapshots.map(
        (snapshot) =>
          [snapshot.definition.packageName, snapshot.definition.packageName] as const,
      ),
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
  const packages = Object.fromEntries(
    [
      ['.', { url: '..', dependencies: rootDependencies }] as const,
      ...snapshots.map(
        (snapshot) =>
          [
            snapshot.definition.packageName,
            {
              url: `./${snapshot.definition.packageName}`,
              dependencies: {
                [snapshot.definition.packageName]: snapshot.definition.packageName,
              },
            },
          ] as const,
      ),
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
  if (JSON.stringify(content) !== JSON.stringify({ packages })) {
    throw new Error('approved pnpm package-map metadata content does not match graph');
  }
}

function validatePnpmWorkspaceStateMetadata(content: Record<string, unknown>): void {
  const timestamp = content['lastValidatedTimestamp'];
  const settings = content['settings'];
  if (
    !hasExactKeys(content, [
      'lastValidatedTimestamp',
      'projects',
      'pnpmfiles',
      'settings',
      'filteredInstall',
    ]) ||
    !Number.isSafeInteger(timestamp) ||
    (timestamp as number) <= 0 ||
    JSON.stringify(content['projects']) !== '{}' ||
    JSON.stringify(content['pnpmfiles']) !== '[]' ||
    settings === null ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    JSON.stringify(settings) !==
      JSON.stringify({
        enableGlobalVirtualStore: false,
        autoInstallPeers: true,
        dedupeDirectDeps: false,
        dedupeInjectedDeps: true,
        dedupePeerDependents: true,
        dedupePeers: false,
        dev: true,
        excludeLinksFromLockfile: false,
        hoistPattern: ['*'],
        hoistWorkspacePackages: true,
        injectWorkspacePackages: false,
        linkWorkspacePackages: false,
        minimumReleaseAge: 1440,
        minimumReleaseAgeIgnoreMissingTime: true,
        nodeLinker: 'hoisted',
        optional: true,
        peersSuffixMaxLength: 1000,
        preferWorkspacePackages: false,
        production: true,
        publicHoistPattern: [],
      }) ||
    content['filteredInstall'] !== false
  ) {
    throw new Error('approved pnpm workspace-state metadata content does not match policy');
  }
}

function verifyCapturedInstalledApprovedSources(
  captureRoot: string,
  entries: readonly FrozenTreeEntry[],
  snapshots: readonly ApprovedSourceSnapshot[],
  policy: OfflineDependencyPolicy,
  operation: CommandOperationControl,
): ReadonlySet<string> {
  const expected = new Map<
    string,
    | { kind: 'package'; mode: '100644' | '100755'; bytes: number; sha256: string }
    | { kind: 'metadata'; definition: OfflineDependencyOutputMetadata }
  >();
  for (const snapshot of snapshots) {
    operation.checkpoint();
    const installedPrefix = `node_modules/${snapshot.definition.packageName}`;
    for (const file of snapshot.files) {
      operation.checkpoint();
      expected.set(`${installedPrefix}/${file.path}`, {
        kind: 'package',
        mode: file.executable ? '100755' : '100644',
        bytes: file.content.length,
        sha256: file.sha256,
      });
    }
  }
  for (const metadata of policy.approvedOutputMetadata ?? []) {
    operation.checkpoint();
    if (
      !safeRelativePath(metadata.path) ||
      !policy.persistentOutputRoots.some(
        (root) => metadata.path === root || metadata.path.startsWith(`${root}/`),
      ) ||
      ![
        'exact_lockfile_v1',
        'pnpm_modules_json_v1',
        'pnpm_package_map_json_v1',
        'pnpm_workspace_state_json_v1',
      ].includes(metadata.validator) ||
      (metadata.packageManager !== undefined &&
        (typeof metadata.packageManager !== 'string' ||
          !/^pnpm@\d+\.\d+\.\d+$/u.test(metadata.packageManager))) ||
      expected.has(metadata.path)
    ) {
      throw new Error(`approved installed-output metadata is invalid: ${metadata.path}`);
    }
    expected.set(metadata.path, { kind: 'metadata', definition: metadata });
  }
  const installedEntries = entries
    .filter((entry) =>
      policy.persistentOutputRoots.some(
        (root) => entry.path === root || entry.path.startsWith(`${root}/`),
      ),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const expectedPaths = [...expected.keys()].sort();
  operation.checkpoint();
  const mismatch =
    installedEntries.length !== expectedPaths.length ||
    installedEntries.some((installed, index) => {
      const expectedPath = expectedPaths[index];
      const approved = expectedPath === undefined ? undefined : expected.get(expectedPath);
      return (
        approved === undefined ||
        installed.path !== expectedPath ||
        (approved.kind === 'package' &&
          (installed.mode !== approved.mode ||
            installed.bytes !== approved.bytes ||
            installed.sha256 !== approved.sha256))
      );
    });
  if (mismatch) {
    const actualPaths = installedEntries.map((entry) => entry.path);
    const unexpected = installedEntries
      .filter((entry) => !expected.has(entry.path))
      .map(
        (entry) =>
          `${entry.path}:${entry.mode}:${entry.bytes}:${entry.sha256}`,
      )
      .join(',');
    const missing = expectedPaths.filter((path) => !actualPaths.includes(path)).join(',');
    throw new Error(
      `captured installed output set differs from approved graph${
        unexpected === '' ? '' : `; unexpected=${unexpected}`
      }${missing === '' ? '' : `; missing=${missing}`}`,
    );
  }
  const installedByPath = new Map(installedEntries.map((entry) => [entry.path, entry]));
  for (const [path, approved] of expected) {
    operation.checkpoint();
    if (approved.kind !== 'metadata') continue;
    const entry = installedByPath.get(path);
    if (entry === undefined) {
      throw new Error(`captured installed output set differs from approved graph; missing=${path}`);
    }
    if (approved.definition.validator === 'exact_lockfile_v1') {
      if (entry.mode !== '100644' || entry.sha256 !== policy.lockfileHash) {
        throw new Error('approved installed lockfile metadata differs from frozen lockfile');
      }
      continue;
    }
    const content = parseMetadataObject(captureRoot, entry);
    if (approved.definition.validator === 'pnpm_modules_json_v1') {
      validatePnpmModulesMetadata(
        content,
        snapshots,
        approved.definition.packageManager,
      );
    } else if (approved.definition.validator === 'pnpm_package_map_json_v1') {
      validatePnpmPackageMapMetadata(content, captureRoot, snapshots);
    } else {
      validatePnpmWorkspaceStateMetadata(content);
    }
  }
  return new Set(expectedPaths);
}

function validateFrozenDependencyGraph(
  workspaceRoot: string,
  policy: OfflineDependencyPolicy,
  operation: CommandOperationControl,
): void {
  operation.checkpoint();
  const manifest = contained(workspaceRoot, policy.manifestPath);
  const lockfile = contained(workspaceRoot, policy.lockfilePath);
  if (!existsSync(manifest) || fileHash(manifest) !== policy.manifestHash) {
    throw new Error('required package manifest is missing or does not match its exact hash');
  }
  if (!existsSync(lockfile) || fileHash(lockfile) !== policy.lockfileHash) {
    throw new Error('required lockfile is missing or does not match its exact hash');
  }
  let packageManifest: Record<string, unknown>;
  try {
    packageManifest = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('required package manifest is not valid JSON');
  }
  const unsupportedGroups = ['devDependencies', 'optionalDependencies', 'peerDependencies'];
  if (
    unsupportedGroups.some((group) => {
      const value = packageManifest[group];
      return value !== undefined && (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value as Record<string, unknown>).length > 0
      );
    })
  ) {
    throw new Error('package manifest contains an unsupported dependency group');
  }
  const dependencies = packageManifest['dependencies'];
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('package manifest dependency graph is missing');
  }
  const graph = dependencies as Record<string, unknown>;
  operation.checkpoint();
  if (Object.keys(graph).length !== policy.approvedSources.length) {
    throw new Error('package manifest dependency graph does not match approved sources');
  }
  const lockfileBytes = readFileSync(lockfile, 'utf8');
  if (!/^lockfileVersion:\s*['"]?9\.0['"]?\s*$/mu.test(lockfileBytes)) {
    throw new Error('unsupported frozen lockfile format');
  }
  if (/\bintegrity:|\bhttps?:\/\//u.test(lockfileBytes)) {
    throw new Error('frozen lockfile contains an unsupported external source');
  }
  const section = (name: string, next: string | undefined): string => {
    const start = lockfileBytes.indexOf(`${name}:\n`);
    if (start < 0) throw new Error(`frozen lockfile omits ${name}`);
    const contentStart = start + name.length + 2;
    const end = next === undefined ? lockfileBytes.length : lockfileBytes.indexOf(`${next}:\n`, contentStart);
    if (end < 0) throw new Error(`frozen lockfile omits ${next}`);
    return lockfileBytes.slice(contentStart, end);
  };
  const importers = section('importers', 'packages');
  const packages = section('packages', 'snapshots');
  const snapshots = section('snapshots', undefined);
  const importerRoots = [...importers.matchAll(/^ {2}(?! )([^:\n]+):$/gmu)].map((match) => match[1]);
  if (importerRoots.length !== 1 || importerRoots[0] !== '.') {
    throw new Error('frozen lockfile contains an unsupported importer graph');
  }
  const expectedNames = policy.approvedSources.map((source) => source.packageName).sort();
  const importerNames = [...importers.matchAll(/^ {6}(?! )([^:\n]+):$/gmu)]
    .map((match) => match[1] as string)
    .sort();
  if (JSON.stringify(importerNames) !== JSON.stringify(expectedNames)) {
    throw new Error('frozen lockfile importer graph does not match approved sources');
  }
  const expectedPackageKeys = policy.approvedSources
    .map((source) => `${source.packageName}@${source.specifier}`)
    .sort();
  const packageKeys = [...packages.matchAll(/^ {2}(?! )(.+):$/gmu)]
    .map((match) => match[1] as string)
    .sort();
  const snapshotKeys = [...snapshots.matchAll(/^ {2}(?! )(.+):(?: \{\})?$/gmu)]
    .map((match) => match[1] as string)
    .sort();
  if (
    JSON.stringify(packageKeys) !== JSON.stringify(expectedPackageKeys) ||
    JSON.stringify(snapshotKeys) !== JSON.stringify(expectedPackageKeys)
  ) {
    throw new Error('frozen lockfile package graph does not match approved sources');
  }
  for (const source of policy.approvedSources) {
    operation.checkpoint();
    if (graph[source.packageName] !== source.specifier) {
      throw new Error(`package manifest source identity mismatch: ${source.packageName}`);
    }
    const escapedName = source.packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const escapedSpecifier = source.specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const importer = new RegExp(
      `^ {6}${escapedName}:\\n {8}specifier: ${escapedSpecifier}\\n {8}version: ${escapedSpecifier}$`,
      'mu',
    );
    if (!importer.test(lockfileBytes)) {
      throw new Error(`frozen lockfile importer does not bind approved source: ${source.packageName}`);
    }
    if (!lockfileBytes.includes(`  ${source.packageName}@${source.specifier}:`)) {
      throw new Error(`frozen lockfile package graph omits approved source: ${source.packageName}`);
    }
  }
}

function validateOfflinePolicy(
  action: RunCommandAction,
  context: TrustedCommandContext,
  policy: OfflineDependencyPolicy | undefined,
): { packageInstall: boolean; rejection?: CoreCommandOutcome } {
  const packageInstall = PACKAGE_INSTALL.test(action.cmd);
  if (!packageInstall) return { packageInstall: false };
  if (context.role !== 'implementer' && policy === undefined) {
    return {
      packageInstall,
      rejection: {
        status: 'preflight_rejected',
        reason: 'package_install_denied',
        detail: `role ${context.role} has no bound package-install permission`,
        evidenceRef: '',
      },
    };
  }
  if (policy === undefined) {
    return {
      packageInstall,
      rejection: {
        status: 'preflight_rejected',
        reason: 'offline_dependency_unavailable',
        detail: 'no Phase 0 offline dependency policy is bound',
        evidenceRef: '',
      },
    };
  }
  if (
    !Array.isArray(policy.allowedRoles) ||
    !Array.isArray(policy.commands) ||
    !Array.isArray(policy.approvedSourceHashes) ||
    !Array.isArray(policy.approvedSources) ||
    (policy.approvedOutputMetadata !== undefined &&
      !Array.isArray(policy.approvedOutputMetadata)) ||
    !Array.isArray(policy.persistentOutputRoots)
  ) {
    return {
      packageInstall,
      rejection: {
        status: 'preflight_rejected',
        reason: 'offline_dependency_unavailable',
        detail: 'offline dependency policy shape is invalid',
        evidenceRef: '',
      },
    };
  }
  if (!policy.allowedRoles.includes(context.role)) {
    return {
      packageInstall,
      rejection: {
        status: 'preflight_rejected',
        reason: 'package_install_denied',
        detail: `role ${context.role} is not permitted to install packages`,
        evidenceRef: '',
      },
    };
  }
  const approvedOutputMetadata = policy.approvedOutputMetadata ?? [];
  if (
    policy.version !== 1 ||
    policy.lifecycleScripts !== 'disabled' ||
    policy.network !== 'none' ||
    !safeRelativePath(policy.manifestPath) ||
    !/^[0-9a-f]{64}$/u.test(policy.manifestHash) ||
    !safeRelativePath(policy.lockfilePath) ||
    !/^[0-9a-f]{64}$/u.test(policy.lockfileHash) ||
    !policy.approvedSourceHashes.every((hash) => /^[0-9a-f]{64}$/u.test(hash)) ||
    policy.persistentOutputRoots.length === 0 ||
    !policy.persistentOutputRoots.every(safeRelativePath) ||
    new Set(policy.persistentOutputRoots).size !== policy.persistentOutputRoots.length ||
    policy.persistentOutputRoots.length !== 1 ||
    policy.persistentOutputRoots[0] !== 'node_modules' ||
    !approvedOutputMetadata.every(
      (metadata) =>
        safeRelativePath(metadata.path) &&
        policy.persistentOutputRoots.some(
          (root) =>
            metadata.path === root || metadata.path.startsWith(`${root}/`),
        ) &&
        [
          'exact_lockfile_v1',
          'pnpm_modules_json_v1',
          'pnpm_package_map_json_v1',
          'pnpm_workspace_state_json_v1',
        ].includes(metadata.validator) &&
        (metadata.validator === 'pnpm_modules_json_v1'
          ? typeof metadata.packageManager === 'string' &&
            /^pnpm@\d+\.\d+\.\d+$/u.test(metadata.packageManager)
          : metadata.packageManager === undefined),
    ) ||
    new Set(approvedOutputMetadata.map((metadata) => metadata.path)).size !==
      approvedOutputMetadata.length ||
    !policy.commands.includes(action.cmd) ||
    !action.cmd.includes('--ignore-scripts') ||
    !action.cmd.includes('--offline') ||
    !action.cmd.includes('--frozen-lockfile')
  ) {
    return {
      packageInstall,
      rejection: {
        status: 'preflight_rejected',
        reason: 'offline_dependency_unavailable',
        detail: 'offline install command does not match the exact lifecycle-disabled policy',
        evidenceRef: '',
      },
    };
  }
  return { packageInstall };
}

function typedEvidence(
  outputRef: string,
  environmentHash: string | undefined,
  request: {
    sandbox: SandboxWrap;
    artifactPolicy: Readonly<CommandArtifactPolicy>;
    offlineDependencyPolicy?: OfflineDependencyPolicy;
    /** Whether THIS command ran under the relaxed offline-install profile. */
    offlineInstallProfile: boolean;
  },
): CommandEvidence {
  const policyBytes = JSON.stringify({
    network: 'none',
    backend: request.sandbox.kind,
    backendNetworkPolicyHash:
      request.sandbox.kind === 'available'
        ? request.sandbox.networkPolicyHash ?? 'injected-unspecified'
        : null,
    artifactPolicy: request.artifactPolicy,
    offlineDependencyPolicy: request.offlineDependencyPolicy ?? null,
    // Per-command, not per-executor: an auditor must be able to tell which
    // command actually ran with approved-source writes demoted to EPERM.
    offlineInstallProfile: request.offlineInstallProfile,
  });
  return {
    outputRef,
    networkPolicyHash: sha256(policyBytes),
    environmentHash: sha256(
      JSON.stringify({
        runner: environmentHash ?? 'injected-unspecified',
        policyHash: sha256(policyBytes),
      }),
    ),
    backend: BACKEND_CAPABILITIES,
    observedViolation: null,
  };
}

function entryMap(entries: readonly FrozenTreeEntry[]): Map<string, FrozenTreeEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function changedEntries(
  before: readonly FrozenTreeEntry[],
  after: readonly FrozenTreeEntry[],
  operation?: CommandOperationControl,
): Array<{ path: string; before?: FrozenTreeEntry; after?: FrozenTreeEntry }> {
  const oldMap = entryMap(before);
  const newMap = entryMap(after);
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  return paths.flatMap((path) => {
    operation?.checkpoint();
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (
      oldEntry?.mode === newEntry?.mode &&
      oldEntry?.sha256 === newEntry?.sha256 &&
      oldEntry?.bytes === newEntry?.bytes
    ) {
      return [];
    }
    return [
      {
        path,
        ...(oldEntry === undefined ? {} : { before: oldEntry }),
        ...(newEntry === undefined ? {} : { after: newEntry }),
      },
    ];
  });
}

function makeImmutable(root: string, operation?: CommandOperationControl): void {
  const walk = (path: string): void => {
    operation?.checkpoint();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      chmodSync(path, 0o555);
      return;
    }
    chmodSync(path, 0o444);
  };
  walk(root);
}

function makeMutable(root: string): void {
  if (!existsSync(root)) return;
  const walk = (path: string): void => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) walk(join(path, entry));
      return;
    }
    chmodSync(path, 0o600);
  };
  walk(root);
}

async function promote(
  worktree: string,
  captureRoot: string,
  changes: readonly { path: string; before?: FrozenTreeEntry; after?: FrozenTreeEntry }[],
  allowedRoots: readonly string[],
  failpoints: CommandCaptureFailpoints | undefined,
  state: { workspaceRoot: string; captureRoot: string },
  operation: CommandOperationControl,
): Promise<void> {
  const mutations: MutationPathOperation[] = [];
  for (const change of changes) {
    operation.checkpoint();
    const expected: MutationPathOperation['expected'] =
      change.before === undefined
        ? { kind: 'absent' }
        : {
            kind: 'regular',
            sha256: change.before.sha256,
            mode: change.before.mode as '100644' | '100755',
          };
    if (change.after === undefined) {
      mutations.push({
        path: change.path,
        expected,
        desired: { kind: 'absent' },
      });
      continue;
    }
    const content = (
      await readRegularFileByDescriptor(
        captureRoot,
        change.path,
        change.after.bytes,
        operation,
      )
    ).content;
    if (createHash('sha256').update(content).digest('hex') !== change.after.sha256) {
      throw new Error(`capture changed before promotion: ${change.path}`);
    }
    mutations.push({
      path: change.path,
      expected,
      desired: {
        kind: 'regular',
        content,
        mode: change.after.mode as '100644' | '100755',
      },
    });
  }
  failpoints?.at?.('promote', state);
  operation.checkpoint();
  await applyMutationBatch({
    worktreeDir: worktree,
    operations: mutations,
    allowedRoots,
    operation,
  });
}

function asCaptureRejection(
  evidence: EvidenceStore,
  failure: unknown,
): Extract<CoreCommandOutcome, { status: 'capture_rejected' }> {
  const detail = failure instanceof Error ? failure.message : String(failure);
  return {
    status: 'capture_rejected',
    reason:
      failure instanceof FrozenTreeOperationError
        ? failure.reason
        : /red_artifact_frozen/u.test(detail)
          ? 'red_artifact_frozen'
        : /path|golden|red_artifact_frozen/u.test(detail)
          ? 'command_diff_rejected'
          : 'command_artifact_unavailable',
    detail,
    evidenceRef: rejectionEvidence(evidence, 'capture_rejected', detail),
  };
}

export function createCoreCommandExecutor(opts: CoreCommandExecutorOptions): CoreCommandExecutor {
  const artifactPolicy = opts.artifactPolicy ?? PHASE0_COMMAND_ARTIFACT_POLICY;
  checkPolicy(artifactPolicy);
  const limits = {
    maxFiles: artifactPolicy.maxFiles,
    maxSingleFileBytes: artifactPolicy.maxSingleFileBytes,
    maxTotalBytes: artifactPolicy.maxTotalBytes,
    maxGitOutputBytes: DEFAULT_FROZEN_TREE_LIMITS.maxGitOutputBytes,
  };
  const now = opts.now ?? (() => performance.now());

  return {
    get environmentHash() {
      return opts.commandRunner.environmentHash;
    },
    async execute(action, context) {
      context.operation?.checkpoint();
      if (action.network !== 'none') {
        const detail =
          'the deprecated Phase 0 macOS backend cannot prove revocable descendant network grants';
        return {
          status: 'preflight_rejected',
          reason: 'network_grant_unavailable',
          detail,
          evidenceRef: rejectionEvidence(opts.evidence, 'network_grant_unavailable', detail),
        };
      }

      const offline = validateOfflinePolicy(
        action,
        context,
        opts.offlineDependencyPolicy,
      );
      if (offline.rejection !== undefined) {
        const rejection = offline.rejection as Extract<
          CoreCommandOutcome,
          { status: 'preflight_rejected' }
        >;
        return {
          ...rejection,
          evidenceRef: rejectionEvidence(opts.evidence, rejection.reason, rejection.detail),
        };
      }
      let ownedOperation:
        | ReturnType<typeof createFrozenTreeOperationControl>
        | undefined;
      let operation: FrozenTreeOperationControl;
      if (context.operation === undefined) {
        ownedOperation = createFrozenTreeOperationControl(
          artifactPolicy.captureTimeoutMs,
          context.signal,
          now,
          `command artifact capture exceeds captureTimeoutMs=${artifactPolicy.captureTimeoutMs}`,
        );
        operation = ownedOperation;
      } else {
        operation = context.operation;
      }
      const ensureTime = (): void => operation.checkpoint();
      const approvedSourceLimits: ApprovedSourceCaptureLimits = {
        maxFiles: artifactPolicy.maxFiles,
        maxSingleFileBytes: artifactPolicy.maxSingleFileBytes,
        maxTotalBytes: artifactPolicy.maxTotalBytes,
        ensureTime,
        operation,
      };
      let approvedSourceSnapshots: ApprovedSourceSnapshot[] = [];
      if (offline.packageInstall) {
        try {
          approvedSourceSnapshots = await captureApprovedSources(
            opts.offlineDependencyPolicy as OfflineDependencyPolicy,
            approvedSourceLimits,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const reason =
            error instanceof FrozenTreeOperationError
              ? error.reason
              : 'offline_dependency_unavailable';
          ownedOperation?.dispose();
          return {
            status: 'preflight_rejected',
            reason,
            detail,
            evidenceRef: rejectionEvidence(
              opts.evidence,
              reason,
              detail,
            ),
          };
        }
      }

      const ownedTrees: FrozenTree[] = [];
      let attemptRoot = '';
      let workspaceRoot = '';
      let captureRoot: string | undefined;
      const phase = (name: CommandCapturePhase, relativePath?: string): void => {
        ensureTime();
        opts.failpoints?.at?.(name, {
          workspaceRoot,
          ...(captureRoot === undefined ? {} : { captureRoot }),
          ...(relativePath === undefined ? {} : { relativePath }),
        });
        ensureTime();
      };

      try {
        phase('freeze_input');
        const persistentRoots = opts.offlineDependencyPolicy?.persistentOutputRoots ?? [];
        const input = await freezeWorkingTree(
          context.worktreeDir,
          limits,
          tmpdir(),
          { includeIgnoredRoots: persistentRoots, operation },
        );
        ownedTrees.push(input);
        attemptRoot = mkdtempSync(
          join(opts.temporaryRoot ?? tmpdir(), 'command-attempt-'),
        );
        workspaceRoot = join(attemptRoot, 'workspace');
        mkdirSync(workspaceRoot, { mode: 0o700 });
        phase('materialize');
        await input.materialize(workspaceRoot, operation);

        if (offline.packageInstall) {
          validateFrozenDependencyGraph(
            workspaceRoot,
            opts.offlineDependencyPolicy as OfflineDependencyPolicy,
            operation,
          );
          materializeApprovedSources(workspaceRoot, approvedSourceSnapshots, operation);
        }
        const packageScratch = offline.packageInstall ? persistentRoots : [];
        for (const root of packageScratch) {
          operation.checkpoint();
          mkdirSync(join(workspaceRoot, root), { recursive: true });
        }
        phase('spawn');
        const result: CommandResult = await opts.commandRunner.run({
          command: action.cmd,
          workspaceRoot,
          cwd:
            action.cwd === undefined
              ? workspaceRoot
              : contained(workspaceRoot, action.cwd),
          writableRoots:
            context.classification === 'gate_check'
              ? ['.']
              : [...opts.policy.writeRoots(context.role), ...packageScratch],
          protectedRoots: offline.packageInstall
            ? ['test/golden']
            : [
                'test/golden',
                ...approvedSourceSnapshots.map((snapshot) => snapshot.definition.targetPath),
              ],
          // The approved installer needs unix-domain IPC and survives (rather
          // than dies on) EPERM from its read-only source staging probes; the
          // source roots stay write-denied and are re-verified byte-for-byte
          // against the approved snapshot before promotion.
          ...(offline.packageInstall
            ? {
                offlineInstall: {
                  gracefulDenyRoots: approvedSourceSnapshots.map(
                    (snapshot) => snapshot.definition.targetPath,
                  ),
                },
              }
            : {}),
          allowNetwork: false,
          timeoutMs: operation.remainingMs(action.timeoutMs ?? 120_000),
          signal: operation.signal,
        });
        operation.checkpoint();

        if (result.status === 'rejected') {
          if (result.reason === 'sandbox_violation') {
            if (result.observedViolation === undefined) {
              return {
                status: 'preflight_rejected',
                reason: 'sandbox_unavailable',
                detail:
                  'sandbox backend reported a violation without a backend-owned observation',
                evidenceRef: result.evidenceRef,
              };
            }
            const evidence = typedEvidence(
              result.evidenceRef,
              opts.commandRunner.environmentHash,
              {
                sandbox: opts.sandbox,
                artifactPolicy,
                offlineInstallProfile: offline.packageInstall,
                ...(opts.offlineDependencyPolicy === undefined
                  ? {}
                  : { offlineDependencyPolicy: opts.offlineDependencyPolicy }),
              },
            );
            return {
              status: 'sandbox_violation',
              exitCode: result.exitCode,
              signal: null,
              evidence: {
                ...evidence,
                observedViolation: result.observedViolation,
              },
            };
          }
          return {
            status: 'preflight_rejected',
            reason: result.reason,
            detail: result.detail,
            evidenceRef: result.evidenceRef,
          };
        }

        const evidence = typedEvidence(
          result.evidenceRef,
          opts.commandRunner.environmentHash,
          {
            sandbox: opts.sandbox,
            artifactPolicy,
            offlineInstallProfile: offline.packageInstall,
            ...(opts.offlineDependencyPolicy === undefined
              ? {}
              : { offlineDependencyPolicy: opts.offlineDependencyPolicy }),
          },
        );
        if (result.status === 'signaled') {
          if (context.classification === 'artifact_mutation') {
            return {
              status: 'command_failed',
              exitCode: null,
              signal: result.signal,
              evidence,
            };
          }
          return {
            status: 'signaled',
            exitCode: null,
            signal: result.signal,
            evidence,
          };
        }
        if (result.exitCode !== 0) {
          if (context.classification === 'artifact_mutation') {
            return {
              status: 'command_failed',
              exitCode: result.exitCode,
              signal: null,
              evidence,
            };
          }
          return {
            status: 'completed',
            exitCode: result.exitCode,
            signal: null,
            evidence,
          };
        }
        if (context.classification !== 'artifact_mutation') {
          return {
            status: 'completed',
            exitCode: 0,
            signal: null,
            evidence,
          };
        }

        if (offline.packageInstall) {
          await verifyInstalledApprovedSources(
            workspaceRoot,
            approvedSourceSnapshots,
            approvedSourceLimits,
          );
        }
        const provisionedSourceBudget = { files: 0, totalBytes: 0 };
        for (const snapshot of approvedSourceSnapshots) {
          const provisionedRoot = contained(workspaceRoot, snapshot.definition.targetPath);
          const capturedProvision = await captureApprovedSource(
            { ...snapshot.definition, sourcePath: provisionedRoot },
            approvedSourceLimits,
            provisionedSourceBudget,
          );
          if (capturedProvision.definition.contentHash !== snapshot.definition.contentHash) {
            return asCaptureRejection(
              opts.evidence,
              `provisioned offline source changed during install: ${snapshot.definition.packageName}`,
            );
          }
          makeMutable(provisionedRoot);
          rmSync(provisionedRoot, { recursive: true, force: true });
          operation.checkpoint();
        }

        phase('pre_inventory');
        const preCopy = await freezeWorkingTree(
          workspaceRoot,
          limits,
          tmpdir(),
          {
            includeIgnoredRoots: persistentRoots,
            beforeFileOpen(relativePath) {
              phase('capture_file_open', relativePath);
            },
            operation,
          },
        );
        ownedTrees.push(preCopy);
        captureRoot = join(attemptRoot, 'capture');
        mkdirSync(captureRoot, { mode: 0o700 });
        phase('copy');
        await preCopy.materialize(captureRoot, operation);
        phase('post_inventory');
        const postCopy = await freezeWorkingTree(
          workspaceRoot,
          limits,
          tmpdir(),
          { includeIgnoredRoots: persistentRoots, operation },
        );
        ownedTrees.push(postCopy);
        if (
          preCopy.treeHash !== postCopy.treeHash ||
          preCopy.inventoryHash !== postCopy.inventoryHash
        ) {
          return asCaptureRejection(opts.evidence, 'source inventory changed during capture');
        }
        phase('capture_inventory');
        const captured = await freezeWorkingTree(
          captureRoot,
          limits,
          tmpdir(),
          { includeIgnoredRoots: persistentRoots, operation },
        );
        ownedTrees.push(captured);
        if (
          captured.treeHash !== preCopy.treeHash ||
          captured.inventoryHash !== preCopy.inventoryHash
        ) {
          return asCaptureRejection(
            opts.evidence,
            'exclusive capture inventory differs from the pre-copy source inventory',
          );
        }
        makeImmutable(captureRoot, operation);
        let approvedDependencyOutputPaths: ReadonlySet<string> = new Set();
        if (offline.packageInstall) {
          approvedDependencyOutputPaths = verifyCapturedInstalledApprovedSources(
            captureRoot,
            captured.entries,
            approvedSourceSnapshots,
            opts.offlineDependencyPolicy as OfflineDependencyPolicy,
            operation,
          );
        }

        phase('diff');
        const changes = changedEntries(input.entries, captured.entries, operation);
        let diffBytes = 0;
        for (const change of changes) {
          operation.checkpoint();
          diffBytes += Buffer.byteLength(change.path) + (change.after?.bytes ?? 0);
          if (diffBytes > artifactPolicy.maxDiffBytes) {
            return asCaptureRejection(
              opts.evidence,
              `captured diff exceeds maxDiffBytes=${artifactPolicy.maxDiffBytes}`,
            );
          }
          if (
            change.before?.mode === '120000' ||
            change.before?.mode === '160000' ||
            change.after?.mode === '120000' ||
            change.after?.mode === '160000'
          ) {
            return asCaptureRejection(
              opts.evidence,
              `unsupported changed artifact shape: ${change.path}`,
            );
          }
          const dependencyOutputAllowed =
            offline.packageInstall &&
            approvedDependencyOutputPaths.has(change.path);
          const decision = opts.policy.checkWrite(context.role, change.path);
          if (!decision.allowed && !dependencyOutputAllowed) {
            return asCaptureRejection(
              opts.evidence,
              `${decision.reason}: ${change.path}`,
            );
          }
        }

        const diffBody = JSON.stringify(
          changes.map(({ path, before, after }) => ({
            path,
            before: before === undefined ? null : { mode: before.mode, sha256: before.sha256 },
            after: after === undefined ? null : { mode: after.mode, sha256: after.sha256 },
          })),
        );
        const diffHash = sha256(diffBody);
        phase('evidence');
        const diffRef = opts.evidence.put(diffBody);
        operation.checkpoint();
        const capture: CapturedCommandArtifact = {
          exitCode: 0,
          inputTreeHash: input.treeHash,
          outputTreeHash: captured.treeHash,
          preCopyInventoryHash: preCopy.inventoryHash,
          postCopyInventoryHash: postCopy.inventoryHash,
          captureInventoryHash: captured.inventoryHash,
          diffRef,
          diffHash,
          affectedPaths: changes.map((change) => change.path),
        };
        if (changes.length === 0) return { status: 'no_changes', capture, evidence };

        const authoritative = await freezeWorkingTree(
          context.worktreeDir,
          limits,
          tmpdir(),
          { includeIgnoredRoots: persistentRoots, operation },
        );
        ownedTrees.push(authoritative);
        if (
          authoritative.treeHash !== input.treeHash ||
          authoritative.inventoryHash !== input.inventoryHash
        ) {
          return asCaptureRejection(
            opts.evidence,
            'authoritative input changed before promotion',
          );
        }
        await promote(
          context.worktreeDir,
          captureRoot,
          changes,
          [
            ...opts.policy.writeRoots(context.role),
            ...(offline.packageInstall ? persistentRoots : []),
          ],
          opts.failpoints,
          { workspaceRoot, captureRoot },
          operation,
        );
        return {
          status: 'promoted',
          capture,
          promotedDiffHash: diffHash,
          evidence,
        };
      } catch (error) {
        return asCaptureRejection(opts.evidence, error);
      } finally {
        for (const tree of ownedTrees.reverse()) {
          try {
            tree.cleanup();
          } catch {
            // The exclusive attempt root is still removed below.
          }
        }
        try {
          if (workspaceRoot !== '') {
            opts.failpoints?.at?.('cleanup', {
              workspaceRoot,
              ...(captureRoot === undefined ? {} : { captureRoot }),
            });
          }
        } catch {
          // Cleanup failpoints cannot bypass the unconditional core-owned removal.
        } finally {
          if (attemptRoot !== '') {
            makeMutable(attemptRoot);
            rmSync(attemptRoot, { recursive: true, force: true });
          }
          ownedOperation?.dispose();
        }
      }
    },
  };
}
