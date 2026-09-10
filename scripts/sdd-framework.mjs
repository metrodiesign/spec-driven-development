#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_PATH = '.ai/distribution/framework-manifest.json';
const LOCK_PATH = '.ai/sdd-framework.lock.json';
const TX_PREFIX = '.sdd-framework-tx-';
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MODES = new Set(['100644', '100755']);
const COMMANDS = new Set(['install', 'adopt', 'update', 'status', 'check', 'validate']);
const RESERVED_NAMESPACES = [
  ...[
    '.ai/shared/project_context.md',
    '.ai/shared/architecture.md',
    '.ai/shared/coding_standards.md',
    '.ai/shared/lessons.md',
    '.ai/shared/lessons-coverage.md',
    '.claude/settings.json',
    '.codex/config.toml',
    '.pi/settings.json',
    'agents.md',
    'claude.md',
    'opencode.json',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'cargo.toml',
    'cargo.lock',
    'pyproject.toml',
    'poetry.lock',
    'go.mod',
    'go.sum',
    'composer.json',
    'composer.lock',
    'gemfile',
    'gemfile.lock',
    'pipfile',
    'pipfile.lock',
    'requirements.txt',
    'pom.xml',
    'build.gradle',
    'gradle.lockfile',
    'deno.json',
    'deno.lock',
    '.opencode/config.json',
    '.git',
    '.github',
    '.ai/specs',
    '.ai/goals',
    '.ai/governance',
    '.ai/calibration',
    '.ai/runs',
    '.ai/platform',
    '.ai/private',
    '.ai/product',
    '.ai/schemas',
    LOCK_PATH,
  ].map((path) => ({ path, prefix: false })),
  { path: '.claude/settings.', prefix: true },
  { path: '.codex/config.', prefix: true },
  { path: TX_PREFIX, prefix: true },
];

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(code, message) {
  throw new CliError(code, message);
}

function strictKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(2, `${label}: expected object`);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    fail(2, `${label}: expected keys ${expected.join(', ')}, got ${actual.join(', ')}`);
  }
}

function validateRelativePath(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail(2, `${label}: path must be relative`);
  }
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('\\') || value.includes('//') || /[*?\[\]]/.test(value)) {
    fail(2, `${label}: path must be printable ASCII POSIX syntax`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(2, `${label}: invalid path segment`);
  return value;
}

function pathOverlapsNamespace(value, namespace) {
  const path = value.toLowerCase();
  const reserved = namespace.path.toLowerCase();
  return path === reserved
    || path.startsWith(namespace.prefix ? reserved : `${reserved}/`)
    || reserved.startsWith(`${path}/`);
}

function isReservedConsumerPath(value) {
  return RESERVED_NAMESPACES.some((namespace) => pathOverlapsNamespace(value, namespace));
}

function validateManagedPath(value, label) {
  validateRelativePath(value, label);
  if (isReservedConsumerPath(value)) {
    fail(2, `${label}: reserved consumer-owned path ${value}`);
  }
}

function validateManagedTargetSet(targets, label) {
  const allTargets = [LOCK_PATH, ...targets];
  const exactTargets = new Set();
  const foldedTargets = new Map();
  const foldedDirectories = new Map();
  for (const target of allTargets) {
    if (exactTargets.has(target)) fail(2, `${label}: duplicate target ${target}`);
    const foldedTarget = target.toLowerCase();
    if (foldedTargets.has(foldedTarget)) fail(2, `${label}: case duplicate target ${target}`);
    exactTargets.add(target);
    foldedTargets.set(foldedTarget, target);

    const parts = target.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      const foldedDirectory = directory.toLowerCase();
      const existing = foldedDirectories.get(foldedDirectory);
      if (existing && existing !== directory) fail(2, `${label}: inconsistent directory casing ${existing} and ${directory}`);
      foldedDirectories.set(foldedDirectory, directory);
    }
  }
  for (const target of allTargets) {
    const parts = target.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const foldedDirectory = parts.slice(0, index).join('/').toLowerCase();
      const parent = foldedTargets.get(foldedDirectory);
      if (parent) fail(2, `${label}: target overlap ${parent} and ${target}`);
    }
  }
}

function parseJson(bytes, label, code = 2) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(code, `${label}: invalid JSON (${error.message})`);
  }
}

function git(cwd, args, encoding = 'utf8') {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8').trim() : String(error.stderr || '').trim();
    fail(2, `git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

function exactGitRoot(input, label, rejectSymlink = false) {
  const absolute = resolve(input);
  let requested;
  try {
    if (rejectSymlink && lstatSync(absolute).isSymbolicLink()) fail(2, `${label}: root must not be a symlink`);
    requested = realpathSync(absolute);
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail(2, `${label}: cannot resolve ${absolute}`);
  }
  const top = git(requested, ['rev-parse', '--show-toplevel']).trim();
  const root = realpathSync(top);
  if (requested !== root) fail(2, `${label}: must be the exact Git root (${root})`);
  return root;
}

function validateManifest(manifest) {
  strictKeys(manifest, ['schema', 'version', 'files', 'references'], 'manifest');
  if (manifest.schema !== 1) fail(2, 'manifest.schema: expected 1');
  if (typeof manifest.version !== 'string' || !manifest.version) fail(2, 'manifest.version: expected non-empty string');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail(2, 'manifest.files: expected non-empty array');
  if (!Array.isArray(manifest.references)) fail(2, 'manifest.references: expected array');

  const targets = new Set();
  let previous = '';
  for (const [index, entry] of manifest.files.entries()) {
    strictKeys(entry, ['source', 'target', 'mode'], `manifest.files[${index}]`);
    validateManagedPath(entry.source, `manifest.files[${index}].source`);
    validateManagedPath(entry.target, `manifest.files[${index}].target`);
    if (!MODES.has(entry.mode)) fail(2, `manifest.files[${index}].mode: unsupported ${entry.mode}`);
    if (previous && Buffer.compare(Buffer.from(previous), Buffer.from(entry.target)) > 0) {
      fail(2, 'manifest.files: targets must be bytewise sorted');
    }
    previous = entry.target;
    if (targets.has(entry.target)) fail(2, `manifest.files: duplicate target ${entry.target}`);
    targets.add(entry.target);
  }
  validateManagedTargetSet(manifest.files.map((entry) => entry.target), 'manifest.files');

  const referencePaths = new Set();
  for (const [index, entry] of manifest.references.entries()) {
    strictKeys(entry, ['path', 'kind'], `manifest.references[${index}]`);
    validateRelativePath(entry.path, `manifest.references[${index}].path`);
    if (!['managed', 'consumer-owned', 'optional'].includes(entry.kind)) {
      fail(2, `manifest.references[${index}].kind: unsupported ${entry.kind}`);
    }
    if (referencePaths.has(entry.path)) fail(2, `manifest.references: duplicate path ${entry.path}`);
    referencePaths.add(entry.path);
    if (entry.kind === 'managed' && !targets.has(entry.path)) {
      fail(2, `manifest.references: required managed path missing from payload: ${entry.path}`);
    }
  }
  return manifest;
}

function loadSnapshot(sourceArg, ref) {
  if (!ref || ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref)) fail(2, '--ref: invalid Git revision');
  const sourceRoot = exactGitRoot(sourceArg, '--source');
  const revision = git(sourceRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(revision)) fail(2, '--ref: did not resolve to a full commit OID');
  const manifestBytes = git(sourceRoot, ['show', `${revision}:${MANIFEST_PATH}`], null);
  const manifest = validateManifest(parseJson(manifestBytes, MANIFEST_PATH));
  const files = [];

  for (const entry of manifest.files) {
    const tree = git(sourceRoot, ['ls-tree', '-z', revision, '--', entry.source], null);
    const records = tree.toString('utf8').split('\0').filter(Boolean);
    if (records.length !== 1) fail(2, `${entry.source}: source path missing at ${revision}`);
    const match = /^(\d{6}) ([^ ]+) ([0-9a-f]+)\t(.+)$/.exec(records[0]);
    if (!match || match[2] !== 'blob' || match[4] !== entry.source) fail(2, `${entry.source}: source must be one regular Git blob`);
    if (!MODES.has(match[1]) || match[1] !== entry.mode) {
      fail(2, `${entry.source}: expected mode ${entry.mode}, got ${match?.[1] || 'invalid'}`);
    }
    const bytes = git(sourceRoot, ['cat-file', 'blob', `${revision}:${entry.source}`], null);
    files.push({ ...entry, bytes, sha256: `sha256:${sha256(bytes)}` });
  }

  const manifestSha256 = `sha256:${sha256(manifestBytes)}`;
  const contentIdentity = identity(manifestSha256, files);
  return { sourceRoot, revision, manifest, manifestBytes, manifestSha256, contentIdentity, files };
}

function identity(manifestSha256, files) {
  const hash = createHash('sha256');
  hash.update('sdd-framework-content-v1\0');
  hash.update(`${manifestSha256}\n`);
  for (const file of [...files].sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)))) {
    hash.update(`${file.target}\0${file.mode}\0${file.sha256}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

function desiredLock(snapshot) {
  return {
    schema: 1,
    sourceRevision: snapshot.revision,
    version: snapshot.manifest.version,
    manifestSha256: snapshot.manifestSha256,
    contentIdentity: snapshot.contentIdentity,
    files: snapshot.files.map(({ target, mode, sha256: hash }) => ({ target, mode, sha256: hash })),
  };
}

function lockBytes(lock) {
  return Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
}

function validateLock(lock, code = 3) {
  const originalFail = fail;
  try {
    strictKeys(lock, ['schema', 'sourceRevision', 'version', 'manifestSha256', 'contentIdentity', 'files'], 'lock');
    if (lock.schema !== 1) originalFail(2, 'lock.schema: expected 1');
    if (!/^[0-9a-f]{40,64}$/.test(lock.sourceRevision || '')) originalFail(2, 'lock.sourceRevision: invalid commit OID');
    if (typeof lock.version !== 'string' || !lock.version) originalFail(2, 'lock.version: expected non-empty string');
    if (!HASH_RE.test(lock.manifestSha256 || '') || !HASH_RE.test(lock.contentIdentity || '')) originalFail(2, 'lock: invalid hash');
    if (!Array.isArray(lock.files) || lock.files.length === 0) originalFail(2, 'lock.files: expected non-empty array');
    let previous = '';
    for (const [index, entry] of lock.files.entries()) {
      strictKeys(entry, ['target', 'mode', 'sha256'], `lock.files[${index}]`);
      validateManagedPath(entry.target, `lock.files[${index}].target`);
      if (!MODES.has(entry.mode) || !HASH_RE.test(entry.sha256 || '')) originalFail(2, `lock.files[${index}]: invalid mode or hash`);
      if (previous && Buffer.compare(Buffer.from(previous), Buffer.from(entry.target)) > 0) originalFail(2, 'lock.files: targets must be sorted');
      previous = entry.target;
    }
    validateManagedTargetSet(lock.files.map((file) => file.target), 'lock.files');
    if (identity(lock.manifestSha256, lock.files) !== lock.contentIdentity) originalFail(2, 'lock.contentIdentity: self-consistency check failed');
    return lock;
  } catch (error) {
    if (error instanceof CliError) throw new CliError(code, error.message.replace(/^lock[^:]*: /, 'lock: '));
    throw error;
  }
}

function readLock(root, code = 3) {
  const path = join(root, LOCK_PATH);
  inspectCaseAndTypes(root, LOCK_PATH, code);
  let type;
  try {
    type = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(code, `${LOCK_PATH}: cannot inspect (${error.message})`);
  }
  if (!type.isFile() || type.isSymbolicLink()) fail(code, `${LOCK_PATH}: must be a regular file`);
  return validateLock(parseJson(readFileSync(path), LOCK_PATH, code), code);
}

function targetPath(root, relativePath) {
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${sep}`)) fail(2, `${relativePath}: resolves outside target root`);
  return absolute;
}

function inspectCaseAndTypes(root, relativePath, code = 3) {
  let current = root;
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const expected = parts[index];
    let names;
    try {
      names = readdirSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      fail(code, `${relativePath}: cannot inspect parent ${relative(root, current) || '.'}`);
    }
    const caseMatch = names.find((name) => name.toLowerCase() === expected.toLowerCase());
    if (!caseMatch) return;
    if (caseMatch !== expected) fail(code, `${relativePath}: case collision at ${caseMatch}`);
    current = join(current, expected);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail(code, `${relativePath}: symlink segment ${parts.slice(0, index + 1).join('/')}`);
    if (index < parts.length - 1 && !stat.isDirectory()) fail(code, `${relativePath}: non-directory parent ${parts.slice(0, index + 1).join('/')}`);
    if (index === parts.length - 1 && !stat.isFile()) fail(code, `${relativePath}: leaf must be a regular file`);
  }
}

function fileMode(stat) {
  return stat.mode & 0o111 ? '100755' : '100644';
}

function observe(root, relativePath, code = 3) {
  inspectCaseAndTypes(root, relativePath, code);
  const absolute = targetPath(root, relativePath);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(code, `${relativePath}: must be a regular file`);
    const bytes = readFileSync(absolute);
    return { exists: true, mode: fileMode(stat), sha256: `sha256:${sha256(bytes)}` };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    if (error instanceof CliError) throw error;
    fail(code, `${relativePath}: cannot inspect (${error.message})`);
  }
}

function sameObservation(a, b) {
  return a.exists === b.exists && (!a.exists || (a.mode === b.mode && a.sha256 === b.sha256));
}

function inspectLocal(root, lock, code = 1) {
  const drift = [];
  for (const file of lock.files) {
    let actual;
    try {
      actual = observe(root, file.target, code);
    } catch (error) {
      drift.push(`${file.target}: ${error.message}`);
      continue;
    }
    if (!actual.exists) drift.push(`${file.target}: missing`);
    else if (actual.mode !== file.mode) drift.push(`${file.target}: mode ${actual.mode}, expected ${file.mode}`);
    else if (actual.sha256 !== file.sha256) drift.push(`${file.target}: hash ${actual.sha256}, expected ${file.sha256}`);
  }
  return drift;
}

function lockMatches(lock, desired) {
  return lockBytes(lock).equals(lockBytes(desired));
}

function authenticateLock(snapshot, lock, code) {
  let trustedSnapshot;
  try {
    trustedSnapshot = snapshot.revision === lock.sourceRevision
      ? snapshot
      : loadSnapshot(snapshot.sourceRoot, lock.sourceRevision);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(code, `lock: cannot load trusted source revision ${lock.sourceRevision} (${error.message})`);
    }
    throw error;
  }
  if (!lockMatches(lock, desiredLock(trustedSnapshot))) {
    fail(code, `lock: lock does not match trusted source revision ${lock.sourceRevision}`);
  }
}

function verifyOfflineTargetSet(root, lock) {
  inspectCaseAndTypes(root, MANIFEST_PATH, 1);
  let bytes;
  try {
    const stat = lstatSync(join(root, MANIFEST_PATH));
    if (!stat.isFile() || stat.isSymbolicLink()) fail(1, `${MANIFEST_PATH}: must be a regular file`);
    bytes = readFileSync(join(root, MANIFEST_PATH));
  } catch (error) {
    if (error.code === 'ENOENT') fail(1, `${MANIFEST_PATH}: missing; offline lock target set cannot be checked`);
    if (error instanceof CliError) throw error;
    fail(1, `${MANIFEST_PATH}: cannot inspect (${error.message})`);
  }

  let manifest;
  try {
    manifest = validateManifest(parseJson(bytes, MANIFEST_PATH));
  } catch (error) {
    if (error instanceof CliError) throw new CliError(1, `${MANIFEST_PATH}: invalid installed manifest (${error.message})`);
    throw error;
  }
  const manifestTargets = manifest.files.map((file) => file.target);
  const lockTargets = lock.files.map((file) => file.target);
  if (JSON.stringify(manifestTargets) !== JSON.stringify(lockTargets)) {
    fail(1, `${MANIFEST_PATH}: manifest target set differs from lock`);
  }
}

function ensureNoTransaction(root) {
  const stale = readdirSync(root).filter((name) => name.startsWith(TX_PREFIX));
  if (stale.length) fail(3, `target: unfinished transaction ${stale.join(', ')}`);
}

function preflightTarget(targetArg) {
  const root = exactGitRoot(targetArg, '--target', true);
  inspectCaseAndTypes(root, LOCK_PATH, 3);
  ensureNoTransaction(root);
  return root;
}

function status(targetArg) {
  const root = exactGitRoot(targetArg, '--target', true);
  let lock;
  try {
    lock = readLock(root, 1);
  } catch (error) {
    if (error instanceof CliError) {
      console.log(`status: drift\n${error.message}`);
      return 1;
    }
    throw error;
  }
  if (!lock) {
    console.log('status: not-installed');
    return 1;
  }
  try {
    verifyOfflineTargetSet(root, lock);
  } catch (error) {
    if (error instanceof CliError) {
      console.log(`status: drift\n${error.message}`);
      return 1;
    }
    throw error;
  }
  const drift = inspectLocal(root, lock, 1);
  console.log(`status: ${drift.length ? 'drift' : 'clean'}`);
  console.log(`revision: ${lock.sourceRevision}`);
  console.log(`identity: ${lock.contentIdentity}`);
  if (drift.length) console.log(drift.join('\n'));
  return drift.length ? 1 : 0;
}

function check(snapshot, targetArg) {
  const root = exactGitRoot(targetArg, '--target', true);
  let lock;
  try {
    lock = readLock(root, 1);
  } catch (error) {
    console.log(`check: mismatch\n${error.message}`);
    return 1;
  }
  if (!lock) {
    console.log('check: not-installed');
    return 1;
  }
  try {
    authenticateLock(snapshot, lock, 1);
  } catch (error) {
    if (error instanceof CliError) {
      console.log(`check: mismatch\n${error.message}`);
      return 1;
    }
    throw error;
  }
  const desired = desiredLock(snapshot);
  const drift = inspectLocal(root, lock, 1);
  const mismatches = [];
  if (lock.sourceRevision !== desired.sourceRevision) mismatches.push(`revision: ${lock.sourceRevision}, desired ${desired.sourceRevision}`);
  if (lock.contentIdentity !== desired.contentIdentity) mismatches.push(`identity: ${lock.contentIdentity}, desired ${desired.contentIdentity}`);
  if (lock.version !== desired.version || lock.manifestSha256 !== desired.manifestSha256
      || JSON.stringify(lock.files) !== JSON.stringify(desired.files)) {
    mismatches.push('lock payload metadata differs from desired snapshot');
  }
  if (drift.length || mismatches.length) {
    console.log('check: mismatch');
    console.log([...drift, ...mismatches].join('\n'));
    return 1;
  }
  console.log(`check: clean\nrevision: ${lock.sourceRevision}\nidentity: ${lock.contentIdentity}`);
  return 0;
}

function mkdirTracked(root, directory, created) {
  const missing = [];
  let current = directory;
  while (current !== root && !existsSync(current)) {
    missing.push(current);
    current = dirname(current);
  }
  if (current !== root) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(3, `${relative(root, current)}: invalid parent`);
  }
  for (const path of missing.reverse()) {
    mkdirSync(path);
    created.push(path);
  }
}

function stageFile(path, bytes, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', mode === '100755' ? 0o755 : 0o644);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode === '100755' ? 0o755 : 0o644);
}

function rollback(root, tx, journal, createdDirectories) {
  if (process.env.SDD_FRAMEWORK_TEST_FAIL_ROLLBACK === '1') throw new Error('injected rollback failure');
  for (const entry of [...journal].reverse()) {
    if (entry.installed && existsSync(entry.destination)) rmSync(entry.destination);
    if (entry.backup && existsSync(entry.backup)) renameSync(entry.backup, entry.destination);
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
    }
  }
  rmSync(tx, { recursive: true, force: true });
}

function commitTransaction(root, desired, operations, observations, oldLockExists) {
  const tx = mkdtempSync(join(root, TX_PREFIX));
  const stagedRoot = join(tx, 'staged');
  const backupRoot = join(tx, 'backup');
  const createdDirectories = [];
  const journal = [];
  let committed = 0;

  try {
    for (const operation of operations) {
      if (operation.kind !== 'remove') stageFile(join(stagedRoot, operation.target), operation.file.bytes, operation.file.mode);
    }
    stageFile(join(stagedRoot, LOCK_PATH), lockBytes(desired), '100644');

    for (const operation of operations) {
      const destination = targetPath(root, operation.target);
      const current = observe(root, operation.target, 3);
      if (!sameObservation(current, observations.get(operation.target))) fail(3, `${operation.target}: changed after preflight`);
      const record = { destination, backup: null, installed: false };
      journal.push(record);
      if (operation.kind !== 'add') {
        record.backup = join(backupRoot, operation.target);
        mkdirSync(dirname(record.backup), { recursive: true });
        renameSync(destination, record.backup);
      }
      if (operation.kind !== 'remove') {
        mkdirTracked(root, dirname(destination), createdDirectories);
        renameSync(join(stagedRoot, operation.target), destination);
        record.installed = true;
      }
      committed += 1;
      if (Number(process.env.SDD_FRAMEWORK_TEST_FAIL_AFTER || 0) === committed) throw new Error(`injected write failure after operation ${committed}`);
    }

    const lockDestination = targetPath(root, LOCK_PATH);
    const currentLock = observe(root, LOCK_PATH, 3);
    if (!sameObservation(currentLock, observations.get(LOCK_PATH))) fail(3, `${LOCK_PATH}: changed after preflight`);
    const lockRecord = { destination: lockDestination, backup: null, installed: false };
    journal.push(lockRecord);
    if (oldLockExists) {
      lockRecord.backup = join(backupRoot, LOCK_PATH);
      mkdirSync(dirname(lockRecord.backup), { recursive: true });
      renameSync(lockDestination, lockRecord.backup);
    }
    mkdirTracked(root, dirname(lockDestination), createdDirectories);
    renameSync(join(stagedRoot, LOCK_PATH), lockDestination);
    lockRecord.installed = true;
    rmSync(tx, { recursive: true, force: true });
  } catch (error) {
    try {
      rollback(root, tx, journal, createdDirectories);
    } catch (rollbackError) {
      throw new CliError(5, `transaction failed (${error.message}); rollback failed (${rollbackError.message}); recovery: ${tx}`);
    }
    throw new CliError(error instanceof CliError && error.code === 3 ? 3 : 4, `transaction failed and rolled back: ${error.message}`);
  }
}

function mutate(command, snapshot, targetArg) {
  const root = preflightTarget(targetArg);
  const desired = desiredLock(snapshot);
  const existingLock = readLock(root, 3);
  if (existingLock && command !== 'adopt') authenticateLock(snapshot, existingLock, 3);
  const desiredByTarget = new Map(snapshot.files.map((file) => [file.target, file]));
  const observations = new Map();

  for (const file of snapshot.files) observations.set(file.target, observe(root, file.target, 3));
  observations.set(LOCK_PATH, observe(root, LOCK_PATH, 3));

  if (command === 'install') {
    if (existingLock) {
      const drift = inspectLocal(root, existingLock, 3);
      if (!drift.length && lockMatches(existingLock, desired)) {
        console.log(`install: no-op\nrevision: ${desired.sourceRevision}\nidentity: ${desired.contentIdentity}`);
        return;
      }
      fail(3, `install: target already managed${drift.length ? ` with drift (${drift.join('; ')})` : ' by another snapshot'}`);
    }
    const collisions = snapshot.files.filter((file) => observations.get(file.target).exists).map((file) => file.target);
    if (collisions.length) fail(3, `install: existing paths ${collisions.join(', ')}`);
    const operations = snapshot.files.map((file) => ({ kind: 'add', target: file.target, file }));
    commitTransaction(root, desired, operations, observations, false);
  } else if (command === 'adopt') {
    if (existingLock) fail(3, 'adopt: target already has a lock');
    const mismatches = [];
    for (const file of snapshot.files) {
      const actual = observations.get(file.target);
      if (!actual.exists) mismatches.push(`${file.target}: missing`);
      else if (actual.mode !== file.mode || actual.sha256 !== file.sha256) mismatches.push(`${file.target}: bytes or mode differ`);
    }
    if (mismatches.length) fail(3, `adopt: ${mismatches.join('; ')}`);
    commitTransaction(root, desired, [], observations, false);
  } else {
    if (!existingLock) fail(3, 'update: target is not installed');
    const drift = inspectLocal(root, existingLock, 3);
    if (drift.length) fail(3, `update: local drift (${drift.join('; ')})`);
    if (lockMatches(existingLock, desired)) {
      console.log(`update: no-op\nrevision: ${desired.sourceRevision}\nidentity: ${desired.contentIdentity}`);
      return;
    }
    const oldByTarget = new Map(existingLock.files.map((file) => [file.target, file]));
    const operations = [];
    for (const file of snapshot.files) {
      const old = oldByTarget.get(file.target);
      if (!old) {
        if (observations.get(file.target).exists) fail(3, `update: new managed path collides with local file ${file.target}`);
        operations.push({ kind: 'add', target: file.target, file });
      } else if (old.mode !== file.mode || old.sha256 !== file.sha256) {
        operations.push({ kind: 'replace', target: file.target, file });
      }
    }
    for (const old of existingLock.files) {
      if (!desiredByTarget.has(old.target)) {
        observations.set(old.target, observe(root, old.target, 3));
        operations.push({ kind: 'remove', target: old.target });
      }
    }
    operations.sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)));
    commitTransaction(root, desired, operations, observations, true);
  }
  console.log(`${command}: complete\nrevision: ${desired.sourceRevision}\nidentity: ${desired.contentIdentity}`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) fail(2, 'usage: sdd-framework.mjs <install|adopt|update|status|check|validate> [--source PATH --ref REF] --target PATH');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!['--source', '--ref', '--target'].includes(name) || value === undefined || name.slice(2) in options) fail(2, `usage: invalid option ${name || ''}`);
    options[name.slice(2)] = value;
  }
  if (command === 'status') {
    if (!options.target || options.source || options.ref) fail(2, 'status requires only --target');
  } else if (command === 'validate') {
    if (!options.source || !options.ref || options.target) fail(2, 'validate requires --source and --ref');
  } else if (!options.source || !options.ref || !options.target) {
    fail(2, `${command} requires --source, --ref and --target`);
  }
  return { command, options };
}

export function run(argv) {
  const { command, options } = parseArgs(argv);
  if (command === 'status') return status(options.target);
  const snapshot = loadSnapshot(options.source, options.ref);
  if (command === 'validate') {
    console.log(`validate: valid\nrevision: ${snapshot.revision}\nidentity: ${snapshot.contentIdentity}`);
    return 0;
  }
  if (command === 'check') return check(snapshot, options.target);
  mutate(command, snapshot, options.target);
  return 0;
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.code;
    } else {
      console.error(error.stack || error.message);
      process.exitCode = 2;
    }
  }
}
