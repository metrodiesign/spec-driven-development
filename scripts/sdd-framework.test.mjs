import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'scripts/sdd-framework.mjs');

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function git(repo, ...args) {
  const result = command('git', ['-C', repo, ...args]);
  assert.equal(result.status, 0, result.output);
  return result.stdout.trim();
}

function write(root, path, content, mode = 0o644) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  chmodSync(destination, mode);
}

function initRepo(root) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'SDD Test');
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function runCli(commandName, source, ref, target, options = {}) {
  const cli = options.cli || CLI;
  const args = [cli, commandName];
  if (source) args.push('--source', source, '--ref', ref);
  if (target) args.push('--target', target);
  return command(process.execPath, args, options);
}

function makeManifest(files, references = []) {
  return {
    schema: 1,
    version: 'fixture-v1',
    files: [...files].sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target))),
    references,
  };
}

function writeManifest(source, manifest) {
  write(source, '.ai/distribution/framework-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
}

function sourceFixture(root) {
  initRepo(root);
  const copied = [
    ['scripts/sdd-framework.mjs', 'scripts/sdd-framework.mjs', '100755'],
    ['scripts/spec-trace.sh', 'scripts/spec-trace.sh', '100755'],
    ['scripts/spec_trace.py', 'scripts/spec_trace.py', '100755'],
    ['.ai/bin/gate-task.sh', '.ai/bin/gate-task.sh', '100755'],
    ['.ai/bin/lib-guard.sh', '.ai/bin/lib-guard.sh', '100755'],
    ['.ai/bin/check-evidence.sh', '.ai/bin/check-evidence.sh', '100755'],
  ];
  for (const [from, to, mode] of copied) {
    const destination = join(root, to);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(REPO, from), destination);
    chmodSync(destination, mode === '100755' ? 0o755 : 0o644);
  }
  write(root, 'payload/core.txt', 'revision one\n');
  write(root, 'payload/remove.txt', 'remove on update\n');
  const files = [
    { source: '.ai/bin/check-evidence.sh', target: '.ai/bin/check-evidence.sh', mode: '100755' },
    { source: '.ai/bin/gate-task.sh', target: '.ai/bin/gate-task.sh', mode: '100755' },
    { source: '.ai/bin/lib-guard.sh', target: '.ai/bin/lib-guard.sh', mode: '100755' },
    { source: 'scripts/sdd-framework.mjs', target: '.ai/bin/sdd-framework.mjs', mode: '100755' },
    { source: '.ai/distribution/framework-manifest.json', target: '.ai/distribution/framework-manifest.json', mode: '100644' },
    { source: 'payload/core.txt', target: '.ai/framework/core.txt', mode: '100644' },
    { source: 'payload/remove.txt', target: '.ai/framework/remove.txt', mode: '100644' },
    { source: 'scripts/spec-trace.sh', target: 'scripts/spec-trace.sh', mode: '100755' },
    { source: 'scripts/spec_trace.py', target: 'scripts/spec_trace.py', mode: '100755' },
  ];
  writeManifest(root, makeManifest(files, [
    { path: '.ai/bin/gate-task.sh', kind: 'managed' },
    { path: 'scripts/spec-trace.sh', kind: 'managed' },
    { path: '.ai/specs/example', kind: 'consumer-owned' },
  ]));
  return { files, revision: commit(root, 'fixture revision one') };
}

function secondRevision(source, files) {
  write(source, 'payload/core.txt', 'revision two\n', 0o755);
  rmSync(join(source, 'payload/remove.txt'));
  write(source, 'payload/new.sh', '#!/usr/bin/env bash\necho updated\n', 0o755);
  const next = files
    .filter((entry) => entry.target !== '.ai/framework/remove.txt')
    .map((entry) => entry.target === '.ai/framework/core.txt' ? { ...entry, mode: '100755' } : entry)
    .concat({ source: 'payload/new.sh', target: '.ai/framework/new.sh', mode: '100755' });
  writeManifest(source, makeManifest(next, [
    { path: '.ai/bin/gate-task.sh', kind: 'managed' },
    { path: 'scripts/spec-trace.sh', kind: 'managed' },
    { path: '.ai/specs/example', kind: 'consumer-owned' },
  ]));
  return commit(source, 'fixture revision two');
}

function consumerFixture(root, projectValue) {
  initRepo(root);
  write(root, 'project.txt', `${projectValue}\n`);
  write(root, '.ai/shared/PROJECT_CONTEXT.md', `context ${projectValue}\n`);
  write(root, '.ai/specs/example/requirements.md', '# Requirements\n\n## REQ-1: Runtime\n\n- 1.1 ระบบต้องรันเครื่องมือที่ติดตั้งแล้วได้\n');
  write(root, '.ai/specs/example/design.md', '# Design\n\n## Runtime\n\nใช้เครื่องมือที่ติดตั้งแล้ว\n\n## Requirement Traceability\n\n| REQ | Section |\n|---|---|\n| REQ-1 | Runtime |\n');
  write(root, '.ai/specs/example/tasks.md', '# Tasks\n\n- [ ] 1. Verify runtime\n  Satisfies: REQ-1\n  Verify: scripts/spec-trace.sh example\n');
  commit(root, 'consumer project');
}

function snapshotFiles(root, paths) {
  return new Map(paths.map((path) => [path, existsSync(join(root, path)) ? readFileSync(join(root, path)) : null]));
}

function assertSnapshot(root, snapshot) {
  for (const [path, bytes] of snapshot) {
    if (bytes === null) assert.equal(existsSync(join(root, path)), false, path);
    else assert.deepEqual(readFileSync(join(root, path)), bytes, path);
  }
}

test('สอง consumer ติดตั้ง อัปเดต และรัน installed tools โดยคง project data', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sdd-distribution-lifecycle-'));
  try {
    const source = join(temp, 'source');
    const first = sourceFixture(source);
    const consumers = [join(temp, 'consumer-a'), join(temp, 'consumer-b')];
    consumerFixture(consumers[0], 'alpha');
    consumerFixture(consumers[1], 'beta');

    const identities = [];
    for (const consumer of consumers) {
      const beforeProject = readFileSync(join(consumer, 'project.txt'));
      const beforeContext = readFileSync(join(consumer, '.ai/shared/PROJECT_CONTEXT.md'));
      const install = runCli('install', source, first.revision, consumer);
      assert.equal(install.status, 0, install.output);
      const lock = JSON.parse(readFileSync(join(consumer, '.ai/sdd-framework.lock.json')));
      assert.equal(lock.sourceRevision, first.revision);
      identities.push(lock.contentIdentity);
      assert.equal(runCli('check', source, first.revision, consumer).status, 0);
      const lockMtime = statSync(join(consumer, '.ai/sdd-framework.lock.json')).mtimeMs;
      assert.equal(runCli('install', source, first.revision, consumer).status, 0);
      assert.equal(statSync(join(consumer, '.ai/sdd-framework.lock.json')).mtimeMs, lockMtime);
      assert.deepEqual(readFileSync(join(consumer, 'project.txt')), beforeProject);
      assert.deepEqual(readFileSync(join(consumer, '.ai/shared/PROJECT_CONTEXT.md')), beforeContext);
    }
    assert.equal(identities[0], identities[1]);

    const hiddenSource = `${source}-offline`;
    renameSync(source, hiddenSource);
    for (const consumer of consumers) {
      const installedCli = join(consumer, '.ai/bin/sdd-framework.mjs');
      assert.equal(runCli('status', null, null, consumer, { cli: installedCli }).status, 0);
      const trace = command('bash', ['scripts/spec-trace.sh', 'example'], { cwd: consumer });
      assert.equal(trace.status, 0, trace.output);
      const evidence = '- [x] 1. Verify runtime\n  Evidence: test passed; viewports n/a; deviations none';
      const gate = command('bash', ['.ai/bin/gate-task.sh', '.ai/specs/example/tasks.md', evidence], {
        cwd: consumer,
        env: { SDD_TYPECHECK_CMD: 'true', SDD_TEST_CMD: 'true', SDD_GATE_NO_CACHE: '1' },
      });
      assert.equal(gate.status, 0, gate.output);
    }
    renameSync(hiddenSource, source);

    const second = secondRevision(source, first.files);
    for (const consumer of consumers) {
      const project = readFileSync(join(consumer, 'project.txt'));
      const update = runCli('update', source, second, consumer);
      assert.equal(update.status, 0, update.output);
      assert.equal(readFileSync(join(consumer, '.ai/framework/core.txt'), 'utf8'), 'revision two\n');
      assert.equal(lstatSync(join(consumer, '.ai/framework/core.txt')).mode & 0o111, 0o111);
      assert.equal(existsSync(join(consumer, '.ai/framework/remove.txt')), false);
      assert.equal(lstatSync(join(consumer, '.ai/framework/new.sh')).mode & 0o111, 0o111);
      assert.deepEqual(readFileSync(join(consumer, 'project.txt')), project);
      const mtime = statSync(join(consumer, '.ai/sdd-framework.lock.json')).mtimeMs;
      assert.equal(runCli('update', source, second, consumer).status, 0);
      assert.equal(statSync(join(consumer, '.ai/sdd-framework.lock.json')).mtimeMs, mtime);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('real manifest ติดตั้ง core payload ครบในสอง consumer และรัน offline ได้', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sdd-distribution-real-payload-'));
  try {
    const source = join(temp, 'source');
    initRepo(source);
    const manifest = JSON.parse(readFileSync(join(REPO, '.ai/distribution/framework-manifest.json')));
    assert.ok(manifest.files.length > 50, 'real manifest must carry the complete core payload');
    assert.equal(manifest.files.some((file) => /[*?\[\]]/.test(file.source) || /[*?\[\]]/.test(file.target)), false);
    const realTargets = new Set(manifest.files.map((file) => file.target));
    for (const adapter of [
      '.claude/agents/bug-investigator.md',
      '.claude/agents/pbt-runner.md',
      '.claude/agents/spec-architect.md',
    ]) {
      assert.equal(realTargets.has(adapter), true, adapter);
    }
    for (const reference of manifest.references.filter((entry) => entry.kind === 'managed')) {
      assert.equal(realTargets.has(reference.path), true, reference.path);
    }
    for (const excluded of [
      '.ai/bin/check-b0-bootstrap.mjs',
      '.agents/skills/spec-retro/SKILL.md',
      '.agents/skills/spec-sync-github/SKILL.md',
      '.claude/commands/pane-loop.md',
      '.codex/config.toml',
      '.claude/settings.json',
      'AGENTS.md',
      'CLAUDE.md',
    ]) {
      assert.equal(realTargets.has(excluded), false, excluded);
    }
    for (const file of manifest.files) {
      const destination = join(source, file.source);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(REPO, file.source), destination);
      chmodSync(destination, file.mode === '100755' ? 0o755 : 0o644);
    }
    const revision = commit(source, 'real managed payload');
    const validation = runCli('validate', source, revision, null);
    assert.equal(validation.status, 0, validation.output);

    const consumers = [join(temp, 'consumer-a'), join(temp, 'consumer-b')];
    consumerFixture(consumers[0], 'real-alpha');
    consumerFixture(consumers[1], 'real-beta');
    const locks = [];
    for (const consumer of consumers) {
      const install = runCli('install', source, revision, consumer);
      assert.equal(install.status, 0, install.output);
      locks.push(JSON.parse(readFileSync(join(consumer, '.ai/sdd-framework.lock.json'))));
    }
    assert.equal(locks[0].contentIdentity, locks[1].contentIdentity);
    for (const file of manifest.files) {
      assert.deepEqual(readFileSync(join(consumers[0], file.target)), readFileSync(join(consumers[1], file.target)), file.target);
      assert.equal(lstatSync(join(consumers[0], file.target)).mode & 0o111, file.mode === '100755' ? 0o111 : 0);
    }
    assert.equal(readFileSync(join(consumers[0], 'project.txt'), 'utf8'), 'real-alpha\n');
    assert.equal(readFileSync(join(consumers[1], 'project.txt'), 'utf8'), 'real-beta\n');

    renameSync(source, `${source}-offline`);
    for (const consumer of consumers) {
      const installedCli = join(consumer, '.ai/bin/sdd-framework.mjs');
      assert.equal(runCli('status', null, null, consumer, { cli: installedCli }).status, 0);
      const trace = command('bash', ['scripts/spec-trace.sh', 'example'], { cwd: consumer });
      assert.equal(trace.status, 0, trace.output);
      const evidence = '- [x] 1. Verify runtime\n  Evidence: test passed; viewports n/a; deviations none';
      const gate = command('bash', ['.ai/bin/gate-task.sh', '.ai/specs/example/tasks.md', evidence], {
        cwd: consumer,
        env: { SDD_TYPECHECK_CMD: 'true', SDD_TEST_CMD: 'true', SDD_GATE_NO_CACHE: '1' },
      });
      assert.equal(gate.status, 0, gate.output);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('adopt รับเฉพาะ exact copy และ mismatch ไม่เขียน lock', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sdd-distribution-adopt-'));
  try {
    const source = join(temp, 'source');
    const fixture = sourceFixture(source);
    const exact = join(temp, 'exact');
    const mismatch = join(temp, 'mismatch');
    consumerFixture(exact, 'exact');
    consumerFixture(mismatch, 'mismatch');
    for (const consumer of [exact, mismatch]) {
      for (const file of fixture.files) {
        const destination = join(consumer, file.target);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(source, file.source), destination);
        chmodSync(destination, file.mode === '100755' ? 0o755 : 0o644);
      }
    }
    write(mismatch, '.ai/framework/core.txt', 'local edit\n');

    assert.equal(runCli('adopt', source, fixture.revision, exact).status, 0);
    assert.equal(existsSync(join(exact, '.ai/sdd-framework.lock.json')), true);
    const before = readFileSync(join(mismatch, '.ai/framework/core.txt'));
    assert.equal(runCli('adopt', source, fixture.revision, mismatch).status, 3);
    assert.equal(existsSync(join(mismatch, '.ai/sdd-framework.lock.json')), false);
    assert.deepEqual(readFileSync(join(mismatch, '.ai/framework/core.txt')), before);

    const missing = join(temp, 'missing');
    consumerFixture(missing, 'missing');
    for (const file of fixture.files.slice(1)) {
      const destination = join(missing, file.target);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(source, file.source), destination);
      chmodSync(destination, file.mode === '100755' ? 0o755 : 0o644);
    }
    assert.equal(runCli('adopt', source, fixture.revision, missing).status, 3);
    assert.equal(existsSync(join(missing, '.ai/sdd-framework.lock.json')), false);

    const wrongMode = join(temp, 'wrong-mode');
    consumerFixture(wrongMode, 'wrong-mode');
    for (const file of fixture.files) {
      const destination = join(wrongMode, file.target);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(source, file.source), destination);
      chmodSync(destination, file.mode === '100755' ? 0o644 : 0o755);
    }
    assert.equal(runCli('adopt', source, fixture.revision, wrongMode).status, 3);
    assert.equal(existsSync(join(wrongMode, '.ai/sdd-framework.lock.json')), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('drift, new-path collision และ caught write failure ไม่ทิ้ง partial update', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sdd-distribution-conflict-'));
  try {
    const source = join(temp, 'source');
    const first = sourceFixture(source);
    const second = secondRevision(source, first.files);
    const drifted = join(temp, 'drifted');
    const collided = join(temp, 'collided');
    const rollback = join(temp, 'rollback');
    for (const consumer of [drifted, collided, rollback]) {
      consumerFixture(consumer, consumer.split('/').at(-1));
      assert.equal(runCli('install', source, first.revision, consumer).status, 0);
    }

    write(drifted, '.ai/framework/core.txt', 'drift\n');
    const driftSnapshot = snapshotFiles(drifted, ['.ai/framework/core.txt', '.ai/framework/remove.txt', '.ai/sdd-framework.lock.json']);
    assert.equal(runCli('status', null, null, drifted, { cli: join(drifted, '.ai/bin/sdd-framework.mjs') }).status, 1);
    assert.equal(runCli('update', source, second, drifted).status, 3);
    assertSnapshot(drifted, driftSnapshot);

    write(collided, '.ai/framework/new.sh', 'consumer owned\n');
    const collisionSnapshot = snapshotFiles(collided, ['.ai/framework/core.txt', '.ai/framework/remove.txt', '.ai/framework/new.sh', '.ai/sdd-framework.lock.json']);
    assert.equal(runCli('update', source, second, collided).status, 3);
    assertSnapshot(collided, collisionSnapshot);

    const rollbackSnapshot = snapshotFiles(rollback, ['.ai/framework/core.txt', '.ai/framework/remove.txt', '.ai/framework/new.sh', '.ai/sdd-framework.lock.json']);
    const failed = runCli('update', source, second, rollback, { env: { SDD_FRAMEWORK_TEST_FAIL_AFTER: '1' } });
    assert.equal(failed.status, 4, failed.output);
    assertSnapshot(rollback, rollbackSnapshot);
    assert.equal(readdirSync(rollback).some((name) => name.startsWith('.sdd-framework-tx-')), false);

    const unrecovered = join(temp, 'unrecovered');
    consumerFixture(unrecovered, 'unrecovered');
    assert.equal(runCli('install', source, first.revision, unrecovered).status, 0);
    const incomplete = runCli('update', source, second, unrecovered, {
      env: { SDD_FRAMEWORK_TEST_FAIL_AFTER: '1', SDD_FRAMEWORK_TEST_FAIL_ROLLBACK: '1' },
    });
    assert.equal(incomplete.status, 5, incomplete.output);
    assert.equal(readdirSync(unrecovered).some((name) => name.startsWith('.sdd-framework-tx-')), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('validate ปฏิเสธ path, schema, object และ reference ที่ไม่ปลอดภัย', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sdd-distribution-validate-'));
  try {
    const cases = [
      ['traversal', [{ source: '../escape', target: 'safe/file', mode: '100644' }], []],
      ['absolute', [{ source: 'payload/a', target: '/tmp/escape', mode: '100644' }], []],
      ['dot segment', [{ source: 'payload/a', target: 'safe/./file', mode: '100644' }], []],
      ['glob', [{ source: 'payload/a', target: 'safe/*.md', mode: '100644' }], []],
      ['control', [{ source: 'payload/a', target: 'safe/new\nline', mode: '100644' }], []],
      ['duplicate', [{ source: 'payload/a', target: 'safe/file', mode: '100644' }, { source: 'payload/b', target: 'safe/file', mode: '100644' }], []],
      ['case duplicate', [{ source: 'payload/a', target: 'safe/A', mode: '100644' }, { source: 'payload/b', target: 'safe/a', mode: '100644' }], []],
      ['overlap', [{ source: 'payload/a', target: 'safe', mode: '100644' }, { source: 'payload/b', target: 'safe/child', mode: '100644' }], []],
      ['case-folded overlap uppercase parent', [{ source: 'payload/a', target: 'Safe', mode: '100644' }, { source: 'payload/b', target: 'safe/child', mode: '100644' }], []],
      ['case-folded overlap uppercase child', [{ source: 'payload/a', target: 'safe', mode: '100644' }, { source: 'payload/b', target: 'Safe/child', mode: '100644' }], []],
      ['shared parent casing', [{ source: 'payload/a', target: 'Safe/a', mode: '100644' }, { source: 'payload/b', target: 'safe/b', mode: '100644' }], []],
      ['nested shared parent casing', [{ source: 'payload/a', target: 'nested/Safe/a', mode: '100644' }, { source: 'payload/b', target: 'nested/safe/b', mode: '100644' }], []],
      ['reverse shared parent casing', [{ source: 'payload/a', target: 'safe/a', mode: '100644' }, { source: 'payload/b', target: 'Safe/b', mode: '100644' }], []],
      ['implicit lock parent casing', [{ source: 'payload/a', target: '.AI/framework/a', mode: '100644' }], []],
      ['reserved git', [{ source: 'payload/a', target: '.git/config', mode: '100644' }], []],
      ['reserved specs', [{ source: 'payload/a', target: '.ai/specs/private.md', mode: '100644' }], []],
      ['reserved goals', [{ source: 'payload/a', target: '.ai/goals/private.md', mode: '100644' }], []],
      ['reserved governance', [{ source: 'payload/a', target: '.ai/governance/private.md', mode: '100644' }], []],
      ['reserved calibration', [{ source: 'payload/a', target: '.ai/calibration/private.md', mode: '100644' }], []],
      ['reserved runs', [{ source: 'payload/a', target: '.ai/runs/private.md', mode: '100644' }], []],
      ['reserved github', [{ source: 'payload/a', target: '.github/workflows/ci.yml', mode: '100644' }], []],
      ['reserved context', [{ source: 'payload/a', target: '.ai/shared/PROJECT_CONTEXT.md', mode: '100644' }], []],
      ['reserved front door', [{ source: 'payload/a', target: 'AGENTS.md', mode: '100644' }], []],
      ['reserved harness config', [{ source: 'payload/a', target: '.claude/settings.json', mode: '100644' }], []],
      ['reserved claude ancestor', [{ source: 'payload/a', target: '.claude', mode: '100644' }], []],
      ['reserved case-folded ancestor', [{ source: 'payload/a', target: '.ClAuDe', mode: '100644' }], []],
      ['reserved ai ancestor', [{ source: 'payload/a', target: '.ai', mode: '100644' }], []],
      ['reserved codex ancestor', [{ source: 'payload/a', target: '.codex', mode: '100644' }], []],
      ['reserved opencode ancestor', [{ source: 'payload/a', target: '.opencode', mode: '100644' }], []],
      ['reserved pi ancestor', [{ source: 'payload/a', target: '.pi', mode: '100644' }], []],
      ['reserved git ancestor', [{ source: 'payload/a', target: '.git', mode: '100644' }], []],
      ['reserved github ancestor', [{ source: 'payload/a', target: '.github', mode: '100644' }], []],
      ['reserved shared ancestor', [{ source: 'payload/a', target: '.ai/shared', mode: '100644' }], []],
      ['reserved config descendant', [{ source: 'payload/a', target: '.codex/config.toml/child', mode: '100644' }], []],
      ['reserved lock', [{ source: 'payload/a', target: '.ai/sdd-framework.lock.json', mode: '100644' }], []],
      ['reserved lock descendant', [{ source: 'payload/a', target: '.ai/sdd-framework.lock.json/child', mode: '100644' }], []],
      ['reserved transaction namespace', [{ source: 'payload/a', target: '.sdd-framework-tx-forged/file', mode: '100644' }], []],
      ['reserved source', [{ source: 'package.json', target: 'safe/file', mode: '100644' }], []],
      ['missing managed reference', [{ source: 'payload/a', target: 'safe/file', mode: '100644' }], [{ path: 'safe/missing', kind: 'managed' }]],
      ['unsupported mode', [{ source: 'payload/a', target: 'safe/file', mode: '100755' }], []],
      ['missing source', [{ source: 'payload/missing', target: 'safe/file', mode: '100644' }], []],
    ];
    for (const [name, files, references] of cases) {
      const source = join(temp, name.replaceAll(' ', '-'));
      initRepo(source);
      write(source, 'payload/a', 'a\n');
      write(source, 'payload/b', 'b\n');
      write(source, 'package.json', '{}\n');
      writeManifest(source, makeManifest(files, references));
      const revision = commit(source, name);
      const result = runCli('validate', source, revision, null);
      assert.equal(result.status, 2, `${name}: ${result.output}`);
    }

    const badSchema = join(temp, 'bad-schema');
    initRepo(badSchema);
    write(badSchema, 'payload/a', 'a\n');
    writeManifest(badSchema, { ...makeManifest([{ source: 'payload/a', target: 'safe/file', mode: '100644' }]), typo: true });
    assert.equal(runCli('validate', badSchema, commit(badSchema, 'bad schema'), null).status, 2);

    const symlinkSource = join(temp, 'symlink-source');
    initRepo(symlinkSource);
    write(symlinkSource, 'payload/real', 'a\n');
    symlinkSync('real', join(symlinkSource, 'payload/link'));
    writeManifest(symlinkSource, makeManifest([{ source: 'payload/link', target: 'safe/file', mode: '100644' }]));
    assert.equal(runCli('validate', symlinkSource, commit(symlinkSource, 'symlink'), null).status, 2);

    const reservedSiblings = join(temp, 'reserved-siblings');
    initRepo(reservedSiblings);
    const siblingTargets = ['.ai/bin/x', '.ai/framework/a', '.claude/hooks/x', '.codex/agents/x', '.opencode/agents/x', '.pi/extensions/x', 'Safe/a', 'Safe/b', 'safe-sibling/child'];
    const siblingFiles = siblingTargets.map((target, index) => {
      const source = `payload/${index}`;
      write(reservedSiblings, source, `${target}\n`);
      return { source, target, mode: '100644' };
    });
    writeManifest(reservedSiblings, makeManifest(siblingFiles));
    const siblingRevision = commit(reservedSiblings, 'reserved siblings');
    const siblingResult = runCli('validate', reservedSiblings, siblingRevision, null);
    assert.equal(siblingResult.status, 0, siblingResult.output);
    const siblingConsumer = join(temp, 'sibling-consumer');
    consumerFixture(siblingConsumer, 'sibling control');
    const siblingInstall = runCli('install', reservedSiblings, siblingRevision, siblingConsumer);
    assert.equal(siblingInstall.status, 0, siblingInstall.output);
    for (const target of ['.ai/framework/a', 'Safe/a', 'Safe/b', 'safe-sibling/child']) assert.equal(existsSync(join(siblingConsumer, target)), true, target);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function lockIdentity(lock) {
  const hash = createHash('sha256');
  hash.update('sdd-framework-content-v1\0');
  hash.update(`${lock.manifestSha256}\n`);
  for (const file of lock.files) hash.update(`${file.target}\0${file.mode}\0${file.sha256}\n`);
  return `sha256:${hash.digest('hex')}`;
}

test('nested target, symlink parent และ forged lock ถูกปฏิเสธโดยไม่แตะ outside', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sdd-distribution-path-'));
  try {
    const source = join(temp, 'source');
    const fixture = sourceFixture(source);
    const consumer = join(temp, 'consumer');
    consumerFixture(consumer, 'safe');
    mkdirSync(join(consumer, 'nested'));
    assert.equal(runCli('install', source, fixture.revision, join(consumer, 'nested')).status, 2);

    const outside = join(temp, 'outside');
    mkdirSync(outside);
    const linked = join(temp, 'linked');
    initRepo(linked);
    symlinkSync(outside, join(linked, '.ai'));
    assert.equal(runCli('install', source, fixture.revision, linked).status, 3);
    assert.deepEqual(readdirSyncSafe(outside), []);

    assert.equal(runCli('install', source, fixture.revision, consumer).status, 0);
    const lockPath = join(consumer, '.ai/sdd-framework.lock.json');
    const validLock = readFileSync(lockPath);
    const forgedTargets = [
      '.claude',
      '.ai',
      '.codex',
      '.opencode',
      '.pi',
      '.git',
      '.github',
      '.git/config',
      '.ai/specs/private.md',
      '.ai/goals/private.md',
      '.ai/governance/private.md',
      '.ai/calibration/private.md',
      '.ai/runs/private.md',
      '.github/workflows/ci.yml',
      '.ai/shared/PROJECT_CONTEXT.md',
      '.claude/settings.json',
      'AGENTS.md',
      'package.json',
      '.ai/sdd-framework.lock.json',
      '.ai/sdd-framework.lock.json/child',
      '.sdd-framework-tx-forged/file',
    ];
    for (const target of forgedTargets) {
      const lock = JSON.parse(validLock);
      lock.files[0].target = target;
      lock.files.sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)));
      lock.contentIdentity = lockIdentity(lock);
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      assert.equal(runCli('status', null, null, consumer, { cli: join(consumer, '.ai/bin/sdd-framework.mjs') }).status, 1, target);
      assert.equal(runCli('update', source, fixture.revision, consumer).status, 3, target);
    }
    for (const [parent, child] of [['.ai/bin', '.ai/bin/child'], ['Safe', 'safe/child'], ['safe', 'Safe/child']]) {
      const overlap = JSON.parse(validLock);
      overlap.files[0].target = parent;
      overlap.files[1].target = child;
      overlap.files.sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)));
      overlap.contentIdentity = lockIdentity(overlap);
      writeFileSync(lockPath, `${JSON.stringify(overlap, null, 2)}\n`);
      assert.equal(runCli('status', null, null, consumer, { cli: join(consumer, '.ai/bin/sdd-framework.mjs') }).status, 1, `${parent} and ${child}`);
      assert.equal(runCli('update', source, fixture.revision, consumer).status, 3, `${parent} and ${child}`);
    }
    for (const [first, second] of [
      ['Safe/a', 'safe/b'],
      ['nested/Safe/a', 'nested/safe/b'],
      ['safe/a', 'Safe/b'],
    ]) {
      const inconsistent = JSON.parse(validLock);
      inconsistent.files[0].target = first;
      inconsistent.files[1].target = second;
      inconsistent.files.sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)));
      inconsistent.contentIdentity = lockIdentity(inconsistent);
      writeFileSync(lockPath, `${JSON.stringify(inconsistent, null, 2)}\n`);
      const label = `${first} and ${second}`;
      assert.equal(runCli('status', null, null, consumer, { cli: join(consumer, '.ai/bin/sdd-framework.mjs') }).status, 1, label);
      assert.equal(runCli('update', source, fixture.revision, consumer).status, 3, label);
    }
    const implicitCollision = JSON.parse(validLock);
    implicitCollision.files[0].target = '.AI/framework/a';
    implicitCollision.files.sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)));
    implicitCollision.contentIdentity = lockIdentity(implicitCollision);
    writeFileSync(lockPath, `${JSON.stringify(implicitCollision, null, 2)}\n`);
    const collisionStatus = runCli('status', null, null, consumer, { cli: join(consumer, '.ai/bin/sdd-framework.mjs') });
    assert.equal(collisionStatus.status, 1, collisionStatus.output);
    assert.match(collisionStatus.output, /inconsistent directory casing/);
    const collisionUpdate = runCli('update', source, fixture.revision, consumer);
    assert.equal(collisionUpdate.status, 3, collisionUpdate.output);
    assert.match(collisionUpdate.output, /inconsistent directory casing/);

    const siblings = JSON.parse(validLock);
    siblings.files[0].target = 'Safe/a';
    siblings.files[1].target = 'Safe/b';
    siblings.files[2].target = 'safe-sibling/child';
    siblings.files[3].target = '.ai/framework/a';
    siblings.files.sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)));
    siblings.contentIdentity = lockIdentity(siblings);
    writeFileSync(lockPath, `${JSON.stringify(siblings, null, 2)}\n`);
    const siblingStatus = runCli('status', null, null, consumer, { cli: join(consumer, '.ai/bin/sdd-framework.mjs') });
    assert.equal(siblingStatus.status, 1);
    assert.doesNotMatch(siblingStatus.output, /target overlap/);
    assert.doesNotMatch(siblingStatus.output, /inconsistent directory casing/);
    assert.match(siblingStatus.output, /manifest target set differs from lock/);

    writeFileSync(lockPath, validLock);
    const outsideLeaf = join(temp, 'outside-leaf');
    writeFileSync(outsideLeaf, 'outside\n');
    renameSync(join(consumer, '.ai/framework/core.txt'), join(consumer, '.ai/framework/core.backup'));
    symlinkSync(outsideLeaf, join(consumer, '.ai/framework/core.txt'));
    assert.equal(runCli('status', null, null, consumer, { cli: join(consumer, '.ai/bin/sdd-framework.mjs') }).status, 1);
    assert.equal(runCli('update', source, fixture.revision, consumer).status, 3);
    assert.equal(readFileSync(outsideLeaf, 'utf8'), 'outside\n');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('lock ปลอมแบบ self-consistent ไม่ใช่หลักฐาน ownership ของ project file', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sdd-distribution-forged-ownership-'));
  try {
    const source = join(temp, 'source');
    const first = sourceFixture(source);
    const second = secondRevision(source, first.files);
    const consumer = join(temp, 'consumer');
    consumerFixture(consumer, 'forged ownership');
    assert.equal(runCli('install', source, first.revision, consumer).status, 0);

    const projectPath = join(consumer, 'project-owned.txt');
    writeFileSync(projectPath, 'project owned\n');
    const lockPath = join(consumer, '.ai/sdd-framework.lock.json');
    const lock = JSON.parse(readFileSync(lockPath));
    lock.files.push({
      target: 'project-owned.txt',
      mode: '100644',
      sha256: `sha256:${createHash('sha256').update(readFileSync(projectPath)).digest('hex')}`,
    });
    lock.files.sort((a, b) => Buffer.compare(Buffer.from(a.target), Buffer.from(b.target)));
    lock.contentIdentity = lockIdentity(lock);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const installedCli = join(consumer, '.ai/bin/sdd-framework.mjs');
    const offlineStatus = runCli('status', null, null, consumer, { cli: installedCli });
    assert.equal(offlineStatus.status, 1, offlineStatus.output);
    assert.match(offlineStatus.output, /manifest target set differs from lock/);
    for (const commandName of ['install', 'check', 'update']) {
      const result = runCli(commandName, source, commandName === 'update' ? second : first.revision, consumer);
      assert.notEqual(result.status, 0, `${commandName}: ${result.output}`);
      assert.match(result.output, /lock does not match trusted source revision/);
      assert.equal(readFileSync(projectPath, 'utf8'), 'project owned\n');
    }

    const unavailableRevisionLock = JSON.parse(readFileSync(lockPath));
    unavailableRevisionLock.files.pop();
    unavailableRevisionLock.sourceRevision = 'a'.repeat(40);
    unavailableRevisionLock.contentIdentity = lockIdentity(unavailableRevisionLock);
    writeFileSync(lockPath, `${JSON.stringify(unavailableRevisionLock, null, 2)}\n`);
    const before = snapshotFiles(consumer, ['.ai/framework/core.txt', '.ai/framework/remove.txt', 'project-owned.txt', '.ai/sdd-framework.lock.json']);
    const unavailable = runCli('update', source, second, consumer);
    assert.notEqual(unavailable.status, 0, unavailable.output);
    assert.match(unavailable.output, /cannot load trusted source revision/);
    assertSnapshot(consumer, before);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function readdirSyncSafe(root) {
  return existsSync(root) ? readdirSync(root) : [];
}

test('check ตรวจ exact revision แม้ payload identity เท่าเดิม', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sdd-distribution-revision-'));
  try {
    const source = join(temp, 'source');
    const first = sourceFixture(source);
    const consumer = join(temp, 'consumer');
    consumerFixture(consumer, 'revision');
    assert.equal(runCli('install', source, first.revision, consumer).status, 0);
    const before = JSON.parse(readFileSync(join(consumer, '.ai/sdd-framework.lock.json')));
    git(source, 'commit', '--allow-empty', '-m', 'same payload new revision');
    const samePayloadRevision = git(source, 'rev-parse', 'HEAD');
    assert.equal(runCli('check', source, samePayloadRevision, consumer).status, 1);
    assert.equal(runCli('update', source, samePayloadRevision, consumer).status, 0);
    const after = JSON.parse(readFileSync(join(consumer, '.ai/sdd-framework.lock.json')));
    assert.equal(after.contentIdentity, before.contentIdentity);
    assert.notEqual(after.sourceRevision, before.sourceRevision);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
