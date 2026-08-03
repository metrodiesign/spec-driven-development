import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  canonicalEvidenceBytes,
  openEvidenceAuthenticator,
} from './auth.ts';

function fixture(): { root: string; worktree: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'evidence-auth-'));
  const worktree = join(root, 'agent-worktree');
  mkdirSync(worktree);
  return { root, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('REQ-4.1-4.4: new run freezes Ed25519 metadata and recovery reuses the 0600 private key', () => {
  const fix = fixture();
  try {
    const first = openEvidenceAuthenticator({
      runStateDir: fix.root,
      runId: 'RUN-1',
      recovering: false,
      worktreeDirs: [fix.worktree],
    });
    const privatePath = join(fix.root, 'evidence-auth', 'private-key.pem');
    const metadataPath = join(fix.root, 'run-metadata.json');
    assert.equal(existsSync(privatePath), true);
    assert.equal(statSync(privatePath).mode & 0o777, 0o600);
    assert.equal(statSync(metadataPath).mode & 0o777, 0o444);
    assert.equal(existsSync(join(fix.worktree, 'evidence-auth')), false);

    const frozenMetadata = readFileSync(metadataPath, 'utf8');
    const bytes = canonicalEvidenceBytes({ purpose: 'same run', n: 1 });
    const signature = first.sign(bytes);

    const recovered = openEvidenceAuthenticator({
      runStateDir: fix.root,
      runId: 'RUN-1',
      recovering: true,
      worktreeDirs: [fix.worktree],
    });
    assert.equal(readFileSync(metadataPath, 'utf8'), frozenMetadata);
    assert.equal(recovered.publicKeyFingerprintSha256, first.publicKeyFingerprintSha256);
    assert.equal(recovered.verify(bytes, signature), true);
    assert.equal(recovered.sign(bytes), signature, 'Ed25519 signs the same canonical bytes deterministically');
  } finally {
    fix.cleanup();
  }
});

test('REQ-4.4/4.11: recovery fails closed for a missing key or public-key mismatch', () => {
  const fix = fixture();
  try {
    openEvidenceAuthenticator({
      runStateDir: fix.root,
      runId: 'RUN-1',
      recovering: false,
      worktreeDirs: [fix.worktree],
    });
    const privatePath = join(fix.root, 'evidence-auth', 'private-key.pem');
    const privateBytes = readFileSync(privatePath);
    unlinkSync(privatePath);
    assert.throws(
      () => openEvidenceAuthenticator({ runStateDir: fix.root, runId: 'RUN-1', recovering: true }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'signing_key_missing',
    );

    writeFileSync(privatePath, privateBytes, { mode: 0o600 });
    const metadataPath = join(fix.root, 'run-metadata.json');
    chmodSync(metadataPath, 0o600);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      evidenceAuth: { publicKeyFingerprintSha256: string };
    };
    metadata.evidenceAuth.publicKeyFingerprintSha256 = '0'.repeat(64);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    chmodSync(metadataPath, 0o444);
    assert.throws(
      () => openEvidenceAuthenticator({ runStateDir: fix.root, runId: 'RUN-1', recovering: true }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'public_key_fingerprint_mismatch',
    );
  } finally {
    fix.cleanup();
  }
});

test('REQ-4.2: a symlinked run-state path cannot place the private key in a worktree', () => {
  const fix = fixture();
  try {
    const alias = join(fix.root, 'run-state-alias');
    symlinkSync(fix.worktree, alias, 'dir');
    assert.throws(
      () => openEvidenceAuthenticator({
        runStateDir: alias,
        runId: 'RUN-1',
        recovering: false,
        worktreeDirs: [fix.worktree],
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'private_key_inside_worktree',
    );
  } finally {
    fix.cleanup();
  }
});

test('REQ-4.2: a symlinked auth directory cannot redirect the private key into a worktree', () => {
  const fix = fixture();
  try {
    symlinkSync(fix.worktree, join(fix.root, 'evidence-auth'), 'dir');
    assert.throws(
      () => openEvidenceAuthenticator({
        runStateDir: fix.root,
        runId: 'RUN-1',
        recovering: false,
        worktreeDirs: [fix.worktree],
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'signing_key_mismatch',
    );
    assert.equal(existsSync(join(fix.worktree, 'private-key.pem')), false);
  } finally {
    fix.cleanup();
  }
});

test('REQ-4.5: canonical v1 bytes sort object keys recursively, retain arrays, and reject unsupported values', () => {
  const left = canonicalEvidenceBytes({ z: [{ b: 2, a: 1 }], a: 'x' });
  const right = canonicalEvidenceBytes({ a: 'x', z: [{ a: 1, b: 2 }] });
  assert.deepEqual(left, right);
  assert.match(new TextDecoder().decode(left), /"encoding":"canonical-json-v1"/);
  assert.throws(() => canonicalEvidenceBytes({ invalid: Number.NaN }), /finite/);
  assert.throws(() => canonicalEvidenceBytes({ invalid: undefined }), /unsupported/);
});
