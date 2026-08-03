import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

import {
  FrozenTreeOperationError,
  type FrozenTreeOperationControl,
} from '../gates/frozen-tree.ts';
import { runCoreTool } from '../security/command-runner.ts';

export type MutationExpected =
  | { kind: 'absent' }
  | { kind: 'regular'; sha256: string; mode: '100644' | '100755' }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory' }
  | { kind: 'regular_or_absent' }
  | { kind: 'any_artifact' };

export type MutationDesired =
  | {
      kind: 'regular';
      content: Uint8Array;
      mode: '100644' | '100755';
    }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory' }
  | { kind: 'absent' };

export interface MutationPathOperation {
  path: string;
  expected: MutationExpected;
  desired: MutationDesired;
}

export interface MutationBoundaryOptions {
  worktreeDir: string;
  operations: readonly MutationPathOperation[];
  allowedRoots: readonly string[];
  allowSymlinkArtifacts?: boolean;
  operation?: FrozenTreeOperationControl;
  /** Internal deterministic fault seam; production callers must omit it. */
  testOnly?: {
    failPostCommitCleanup?: boolean;
    pauseAfterCaptureMs?: number;
  };
}

export type MutationCleanupOutcome =
  | { status: 'complete' }
  | {
      status: 'residue';
      quarantinePath: string;
      entries: readonly string[];
      detail: string;
    };

export interface MutationBatchOutcome {
  status: 'committed';
  cleanup: MutationCleanupOutcome;
}

export class MutationPathError extends Error {
  readonly cleanup?: MutationCleanupOutcome;

  constructor(message: string, cleanup?: MutationCleanupOutcome) {
    super(message);
    this.name = 'MutationPathError';
    if (cleanup !== undefined) this.cleanup = cleanup;
  }
}

const PYTHON_BIN = '/usr/bin/python3';
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const HARD_DENIED_ROOTS = ['.git', '.ai/runs', 'test/golden'] as const;

const MUTATION_SCRIPT = String.raw`
import ctypes
import hashlib
import json
import os
import posixpath
import secrets
import stat
import sys
import time

root, stage_root, commit_arg = sys.argv[1], sys.argv[2], sys.argv[3]
commit = commit_arg == "commit"
manifest = json.load(sys.stdin)
nofollow = getattr(os, "O_NOFOLLOW", 0)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | nofollow
created_directories = []
plans = []
all_fds = []
libc = ctypes.CDLL(None, use_errno=True)

def fail(message):
    raise RuntimeError("descriptor-safe mutation rejected: " + message)

def safe_parts(path):
    parts = path.split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        fail("unsafe relative path: " + path)
    return parts

def inside(path, roots):
    return any(path == root or path.startswith(root + "/") for root in roots)

def lstat_at(parent_fd, name):
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None

def rename_noreplace(source_fd, source, destination_fd, destination):
    encoded_source = os.fsencode(source)
    encoded_destination = os.fsencode(destination)
    if hasattr(libc, "renameat2"):
        result = libc.renameat2(
            source_fd,
            ctypes.c_char_p(encoded_source),
            destination_fd,
            ctypes.c_char_p(encoded_destination),
            1,
        )
    elif hasattr(libc, "renameatx_np"):
        result = libc.renameatx_np(
            source_fd,
            ctypes.c_char_p(encoded_source),
            destination_fd,
            ctypes.c_char_p(encoded_destination),
            4,
        )
    else:
        fail("atomic no-replace rename is unavailable")
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), destination)

def digest_fd(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()

def inspect_final(parent_fd, name):
    current = lstat_at(parent_fd, name)
    if current is None:
        return {"kind": "absent"}
    if stat.S_ISLNK(current.st_mode):
        return {"kind": "symlink", "target": os.readlink(name, dir_fd=parent_fd)}
    if stat.S_ISDIR(current.st_mode):
        fd = os.open(name, directory_flags, dir_fd=parent_fd)
        all_fds.append(fd)
        return {"kind": "directory", "empty": len(os.listdir(fd)) == 0}
    if not stat.S_ISREG(current.st_mode):
        fail("final component is not a regular file: " + name)
    fd = os.open(name, os.O_RDONLY | nofollow, dir_fd=parent_fd)
    all_fds.append(fd)
    checked = os.fstat(fd)
    if not stat.S_ISREG(checked.st_mode):
        fail("final component changed shape: " + name)
    return {
        "kind": "regular",
        "sha256": digest_fd(fd),
        "mode": "100755" if checked.st_mode & 0o111 else "100644",
    }

def matches_expected(actual, expected):
    kind = expected["kind"]
    if kind == "any_artifact":
        return True
    if kind == "regular_or_absent":
        return actual["kind"] in ("regular", "absent")
    if actual["kind"] != kind:
        return False
    if kind == "regular":
        return (
            actual["sha256"] == expected["sha256"]
            and actual["mode"] == expected["mode"]
        )
    if kind == "symlink":
        return actual["target"] == expected["target"]
    return True

def walk_parent(root_fd, parts, create, planned_directories=None):
    current_fd = os.dup(root_fd)
    all_fds.append(current_fd)
    walked = []
    for component in parts[:-1]:
        walked.append(component)
        try:
            next_fd = os.open(component, directory_flags, dir_fd=current_fd)
        except FileNotFoundError:
            if not create:
                return None
            os.mkdir(component, 0o700, dir_fd=current_fd)
            created_directories.append((os.dup(current_fd), component))
            all_fds.append(created_directories[-1][0])
            next_fd = os.open(component, directory_flags, dir_fd=current_fd)
        except OSError as error:
            if (
                not create
                and planned_directories is not None
                and "/".join(walked) in planned_directories
            ):
                return None
            fail("symlink or non-directory parent rejected: " + "/".join(parts[:-1]) + ": " + str(error))
        all_fds.append(next_fd)
        current_fd = next_fd
    return current_fd

def revalidate_parent(root_fd, parts, expected_fd):
    current_fd = os.dup(root_fd)
    all_fds.append(current_fd)
    for component in parts[:-1]:
        try:
            next_fd = os.open(component, directory_flags, dir_fd=current_fd)
        except OSError as error:
            fail("parent changed before commit: " + "/".join(parts[:-1]) + ": " + str(error))
        all_fds.append(next_fd)
        current_fd = next_fd
    expected_stat = os.fstat(expected_fd)
    current_stat = os.fstat(current_fd)
    if (expected_stat.st_dev, expected_stat.st_ino) != (current_stat.st_dev, current_stat.st_ino):
        fail("parent directory was replaced before commit: " + "/".join(parts[:-1]))

def remove_name(parent_fd, name):
    current = lstat_at(parent_fd, name)
    if current is None:
        return
    if stat.S_ISDIR(current.st_mode) and not stat.S_ISLNK(current.st_mode):
        os.rmdir(name, dir_fd=parent_fd)
    else:
        os.unlink(name, dir_fd=parent_fd)

def desired_matches(actual, desired):
    kind = desired["kind"]
    if actual["kind"] != kind:
        return False
    if kind == "regular":
        return actual["sha256"] == desired["sha256"] and actual["mode"] == desired["mode"]
    if kind == "symlink":
        return actual["target"] == desired["target"]
    if kind == "directory":
        return actual["empty"]
    return True

def prepare_item(item, parent_fd):
    desired = item["desired"]
    if desired["kind"] == "absent":
        return None
    temporary = ".core-mutation-" + secrets.token_hex(16)
    if desired["kind"] == "regular":
        source_fd = os.open(item["stage"], os.O_RDONLY | nofollow, dir_fd=stage_fd)
        all_fds.append(source_fd)
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            fail("staged content is not regular: " + item["path"])
        if digest_fd(source_fd) != desired["sha256"]:
            fail("staged content changed: " + item["path"])
        target_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow,
            0o600,
            dir_fd=parent_fd,
        )
        all_fds.append(target_fd)
        temporary_stat = os.fstat(target_fd)
        temporaries.append(
            (parent_fd, temporary, temporary_stat.st_dev, temporary_stat.st_ino)
        )
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            offset = 0
            while offset < len(chunk):
                written = os.write(target_fd, chunk[offset:])
                if written <= 0:
                    fail("descriptor write made no progress: " + item["path"])
                offset += written
        os.fchmod(target_fd, 0o755 if desired["mode"] == "100755" else 0o644)
        os.fsync(target_fd)
    elif desired["kind"] == "symlink":
        os.symlink(desired["target"], temporary, dir_fd=parent_fd)
        temporary_stat = lstat_at(parent_fd, temporary)
        temporaries.append(
            (parent_fd, temporary, temporary_stat.st_dev, temporary_stat.st_ino)
        )
    elif desired["kind"] == "directory":
        os.mkdir(temporary, 0o700, dir_fd=parent_fd)
        temporary_stat = lstat_at(parent_fd, temporary)
        temporaries.append(
            (parent_fd, temporary, temporary_stat.st_dev, temporary_stat.st_ino)
        )
    return temporary

def capture_current(item, parent_fd, name):
    while True:
        current = lstat_at(parent_fd, name)
        if current is None:
            actual = {"kind": "absent"}
            if not matches_expected(actual, item["expected"]):
                fail("mutation precondition changed at operation: " + item["path"])
            return None
        backup = ".core-backup-" + secrets.token_hex(16)
        try:
            rename_noreplace(parent_fd, name, stage_fd, backup)
        except FileNotFoundError:
            continue
        backup_record = {
            "parentFd": parent_fd,
            "name": name,
            "backup": backup,
            "captured": None,
        }
        backups.append(backup_record)
        actual = inspect_final(stage_fd, backup)
        backup_record["captured"] = actual
        if actual["kind"] == "symlink" and not manifest["allowSymlinkArtifacts"]:
            fail("final symlink rejected: " + item["path"])
        if not matches_expected(actual, item["expected"]):
            fail("mutation precondition changed at operation: " + item["path"])
        if item["expected"]["kind"] == "directory" and not actual["empty"]:
            fail("directory changed or is not empty at operation: " + item["path"])
        return backup

def install_item(item, parts, parent_fd):
    name = parts[-1]
    desired = item["desired"]
    temporary = prepare_item(item, parent_fd)
    revalidate_parent(root_fd, parts, parent_fd)
    capture_current(item, parent_fd, name)
    pause_after_capture_ms = manifest.get("testPauseAfterCaptureMs", 0)
    if pause_after_capture_ms > 0:
        time.sleep(pause_after_capture_ms / 1000)
    if temporary is not None:
        temporary_entry = next(
            entry
            for entry in temporaries
            if entry[:2] == (parent_fd, temporary)
        )
        rename_noreplace(parent_fd, temporary, parent_fd, name)
        temporaries[:] = [entry for entry in temporaries if entry[:2] != (parent_fd, temporary)]
        installed.append(
            (parent_fd, name, temporary_entry[2], temporary_entry[3], desired)
        )
    actual = inspect_final(parent_fd, name)
    if not desired_matches(actual, desired):
        fail("installed object verification failed: " + item["path"])
    revalidate_parent(root_fd, parts, parent_fd)

root_fd = None
stage_fd = None
backups = []
installed = []
temporaries = []
try:
    root_fd = os.open(root, directory_flags)
    stage_fd = os.open(stage_root, directory_flags)
    all_fds.extend([root_fd, stage_fd])
    roots = manifest["allowedRoots"]
    denied = manifest["hardDeniedRoots"]
    planned_directories = {
        item["path"]
        for item in manifest["operations"]
        if item["desired"]["kind"] == "directory"
    }
    planned_deletions = {
        item["path"]
        for item in manifest["operations"]
        if item["desired"]["kind"] == "absent"
    }
    seen = set()

    for item in manifest["operations"]:
        path = item["path"]
        parts = safe_parts(path)
        if path in seen:
            fail("duplicate mutation path: " + path)
        seen.add(path)
        if inside(path, denied):
            fail("hard-denied mutation path: " + path)
        if not inside(path, roots):
            fail("mutation path outside allowed roots: " + path)
        desired = item["desired"]
        if desired["kind"] == "directory" and not manifest["allowSymlinkArtifacts"]:
            fail("directory artifact mutation is not authorized: " + path)
        if desired["kind"] == "symlink":
            if not manifest["allowSymlinkArtifacts"]:
                fail("symlink artifact mutation is not authorized: " + path)
            target = desired["target"]
            if posixpath.isabs(target):
                fail("absolute symlink target is unsafe: " + path)
            resolved_target = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            if resolved_target == ".." or resolved_target.startswith("../"):
                fail("symlink target escapes worktree: " + path)

        parent_fd = walk_parent(root_fd, parts, False, planned_directories)
        if parent_fd is None:
            actual = {"kind": "absent"}
        else:
            actual = inspect_final(parent_fd, parts[-1])
        if actual["kind"] == "symlink" and not manifest["allowSymlinkArtifacts"]:
            fail("final symlink rejected: " + path)
        if not matches_expected(actual, item["expected"]):
            fail("mutation precondition changed: " + path)

    if not commit:
        sys.stdout.write('{"ok":true}')
        raise SystemExit(0)

    ordered = sorted(
        manifest["operations"],
        key=lambda item: (
            (
                0
                if item["desired"]["kind"] == "directory"
                else 2 if item["desired"]["kind"] == "absent" else 1
            ),
            (
                -len(item["path"].split("/"))
                if item["desired"]["kind"] == "absent"
                else len(item["path"].split("/"))
            ),
            item["path"],
        ),
    )
    if planned_directories:
        for item in ordered:
            parts = safe_parts(item["path"])
            parent_fd = walk_parent(root_fd, parts, True)
            if parent_fd is None:
                fail("failed to create mutation parent: " + item["path"])
            actual = inspect_final(parent_fd, parts[-1])
            if not matches_expected(actual, item["expected"]):
                fail("mutation precondition changed at commit: " + item["path"])
            revalidate_parent(root_fd, parts, parent_fd)
            plans.append((item, parts, parent_fd))
            install_item(item, parts, parent_fd)
    else:
        for item in ordered:
            parts = safe_parts(item["path"])
            parent_fd = walk_parent(root_fd, parts, True)
            if parent_fd is None:
                fail("failed to create mutation parent: " + item["path"])
            actual = inspect_final(parent_fd, parts[-1])
            if actual["kind"] == "symlink" and not manifest["allowSymlinkArtifacts"]:
                fail("final symlink rejected: " + item["path"])
            if not matches_expected(actual, item["expected"]):
                fail("mutation precondition changed at commit: " + item["path"])
            plans.append((item, parts, parent_fd))
        for item, parts, parent_fd in plans:
            revalidate_parent(root_fd, parts, parent_fd)
        for item, parts, parent_fd in plans:
            install_item(item, parts, parent_fd)

    for item, parts, parent_fd in plans:
        parent_path = "/".join(parts[:-1])
        if any(
            parent_path == deleted or parent_path.startswith(deleted + "/")
            for deleted in planned_deletions
        ):
            continue
        revalidate_parent(root_fd, parts, parent_fd)

    sys.stdout.write('{"ok":true,"committed":true}')
except BaseException as error:
    if isinstance(error, SystemExit):
        raise
    rollback_errors = []
    for parent_fd, name, expected_dev, expected_ino, desired in reversed(installed):
        try:
            current = lstat_at(parent_fd, name)
            if current is None:
                continue
            actual = inspect_final(parent_fd, name)
            if (
                (current.st_dev, current.st_ino) != (expected_dev, expected_ino)
                or not desired_matches(actual, desired)
            ):
                rollback_errors.append("installed object changed before rollback: " + name)
                continue
            remove_name(parent_fd, name)
        except BaseException as rollback_error:
            rollback_errors.append("failed to remove installed object " + name + ": " + str(rollback_error))
    for parent_fd, name, expected_dev, expected_ino in reversed(temporaries):
        try:
            current = lstat_at(parent_fd, name)
            if current is None:
                continue
            if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
                rollback_errors.append("temporary object changed before rollback: " + name)
                continue
            remove_name(parent_fd, name)
        except BaseException as rollback_error:
            rollback_errors.append("failed to remove temporary object " + name + ": " + str(rollback_error))
    for backup_record in reversed(backups):
        parent_fd = backup_record["parentFd"]
        name = backup_record["name"]
        backup = backup_record["backup"]
        try:
            if lstat_at(stage_fd, backup) is None:
                rollback_errors.append("rollback backup is missing: " + name)
                continue
            captured = backup_record["captured"]
            if captured is None or inspect_final(stage_fd, backup) != captured:
                rollback_errors.append("rollback backup changed after capture: " + name)
                continue
            rename_noreplace(stage_fd, backup, parent_fd, name)
        except BaseException as rollback_error:
            rollback_errors.append("failed to restore rollback backup " + name + ": " + str(rollback_error))
    for parent_fd, component in reversed(created_directories):
        try:
            os.rmdir(component, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        except BaseException as rollback_error:
            rollback_errors.append("failed to remove created directory " + component + ": " + str(rollback_error))
    remaining_backups = [
        backup_record["backup"]
        for backup_record in backups
        if lstat_at(stage_fd, backup_record["backup"]) is not None
    ]
    rollback_status = "residue" if rollback_errors or remaining_backups else "complete"
    sys.stdout.write(json.dumps({
        "ok": False,
        "rollback": rollback_status,
        "residueEntries": remaining_backups,
        "rollbackErrors": rollback_errors,
    }))
    sys.stderr.write(str(error))
    raise SystemExit(2)
finally:
    for fd in reversed(all_fds):
        try:
            os.close(fd)
        except OSError:
            pass
`;

function safeRelativePath(path: string): string | null {
  if (path.length === 0 || isAbsolute(path) || path.includes('\0')) return null;
  const normalized = normalize(path);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`)
  ) {
    return null;
  }
  return normalized.split(sep).join('/');
}

function normalizedRoots(roots: readonly string[]): string[] {
  return roots.map((root) => {
    const normalized = safeRelativePath(root);
    if (normalized === null) {
      throw new MutationPathError(`invalid mutation root: ${root}`);
    }
    return normalized;
  });
}

interface BoundaryResponse {
  ok?: boolean;
  committed?: boolean;
  rollback?: 'complete' | 'residue';
  residueEntries?: string[];
  rollbackErrors?: string[];
}

function parseBoundaryResponse(output: Buffer): BoundaryResponse | null {
  try {
    const parsed: unknown = JSON.parse(output.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as BoundaryResponse;
  } catch {
    return null;
  }
}

function cleanupResidue(
  quarantinePath: string,
  detail: string,
  knownEntries?: readonly string[],
): MutationCleanupOutcome {
  let entries = knownEntries === undefined ? [] : [...knownEntries];
  if (knownEntries === undefined && existsSync(quarantinePath)) {
    try {
      entries = readdirSync(quarantinePath).sort();
    } catch (error) {
      detail += `; failed to inspect cleanup residue: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  return { status: 'residue', quarantinePath, entries, detail };
}

function cleanupStage(
  stageRoot: string,
  injectFailure: boolean,
): MutationCleanupOutcome {
  if (injectFailure) {
    return cleanupResidue(stageRoot, 'injected post-commit cleanup failure');
  }
  try {
    rmSync(stageRoot, { recursive: true, force: true });
    return { status: 'complete' };
  } catch (error) {
    if (!existsSync(stageRoot)) return { status: 'complete' };
    return cleanupResidue(
      stageRoot,
      `post-commit cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function runBoundary(
  opts: MutationBoundaryOptions,
  commit: boolean,
): Promise<MutationBatchOutcome | undefined> {
  if (opts.operations.length === 0) {
    return commit
      ? { status: 'committed', cleanup: { status: 'complete' } }
      : undefined;
  }
  opts.operation?.checkpoint();
  const worktreeDir = resolve(opts.worktreeDir);
  const stageRoot = mkdtempSync(
    join(dirname(worktreeDir), '.core-mutation-quarantine-'),
  );
  const pauseAfterCaptureMs = opts.testOnly?.pauseAfterCaptureMs ?? 0;
  if (
    !Number.isSafeInteger(pauseAfterCaptureMs) ||
    pauseAfterCaptureMs < 0 ||
    pauseAfterCaptureMs > 1_000
  ) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw new MutationPathError('invalid mutation test pause');
  }
  let stageOwned = true;
  let preserveStage = false;
  try {
    const operations = opts.operations.map((item, index) => {
      const path = safeRelativePath(item.path);
      if (path === null) {
        throw new MutationPathError(`unsafe mutation path: ${item.path}`);
      }
      if (item.desired.kind !== 'regular') {
        return { path, expected: item.expected, desired: item.desired };
      }
      const stage = String(index);
      writeFileSync(join(stageRoot, stage), item.desired.content, {
        flag: 'wx',
        mode: 0o600,
      });
      chmodSync(join(stageRoot, stage), 0o400);
      return {
        path,
        expected: item.expected,
        desired: {
          kind: 'regular',
          mode: item.desired.mode,
          sha256: createHash('sha256')
            .update(item.desired.content)
            .digest('hex'),
        },
        stage,
      };
    });
    const manifest = Buffer.from(
      JSON.stringify({
        allowedRoots: normalizedRoots(opts.allowedRoots),
        hardDeniedRoots: [...HARD_DENIED_ROOTS],
        allowSymlinkArtifacts: opts.allowSymlinkArtifacts === true,
        testPauseAfterCaptureMs: pauseAfterCaptureMs,
        operations,
      }),
    );
    const result = await runCoreTool({
      executable: PYTHON_BIN,
      args: [
        '-I',
        '-c',
        MUTATION_SCRIPT,
        worktreeDir,
        stageRoot,
        commit ? 'commit' : 'check',
      ],
      cwd: stageRoot,
      environment: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'C',
        LC_ALL: 'C',
        PYTHONNOUSERSITE: '1',
      },
      input: manifest,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      timeoutMs: opts.operation?.remainingMs(TIMEOUT_MS) ?? TIMEOUT_MS,
      ...(opts.operation === undefined ? {} : { signal: opts.operation.signal }),
    });
    if (result.status === 'timed_out' || result.status === 'cancelled') {
      preserveStage = true;
      // The shared operation control owns the public reason. A deadline aborts
      // the child signal too, so the low-level runner may observe "cancelled"
      // while the authoritative outcome is "timed_out".
      opts.operation?.checkpoint();
      throw new FrozenTreeOperationError(
        result.status,
        `descriptor-safe mutation ${result.status}; quarantine preserved at ${stageRoot}`,
      );
    }
    if (result.status !== 'completed' || result.exitCode !== 0) {
      const response = parseBoundaryResponse(result.stdout);
      const detail =
        result.status === 'completed'
          ? result.stderr.toString('utf8').trim()
          : result.status === 'signaled'
            ? `descriptor-safe mutation terminated by ${result.signal}`
            : result.detail;
      const rollbackComplete = response?.rollback === 'complete';
      const cleanup = rollbackComplete
        ? cleanupStage(stageRoot, false)
        : cleanupResidue(
            stageRoot,
            response?.rollbackErrors?.join('; ') ||
              'mutation terminated without a complete rollback outcome',
            response?.residueEntries,
          );
      if (cleanup.status === 'complete') stageOwned = false;
      preserveStage = cleanup.status === 'residue';
      throw new MutationPathError(
        detail.length > 0 ? detail : 'descriptor-safe mutation failed closed',
        cleanup.status === 'residue' ? cleanup : undefined,
      );
    }
    const response = parseBoundaryResponse(result.stdout);
    if (response?.ok !== true || (commit && response.committed !== true)) {
      preserveStage = true;
      throw new MutationPathError(
        'descriptor-safe mutation returned an invalid transaction outcome',
        cleanupResidue(stageRoot, 'transaction outcome was not authoritative'),
      );
    }
    const cleanup = cleanupStage(
      stageRoot,
      commit && opts.testOnly?.failPostCommitCleanup === true,
    );
    if (cleanup.status === 'complete') stageOwned = false;
    preserveStage = cleanup.status === 'residue';
    opts.operation?.checkpoint();
    if (!commit && cleanup.status === 'residue') {
      throw new MutationPathError('descriptor-safe preflight cleanup failed', cleanup);
    }
    return commit ? { status: 'committed', cleanup } : undefined;
  } finally {
    if (stageOwned && !preserveStage && existsSync(stageRoot)) {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

export async function checkMutationPaths(
  opts: MutationBoundaryOptions,
): Promise<void> {
  await runBoundary(opts, false);
}

export async function applyMutationBatch(
  opts: MutationBoundaryOptions,
): Promise<MutationBatchOutcome> {
  return (await runBoundary(opts, true)) as MutationBatchOutcome;
}
