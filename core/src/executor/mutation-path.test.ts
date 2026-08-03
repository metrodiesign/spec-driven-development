import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyMutationBatch,
  MutationPathError,
  type MutationExpected,
} from './mutation-path.ts';

const LARGE_STAGED_CONTENT = new Uint8Array(32 * 1024 * 1024);

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function raceLaterFinal(opts: {
  initial?: string;
  expected: MutationExpected;
}): Promise<{
  firstExists: boolean;
  later: string;
  raced: boolean;
}> {
  const root = mkdtempSync(join(tmpdir(), 'mutation-cas-race-'));
  const worktree = join(root, 'worktree');
  const sourceRoot = join(worktree, 'src');
  const first = join(sourceRoot, 'a-large.bin');
  const later = join(sourceRoot, 'z-later.txt');
  mkdirSync(sourceRoot, { recursive: true });
  if (opts.initial !== undefined) writeFileSync(later, opts.initial);

  let raced = false;
  const watcher = setInterval(() => {
    if (raced) return;
    const stagingVisible = readdirSync(sourceRoot).some((entry) =>
      entry.startsWith('.core-mutation-'),
    );
    if (!stagingVisible) return;
    writeFileSync(later, 'concurrent\n');
    raced = true;
  }, 1);

  try {
    await assert.rejects(
      applyMutationBatch({
        worktreeDir: worktree,
        allowedRoots: ['src'],
        operations: [
          {
            path: 'src/a-large.bin',
            expected: { kind: 'absent' },
            desired: {
              kind: 'regular',
              content: LARGE_STAGED_CONTENT,
              mode: '100644',
            },
          },
          {
            path: 'src/z-later.txt',
            expected: opts.expected,
            desired: {
              kind: 'regular',
              content: new TextEncoder().encode('transaction\n'),
              mode: '100644',
            },
          },
        ],
      }),
      MutationPathError,
    );
    return {
      firstExists: existsSync(first),
      later: readFileSync(later, 'utf8'),
      raced,
    };
  } finally {
    clearInterval(watcher);
    rmSync(root, { recursive: true, force: true });
  }
}

test('REQ-3.6: descriptor transaction rejects a concurrent replacement after batch prevalidation', async () => {
  const result = await raceLaterFinal({
    initial: 'before\n',
    expected: {
      kind: 'regular',
      sha256: '9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb',
      mode: '100644',
    },
  });

  assert.equal(result.raced, true);
  assert.equal(result.firstExists, false, 'earlier operation must roll back');
  assert.equal(result.later, 'concurrent\n', 'concurrent bytes must not be overwritten');
});

test('REQ-3.6: descriptor transaction rejects a concurrent create after an absent precondition', async () => {
  const result = await raceLaterFinal({ expected: { kind: 'absent' } });

  assert.equal(result.raced, true);
  assert.equal(result.firstExists, false, 'earlier operation must roll back');
  assert.equal(result.later, 'concurrent\n', 'concurrent create must remain authoritative');
});

test('REQ-3.6-3.8: one descriptor transaction commits files, directories, symlinks, creates, and deletes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-kind-matrix-'));
  const worktree = join(root, 'worktree');
  const sourceRoot = join(worktree, 'src');
  mkdirSync(join(sourceRoot, 'empty-before'), { recursive: true });
  writeFileSync(join(sourceRoot, 'replace.txt'), 'before\n');
  writeFileSync(join(sourceRoot, 'delete.txt'), 'delete\n');
  symlinkSync('replace.txt', join(sourceRoot, 'link'));

  try {
    const outcome = await applyMutationBatch({
      worktreeDir: worktree,
      allowedRoots: ['src'],
      allowSymlinkArtifacts: true,
      operations: [
        {
          path: 'src/replace.txt',
          expected: {
            kind: 'regular',
            sha256: sha256('before\n'),
            mode: '100644',
          },
          desired: {
            kind: 'regular',
            content: new TextEncoder().encode('after\n'),
            mode: '100755',
          },
        },
        {
          path: 'src/delete.txt',
          expected: {
            kind: 'regular',
            sha256: sha256('delete\n'),
            mode: '100644',
          },
          desired: { kind: 'absent' },
        },
        {
          path: 'src/create.txt',
          expected: { kind: 'absent' },
          desired: {
            kind: 'regular',
            content: new TextEncoder().encode('created\n'),
            mode: '100644',
          },
        },
        {
          path: 'src/link',
          expected: { kind: 'symlink', target: 'replace.txt' },
          desired: { kind: 'symlink', target: 'create.txt' },
        },
        {
          path: 'src/empty-before',
          expected: { kind: 'directory' },
          desired: { kind: 'absent' },
        },
        {
          path: 'src/empty-after',
          expected: { kind: 'absent' },
          desired: { kind: 'directory' },
        },
      ],
    });

    assert.deepEqual(outcome, {
      status: 'committed',
      cleanup: { status: 'complete' },
    });
    assert.equal(readFileSync(join(sourceRoot, 'replace.txt'), 'utf8'), 'after\n');
    assert.equal(lstatSync(join(sourceRoot, 'replace.txt')).mode & 0o111, 0o111);
    assert.equal(existsSync(join(sourceRoot, 'delete.txt')), false);
    assert.equal(readFileSync(join(sourceRoot, 'create.txt'), 'utf8'), 'created\n');
    assert.equal(readlinkSync(join(sourceRoot, 'link')), 'create.txt');
    assert.equal(existsSync(join(sourceRoot, 'empty-before')), false);
    assert.equal(lstatSync(join(sourceRoot, 'empty-after')).isDirectory(), true);
    assert.equal(
      readdirSync(sourceRoot).some((entry) => entry.startsWith('.core-')),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-3.6: rollback never overwrites a concurrent final after capturing the expected object', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-safe-restore-'));
  const worktree = join(root, 'worktree');
  const target = join(worktree, 'src', 'target.txt');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(target, 'before\n');
  let raced = false;
  let rejection: MutationPathError | undefined;
  const watcher = setInterval(() => {
    if (raced) return;
    const quarantine = readdirSync(root).find((entry) =>
      entry.startsWith('.core-mutation-quarantine-'),
    );
    if (quarantine === undefined) return;
    const quarantinePath = join(root, quarantine);
    if (
      !readdirSync(quarantinePath).some((entry) =>
        entry.startsWith('.core-backup-'),
      )
    ) {
      return;
    }
    writeFileSync(target, 'concurrent\n');
    raced = true;
  }, 1);

  try {
    await assert.rejects(
      applyMutationBatch({
        worktreeDir: worktree,
        allowedRoots: ['src'],
        operations: [
          {
            path: 'src/target.txt',
            expected: {
              kind: 'regular',
              sha256: sha256('before\n'),
              mode: '100644',
            },
            desired: {
              kind: 'regular',
              content: new TextEncoder().encode('transaction\n'),
              mode: '100644',
            },
          },
        ],
        testOnly: { pauseAfterCaptureMs: 100 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MutationPathError);
        rejection = error;
        return true;
      },
    );

    assert.equal(raced, true);
    assert.equal(readFileSync(target, 'utf8'), 'concurrent\n');
    assert.equal(rejection?.cleanup?.status, 'residue');
    if (rejection?.cleanup?.status !== 'residue') {
      assert.fail('captured pre-call object must remain in quarantine');
    }
    const backup = rejection.cleanup.entries.find((entry) =>
      entry.startsWith('.core-backup-'),
    );
    if (backup === undefined) assert.fail('expected retained rollback backup');
    assert.equal(
      readFileSync(join(rejection.cleanup.quarantinePath, backup), 'utf8'),
      'before\n',
    );
  } finally {
    clearInterval(watcher);
    rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-3.7: generated recovery-prune failure restores captured bytes and unmodeled empty directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-recovery-prune-'));
  const worktree = join(root, 'worktree');
  const obsolete = join(worktree, 'src', 'obsolete');
  const captured = join(obsolete, 'captured.txt');
  mkdirSync(join(obsolete, 'unmodeled-empty'), { recursive: true });
  writeFileSync(captured, 'captured-before\n');

  try {
    await assert.rejects(
      applyMutationBatch({
        worktreeDir: worktree,
        allowedRoots: ['src'],
        operations: [
          {
            path: 'src/obsolete/captured.txt',
            expected: {
              kind: 'regular',
              sha256: sha256('captured-before\n'),
              mode: '100644',
            },
            desired: { kind: 'absent' },
          },
          {
            path: 'src/obsolete',
            expected: { kind: 'directory' },
            desired: { kind: 'absent' },
          },
          {
            path: 'src',
            expected: { kind: 'directory' },
            desired: { kind: 'absent' },
          },
        ],
      }),
      /directory changed or is not empty at operation/u,
    );

    assert.equal(readFileSync(captured, 'utf8'), 'captured-before\n');
    assert.equal(lstatSync(join(obsolete, 'unmodeled-empty')).isDirectory(), true);
    assert.deepEqual(readdirSync(obsolete).sort(), [
      'captured.txt',
      'unmodeled-empty',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-3.7: post-commit cleanup failure returns typed residue without rolling back authoritative state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-cleanup-residue-'));
  const worktree = join(root, 'worktree');
  const target = join(worktree, 'src', 'target.txt');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(target, 'before\n');

  try {
    const outcome = await applyMutationBatch({
      worktreeDir: worktree,
      allowedRoots: ['src'],
      operations: [
        {
          path: 'src/target.txt',
          expected: {
            kind: 'regular',
            sha256: sha256('before\n'),
            mode: '100644',
          },
          desired: {
            kind: 'regular',
            content: new TextEncoder().encode('committed\n'),
            mode: '100644',
          },
        },
      ],
      testOnly: { failPostCommitCleanup: true },
    });

    assert.equal(outcome.status, 'committed');
    assert.equal(outcome.cleanup.status, 'residue');
    if (outcome.cleanup.status !== 'residue') {
      assert.fail('expected a typed post-commit cleanup residue');
    }
    assert.equal(readFileSync(target, 'utf8'), 'committed\n');
    assert.equal(existsSync(outcome.cleanup.quarantinePath), true);
    assert.ok(
      outcome.cleanup.entries.some((entry) => entry.startsWith('.core-backup-')),
    );
    assert.equal(
      readdirSync(join(worktree, 'src')).some((entry) => entry.startsWith('.core-')),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
