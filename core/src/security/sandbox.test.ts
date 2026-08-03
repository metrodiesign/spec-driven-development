import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { denyNetworkSandbox } from './sandbox.ts';

function profileFor(
  root: string,
  writableRoots: string[] = ['.'],
): string {
  const sandbox = denyNetworkSandbox('darwin');
  assert.equal(sandbox.kind, 'available');
  if (sandbox.kind !== 'available') throw new Error('darwin sandbox must be available');
  const wrapped = sandbox.wrap({
    shellCmd: 'true',
    workspaceRoot: root,
    writableRoots,
    protectedRoots: ['test/golden'],
  });
  assert.equal(wrapped.args[0], '-p');
  return wrapped.args[1] ?? '';
}

test('SBPL paths encode legal backslashes, quotes, and Unicode without raw interpolation', () => {
  const parent = mkdtempSync(join(tmpdir(), 'sandbox-profile-'));
  const root = join(parent, 'workspace\\segment-"ยูนิโค้ด');
  mkdirSync(join(root, 'test', 'golden'), { recursive: true });
  try {
    const profile = profileFor(root);
    assert.match(profile, /workspace\\\\segment-\\"ยูนิโค้ด/);
    assert.doesNotMatch(profile, /workspace\\segment-"ยูนิโค้ด/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('SBPL rejects control-character paths before spawning', () => {
  const parent = mkdtempSync(join(tmpdir(), 'sandbox-profile-'));
  const root = join(parent, 'workspace\nsegment');
  mkdirSync(join(root, 'test', 'golden'), { recursive: true });
  try {
    assert.throws(() => profileFor(root), /not representable|control/i);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('SBPL denials request an enforcement signal instead of relying on child output', () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-profile-'));
  mkdirSync(join(root, 'test', 'golden'), { recursive: true });
  try {
    const profile = profileFor(root);
    assert.match(profile, /deny network\*.*with send-signal SIGKILL/);
    assert.match(profile, /deny file-write\*.*with send-signal SIGKILL/);
    assert.match(profile, /allow file-write-data \(vnode-type CHARACTER-DEVICE\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Phase 0 exposes no package-manager or network grant in the sandbox profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-profile-'));
  mkdirSync(join(root, 'test', 'golden'), { recursive: true });
  try {
    const profile = profileFor(root, ['node_modules']);
    assert.match(profile, /deny network\*/);
    assert.equal(profile.includes(`(allow file-write* (subpath "${root}"))`), false);
    assert.doesNotMatch(profile, /pnpm-lock|_tmp_/);
    assert.match(profile, /allow file-write\* \(subpath ".*\/node_modules"\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
