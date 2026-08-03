import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type Server } from 'node:net';
import { test } from 'node:test';

import * as corePublic from '../index.ts';
import { createCoreCommandExecutor } from '../index.ts';
import type {
  CommandArtifactPolicy,
  CommandCaptureFailpoints,
  CoreCommandExecutor,
  OfflineDependencyPolicy,
} from '../index.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import { createExecutor } from '../executor/executor.ts';
import { createDefaultPathPolicy } from '../executor/path-policy.ts';
import { readRegularFileByDescriptor } from '../gates/frozen-tree.ts';
import { openEventLog } from '../state/event-log.ts';
import { createCommandRunner, runCoreTool } from './command-runner.ts';
import { denyNetworkSandbox, type SandboxWrap } from './sandbox.ts';

const clock = { now: () => 1_000_000 };
const passthrough: SandboxWrap = {
  kind: 'available',
  wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
};

function git(cwd: string, ...args: string[]): void {
  const { execFileSync } = process.getBuiltinModule('node:child_process');
  execFileSync('/usr/bin/git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}

function harness(opts: {
  commandRunner?: {
    run(input: {
      command: string;
      workspaceRoot: string;
      cwd: string;
      writableRoots: string[];
      protectedRoots: string[];
      allowNetwork: boolean;
      timeoutMs: number;
    }): Promise<
      | {
          status: 'completed';
          exitCode: number;
          evidenceRef: string;
          egressBlocked: boolean;
        }
      | {
          status: 'rejected';
          reason: 'sandbox_violation';
          detail: string;
          evidenceRef: string;
          exitCode: number;
          egressBlocked: boolean;
          observedViolation?: {
            source: 'enforcement_owned_direct' | 'backend_owned';
            operation: 'filesystem' | 'network';
          };
        }
    >;
  };
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'amended-command-contract-'));
  const worktree = join(root, 'worktree');
  const { mkdirSync } = process.getBuiltinModule('node:fs');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  mkdirSync(join(worktree, 'test', 'ai-generated'), { recursive: true });
  mkdirSync(join(worktree, 'test', 'golden'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'stable.txt'), 'stable\n');
  writeFileSync(join(worktree, '.gitignore'), '*.ignored\nnode_modules/\n');
  git(worktree, 'init', '-q', '-b', 'main');
  git(worktree, 'config', 'user.email', 'fixture@example.invalid');
  git(worktree, 'config', 'user.name', 'fixture');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'fixture');

  const evidence = createEvidenceStore(join(root, 'evidence'));
  const log = openEventLog(join(root, 'events.db'), clock);
  const executor = createExecutor({
    worktreeDir: worktree,
    runId: 'RUN-AMENDED',
    taskId: 'T-AMENDED',
    log,
    evidence,
    policy: createDefaultPathPolicy(),
    sandbox: passthrough,
    clock,
    ...(opts.commandRunner === undefined ? {} : { commandRunner: opts.commandRunner }),
  });
  return {
    root,
    worktree,
    evidence,
    executor,
    cleanup() {
      log.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeApprovedOfflineFixture(root: string, command: string): {
  manifest: string;
  lockfile: string;
  sourceRoot: string;
  sourceHash: string;
  policy: OfflineDependencyPolicy;
} {
  const sourceRoot = join(root, 'approved-source');
  mkdirSync(sourceRoot);
  const sourcePackage = JSON.stringify({
    name: 'phase0-offline-dependency',
    version: '1.0.0',
    main: 'index.js',
  });
  const sourceModule = "module.exports = 'approved';\n";
  writeFileSync(join(sourceRoot, 'package.json'), sourcePackage);
  writeFileSync(join(sourceRoot, 'index.js'), sourceModule);
  const sourceHash = sha256(
    JSON.stringify([
      { path: 'index.js', sha256: sha256(sourceModule) },
      { path: 'package.json', sha256: sha256(sourcePackage) },
    ]),
  );
  const targetPath = '.phase0-offline-sources/phase0-offline-dependency';
  const specifier = `file:${targetPath}`;
  const manifest = JSON.stringify({
    name: 'offline-consumer',
    private: true,
    dependencies: { 'phase0-offline-dependency': specifier },
  });
  const lockfile = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      phase0-offline-dependency:',
    `        specifier: ${specifier}`,
    `        version: ${specifier}`,
    'packages:',
    `  phase0-offline-dependency@${specifier}:`,
    `    resolution: {directory: ${targetPath}, type: directory}`,
    'snapshots:',
    `  phase0-offline-dependency@${specifier}: {}`,
    '',
  ].join('\n');
  return {
    manifest,
    lockfile,
    sourceRoot,
    sourceHash,
    policy: {
      version: 1,
      allowedRoles: ['implementer'],
      commands: [command],
      manifestPath: 'package.json',
      manifestHash: sha256(manifest),
      lockfilePath: 'pnpm-lock.yaml',
      lockfileHash: sha256(lockfile),
      approvedSourceHashes: [sourceHash],
      approvedSources: [
        {
          packageName: 'phase0-offline-dependency',
          specifier,
          targetPath,
          sourcePath: sourceRoot,
          contentHash: sourceHash,
        },
      ],
      persistentOutputRoots: ['node_modules'],
      lifecycleScripts: 'disabled',
      network: 'none',
    },
  };
}

function rebindApprovedSourceHash(
  policy: OfflineDependencyPolicy,
  sourceRoot: string,
): void {
  const inventory = readdirSync(sourceRoot)
    .sort()
    .map((path) => ({ path, sha256: sha256(readFileSync(join(sourceRoot, path))) }));
  const contentHash = sha256(JSON.stringify(inventory));
  const source = policy.approvedSources[0];
  if (source === undefined) throw new Error('test fixture has no approved source');
  source.contentHash = contentHash;
  policy.approvedSourceHashes = [contentHash];
}

function orchestratorHarness(opts: {
  run?(input: {
    command: string;
    workspaceRoot: string;
    cwd: string;
    writableRoots: string[];
    protectedRoots: string[];
    allowNetwork: boolean;
    timeoutMs: number;
  }): Promise<
    | {
        status: 'completed';
        exitCode: number;
        evidenceRef: string;
        egressBlocked: boolean;
      }
    | {
        status: 'rejected';
        reason: 'sandbox_violation';
        detail: string;
        evidenceRef: string;
        exitCode: number;
        egressBlocked: boolean;
        observedViolation?: {
          source: 'enforcement_owned_direct' | 'backend_owned';
          operation: 'filesystem' | 'network';
        };
      }
  >;
  offlineDependencyPolicy?: OfflineDependencyPolicy;
  artifactPolicy?: CommandArtifactPolicy;
  failpoints?: CommandCaptureFailpoints;
  now?: () => number;
}) {
  const root = mkdtempSync(join(tmpdir(), 'core-command-orchestrator-'));
  const worktree = join(root, 'worktree');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  mkdirSync(join(worktree, 'test', 'ai-generated'), { recursive: true });
  mkdirSync(join(worktree, 'test', 'golden'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'stable.txt'), 'stable\n');
  writeFileSync(join(worktree, '.gitignore'), '*.ignored\nnode_modules/\n');
  git(worktree, 'init', '-q', '-b', 'main');
  git(worktree, 'config', 'user.email', 'fixture@example.invalid');
  git(worktree, 'config', 'user.name', 'fixture');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'fixture');
  const evidence = createEvidenceStore(join(root, 'evidence'));
  const temporaryRoot = join(root, 'attempts');
  mkdirSync(temporaryRoot);
  const commandRunner =
    opts.run === undefined
      ? createCommandRunner({ sandbox: passthrough, evidence })
      : { environmentHash: 'a'.repeat(64), run: opts.run };
  const commands: CoreCommandExecutor = createCoreCommandExecutor({
    evidence,
    policy: createDefaultPathPolicy(),
    sandbox: passthrough,
    commandRunner,
    temporaryRoot,
    ...(opts.offlineDependencyPolicy === undefined
      ? {}
      : { offlineDependencyPolicy: opts.offlineDependencyPolicy }),
    ...(opts.artifactPolicy === undefined ? {} : { artifactPolicy: opts.artifactPolicy }),
    ...(opts.failpoints === undefined ? {} : { failpoints: opts.failpoints }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return {
    root,
    worktree,
    evidence,
    temporaryRoot,
    commands,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function mutation(
  commands: CoreCommandExecutor,
  worktreeDir: string,
  actionId = 'mutation',
  cmd = 'fixture-command',
) {
  return commands.execute(
    { type: 'RUN_COMMAND', actionId, cmd, network: 'none' },
    { worktreeDir, role: 'implementer', classification: 'artifact_mutation' },
  );
}

test('REQ-2.1/2.46/2.47: the package exports one core RUN_COMMAND orchestrator and no low-level spawn', () => {
  const exported = corePublic as Record<string, unknown>;
  assert.equal(typeof exported['createCoreCommandExecutor'], 'function');
  assert.equal(exported['createCommandRunner'], undefined);
  assert.equal(exported['runCoreTool'], undefined);
  assert.equal(exported['denyNetworkSandbox'], undefined);
});

test('REQ-2.1: executor, gate, and workspace preparation launch children only through the shared primitive', () => {
  const sourceRoot = join(import.meta.dirname, '..');
  for (const relativePath of [
    'executor/executor.ts',
    'executor/command-executor.ts',
    'gates/frozen-tree.ts',
    'gates/runner.ts',
  ]) {
    const source = readFileSync(join(sourceRoot, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /node:child_process|\b(?:execFileSync|spawnSync|execFile|spawn)\s*\(/u,
      `${relativePath} bypasses the shared child-process primitive`,
    );
  }
  assert.match(
    readFileSync(join(sourceRoot, 'security', 'command-runner.ts'), 'utf8'),
    /node:child_process/u,
  );
  const boundarySource = readFileSync(
    join(sourceRoot, 'security', 'command-runner.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    boundarySource,
    /\b(?:execFileSync|spawnSync|execFile)\s*\(/u,
    'the boundary must not retain a second synchronous child implementation',
  );
  assert.equal(
    [...boundarySource.matchAll(/\bspawn\s*\(/gu)].length,
    1,
    'all modes must compose one async spawn primitive',
  );
});

test('REQ-2.1/2.41: core tooling has typed timeout and cancellation results', async () => {
  const timed = await runCoreTool({
    executable: '/bin/sh',
    args: ['-c', 'sleep 1'],
    cwd: tmpdir(),
    environment: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxOutputBytes: 1_024,
    timeoutMs: 10,
  });
  assert.equal(timed.status, 'timed_out');
  assert.equal(timed.exitCode, null);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await runCoreTool({
    executable: '/bin/sh',
    args: ['-c', 'sleep 1'],
    cwd: tmpdir(),
    environment: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxOutputBytes: 1_024,
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.exitCode, null);
});

test('REQ-2.15/2.46: an artifact command receives only a core-derived disposable workspace', async () => {
  let receivedRoot = '';
  const h = harness({
    commandRunner: {
      async run(input) {
        receivedRoot = input.workspaceRoot;
        return {
          status: 'completed',
          exitCode: 0,
          evidenceRef: h.evidence.put('completed'),
          egressBlocked: true,
        };
      },
    },
  });
  try {
    const outcome = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'disposable-root',
        cmd: 'printf changed > src/stable.txt',
        network: 'none',
      },
      'implementer',
    );

    assert.equal(outcome.status, 'applied');
    assert.notEqual(receivedRoot, h.worktree);
    assert.equal(existsSync(receivedRoot), false, 'the disposable command root is cleaned');
  } finally {
    h.cleanup();
  }
});

test('REQ-2.3/2.13: every Phase 0 network grant is rejected before spawn', async () => {
  let calls = 0;
  const h = harness({
    commandRunner: {
      async run() {
        calls += 1;
        return {
          status: 'completed',
          exitCode: 0,
          evidenceRef: h.evidence.put('must not spawn'),
          egressBlocked: false,
        };
      },
    },
  });
  try {
    const outcome = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'network-grant',
        cmd: 'pnpm install --frozen-lockfile --ignore-scripts',
        network: 'allowlist:package_install',
      },
      'implementer',
    );

    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.equal(outcome.rejection.reason, 'network_grant_unavailable');
    }
    assert.equal(calls, 0);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.31/2.32: a read-only role receives no package scratch or install spawn', async () => {
  let calls = 0;
  const h = harness({
    commandRunner: {
      async run() {
        calls += 1;
        return {
          status: 'completed',
          exitCode: 0,
          evidenceRef: h.evidence.put('must not spawn'),
          egressBlocked: true,
        };
      },
    },
  });
  try {
    const outcome = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'planner-install',
        cmd: 'pnpm install --offline --frozen-lockfile --ignore-scripts',
        network: 'none',
      },
      'planner',
    );

    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.equal(outcome.rejection.reason, 'package_install_denied');
    }
    assert.equal(calls, 0);
    assert.equal(existsSync(join(h.worktree, 'node_modules')), false);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.48/2.49: normal non-zero exit discards partial and ignored writes', async () => {
  let commandRoot = '';
  const h = harness({
    commandRunner: {
      async run(input) {
        commandRoot = input.workspaceRoot;
        writeFileSync(join(input.workspaceRoot, 'src', 'partial.txt'), 'partial\n');
        writeFileSync(join(input.workspaceRoot, 'src', 'residue.ignored'), 'residue\n');
        return {
          status: 'completed',
          exitCode: 9,
          evidenceRef: h.evidence.put('exit 9'),
          egressBlocked: true,
        };
      },
    },
  });
  try {
    const outcome = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'nonzero',
        cmd: 'false',
        network: 'none',
      },
      'implementer',
    );

    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.rejection.reason, 'command_failed');
    assert.equal(existsSync(join(h.worktree, 'src', 'partial.txt')), false);
    assert.equal(existsSync(join(h.worktree, 'src', 'residue.ignored')), false);
    assert.equal(existsSync(commandRoot), false);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.22/2.37-2.40: an ordinary signal is typed without fabricated sandbox attribution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amended-signal-'));
  try {
    const worktree = join(root, 'worktree');
    const { mkdirSync } = process.getBuiltinModule('node:fs');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.keep'), '');
    git(worktree, 'init', '-q', '-b', 'main');
    git(worktree, 'config', 'user.email', 'fixture@example.invalid');
    git(worktree, 'config', 'user.name', 'fixture');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'fixture');
    const evidence = createEvidenceStore(join(root, 'evidence'));
    const runner = createCommandRunner({ sandbox: passthrough, evidence });
    const commands = createCoreCommandExecutor({
      evidence,
      policy: createDefaultPathPolicy(),
      sandbox: passthrough,
      commandRunner: runner,
    });
    const result = await commands.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'ordinary-signal',
        cmd: 'kill -9 $$',
        network: 'none',
        timeoutMs: 1_000,
      },
      { worktreeDir: worktree, role: 'diagnostician', classification: 'read_only_probe' },
    );

    assert.equal(result.status, 'signaled');
    if (result.status === 'signaled') {
      assert.equal(result.signal, 'SIGKILL');
      assert.equal(result.evidence.observedViolation, null);
      assert.equal(result.evidence.backend.denialObservation, 'direct_only');
      assert.equal(result.evidence.backend.revocableDescendantContainment, false);
      assert.equal(result.evidence.backend.descendantTermination, 'unproven_new_session');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-2.5: a backend-owned direct denial observation is preserved as sandbox_violation', async () => {
  const fix = orchestratorHarness({
    run: async () => ({
      status: 'rejected',
      reason: 'sandbox_violation',
      detail: 'backend observed a denied filesystem operation',
      evidenceRef: fix.evidence.put('direct denial'),
      exitCode: 77,
      egressBlocked: true,
      observedViolation: {
        source: 'backend_owned',
        operation: 'filesystem',
      },
    }),
  });
  try {
    const outcome = await mutation(fix.commands, fix.worktree);
    assert.equal(outcome.status, 'sandbox_violation');
    if (outcome.status === 'sandbox_violation') {
      assert.deepEqual(outcome.evidence.observedViolation, {
        source: 'backend_owned',
        operation: 'filesystem',
      });
    }
    assert.equal(readFileSync(join(fix.worktree, 'src', 'stable.txt'), 'utf8'), 'stable\n');
  } finally {
    fix.cleanup();
  }
});

test(
  'REQ-2.21-2.24/2.37-2.40: a swallowed descendant denial has honest null attribution',
  {
    skip:
      process.platform !== 'darwin' || process.env['PHASE0_REAL_MACOS_TESTS'] !== '1'
        ? 'requires explicit execution outside a nested sandbox'
        : false,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'swallowed-descendant-denial-'));
    try {
      const worktree = join(root, 'worktree');
      mkdirSync(join(worktree, 'src'), { recursive: true });
      mkdirSync(join(worktree, 'test', 'golden'), { recursive: true });
      writeFileSync(join(worktree, 'src', 'stable.txt'), 'stable\n');
      git(worktree, 'init', '-q', '-b', 'main');
      git(worktree, 'config', 'user.email', 'fixture@example.invalid');
      git(worktree, 'config', 'user.name', 'fixture');
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-qm', 'fixture');
      const evidence = createEvidenceStore(join(root, 'evidence'));
      const sandbox = denyNetworkSandbox(process.platform);
      const runner = createCommandRunner({ sandbox, evidence });
      const commands = createCoreCommandExecutor({
        evidence,
        policy: createDefaultPathPolicy(),
        sandbox,
        commandRunner: runner,
      });
      const outcome = await commands.execute(
        {
          type: 'RUN_COMMAND',
          actionId: 'swallowed-descendant-denial',
          cmd:
            "(/bin/sh -c 'exec 2>/dev/null; printf denied > test/golden/forbidden.txt' || true) & wait; exit 0",
          network: 'none',
        },
        { worktreeDir: worktree, role: 'implementer', classification: 'artifact_mutation' },
      );

      assert.equal(outcome.status, 'no_changes');
      if (outcome.status === 'no_changes') {
        assert.equal(outcome.evidence.observedViolation, null);
        assert.equal(outcome.evidence.backend.denialObservation, 'direct_only');
        assert.equal(outcome.evidence.backend.revocableDescendantContainment, false);
        assert.equal(outcome.evidence.backend.descendantTermination, 'unproven_new_session');
      }
      assert.equal(existsSync(join(worktree, 'test', 'golden', 'forbidden.txt')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('REQ-2.30: replacing tool bytes at one resolved path changes environmentHash', () => {
  const root = mkdtempSync(join(tmpdir(), 'amended-tool-hash-'));
  try {
    const bin = join(root, 'bin');
    const { mkdirSync } = process.getBuiltinModule('node:fs');
    mkdirSync(bin);
    const pnpm = join(bin, 'pnpm');
    writeFileSync(pnpm, '#!/bin/sh\nprintf first\n');
    chmodSync(pnpm, 0o755);
    const evidence = createEvidenceStore(join(root, 'evidence'));
    const runner = createCommandRunner({
      sandbox: passthrough,
      evidence,
      environment: { PATH: bin },
    });
    const first = runner.environmentHash;

    writeFileSync(pnpm, '#!/bin/sh\nprintf second\n');
    chmodSync(pnpm, 0o755);
    const second = runner.environmentHash;

    assert.match(first ?? '', /^[0-9a-f]{64}$/);
    assert.match(second ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-2.16-2.20/2.42-2.47: only the exact stable captured diff is promoted', async () => {
  let seenRoot = '';
  const h = orchestratorHarness({
    async run(input) {
      seenRoot = input.workspaceRoot;
      writeFileSync(join(input.workspaceRoot, 'src', 'stable.txt'), 'changed\n');
      writeFileSync(join(input.workspaceRoot, 'src', 'added.txt'), 'added\n');
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('exit 0'),
        egressBlocked: true,
      };
    },
  });
  try {
    const outcome = await mutation(h.commands, h.worktree);

    assert.equal(outcome.status, 'promoted');
    if (outcome.status === 'promoted') {
      assert.deepEqual(outcome.capture.affectedPaths, ['src/added.txt', 'src/stable.txt']);
      assert.equal(
        outcome.capture.preCopyInventoryHash,
        outcome.capture.postCopyInventoryHash,
      );
      assert.equal(
        outcome.capture.captureInventoryHash,
        outcome.capture.preCopyInventoryHash,
      );
      assert.equal(outcome.promotedDiffHash, outcome.capture.diffHash);
      assert.equal(outcome.evidence.observedViolation, null);
    }
    assert.equal(readFileSync(join(h.worktree, 'src', 'stable.txt'), 'utf8'), 'changed\n');
    assert.equal(readFileSync(join(h.worktree, 'src', 'added.txt'), 'utf8'), 'added\n');
    assert.notEqual(seenRoot, h.worktree);
    assert.equal(existsSync(seenRoot), false);
  } finally {
    h.cleanup();
  }
});

test('Task 30/REQ-2.18/2.44/REQ-3.6: RUN_COMMAND promotion rejects a swapped symlink parent without escape', async () => {
  let swapped = false;
  const h = orchestratorHarness({
    async run(input) {
      mkdirSync(join(input.workspaceRoot, 'src', 'safe'), { recursive: true });
      writeFileSync(
        join(input.workspaceRoot, 'src', 'safe', 'promoted.txt'),
        'captured\n',
      );
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('exit 0'),
        egressBlocked: true,
      };
    },
    failpoints: {
      at(phase) {
        if (phase !== 'promote' || swapped) return;
        swapped = true;
        rmSync(join(h.worktree, 'src', 'safe'), { recursive: true });
        symlinkSync('../docs', join(h.worktree, 'src', 'safe'));
      },
    },
  });
  try {
    mkdirSync(join(h.worktree, 'src', 'safe'), { recursive: true });
    mkdirSync(join(h.worktree, 'docs'), { recursive: true });

    const outcome = await mutation(
      h.commands,
      h.worktree,
      'run-promotion-parent-swap',
    );

    assert.equal(swapped, true);
    assert.equal(outcome.status, 'capture_rejected');
    assert.equal(existsSync(join(h.worktree, 'docs', 'promoted.txt')), false);
    assert.deepEqual(readdirSync(h.temporaryRoot), []);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.18/2.44: one forbidden or unsupported changed shape rejects the whole diff', async () => {
  for (const scenario of ['golden', 'symlink'] as const) {
    const h = orchestratorHarness({
      async run(input) {
        writeFileSync(join(input.workspaceRoot, 'src', 'allowed.txt'), 'allowed\n');
        if (scenario === 'golden') {
          writeFileSync(join(input.workspaceRoot, 'test', 'golden', 'forbidden.txt'), 'bad\n');
        } else {
          symlinkSync('stable.txt', join(input.workspaceRoot, 'src', 'link.txt'));
        }
        return {
          status: 'completed',
          exitCode: 0,
          evidenceRef: h.evidence.put('exit 0'),
          egressBlocked: true,
        };
      },
    });
    try {
      const outcome = await mutation(h.commands, h.worktree, `shape-${scenario}`);
      assert.equal(outcome.status, 'capture_rejected');
      assert.equal(existsSync(join(h.worktree, 'src', 'allowed.txt')), false);
      assert.equal(
        existsSync(join(h.worktree, 'test', 'golden', 'forbidden.txt')),
        false,
      );
      assert.equal(existsSync(join(h.worktree, 'src', 'link.txt')), false);
      assert.deepEqual(readdirSync(h.temporaryRoot), []);
    } finally {
      h.cleanup();
    }
  }
});

test('REQ-2.44: FIFO and ignored socket reject the whole artifact before promotion', async (t) => {
  for (const scenario of ['fifo-tracked-root', 'socket-ignored-path'] as const) {
    await t.test(scenario, async () => {
      let socketServer: Server | undefined;
      const unsupportedRootPolicy: OfflineDependencyPolicy = {
        version: 1,
        allowedRoles: ['implementer'],
        commands: ['unused'],
        manifestPath: 'package.json',
        manifestHash: '1'.repeat(64),
        lockfilePath: 'pnpm-lock.yaml',
        lockfileHash: '2'.repeat(64),
        approvedSourceHashes: [],
        approvedSources: [],
        persistentOutputRoots: ['node_modules'],
        lifecycleScripts: 'disabled',
        network: 'none',
      };
      const h = orchestratorHarness({
        async run(input) {
          writeFileSync(join(input.workspaceRoot, 'src', 'allowed.txt'), 'allowed\n');
          if (scenario === 'fifo-tracked-root') {
            const { execFileSync } = process.getBuiltinModule('node:child_process');
            execFileSync('/usr/bin/mkfifo', [join(input.workspaceRoot, 'src', 'unsupported.pipe')]);
          } else {
            mkdirSync(join(input.workspaceRoot, 'node_modules'), { recursive: true });
            const socketPath = join(input.workspaceRoot, 'node_modules', 'unsupported.sock');
            socketServer = createServer();
            await new Promise<void>((resolve, reject) => {
              socketServer?.once('error', reject);
              socketServer?.listen(socketPath, resolve);
            });
          }
          return {
            status: 'completed',
            exitCode: 0,
            evidenceRef: h.evidence.put('exit 0'),
            egressBlocked: true,
          };
        },
        offlineDependencyPolicy: unsupportedRootPolicy,
      });
      try {
        const outcome = await mutation(h.commands, h.worktree, `unsupported-${scenario}`);

        assert.equal(outcome.status, 'capture_rejected');
        assert.equal(existsSync(join(h.worktree, 'src', 'allowed.txt')), false);
        assert.deepEqual(readdirSync(h.temporaryRoot), []);
      } finally {
        await new Promise<void>((resolve) => {
          if (socketServer === undefined) {
            resolve();
            return;
          }
          socketServer.close(() => resolve());
        });
        h.cleanup();
      }
    });
  }
});

test('REQ-2.6/2.15/2.19: ignored preexisting state is preserved and new ignored residue is never promoted', async () => {
  const h = orchestratorHarness({
    async run(input) {
      assert.equal(
        existsSync(join(input.workspaceRoot, 'src', 'preexisting.ignored')),
        false,
        'ignored authoritative residue is outside the frozen command input',
      );
      writeFileSync(join(input.workspaceRoot, 'src', 'new.ignored'), 'discard\n');
      writeFileSync(join(input.workspaceRoot, 'src', 'promoted.txt'), 'promote\n');
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('exit 0'),
        egressBlocked: true,
      };
    },
  });
  try {
    writeFileSync(join(h.worktree, 'src', 'preexisting.ignored'), 'preserve\n');
    const outcome = await mutation(h.commands, h.worktree, 'ignored-residue');

    assert.equal(outcome.status, 'promoted');
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'preexisting.ignored'), 'utf8'),
      'preserve\n',
    );
    assert.equal(existsSync(join(h.worktree, 'src', 'new.ignored')), false);
    assert.equal(readFileSync(join(h.worktree, 'src', 'promoted.txt'), 'utf8'), 'promote\n');
  } finally {
    h.cleanup();
  }
});

test('REQ-2.21/2.24/2.28: a delayed write stays in the discarded workspace without a cleanup claim', async () => {
  let delayedFinished: Promise<void> = Promise.resolve();
  const h = orchestratorHarness({
    async run(input) {
      writeFileSync(join(input.workspaceRoot, 'src', 'prompt.txt'), 'prompt\n');
      delayedFinished = delay(300).then(() => {
        try {
          writeFileSync(join(input.workspaceRoot, 'src', 'delayed.txt'), 'late\n');
        } catch {
          // The core discarded the workspace; no whole-descendant termination is claimed.
        }
      });
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('exit 0'),
        egressBlocked: true,
      };
    },
  });
  try {
    const outcome = await mutation(h.commands, h.worktree, 'delayed-residue');
    assert.ok(outcome.status === 'promoted' || outcome.status === 'capture_rejected');
    await delayedFinished;
    assert.equal(existsSync(join(h.worktree, 'src', 'delayed.txt')), false);
    assert.deepEqual(readdirSync(h.temporaryRoot), []);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.42: source churn between inventories rejects capture and promotes nothing', async () => {
  const h = orchestratorHarness({
    async run(input) {
      writeFileSync(join(input.workspaceRoot, 'src', 'churn.txt'), 'before\n');
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('exit 0'),
        egressBlocked: true,
      };
    },
    failpoints: {
      at(phase, state) {
        if (phase === 'post_inventory') {
          writeFileSync(join(state.workspaceRoot, 'src', 'churn.txt'), 'after\n');
        }
      },
    },
  });
  try {
    const outcome = await mutation(h.commands, h.worktree, 'source-churn');
    assert.equal(outcome.status, 'capture_rejected');
    assert.equal(existsSync(join(h.worktree, 'src', 'churn.txt')), false);
    assert.deepEqual(readdirSync(h.temporaryRoot), []);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.42-2.44: a symlink swap at the capture read edge fails closed and cleans the attempt', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'capture-race-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'outside bytes\n');
  let swapped = false;
  const h = orchestratorHarness({
    async run(input) {
      writeFileSync(join(input.workspaceRoot, 'src', 'race.txt'), 'approved bytes\n');
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('exit 0'),
        egressBlocked: true,
      };
    },
    failpoints: {
      at(phase, state) {
        if (
          (phase as string) === 'capture_file_open' &&
          (state as { relativePath?: string }).relativePath === 'src/race.txt' &&
          !swapped
        ) {
          swapped = true;
          const source = join(state.workspaceRoot, 'src', 'race.txt');
          renameSync(source, `${source}.original`);
          symlinkSync(join(outside, 'secret.txt'), source);
        }
      },
    },
  });
  try {
    const outcome = await mutation(h.commands, h.worktree, 'capture-symlink-swap');
    assert.equal(swapped, true);
    assert.equal(outcome.status, 'capture_rejected');
    assert.equal(existsSync(join(h.worktree, 'src', 'race.txt')), false);
    assert.deepEqual(readdirSync(h.temporaryRoot), []);
  } finally {
    h.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('REQ-2.43/2.45: capture destination tamper is rejected and it is never sandbox-writable', async () => {
  let commandWritableRoots: string[] = [];
  let commandRoot = '';
  let captureRoot = '';
  const h = orchestratorHarness({
    async run(input) {
      commandWritableRoots = input.writableRoots;
      commandRoot = input.workspaceRoot;
      writeFileSync(join(input.workspaceRoot, 'src', 'captured.txt'), 'source\n');
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('exit 0'),
        egressBlocked: true,
      };
    },
    failpoints: {
      at(phase, state) {
        if (phase === 'post_inventory' && state.captureRoot !== undefined) {
          captureRoot = state.captureRoot;
          writeFileSync(join(state.captureRoot, 'src', 'captured.txt'), 'tampered\n');
        }
      },
    },
  });
  try {
    const outcome = await mutation(h.commands, h.worktree, 'capture-tamper');
    assert.equal(outcome.status, 'capture_rejected');
    assert.equal(existsSync(join(h.worktree, 'src', 'captured.txt')), false);
    assert.notEqual(captureRoot, '');
    assert.equal(captureRoot.startsWith(`${commandRoot}/`), false);
    assert.equal(commandWritableRoots.some((root) => captureRoot.endsWith(root)), false);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.27/2.28/2.41: every capture bound fails closed and cleans the attempt', async () => {
  const cases: Array<{
    name: string;
    policy: CommandArtifactPolicy;
    write(root: string): void;
  }> = [
    {
      name: 'file-count',
      policy: {
        version: 1,
        maxFiles: 3,
        maxSingleFileBytes: 1_024,
        maxTotalBytes: 8_192,
        maxDiffBytes: 8_192,
        captureTimeoutMs: 5_000,
      },
      write(root) {
        writeFileSync(join(root, 'src', 'one.txt'), '1');
        writeFileSync(join(root, 'src', 'two.txt'), '2');
      },
    },
    {
      name: 'single-file',
      policy: {
        version: 1,
        maxFiles: 20,
        maxSingleFileBytes: 40,
        maxTotalBytes: 8_192,
        maxDiffBytes: 8_192,
        captureTimeoutMs: 5_000,
      },
      write(root) {
        writeFileSync(join(root, 'src', 'large.txt'), 'x'.repeat(41));
      },
    },
    {
      name: 'total-bytes',
      policy: {
        version: 1,
        maxFiles: 20,
        maxSingleFileBytes: 1_024,
        maxTotalBytes: 50,
        maxDiffBytes: 8_192,
        captureTimeoutMs: 5_000,
      },
      write(root) {
        writeFileSync(join(root, 'src', 'total.txt'), 'x'.repeat(30));
      },
    },
    {
      name: 'diff-bytes',
      policy: {
        version: 1,
        maxFiles: 20,
        maxSingleFileBytes: 1_024,
        maxTotalBytes: 8_192,
        maxDiffBytes: 8,
        captureTimeoutMs: 5_000,
      },
      write(root) {
        writeFileSync(join(root, 'src', 'diff.txt'), '123456789');
      },
    },
  ];
  for (const item of cases) {
    const h = orchestratorHarness({
      async run(input) {
        item.write(input.workspaceRoot);
        return {
          status: 'completed',
          exitCode: 0,
          evidenceRef: h.evidence.put('exit 0'),
          egressBlocked: true,
        };
      },
      artifactPolicy: item.policy,
    });
    try {
      const outcome = await mutation(h.commands, h.worktree, `bound-${item.name}`);
      assert.equal(outcome.status, 'capture_rejected', item.name);
      assert.deepEqual(readdirSync(h.temporaryRoot), [], item.name);
      assert.equal(readdirSync(join(h.worktree, 'src')).includes(`${item.name}.txt`), false);
    } finally {
      h.cleanup();
    }
  }
});

test('REQ-2.27/2.28/2.41: capture timeout is finite, explicit, and cleanup-safe', async () => {
  let now = 0;
  const h = orchestratorHarness({
    async run(input) {
      writeFileSync(join(input.workspaceRoot, 'src', 'timeout.txt'), 'timeout\n');
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('exit 0'),
        egressBlocked: true,
      };
    },
    artifactPolicy: {
      version: 1,
      maxFiles: 20,
      maxSingleFileBytes: 1_024,
      maxTotalBytes: 8_192,
      maxDiffBytes: 8_192,
      captureTimeoutMs: 5,
    },
    now: () => now,
    failpoints: {
      at(phase) {
        if (phase === 'copy') now = 6;
      },
    },
  });
  try {
    const outcome = await mutation(h.commands, h.worktree, 'capture-timeout');
    assert.equal(outcome.status, 'capture_rejected');
    assert.equal(existsSync(join(h.worktree, 'src', 'timeout.txt')), false);
    assert.deepEqual(readdirSync(h.temporaryRoot), []);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.28: all lifecycle failpoints, including cleanup, leave no core temporary', async () => {
  for (const injected of [
    'materialize',
    'spawn',
    'pre_inventory',
    'copy',
    'post_inventory',
    'capture_inventory',
    'diff',
    'promote',
    'cleanup',
  ] as const) {
    const h = orchestratorHarness({
      async run(input) {
        writeFileSync(join(input.workspaceRoot, 'src', 'a.txt'), 'a\n');
        writeFileSync(join(input.workspaceRoot, 'src', 'b.txt'), 'b\n');
        return {
          status: 'completed',
          exitCode: 0,
          evidenceRef: h.evidence.put('exit 0'),
          egressBlocked: true,
        };
      },
      failpoints: {
        at(phase) {
          if (phase === injected) throw new Error(`injected ${phase}`);
        },
      },
    });
    try {
      const outcome = await mutation(h.commands, h.worktree, `failpoint-${injected}`);
      if (injected === 'cleanup') {
        assert.equal(outcome.status, 'promoted');
      } else {
        assert.equal(outcome.status, 'capture_rejected', injected);
        assert.equal(existsSync(join(h.worktree, 'src', 'a.txt')), false, injected);
        assert.equal(existsSync(join(h.worktree, 'src', 'b.txt')), false, injected);
      }
      assert.deepEqual(readdirSync(h.temporaryRoot), [], injected);
    } finally {
      h.cleanup();
    }
  }
});

test('REQ-2.31-2.36: exact role/lock/source/lifecycle-disabled offline policy is enforced before spawn', async () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-policy-fixture-'));
    return {
      root,
      ...makeApprovedOfflineFixture(
        root,
        'pnpm install --offline --frozen-lockfile --ignore-scripts',
      ),
    };
  };
  for (const scenario of ['allowed', 'role', 'lock', 'source', 'script', 'output'] as const) {
    let calls = 0;
    const fixture = setup();
    const command =
      scenario === 'script'
        ? 'pnpm install --offline --frozen-lockfile'
        : 'pnpm install --offline --frozen-lockfile --ignore-scripts';
    const h = orchestratorHarness({
      async run(input) {
        calls += 1;
        assert.equal(input.allowNetwork, false);
        assert.ok(input.writableRoots.includes('node_modules'));
        writeFileSync(join(input.workspaceRoot, 'src', 'installed.txt'), 'installed\n');
        const installedRoot = join(
          input.workspaceRoot,
          'node_modules',
          'phase0-offline-dependency',
        );
        mkdirSync(installedRoot, { recursive: true });
        for (const file of ['index.js', 'package.json']) {
          writeFileSync(
            join(installedRoot, file),
            readFileSync(
              join(
                input.workspaceRoot,
                '.phase0-offline-sources',
                'phase0-offline-dependency',
                file,
              ),
            ),
          );
        }
        if (scenario === 'output') {
          writeFileSync(join(installedRoot, 'index.js'), "module.exports = 'tampered';\n");
        }
        return {
          status: 'completed',
          exitCode: 0,
          evidenceRef: h.evidence.put('offline install'),
          egressBlocked: true,
        };
      },
      offlineDependencyPolicy: fixture.policy,
    });
    try {
      writeFileSync(join(h.worktree, 'package.json'), fixture.manifest);
      writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), fixture.lockfile);
      if (scenario === 'lock') writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), 'tampered\n');
      if (scenario === 'source') {
        writeFileSync(join(fixture.sourceRoot, 'index.js'), "module.exports = 'tampered';\n");
      }
      const outcome = await h.commands.execute(
        { type: 'RUN_COMMAND', actionId: `offline-${scenario}`, cmd: command, network: 'none' },
        {
          worktreeDir: h.worktree,
          role: scenario === 'role' ? 'planner' : 'implementer',
          classification: 'artifact_mutation',
        },
      );
      if (scenario === 'allowed') {
        assert.equal(
          outcome.status,
          'promoted',
          'detail' in outcome ? outcome.detail : 'unexpected offline policy outcome',
        );
        assert.equal(calls, 1);
        assert.equal(readFileSync(join(h.worktree, 'src', 'installed.txt'), 'utf8'), 'installed\n');
        assert.equal(
          existsSync(
            join(h.worktree, 'node_modules', 'phase0-offline-dependency', 'index.js'),
          ),
          true,
        );
      } else {
        assert.equal(
          outcome.status,
          scenario === 'lock' || scenario === 'output'
            ? 'capture_rejected'
            : 'preflight_rejected',
          scenario,
        );
        assert.equal(calls, scenario === 'output' ? 1 : 0, scenario);
        assert.equal(existsSync(join(h.worktree, 'node_modules')), false, scenario);
      }
    } finally {
      h.cleanup();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('REQ-2.16-2.19/2.33-2.34: frozen installed bytes are revalidated after capture before promotion', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frozen-installed-source-'));
  const fixture = makeApprovedOfflineFixture(
    fixtureRoot,
    'pnpm install --offline --frozen-lockfile --ignore-scripts',
  );
  let lateMutationApplied = false;
  const h = orchestratorHarness({
    async run(input) {
      const installedRoot = join(
        input.workspaceRoot,
        'node_modules',
        'phase0-offline-dependency',
      );
      mkdirSync(installedRoot, { recursive: true });
      for (const file of ['index.js', 'package.json']) {
        writeFileSync(
          join(installedRoot, file),
          readFileSync(
            join(
              input.workspaceRoot,
              '.phase0-offline-sources',
              'phase0-offline-dependency',
              file,
            ),
          ),
        );
      }
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('offline install'),
        egressBlocked: true,
      };
    },
    offlineDependencyPolicy: fixture.policy,
    failpoints: {
      at(phase, state) {
        if (phase === 'pre_inventory') {
          writeFileSync(
            join(
              state.workspaceRoot,
              'node_modules',
              'phase0-offline-dependency',
              'index.js',
            ),
            "module.exports = 'tampered-after-live-verification';\n",
          );
          lateMutationApplied = true;
        }
      },
    },
  });
  try {
    writeFileSync(join(h.worktree, 'package.json'), fixture.manifest);
    writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), fixture.lockfile);
    const outcome = await h.commands.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'frozen-installed-source-revalidation',
        cmd: fixture.policy.commands[0] as string,
        network: 'none',
      },
      {
        worktreeDir: h.worktree,
        role: 'implementer',
        classification: 'artifact_mutation',
      },
    );

    assert.equal(lateMutationApplied, true);
    assert.equal(outcome.status, 'capture_rejected');
    if (outcome.status === 'capture_rejected') {
      assert.match(outcome.detail, /captured installed output set differs/u);
    }
    assert.equal(existsSync(join(h.worktree, 'node_modules')), false);
    assert.deepEqual(readdirSync(h.temporaryRoot), []);
  } finally {
    h.cleanup();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('REQ-2.16-2.19/2.33-2.34/2.42-2.45: exact captured installed set rejects late unapproved additions and deletions', async (t) => {
  for (const scenario of [
    'sibling-package',
    'root-file',
    'manager-metadata',
    'binary-entry',
    'deleted-approved-file',
  ] as const) {
    await t.test(scenario, async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), `exact-installed-set-${scenario}-`));
      const fixture = makeApprovedOfflineFixture(
        fixtureRoot,
        'pnpm install --offline --frozen-lockfile --ignore-scripts',
      );
      let lateMutationApplied = false;
      const h = orchestratorHarness({
        async run(input) {
          const installedRoot = join(
            input.workspaceRoot,
            'node_modules',
            'phase0-offline-dependency',
          );
          mkdirSync(installedRoot, { recursive: true });
          for (const file of ['index.js', 'package.json']) {
            writeFileSync(
              join(installedRoot, file),
              readFileSync(
                join(
                  input.workspaceRoot,
                  '.phase0-offline-sources',
                  'phase0-offline-dependency',
                  file,
                ),
              ),
            );
          }
          return {
            status: 'completed',
            exitCode: 0,
            evidenceRef: h.evidence.put('offline install'),
            egressBlocked: true,
          };
        },
        offlineDependencyPolicy: fixture.policy,
        failpoints: {
          at(phase, state) {
            if (phase !== 'pre_inventory') return;
            const nodeModules = join(state.workspaceRoot, 'node_modules');
            if (scenario === 'sibling-package') {
              const rogueRoot = join(nodeModules, 'rogue-package');
              mkdirSync(rogueRoot, { recursive: true });
              writeFileSync(
                join(rogueRoot, 'package.json'),
                '{"name":"rogue-package","version":"9.9.9"}\n',
              );
            } else if (scenario === 'root-file') {
              writeFileSync(join(nodeModules, 'rogue.txt'), 'rogue\n');
            } else if (scenario === 'manager-metadata') {
              writeFileSync(join(nodeModules, '.modules.yaml'), 'rogue: true\n');
            } else if (scenario === 'binary-entry') {
              const binaryRoot = join(nodeModules, '.bin');
              mkdirSync(binaryRoot, { recursive: true });
              const binary = join(binaryRoot, 'rogue');
              writeFileSync(binary, '#!/bin/sh\nexit 0\n');
              chmodSync(binary, 0o755);
            } else {
              rmSync(
                join(
                  nodeModules,
                  'phase0-offline-dependency',
                  'index.js',
                ),
              );
            }
            lateMutationApplied = true;
          },
        },
      });
      try {
        writeFileSync(join(h.worktree, 'package.json'), fixture.manifest);
        writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), fixture.lockfile);
        const outcome = await h.commands.execute(
          {
            type: 'RUN_COMMAND',
            actionId: `exact-installed-set-${scenario}`,
            cmd: fixture.policy.commands[0] as string,
            network: 'none',
          },
          {
            worktreeDir: h.worktree,
            role: 'implementer',
            classification: 'artifact_mutation',
          },
        );

        assert.equal(lateMutationApplied, true);
        assert.equal(outcome.status, 'capture_rejected', scenario);
        if (outcome.status === 'capture_rejected') {
          assert.match(outcome.detail, /captured installed output set differs/u);
        }
        assert.equal(existsSync(join(h.worktree, 'node_modules')), false, scenario);
        assert.deepEqual(readdirSync(h.temporaryRoot), [], scenario);
      } finally {
        h.cleanup();
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  }
});

test('REQ-2.16-2.19/2.33-2.34/2.42-2.45: explicitly enumerated manager metadata is content-validated', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'validated-manager-metadata-'));
  const fixture = makeApprovedOfflineFixture(
    fixtureRoot,
    'pnpm install --offline --frozen-lockfile --ignore-scripts',
  );
  fixture.policy.approvedOutputMetadata = [
    {
      path: 'node_modules/.modules.yaml',
      validator: 'pnpm_modules_json_v1',
      packageManager: 'pnpm@11.9.0',
    },
  ];
  const h = orchestratorHarness({
    async run(input) {
      const installedRoot = join(
        input.workspaceRoot,
        'node_modules',
        'phase0-offline-dependency',
      );
      mkdirSync(installedRoot, { recursive: true });
      for (const file of ['index.js', 'package.json']) {
        writeFileSync(
          join(installedRoot, file),
          readFileSync(
            join(
              input.workspaceRoot,
              '.phase0-offline-sources',
              'phase0-offline-dependency',
              file,
            ),
          ),
        );
      }
      writeFileSync(
        join(input.workspaceRoot, 'node_modules', '.modules.yaml'),
        '{"packageManager":"pnpm@11.9.0","hoistedDependencies":{"rogue@9.9.9":{"rogue":"private"}}}\n',
      );
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('offline install with tampered metadata'),
        egressBlocked: true,
      };
    },
    offlineDependencyPolicy: fixture.policy,
  });
  try {
    writeFileSync(join(h.worktree, 'package.json'), fixture.manifest);
    writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), fixture.lockfile);
    const outcome = await h.commands.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'validated-manager-metadata',
        cmd: fixture.policy.commands[0] as string,
        network: 'none',
      },
      {
        worktreeDir: h.worktree,
        role: 'implementer',
        classification: 'artifact_mutation',
      },
    );

    assert.equal(outcome.status, 'capture_rejected');
    if (outcome.status === 'capture_rejected') {
      assert.match(outcome.detail, /approved pnpm modules metadata/u);
    }
    assert.equal(existsSync(join(h.worktree, 'node_modules')), false);
    assert.deepEqual(readdirSync(h.temporaryRoot), []);
  } finally {
    h.cleanup();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('REQ-2.27/2.28/2.41: approved source capture obeys file, byte, and time bounds before spawn', async (t) => {
  for (const scenario of ['file-count', 'total-bytes', 'deadline'] as const) {
    await t.test(scenario, async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), `approved-source-${scenario}-`));
      const fixture = makeApprovedOfflineFixture(
        fixtureRoot,
        'pnpm install --offline --frozen-lockfile --ignore-scripts',
      );
      if (scenario === 'file-count') {
        for (let index = 0; index < 5; index += 1) {
          writeFileSync(join(fixture.sourceRoot, `extra-${index}.js`), `${index}\n`);
        }
        rebindApprovedSourceHash(fixture.policy, fixture.sourceRoot);
      } else if (scenario === 'total-bytes') {
        writeFileSync(join(fixture.sourceRoot, 'large-source.js'), 'x'.repeat(1_500));
        rebindApprovedSourceHash(fixture.policy, fixture.sourceRoot);
      }
      let commandCalls = 0;
      let clockCalls = 0;
      const policy: CommandArtifactPolicy = {
        version: 1,
        maxFiles: scenario === 'file-count' ? 5 : 20,
        maxSingleFileBytes: 2_048,
        maxTotalBytes: scenario === 'total-bytes' ? 1_000 : 8_192,
        maxDiffBytes: 8_192,
        captureTimeoutMs: scenario === 'deadline' ? 5 : 5_000,
      };
      const h = orchestratorHarness({
        async run() {
          commandCalls += 1;
          return {
            status: 'completed',
            exitCode: 0,
            evidenceRef: h.evidence.put('must not spawn'),
            egressBlocked: true,
          };
        },
        offlineDependencyPolicy: fixture.policy,
        artifactPolicy: policy,
        ...(scenario === 'deadline'
          ? { now: () => (clockCalls++ === 0 ? 0 : 10) }
          : {}),
      });
      try {
        writeFileSync(join(h.worktree, 'package.json'), fixture.manifest);
        writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), fixture.lockfile);
        const outcome = await h.commands.execute(
          {
            type: 'RUN_COMMAND',
            actionId: `approved-source-${scenario}`,
            cmd: fixture.policy.commands[0] as string,
            network: 'none',
          },
          {
            worktreeDir: h.worktree,
            role: 'implementer',
            classification: 'artifact_mutation',
          },
        );

        assert.equal(outcome.status, 'preflight_rejected');
        if (outcome.status === 'preflight_rejected') {
          assert.equal(
            outcome.reason,
            scenario === 'deadline' ? 'timed_out' : 'offline_dependency_unavailable',
          );
          assert.match(
            outcome.detail,
            scenario === 'file-count'
              ? /approved offline source exceeds maxFiles=5/u
              : scenario === 'total-bytes'
                ? /approved offline source exceeds maxTotalBytes=1000/u
                : /command artifact capture exceeds captureTimeoutMs=5/u,
          );
        }
        assert.equal(commandCalls, 0);
        assert.equal(existsSync(join(h.worktree, 'node_modules')), false);
        assert.deepEqual(readdirSync(h.temporaryRoot), []);
      } finally {
        h.cleanup();
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  }
});

test('REQ-2.27/2.28/2.41: descriptor reads obey the remaining deadline and cancellation signal in flight', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'descriptor-deadline-'));
  const large = join(root, 'large.bin');
  writeFileSync(large, Buffer.alloc(16 * 1024 * 1024, 0x61));
  try {
    await t.test('remaining deadline', async () => {
      const startedAt = performance.now();
      await assert.rejects(
        readRegularFileByDescriptor(root, 'large.bin', 32 * 1024 * 1024, {
          timeoutMs: 1,
        }),
        /timed out/u,
      );
      assert.ok(performance.now() - startedAt < 1_000);
    });

    await t.test('AbortSignal', async () => {
      const controller = new AbortController();
      controller.abort();
      const startedAt = performance.now();
      await assert.rejects(
        readRegularFileByDescriptor(root, 'large.bin', 32 * 1024 * 1024, {
          timeoutMs: 5_000,
          signal: controller.signal,
        }),
        /cancelled/u,
      );
      assert.ok(performance.now() - startedAt < 1_000);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-2.27/2.28/2.41: the shared deadline bounds in-flight Git preparation and cleans immediately', async () => {
  let commandCalls = 0;
  const h = orchestratorHarness({
    async run() {
      commandCalls += 1;
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('must not spawn after Git timeout'),
        egressBlocked: true,
      };
    },
    artifactPolicy: {
      version: 1,
      maxFiles: 20,
      maxSingleFileBytes: 1_024,
      maxTotalBytes: 8_192,
      maxDiffBytes: 8_192,
      captureTimeoutMs: 1,
    },
  });
  try {
    const startedAt = performance.now();
    const outcome = await mutation(h.commands, h.worktree, 'git-deadline');

    assert.equal(outcome.status, 'capture_rejected');
    if (outcome.status === 'capture_rejected') {
      assert.equal(outcome.reason, 'timed_out');
    }
    assert.ok(performance.now() - startedAt < 1_000);
    assert.equal(commandCalls, 0);
    assert.equal(existsSync(join(h.worktree, 'src', 'timeout.txt')), false);
    assert.deepEqual(readdirSync(h.temporaryRoot), []);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.27/2.28/2.41: one cancellation signal stops every capture stage without promotion or leaks', async (t) => {
  for (const cancelledAt of [
    'freeze_input',
    'materialize',
    'spawn',
    'pre_inventory',
    'copy',
    'post_inventory',
    'capture_inventory',
    'diff',
    'evidence',
    'promote',
  ] as const) {
    await t.test(cancelledAt, async () => {
      const controller = new AbortController();
      const h = orchestratorHarness({
        async run(input) {
          writeFileSync(join(input.workspaceRoot, 'src', 'cancelled-a.txt'), 'a\n');
          writeFileSync(join(input.workspaceRoot, 'src', 'cancelled-b.txt'), 'b\n');
          return {
            status: 'completed',
            exitCode: 0,
            evidenceRef: h.evidence.put('exit 0'),
            egressBlocked: true,
          };
        },
        failpoints: {
          at(phase) {
            if (phase === cancelledAt) controller.abort();
          },
        },
      });
      try {
        const outcome = await h.commands.execute(
          {
            type: 'RUN_COMMAND',
            actionId: `cancel-${cancelledAt}`,
            cmd: 'fixture-command',
            network: 'none',
          },
          {
            worktreeDir: h.worktree,
            role: 'implementer',
            classification: 'artifact_mutation',
            signal: controller.signal,
          },
        );

        assert.equal(outcome.status, 'capture_rejected', cancelledAt);
        if (outcome.status === 'capture_rejected') {
          assert.equal(outcome.reason, 'cancelled', cancelledAt);
        }
        assert.equal(
          existsSync(join(h.worktree, 'src', 'cancelled-a.txt')),
          false,
          cancelledAt,
        );
        assert.equal(
          existsSync(join(h.worktree, 'src', 'cancelled-b.txt')),
          false,
          cancelledAt,
        );
        assert.deepEqual(readdirSync(h.temporaryRoot), [], cancelledAt);
      } finally {
        h.cleanup();
      }
    });
  }
});

test('REQ-2.14/2.33/2.34: a non-empty graph without a supported source identity rejects before spawn', async () => {
  let calls = 0;
  const manifest = JSON.stringify({
    name: 'missing-integrity',
    version: '1.0.0',
    dependencies: { foo: '1.0.0' },
  });
  const lockfile = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      foo:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    'packages:',
    '  foo@1.0.0:',
    '    resolution: {tarball: https://example.invalid/foo.tgz}',
    '',
  ].join('\n');
  const policy = {
    version: 1,
    allowedRoles: ['implementer'],
    commands: ['pnpm install --offline --frozen-lockfile --ignore-scripts'],
    manifestPath: 'package.json',
    manifestHash: sha256(manifest),
    lockfilePath: 'pnpm-lock.yaml',
    lockfileHash: sha256(lockfile),
    approvedSourceHashes: [],
    approvedSources: [],
    persistentOutputRoots: ['node_modules'],
    lifecycleScripts: 'disabled',
    network: 'none',
  } as OfflineDependencyPolicy;
  const h = orchestratorHarness({
    async run() {
      calls += 1;
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('must not spawn'),
        egressBlocked: true,
      };
    },
    offlineDependencyPolicy: policy,
  });
  try {
    writeFileSync(join(h.worktree, 'package.json'), manifest);
    writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), lockfile);
    const outcome = await h.commands.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'missing-source-identity',
        cmd: policy.commands[0] as string,
        network: 'none',
      },
      {
        worktreeDir: h.worktree,
        role: 'implementer',
        classification: 'artifact_mutation',
      },
    );
    assert.equal(outcome.status, 'preflight_rejected');
    assert.equal(calls, 0);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.14/2.31-2.36: missing approved source bytes reject before package spawn', async () => {
  let calls = 0;
  const missingSourceRoot = mkdtempSync(join(tmpdir(), 'missing-approved-source-'));
  rmSync(missingSourceRoot, { recursive: true, force: true });
  const manifest = JSON.stringify({
    name: 'missing-source',
    version: '1.0.0',
    dependencies: {
      'phase0-offline-dependency':
        'file:.phase0-offline-sources/phase0-offline-dependency',
    },
  });
  const lockfile = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      phase0-offline-dependency:',
    '        specifier: file:.phase0-offline-sources/phase0-offline-dependency',
    '        version: file:.phase0-offline-sources/phase0-offline-dependency',
    '',
  ].join('\n');
  const policy = {
    version: 1,
    allowedRoles: ['implementer'],
    commands: ['pnpm install --offline --frozen-lockfile --ignore-scripts'],
    manifestPath: 'package.json',
    manifestHash: sha256(manifest),
    lockfilePath: 'pnpm-lock.yaml',
    lockfileHash: sha256(lockfile),
    approvedSourceHashes: ['f'.repeat(64)],
    approvedSources: [
      {
        packageName: 'phase0-offline-dependency',
        specifier: 'file:.phase0-offline-sources/phase0-offline-dependency',
        targetPath: '.phase0-offline-sources/phase0-offline-dependency',
        sourcePath: join(missingSourceRoot, 'phase0-offline-dependency'),
        contentHash: 'f'.repeat(64),
      },
    ],
    persistentOutputRoots: ['node_modules'],
    lifecycleScripts: 'disabled',
    network: 'none',
  } as OfflineDependencyPolicy;
  const h = orchestratorHarness({
    async run() {
      calls += 1;
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('must not spawn'),
        egressBlocked: true,
      };
    },
    offlineDependencyPolicy: policy,
  });
  try {
    writeFileSync(join(h.worktree, 'package.json'), manifest);
    writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), lockfile);
    const outcome = await h.commands.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'missing-source-bytes',
        cmd: policy.commands[0] as string,
        network: 'none',
      },
      {
        worktreeDir: h.worktree,
        role: 'implementer',
        classification: 'artifact_mutation',
      },
    );
    assert.equal(outcome.status, 'preflight_rejected');
    assert.equal(calls, 0);
  } finally {
    h.cleanup();
  }
});

test('REQ-2.14/2.31-2.36: a non-empty approved offline graph installs and persists for a later command', async () => {
  const approvedRoot = mkdtempSync(join(tmpdir(), 'approved-offline-source-'));
  const sourceRoot = join(approvedRoot, 'phase0-offline-dependency');
  mkdirSync(sourceRoot);
  const sourcePackage = JSON.stringify({
    name: 'phase0-offline-dependency',
    version: '1.0.0',
    main: 'index.js',
    scripts: {
      install: 'node -e "require(\'node:fs\').writeFileSync(\'INSTALL_SCRIPT_RAN\', \'bad\')"',
    },
  });
  const sourceModule = "module.exports = 'approved-offline-value';\n";
  writeFileSync(join(sourceRoot, 'package.json'), sourcePackage);
  writeFileSync(join(sourceRoot, 'index.js'), sourceModule);
  const sourceHash = sha256(
    JSON.stringify([
      { path: 'index.js', sha256: sha256(sourceModule) },
      { path: 'package.json', sha256: sha256(sourcePackage) },
    ]),
  );
  const specifier = 'file:.phase0-offline-sources/phase0-offline-dependency';
  const manifest = JSON.stringify({
    name: 'offline-consumer',
    version: '1.0.0',
    private: true,
    dependencies: { 'phase0-offline-dependency': specifier },
  });
  const lockfile = [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      phase0-offline-dependency:',
    `        specifier: ${specifier}`,
    `        version: ${specifier}`,
    '',
    'packages:',
    '',
    `  phase0-offline-dependency@${specifier}:`,
    `    resolution: {directory: .phase0-offline-sources/phase0-offline-dependency, type: directory}`,
    '',
    'snapshots:',
    '',
    `  phase0-offline-dependency@${specifier}: {}`,
    '',
  ].join('\n');
  const install =
    'pnpm install --offline --frozen-lockfile --ignore-scripts --config.node-linker=hoisted';
  const policy: OfflineDependencyPolicy = {
    version: 1,
    allowedRoles: ['implementer'],
    commands: [install],
    manifestPath: 'package.json',
    manifestHash: sha256(manifest),
    lockfilePath: 'pnpm-lock.yaml',
    lockfileHash: sha256(lockfile),
    approvedSourceHashes: [sourceHash],
    approvedSources: [
      {
        packageName: 'phase0-offline-dependency',
        specifier,
        targetPath: '.phase0-offline-sources/phase0-offline-dependency',
        sourcePath: sourceRoot,
        contentHash: sourceHash,
      },
    ],
    approvedOutputMetadata: [
      {
        path: 'node_modules/.modules.yaml',
        validator: 'pnpm_modules_json_v1',
        packageManager: 'pnpm@11.9.0',
      },
      {
        path: 'node_modules/.package-map.json',
        validator: 'pnpm_package_map_json_v1',
      },
      {
        path: 'node_modules/.pnpm-workspace-state-v1.json',
        validator: 'pnpm_workspace_state_json_v1',
      },
      {
        path: 'node_modules/.pnpm/lock.yaml',
        validator: 'exact_lockfile_v1',
      },
    ],
    persistentOutputRoots: ['node_modules'],
    lifecycleScripts: 'disabled',
    network: 'none',
  };
  const h = orchestratorHarness({ offlineDependencyPolicy: policy });
  try {
    writeFileSync(join(h.worktree, 'package.json'), manifest);
    writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), lockfile);
    const installed = await h.commands.execute(
      { type: 'RUN_COMMAND', actionId: 'real-offline-install', cmd: install, network: 'none' },
      {
        worktreeDir: h.worktree,
        role: 'implementer',
        classification: 'artifact_mutation',
      },
    );
    assert.equal(
      installed.status,
      'promoted',
      'detail' in installed ? installed.detail : 'unexpected offline install outcome',
    );
    assert.equal(
      readFileSync(
        join(h.worktree, 'node_modules', 'phase0-offline-dependency', 'index.js'),
        'utf8',
      ),
      sourceModule,
    );
    assert.equal(existsSync(join(h.worktree, 'INSTALL_SCRIPT_RAN')), false);

    const consumed = await h.commands.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'consume-persisted-offline-dependency',
        cmd: "node -e \"if (require('phase0-offline-dependency') !== 'approved-offline-value') process.exit(9)\"",
        network: 'none',
      },
      {
        worktreeDir: h.worktree,
        role: 'diagnostician',
        classification: 'read_only_probe',
      },
    );
    assert.equal(consumed.status, 'completed');
    if (consumed.status === 'completed') assert.equal(consumed.exitCode, 0);
  } finally {
    h.cleanup();
    rmSync(approvedRoot, { recursive: true, force: true });
  }
});

test('REQ-2.33/2.36: dependency policy is revalidated from the frozen command workspace', async () => {
  let calls = 0;
  const approvedRoot = mkdtempSync(join(tmpdir(), 'frozen-policy-source-'));
  const fixture = makeApprovedOfflineFixture(
    approvedRoot,
    'pnpm install --offline --frozen-lockfile --ignore-scripts',
  );
  const h = orchestratorHarness({
    async run() {
      calls += 1;
      return {
        status: 'completed',
        exitCode: 0,
        evidenceRef: h.evidence.put('must not spawn'),
        egressBlocked: true,
      };
    },
    offlineDependencyPolicy: fixture.policy,
    failpoints: {
      at(phase) {
        if ((phase as string) === 'freeze_input') {
          writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), 'tampered before freeze\n');
        }
      },
    },
  });
  try {
    writeFileSync(join(h.worktree, 'package.json'), fixture.manifest);
    writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), fixture.lockfile);
    const outcome = await h.commands.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'frozen-lock-revalidation',
        cmd: 'pnpm install --offline --frozen-lockfile --ignore-scripts',
        network: 'none',
      },
      {
        worktreeDir: h.worktree,
        role: 'implementer',
        classification: 'artifact_mutation',
      },
    );
    assert.equal(outcome.status, 'capture_rejected');
    assert.equal(calls, 0);
  } finally {
    h.cleanup();
    rmSync(approvedRoot, { recursive: true, force: true });
  }
});

test('REQ-2.25/2.26/2.29/2.37-2.40: read-only probe preserves direct exit/output evidence and honest capabilities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'read-only-command-'));
  try {
    const worktree = join(root, 'worktree');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'stable.txt'), 'stable\n');
    git(worktree, 'init', '-q', '-b', 'main');
    git(worktree, 'config', 'user.email', 'fixture@example.invalid');
    git(worktree, 'config', 'user.name', 'fixture');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-qm', 'fixture');
    const evidence = createEvidenceStore(join(root, 'evidence'));
    const runner = createCommandRunner({ sandbox: passthrough, evidence });
    const commands = createCoreCommandExecutor({
      evidence,
      policy: createDefaultPathPolicy(),
      sandbox: passthrough,
      commandRunner: runner,
    });
    const outcome = await commands.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'read-only',
        cmd: 'printf probe-output; printf discarded > src/probe.txt; exit 7',
        network: 'none',
      },
      { worktreeDir: worktree, role: 'diagnostician', classification: 'read_only_probe' },
    );

    assert.equal(outcome.status, 'completed');
    if (outcome.status === 'completed') {
      assert.equal(outcome.exitCode, 7);
      assert.match(evidence.getText(outcome.evidence.outputRef), /probe-output/);
      assert.match(outcome.evidence.networkPolicyHash, /^[0-9a-f]{64}$/);
      assert.match(outcome.evidence.environmentHash, /^[0-9a-f]{64}$/);
      assert.equal(outcome.evidence.observedViolation, null);
      assert.deepEqual(outcome.evidence.backend, {
        inheritedFilesystemAndNetworkPolicy: true,
        denialObservation: 'direct_only',
        revocableDescendantContainment: false,
        descendantTermination: 'unproven_new_session',
      });
    }
    assert.equal(existsSync(join(worktree, 'src', 'probe.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
