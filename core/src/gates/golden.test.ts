import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  copyOperatorGoldenFixture,
  verifyGoldenManifest,
  verifyGoldenManifests,
  GoldenFixtureError,
} from './golden.ts';

function makeGolden(): { worktree: string; goldenDir: string; cleanup(): void } {
  const worktree = mkdtempSync(join(tmpdir(), 'golden-'));
  const goldenDir = join(worktree, 'test', 'golden');
  mkdirSync(goldenDir, { recursive: true });
  writeFileSync(join(goldenDir, 'a.txt'), 'alpha\n');
  writeFileSync(join(goldenDir, 'b.txt'), 'beta\n');
  writeFileSync(join(goldenDir, '_MANIFEST.sha256'), fixtureManifest(goldenDir));
  return { worktree, goldenDir, cleanup: () => rmSync(worktree, { recursive: true, force: true }) };
}

test('frozen golden verifies clean (REQ-9.2)', () => {
  const g = makeGolden();
  try {
    const v = verifyGoldenManifest(g.worktree);
    assert.deepEqual(v, { ok: true, files: 2 });
  } finally {
    g.cleanup();
  }
});

test('name-sorted operator manifest verifies even when hash order differs (REQ-8.3)', () => {
  // sha256('beta\n') > sha256('alpha\n'), so with these contents swapped the
  // digest order inverts the filename order. A real operator manifest is
  // `shasum`-style name-sorted; the verifier must not demand digest order.
  const g = makeGolden();
  try {
    writeFileSync(join(g.goldenDir, 'a.txt'), 'beta\n');
    writeFileSync(join(g.goldenDir, 'b.txt'), 'alpha\n');
    writeFileSync(join(g.goldenDir, '_MANIFEST.sha256'), fixtureManifest(g.goldenDir));
    const v = verifyGoldenManifest(g.worktree);
    assert.deepEqual(v, { ok: true, files: 2 });
  } finally {
    g.cleanup();
  }
});

test('every tamper route fails: edit, delete, add, manifest edit (REQ-9.2)', () => {
  // edit
  let g = makeGolden();
  try {
    writeFileSync(join(g.goldenDir, 'a.txt'), 'tampered\n');
    const v = verifyGoldenManifest(g.worktree);
    assert.ok(!v.ok && v.reason === 'golden_manifest_mismatch');
  } finally {
    g.cleanup();
  }
  // delete
  g = makeGolden();
  try {
    unlinkSync(join(g.goldenDir, 'b.txt'));
    const v = verifyGoldenManifest(g.worktree);
    assert.ok(!v.ok && v.reason === 'golden_manifest_mismatch');
  } finally {
    g.cleanup();
  }
  // add
  g = makeGolden();
  try {
    writeFileSync(join(g.goldenDir, 'sneaky.txt'), 'new file\n');
    const v = verifyGoldenManifest(g.worktree);
    assert.ok(!v.ok && v.reason === 'golden_manifest_mismatch');
  } finally {
    g.cleanup();
  }
  // manifest itself edited to bless tampering — recompute still disagrees
  g = makeGolden();
  try {
    writeFileSync(join(g.goldenDir, 'a.txt'), 'tampered\n');
    // attacker recomputes the manifest to match the tampered content:
    writeFileSync(join(g.goldenDir, '_MANIFEST.sha256'), fixtureManifest(g.goldenDir));
    const v = verifyGoldenManifest(g.worktree);
    // NOTE: a locally recomputed manifest DOES verify — that is exactly why the
    // spec pairs this check with CI-side manifest hash enforcement + read-only
    // policy (REQ-9.1). The local check alone must at least verify cleanly:
    assert.ok(v.ok, 'recomputed manifest passes locally — CI hash enforcement is the backstop');
  } finally {
    g.cleanup();
  }
});

test('symlink golden entries fail closed as a manifest mismatch', () => {
  const g = makeGolden();
  try {
    symlinkSync('a.txt', join(g.goldenDir, 'alias.txt'));
    const verdict = verifyGoldenManifest(g.worktree);
    assert.ok(!verdict.ok && verdict.reason === 'golden_manifest_mismatch');
  } finally {
    g.cleanup();
  }
});

test('missing manifest fails closed (design: golden harness)', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'golden-empty-'));
  try {
    const v = verifyGoldenManifest(worktree);
    assert.ok(!v.ok && v.reason === 'manifest_missing');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('operator fixture is copied byte-for-byte and reports source/hash provenance (REQ-8.3/8.11)', () => {
  const source = mkdtempSync(join(tmpdir(), 'golden-operator-source-'));
  const target = mkdtempSync(join(tmpdir(), 'golden-operator-target-'));
  const sourceGolden = join(source, 'test', 'golden');
  const targetGolden = join(target, 'test', 'golden');
  try {
    mkdirSync(sourceGolden, { recursive: true });
    const bytes = Buffer.from([0, 1, 2, 255, 10]);
    writeFileSync(join(sourceGolden, 'bytes.bin'), bytes);
    // This manifest is supplied by the operator fixture. The provisioner must
    // copy it, never derive or rewrite it.
    writeFileSync(join(sourceGolden, '_MANIFEST.sha256'), `${sha256(bytes)}  bytes.bin\n`);

    const report = copyOperatorGoldenFixture(sourceGolden, targetGolden);
    assert.equal(report.source, sourceGolden);
    assert.match(report.sourceHash, /^[0-9a-f]{64}$/);
    assert.match(report.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal(report.attribution, 'operator-supplied');
    assert.deepEqual(readFileSync(join(targetGolden, 'bytes.bin')), bytes);
    assert.deepEqual(
      readFileSync(join(targetGolden, '_MANIFEST.sha256')),
      readFileSync(join(sourceGolden, '_MANIFEST.sha256')),
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('missing operator fixture is an explicit blocker, never generated (REQ-8.6)', () => {
  const source = join(mkdtempSync(join(tmpdir(), 'golden-missing-')), 'test', 'golden');
  const target = join(mkdtempSync(join(tmpdir(), 'golden-missing-target-')), 'test', 'golden');
  assert.throws(
    () => copyOperatorGoldenFixture(source, target),
    (error: unknown) => error instanceof GoldenFixtureError && error.code === 'operator_golden_fixture_missing',
  );
});

test('configured roots verify every manifest and reject a trusted manifest rewrite (REQ-8.1/8.10)', () => {
  const g = makeGolden();
  try {
    const clean = verifyGoldenManifests([g.goldenDir], { expectedManifestHashes: { [g.goldenDir]: sha256(readFileSync(join(g.goldenDir, '_MANIFEST.sha256'))) } });
    assert.equal(clean.ok, true);
    writeFileSync(join(g.goldenDir, 'a.txt'), 'tampered\n');
    // Rewriting the manifest to bless a modified byte is still rejected when the
    // operator's trusted manifest hash is supplied.
    writeFileSync(join(g.goldenDir, '_MANIFEST.sha256'), fixtureManifest(g.goldenDir));
    const tampered = verifyGoldenManifests([g.goldenDir], { expectedManifestHashes: { [g.goldenDir]: sha256(Buffer.from(`${sha256(Buffer.from('alpha\n'))}  a.txt\n${sha256(Buffer.from('beta\n'))}  b.txt\n`)) } });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.reason, 'golden_manifest_mismatch');
  } finally {
    g.cleanup();
  }
});

test('direct CI script verifies a configured root and blocks tampering (REQ-8.2/8.10)', () => {
  const g = makeGolden();
  try {
    const script = fileURLToPath(new URL('../../../scripts/check-golden-manifests.sh', import.meta.url));
    const clean = spawnSync('bash', [script, g.goldenDir], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    writeFileSync(join(g.goldenDir, 'a.txt'), 'tampered\n');
    const tampered = spawnSync('bash', [script, g.goldenDir], { encoding: 'utf8' });
    assert.equal(tampered.status, 1, tampered.stderr);
    assert.match(`${tampered.stdout}\n${tampered.stderr}`, /golden_manifest_mismatch/);
    symlinkSync('a.txt', join(g.goldenDir, 'alias.txt'));
    const symlinked = spawnSync('bash', [script, g.goldenDir], { encoding: 'utf8' });
    assert.equal(symlinked.status, 1);
    assert.match(`${symlinked.stdout}\n${symlinked.stderr}`, /symlink entry/);
    const missing = spawnSync('bash', [script, join(g.worktree, 'missing-golden')], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(`${missing.stdout}\n${missing.stderr}`, /operator_golden_fixture_missing/);
  } finally {
    g.cleanup();
  }
});

test('direct CI script rejects a rewritten tracked manifest even when it blesses new bytes (REQ-8.10)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'golden-ci-git-'));
  const golden = join(repo, 'test', 'golden');
  const script = fileURLToPath(new URL('../../../scripts/check-golden-manifests.sh', import.meta.url));
  try {
    mkdirSync(golden, { recursive: true });
    writeFileSync(join(golden, 'a.txt'), 'alpha\n');
    writeFileSync(join(golden, '_MANIFEST.sha256'), fixtureManifest(golden));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'operator golden'], { cwd: repo });
    writeFileSync(join(golden, 'a.txt'), 'tampered\n');
    writeFileSync(join(golden, '_MANIFEST.sha256'), fixtureManifest(golden));
    const result = spawnSync('bash', [script, golden], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /manifest bytes changed from the operator commit/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function fixtureManifest(goldenDir: string): string {
  return readdirSync(goldenDir)
    .filter((name) => name !== '_MANIFEST.sha256')
    .sort()
    .map((name) => `${sha256(readFileSync(join(goldenDir, name)))}  ${name}`)
    .join('\n') + '\n';
}
