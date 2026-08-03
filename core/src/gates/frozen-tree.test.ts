import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { git, makeFixture } from '../../test/helpers/fixture.ts';
import {
  DEFAULT_FROZEN_TREE_LIMITS,
  freezeWorkingTree,
} from './frozen-tree.ts';

test('REQ-2.8/2.27: a bounded multi-MiB tracked file freezes and materializes byte-identically', async () => {
  const fix = makeFixture();
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'frozen-tree-large-'));
  const destination = join(fix.root, 'materialized');
  const content = Buffer.alloc(4 * 1024 * 1024, 0x5a);
  try {
    const path = join(fix.worktree, 'src', 'multi-mib.bin');
    writeFileSync(path, content);
    git(fix.worktree, 'add', 'src/multi-mib.bin');
    const frozen = await freezeWorkingTree(
      fix.worktree,
      DEFAULT_FROZEN_TREE_LIMITS,
      temporaryRoot,
    );
    try {
      mkdirSync(destination);
      await frozen.materialize(destination);
      assert.deepEqual(readFileSync(join(destination, 'src', 'multi-mib.bin')), content);
      assert.equal(
        frozen.entries.find((entry) => entry.path === 'src/multi-mib.bin')?.bytes,
        content.byteLength,
      );
    } finally {
      frozen.cleanup();
    }
    assert.deepEqual(readdirSync(temporaryRoot), []);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    fix.cleanup();
  }
});

test('REQ-2.27/2.28: an exceptional size-bound failure removes its snapshot repository', async () => {
  const fix = makeFixture();
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'frozen-tree-failure-'));
  try {
    writeFileSync(join(fix.worktree, 'src', 'too-large.bin'), Buffer.alloc(4096, 0x41));
    await assert.rejects(
      freezeWorkingTree(
          fix.worktree,
          {
            ...DEFAULT_FROZEN_TREE_LIMITS,
            maxSingleFileBytes: 1024,
          },
          temporaryRoot,
        ),
      /maxSingleFileBytes/,
    );
    assert.deepEqual(readdirSync(temporaryRoot), []);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    fix.cleanup();
  }
});

test('REQ-2.27/2.44: ignored filesystem objects independently obey capture bounds', async () => {
  const fix = makeFixture();
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'frozen-tree-ignored-bound-'));
  try {
    writeFileSync(join(fix.worktree, '.gitignore'), 'ignored.bin\n');
    writeFileSync(join(fix.worktree, 'ignored.bin'), Buffer.alloc(4096, 0x41));

    await assert.rejects(
      freezeWorkingTree(
        fix.worktree,
        {
          ...DEFAULT_FROZEN_TREE_LIMITS,
          maxSingleFileBytes: 1024,
        },
        temporaryRoot,
      ),
      /maxSingleFileBytes/,
    );
    assert.deepEqual(readdirSync(temporaryRoot), []);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    fix.cleanup();
  }
});
