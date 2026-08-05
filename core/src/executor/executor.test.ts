// Phase 0 dependency-install policy. Every network grant fails before spawn; the
// only install path is exact-lockfile/content-hash-approved offline execution with
// lifecycle scripts disabled and network:none.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  CrashInjected,
  createExecutor,
  recoverWorktree,
  type ArtifactIdentityPolicy,
  type Failpoints,
} from './executor.ts';
import type {
  CoreCommandExecutor,
  OfflineDependencyPolicy,
} from './command-executor.ts';
import { createDefaultPathPolicy } from './path-policy.ts';
import { denyNetworkSandbox, type SandboxWrap } from '../security/sandbox.ts';
import { createEvidenceStore, EvidenceStoreError } from '../evidence/store.ts';
import { openEventLog } from '../state/event-log.ts';
import type { Action } from '../types.ts';

const realMacOSOnly = {
  skip:
    process.platform !== 'darwin' || process.env['PHASE0_REAL_MACOS_TESTS'] !== '1'
      ? 'requires explicit execution outside a nested sandbox'
      : false,
};
const clock = { now: () => 1_000_000 };
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// A sandbox that reports available without needing darwin — used only for the
// policy REJECT paths, which return before any command is wrapped/run.
const FAKE_AVAILABLE: SandboxWrap = {
  kind: 'available',
  wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
};

interface InjectedCommand {
  command: string;
  workspaceRoot: string;
  cwd: string;
  writableRoots: string[];
  protectedRoots: string[];
  allowNetwork: false;
  timeoutMs: number;
}

interface InjectedCommandRunner {
  run(input: InjectedCommand): Promise<
    | {
        status: 'completed';
        exitCode: number;
        evidenceRef: string;
        egressBlocked: boolean;
      }
    | {
        status: 'rejected';
        reason: 'sandbox_unavailable' | 'sandbox_violation';
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
}

function harness(opts: {
  git?: boolean;
  sandbox?: SandboxWrap;
  commandRunner?: InjectedCommandRunner;
  coreCommandExecutor?: CoreCommandExecutor;
  commandSignal?: AbortSignal;
  artifactIdentityPolicy?: Readonly<ArtifactIdentityPolicy>;
  artifactIdentityBeforeFileOpen?: (relativePath: string) => void;
  offlineDependencyPolicy?: OfflineDependencyPolicy;
  failpoints?: Failpoints;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'exec-'));
  const worktree = join(root, 'wt');
  execFileSync('mkdir', ['-p', worktree]);
  if (opts.git) {
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: worktree });
    writeFileSync(join(worktree, '.keep'), '');
    execFileSync('git', ['add', '-A'], { cwd: worktree });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: worktree });
  }
  const evidence = createEvidenceStore(join(root, 'evidence'));
  const log = openEventLog(join(root, 'events.db'), clock);
  const executorOptions = {
    worktreeDir: worktree,
    runId: 'RUN-1',
    taskId: 'T-1',
    log,
    evidence,
    policy: createDefaultPathPolicy(),
    sandbox: opts.sandbox ?? denyNetworkSandbox(process.platform),
    clock,
    ...(opts.commandRunner ? { commandRunner: opts.commandRunner } : {}),
    ...(opts.coreCommandExecutor ? { coreCommandExecutor: opts.coreCommandExecutor } : {}),
    ...(opts.commandSignal ? { commandSignal: opts.commandSignal } : {}),
    ...(opts.artifactIdentityPolicy
      ? { artifactIdentityPolicy: opts.artifactIdentityPolicy }
      : {}),
    ...(opts.artifactIdentityBeforeFileOpen
      ? {
          artifactIdentityBeforeFileOpen:
            opts.artifactIdentityBeforeFileOpen,
        }
      : {}),
    ...(opts.offlineDependencyPolicy
      ? { offlineDependencyPolicy: opts.offlineDependencyPolicy }
      : {}),
    ...(opts.failpoints ? { failpoints: opts.failpoints } : {}),
  };
  const executor = createExecutor(executorOptions);
  return {
    root,
    worktree,
    executor,
    executorOptions,
    cleanup: () => {
      log.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function commitFixture(worktree: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: worktree });
  execFileSync('git', ['commit', '-qm', message], { cwd: worktree });
}

function captureStagedPatch(
  worktree: string,
  mutate: () => void,
  restore: () => void,
): Buffer {
  mutate();
  execFileSync('git', ['add', '-A'], { cwd: worktree });
  const patch = execFileSync(
    'git',
    ['diff', '--cached', '--binary', '--find-renames', 'HEAD'],
    { cwd: worktree },
  );
  restore();
  execFileSync('git', ['add', '-A'], { cwd: worktree });
  return patch;
}

const install = (cmd: string): Action => ({
  type: 'RUN_COMMAND',
  actionId: 'a',
  cmd,
  network: 'allowlist:package_install',
});

// --- pure gate (REQ-11.2) ---

test('the shipped security-plane policy is exact, offline-only, and lifecycle-disabled', () => {
  const raw = JSON.parse(readFileSync(join(REPO, '.ai/policies/security-plane.json'), 'utf8')) as {
    offlineDependency: OfflineDependencyPolicy;
  };
  assert.equal(raw.offlineDependency.network, 'none');
  assert.equal(raw.offlineDependency.lifecycleScripts, 'disabled');
  assert.deepEqual(raw.offlineDependency.allowedRoles, ['implementer']);
  assert.deepEqual(raw.offlineDependency.commands, [
    'pnpm install --offline --frozen-lockfile --ignore-scripts --config.node-linker=hoisted',
  ]);
  assert.match(raw.offlineDependency.manifestHash, /^[0-9a-f]{64}$/);
  assert.match(raw.offlineDependency.lockfileHash, /^[0-9a-f]{64}$/);
  assert.equal(raw.offlineDependency.approvedSources.length, 1);
  assert.equal(
    raw.offlineDependency.approvedSources[0]?.contentHash,
    raw.offlineDependency.approvedSourceHashes[0],
  );
  assert.deepEqual(raw.offlineDependency.persistentOutputRoots, ['node_modules']);
});

// --- executor gating (REQ-11.2/11.3/11.7) ---

test('package_install network grant is rejected before sandbox selection', async () => {
  const h = harness({
    sandbox: denyNetworkSandbox('linux'),
  });
  try {
    const out = await h.executor.execute(install('echo hi'), 'implementer');
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'network_grant_unavailable');
  } finally {
    h.cleanup();
  }
});

test('package_install with no configured policy is denied (REQ-11.2)', async () => {
  const h = harness({ sandbox: FAKE_AVAILABLE });
  try {
    const out = await h.executor.execute(install('echo hi'), 'implementer');
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'network_grant_unavailable');
  } finally {
    h.cleanup();
  }
});

test('package_install whose command near-misses the pattern is denied (REQ-11.2)', async () => {
  const h = harness({
    sandbox: FAKE_AVAILABLE,
  });
  try {
    const out = await h.executor.execute(install('pnpm install'), 'implementer');
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'network_grant_unavailable');
  } finally {
    h.cleanup();
  }
});

test('an unknown network grant name is denied before spawn', async () => {
  const h = harness({ sandbox: FAKE_AVAILABLE });
  try {
    const out = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'a', cmd: 'curl x', network: 'allowlist:egress_all' },
      'implementer',
    );
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'network_grant_unavailable');
  } finally {
    h.cleanup();
  }
});

test('REQ-2.4/2.5/2.6: planner RUN_COMMAND receives no durable write roots and rejects an escape write', async () => {
  let request: InjectedCommand | undefined;
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'executor-boundary-evidence-'));
  const boundaryEvidence = createEvidenceStore(evidenceRoot);
  const denialRef = boundaryEvidence.put('sandbox:enforced\nfilesystem-write-denied:true\nexit:1\n');
  const commandRunner: InjectedCommandRunner = {
    async run(input) {
      request = input;
      return {
        status: 'rejected',
        reason: 'sandbox_violation',
        detail: 'write outside role roots denied',
        evidenceRef: denialRef,
        exitCode: 1,
        egressBlocked: true,
        observedViolation: { source: 'backend_owned', operation: 'filesystem' },
      };
    },
  };
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE, commandRunner });
  try {
    const out = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'planner-write', cmd: 'printf bypass > src/planner.txt', network: 'none' },
      'planner',
    );
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'sandbox_violation');
    assert.deepEqual(request?.writableRoots, []);
    assert.deepEqual(request?.protectedRoots, ['test/golden']);
    assert.equal(existsSync(join(h.worktree, 'src', 'planner.txt')), false);
  } finally {
    h.cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('REQ-2.4/2.5/2.6: test_designer RUN_COMMAND is restricted to test/ai-generated', async () => {
  let request: InjectedCommand | undefined;
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'executor-boundary-evidence-'));
  const boundaryEvidence = createEvidenceStore(evidenceRoot);
  const denialRef = boundaryEvidence.put('sandbox:enforced\nfilesystem-write-denied:true\nexit:1\n');
  const commandRunner: InjectedCommandRunner = {
    async run(input) {
      request = input;
      return {
        status: 'rejected',
        reason: 'sandbox_violation',
        detail: 'write outside role roots denied',
        evidenceRef: denialRef,
        exitCode: 1,
        egressBlocked: true,
        observedViolation: { source: 'backend_owned', operation: 'filesystem' },
      };
    },
  };
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE, commandRunner });
  try {
    const out = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'test-write', cmd: 'printf bypass > src/test-agent.txt', network: 'none' },
      'test_designer',
    );
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'sandbox_violation');
    assert.deepEqual(request?.writableRoots, ['test/ai-generated']);
    assert.equal(existsSync(join(h.worktree, 'src', 'test-agent.txt')), false);
  } finally {
    h.cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('REQ-2.31-2.36: exact offline install reaches the shared boundary under network:none', async () => {
  let request: InjectedCommand | undefined;
  const command = 'pnpm install --offline --frozen-lockfile --ignore-scripts';
  const approvedRoot = mkdtempSync(join(tmpdir(), 'executor-approved-source-'));
  const sourceRoot = join(approvedRoot, 'phase0-offline-dependency');
  mkdirSync(sourceRoot);
  const sourcePackage = JSON.stringify({
    name: 'phase0-offline-dependency',
    version: '1.0.0',
    main: 'index.js',
  });
  const sourceModule = "module.exports = 'approved';\n";
  writeFileSync(join(sourceRoot, 'package.json'), sourcePackage);
  writeFileSync(join(sourceRoot, 'index.js'), sourceModule);
  const sourceHash = createHash('sha256')
    .update(
      JSON.stringify([
        {
          path: 'index.js',
          sha256: createHash('sha256').update(sourceModule).digest('hex'),
        },
        {
          path: 'package.json',
          sha256: createHash('sha256').update(sourcePackage).digest('hex'),
        },
      ]),
    )
    .digest('hex');
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
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'executor-boundary-evidence-'));
  const boundaryEvidence = createEvidenceStore(evidenceRoot);
  const outputRef = boundaryEvidence.put('sandbox:enforced\negress-blocked:true\nexit:0\n');
  const commandRunner: InjectedCommandRunner = {
    async run(input) {
      request = input;
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
      return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
    },
  };
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    commandRunner,
    offlineDependencyPolicy: {
      version: 1,
      allowedRoles: ['implementer'],
      commands: [command],
      manifestPath: 'package.json',
      manifestHash: createHash('sha256').update(manifest).digest('hex'),
      lockfilePath: 'pnpm-lock.yaml',
      lockfileHash: createHash('sha256').update(lockfile).digest('hex'),
      approvedSourceHashes: [sourceHash],
      approvedSources: [{
        packageName: 'phase0-offline-dependency',
        specifier,
        targetPath,
        sourcePath: sourceRoot,
        contentHash: sourceHash,
      }],
      persistentOutputRoots: ['node_modules'],
      lifecycleScripts: 'disabled',
      network: 'none',
    },
  });
  try {
    writeFileSync(join(h.worktree, 'package.json'), manifest);
    writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), lockfile);
    const out = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'offline-install', cmd: command, network: 'none' },
      'implementer',
    );
    assert.equal(
      out.status,
      'applied',
      out.status === 'rejected' ? out.rejection.detail : 'unexpected executor outcome',
    );
    assert.equal(request?.allowNetwork, false);
    assert.deepEqual(request?.writableRoots, ['src', 'test/ai-generated', 'node_modules']);
    if (out.status === 'applied') {
      assert.equal(out.egressBlocked, true);
      assert.equal(out.outputRef, outputRef);
    }
  } finally {
    h.cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(approvedRoot, { recursive: true, force: true });
  }
});

test('REQ-2.8: executor snapshot tooling ignores fake PATH Git, hooks, and dotted filters', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'executor-boundary-evidence-'));
  const boundaryEvidence = createEvidenceStore(evidenceRoot);
  const outputRef = boundaryEvidence.put('sandbox:enforced\negress-blocked:true\nexit:0\n');
  const commandRunner: InjectedCommandRunner = {
    async run() {
      return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
    },
  };
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE, commandRunner });
  const previousPath = process.env['PATH'];
  try {
    const marker = join(h.root, 'target-controlled-tooling-ran.txt');
    const fakeBin = join(h.root, 'fake-bin');
    const hooks = join(h.worktree, '.hooks');
    mkdirSync(fakeBin);
    mkdirSync(hooks);
    writeFileSync(
      join(fakeBin, 'git'),
      `#!/bin/sh\n/usr/bin/touch "${marker}"\nexec /usr/bin/git "$@"\n`,
    );
    chmodSync(join(fakeBin, 'git'), 0o755);
    writeFileSync(
      join(hooks, 'pre-commit'),
      `#!/bin/sh\n/usr/bin/touch "${marker}"\nexit 1\n`,
    );
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    writeFileSync(join(h.worktree, '.gitattributes'), '*.txt filter=target.owned\n');
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    writeFileSync(join(h.worktree, 'src', 'stable.txt'), 'stable\n');
    execFileSync('/usr/bin/git', ['config', 'core.hooksPath', '.hooks'], { cwd: h.worktree });
    execFileSync(
      '/usr/bin/git',
      ['config', 'filter.target.owned.clean', `/usr/bin/touch "${marker}"; /bin/cat`],
      { cwd: h.worktree },
    );
    execFileSync(
      '/usr/bin/git',
      ['config', 'filter.target.owned.smudge', `/usr/bin/touch "${marker}"; /bin/cat`],
      { cwd: h.worktree },
    );
    execFileSync('/usr/bin/git', ['config', 'filter.target.owned.required', 'true'], {
      cwd: h.worktree,
    });
    process.env['PATH'] = `${fakeBin}:${previousPath ?? ''}`;

    const stagedBefore = execFileSync('/usr/bin/git', ['ls-files', '--stage', '-z'], {
      cwd: h.worktree,
    });
    const outcome = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'isolated-git', cmd: 'true', network: 'none' },
      'implementer',
    );

    assert.equal(outcome.status, 'applied');
    assert.equal(existsSync(marker), false);
    assert.deepEqual(
      execFileSync('/usr/bin/git', ['ls-files', '--stage', '-z'], { cwd: h.worktree }),
      stagedBefore,
    );
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    h.cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('RUN_COMMAND rejects non-finite, non-positive, fractional, and over-ceiling timeouts before INTENT', async () => {
  let calls = 0;
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'executor-boundary-evidence-'));
  const boundaryEvidence = createEvidenceStore(evidenceRoot);
  const outputRef = boundaryEvidence.put('sandbox:enforced\nexit:0\n');
  const commandRunner: InjectedCommandRunner = {
    async run() {
      calls += 1;
      return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
    },
  };
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE, commandRunner });
  try {
    const invalid = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 300_001];
    for (const [index, timeoutMs] of invalid.entries()) {
      const out = await h.executor.execute(
        {
          type: 'RUN_COMMAND',
          actionId: `invalid-timeout-${index}`,
          cmd: 'true',
          network: 'none',
          timeoutMs,
        },
        'implementer',
      );
      assert.equal(out.status, 'rejected', `timeout ${String(timeoutMs)} must fail closed`);
      if (out.status === 'rejected') assert.equal(out.rejection.reason, 'schema_violation');
    }
    assert.equal(calls, 0);
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('recovery ignores a terminal event with the same actionId from another task', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE, failpoints: { crashAfterIntent: true } });
  try {
    const contentRef = h.executorOptions.evidence.put('recovered');
    await assert.rejects(
      h.executor.execute(
        {
          type: 'WRITE_FILE',
          actionId: 'shared-action-id',
          path: 'src/recovered.txt',
          contentRef,
        },
        'implementer',
      ),
      /crash injected/,
    );
    h.executorOptions.log.append({
      runId: 'RUN-1',
      taskId: 'T-OTHER',
      type: 'ACTION_APPLIED',
      payload: { actionId: 'shared-action-id', resultHash: 'foreign' },
    });

    const report = await recoverWorktree(h.executorOptions);

    assert.equal(report.action, 'replayed_intent');
    assert.equal(readFileSync(join(h.worktree, 'src', 'recovered.txt'), 'utf8'), 'recovered');
  } finally {
    h.cleanup();
  }
});

test('recovery ignores a terminal event with the same task/action identity from another run', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE, failpoints: { crashAfterIntent: true } });
  try {
    const contentRef = h.executorOptions.evidence.put('recovered');
    await assert.rejects(
      h.executor.execute(
        {
          type: 'WRITE_FILE',
          actionId: 'cross-run-action-id',
          path: 'src/cross-run.txt',
          contentRef,
        },
        'implementer',
      ),
      /crash injected/,
    );
    h.executorOptions.log.append({
      runId: 'RUN-OTHER',
      taskId: 'T-1',
      type: 'ACTION_APPLIED',
      payload: { actionId: 'cross-run-action-id', resultHash: 'foreign' },
    });

    const report = await recoverWorktree(h.executorOptions);

    assert.equal(report.action, 'replayed_intent');
    assert.equal(readFileSync(join(h.worktree, 'src', 'cross-run.txt'), 'utf8'), 'recovered');
  } finally {
    h.cleanup();
  }
});

test('recovery fails closed when a dangling intent has a missing or invalid role', async () => {
  for (const [label, rolePayload] of [
    ['missing', {}],
    ['invalid', { role: 'administrator' }],
  ] as const) {
    let calls = 0;
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'executor-boundary-evidence-'));
    const boundaryEvidence = createEvidenceStore(evidenceRoot);
    const outputRef = boundaryEvidence.put('sandbox:enforced\nexit:0\n');
    const commandRunner: InjectedCommandRunner = {
      async run() {
        calls += 1;
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE, commandRunner });
    try {
      const snapshotRef = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: h.worktree,
        encoding: 'utf8',
      }).trim();
      h.executorOptions.log.append({
        runId: 'RUN-1',
        taskId: 'T-1',
        type: 'ACTION_INTENT',
        payload: {
          actionId: `legacy-${label}`,
          snapshotRef,
          action: {
            type: 'RUN_COMMAND',
            actionId: `legacy-${label}`,
            cmd: 'printf broadened > src/legacy.txt',
            network: 'none',
          },
          ...rolePayload,
        },
      });

      const report = await recoverWorktree(h.executorOptions);

      assert.equal(report.action, 'rolled_back');
      assert.match(report.detail, /role|invalid|missing/i);
      assert.equal(calls, 0);
      assert.equal(existsSync(join(h.worktree, 'src', 'legacy.txt')), false);
    } finally {
      h.cleanup();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  }
});

test('REQ-2.6: recovery rolls back partial allowed writes when replay is sandbox-rejected', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'executor-boundary-evidence-'));
  const boundaryEvidence = createEvidenceStore(evidenceRoot);
  const denialRef = boundaryEvidence.put('sandbox:enforced\nfilesystem-write-denied:true\nexit:1\n');
  let worktree = '';
  const commandRunner: InjectedCommandRunner = {
    async run() {
      writeFileSync(join(worktree, 'src', 'partial.txt'), 'must be rolled back');
      return {
        status: 'rejected',
        reason: 'sandbox_violation',
        detail: 'later write outside role roots denied',
        evidenceRef: denialRef,
        exitCode: 1,
        egressBlocked: true,
        observedViolation: { source: 'backend_owned', operation: 'filesystem' },
      };
    },
  };
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    commandRunner,
    failpoints: { crashAfterIntent: true },
  });
  worktree = h.worktree;
  mkdirSync(join(h.worktree, 'src'), { recursive: true });
  writeFileSync(join(h.worktree, 'src', 'stable.txt'), 'stable');
  try {
    await assert.rejects(
      h.executor.execute(
        {
          type: 'RUN_COMMAND',
          actionId: 'recovery-command-write',
          cmd: 'printf partial > src/partial.txt; printf denied > ../outside.txt',
          network: 'none',
        },
        'implementer',
      ),
      /crash injected/,
    );

    const recovery = await recoverWorktree(h.executorOptions);

    assert.equal(recovery.action, 'rolled_back');
    assert.equal(existsSync(join(h.worktree, 'src', 'partial.txt')), false);
    assert.equal(readFileSync(join(h.worktree, 'src', 'stable.txt'), 'utf8'), 'stable');
  } finally {
    h.cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

const persistentOutputPolicy: OfflineDependencyPolicy = {
  version: 1,
  allowedRoles: ['implementer'],
  commands: ['injected-offline-install'],
  manifestPath: 'package.json',
  manifestHash: '1'.repeat(64),
  lockfilePath: 'pnpm-lock.yaml',
  lockfileHash: '2'.repeat(64),
  approvedSourceHashes: ['3'.repeat(64)],
  approvedSources: [
    {
      packageName: 'phase0-offline-dependency',
      specifier: 'file:.phase0-offline-sources/phase0-offline-dependency',
      targetPath: '.phase0-offline-sources/phase0-offline-dependency',
      sourcePath: '/core-owned/approved-source',
      contentHash: '3'.repeat(64),
    },
  ],
  persistentOutputRoots: ['node_modules'],
  lifecycleScripts: 'disabled',
  network: 'none',
};

function injectedPromotion(
  onExecute?: (worktreeDir: string) => void,
): CoreCommandExecutor {
  return {
    environmentHash: '4'.repeat(64),
    async execute(_action, context) {
      const installed = join(
        context.worktreeDir,
        'node_modules',
        'phase0-offline-dependency',
        'index.js',
      );
      mkdirSync(join(installed, '..'), { recursive: true });
      writeFileSync(installed, 'approved\n');
      onExecute?.(context.worktreeDir);
      return {
        status: 'promoted',
        capture: {
          exitCode: 0,
          inputTreeHash: '5'.repeat(40),
          outputTreeHash: '6'.repeat(40),
          preCopyInventoryHash: '7'.repeat(64),
          postCopyInventoryHash: '7'.repeat(64),
          captureInventoryHash: '7'.repeat(64),
          diffRef: `blob://${'8'.repeat(64)}`,
          diffHash: '9'.repeat(64),
          affectedPaths: ['node_modules/phase0-offline-dependency/index.js'],
        },
        promotedDiffHash: '9'.repeat(64),
        evidence: {
          outputRef: `blob://${'a'.repeat(64)}`,
          networkPolicyHash: 'b'.repeat(64),
          environmentHash: 'c'.repeat(64),
          backend: {
            inheritedFilesystemAndNetworkPolicy: true,
            denialObservation: 'direct_only',
            revocableDescendantContainment: false,
            descendantTermination: 'unproven_new_session',
          },
          observedViolation: null,
        },
      };
    },
  };
}

function injectedAppendCommand(onExecute: () => void): CoreCommandExecutor {
  return {
    environmentHash: 'd'.repeat(64),
    async execute(_action, context) {
      onExecute();
      const output = join(context.worktreeDir, 'src', 'run-replay.txt');
      mkdirSync(join(output, '..'), { recursive: true });
      writeFileSync(
        output,
        `${existsSync(output) ? readFileSync(output, 'utf8') : ''}B\n`,
      );
      return {
        status: 'promoted',
        capture: {
          exitCode: 0,
          inputTreeHash: '1'.repeat(40),
          outputTreeHash: '2'.repeat(40),
          preCopyInventoryHash: '3'.repeat(64),
          postCopyInventoryHash: '3'.repeat(64),
          captureInventoryHash: '3'.repeat(64),
          diffRef: `blob://${'4'.repeat(64)}`,
          diffHash: '5'.repeat(64),
          affectedPaths: ['src/run-replay.txt'],
        },
        promotedDiffHash: '5'.repeat(64),
        evidence: {
          outputRef: `blob://${'6'.repeat(64)}`,
          networkPolicyHash: '7'.repeat(64),
          environmentHash: '8'.repeat(64),
          backend: {
            inheritedFilesystemAndNetworkPolicy: true,
            denialObservation: 'direct_only',
            revocableDescendantContainment: false,
            descendantTermination: 'unproven_new_session',
          },
          observedViolation: null,
        },
      };
    },
  };
}

test('persistent ignored output mutation, deletion, and addition are reconciled from ACTION_APPLIED identity', async (t) => {
  for (const scenario of ['mutation', 'deletion', 'addition'] as const) {
    await t.test(scenario, async () => {
      const h = harness({
        git: true,
        sandbox: FAKE_AVAILABLE,
        coreCommandExecutor: injectedPromotion(),
        offlineDependencyPolicy: persistentOutputPolicy,
      });
      const installed = join(
        h.worktree,
        'node_modules',
        'phase0-offline-dependency',
        'index.js',
      );
      try {
        writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
        const applied = await h.executor.execute(
          {
            type: 'RUN_COMMAND',
            actionId: `persistent-${scenario}`,
            cmd: 'injected-offline-install',
            network: 'none',
          },
          'implementer',
        );
        assert.equal(applied.status, 'applied');

        if (scenario === 'mutation') {
          writeFileSync(installed, 'tampered\n');
        } else if (scenario === 'deletion') {
          rmSync(installed);
        } else {
          writeFileSync(join(installed, '..', 'extra.js'), 'unexpected\n');
        }

        const recovered = await recoverWorktree(h.executorOptions);

        assert.equal(recovered.action, 'replayed_intent');
        assert.match(recovered.detail, /ACTION_APPLIED|artifact|hash|identity|worktree/i);
        assert.equal(readFileSync(installed, 'utf8'), 'approved\n');
        assert.equal(existsSync(join(installed, '..', 'extra.js')), false);
      } finally {
        h.cleanup();
      }
    });
  }
});

test('duplicate action refuses a stale ACTION_APPLIED identity and reconciles ignored outputs', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: injectedPromotion(),
    offlineDependencyPolicy: persistentOutputPolicy,
  });
  const action = {
    type: 'RUN_COMMAND' as const,
    actionId: 'persistent-duplicate-after-tamper',
    cmd: 'injected-offline-install',
    network: 'none' as const,
  };
  const installed = join(
    h.worktree,
    'node_modules',
    'phase0-offline-dependency',
    'index.js',
  );
  try {
    writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
    const applied = await h.executor.execute(action, 'implementer');
    assert.equal(applied.status, 'applied');
    writeFileSync(installed, 'tampered before duplicate\n');

    const duplicate = await h.executor.execute(action, 'implementer');

    assert.equal(duplicate.status, 'rejected');
    if (duplicate.status === 'rejected') {
      assert.equal(duplicate.rejection.reason, 'command_artifact_unavailable');
      assert.match(duplicate.rejection.detail, /duplicate|ACTION_APPLIED|identity|recovery/i);
    }
    assert.equal(readFileSync(installed, 'utf8'), 'approved\n');
    assert.equal(
      h.executorOptions.log
        .all({ type: 'ACTION_APPLIED' })
        .filter((event) => event.payload['duplicate'] !== true).length,
      1,
    );
  } finally {
    h.cleanup();
  }
});

test('persistent rollback validates every evidence blob before replacing an owned root', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: injectedPromotion(),
    offlineDependencyPolicy: persistentOutputPolicy,
  });
  const preexisting = join(h.worktree, 'node_modules', 'preexisting.txt');
  const installed = join(
    h.worktree,
    'node_modules',
    'phase0-offline-dependency',
    'index.js',
  );
  try {
    writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(preexisting, '..'), { recursive: true });
    writeFileSync(preexisting, 'must survive unavailable evidence\n');
    const applied = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'persistent-missing-rollback-evidence',
        cmd: 'injected-offline-install',
        network: 'none',
      },
      'implementer',
    );
    assert.equal(applied.status, 'applied');

    const intent = h.executorOptions.log.all({ type: 'ACTION_INTENT' })[0];
    const manifestRef = String(intent?.payload['persistentSnapshotRef']);
    const manifest = JSON.parse(
      h.executorOptions.evidence.getText(manifestRef),
    ) as {
      entries: Array<{ path: string; contentRef: string }>;
    };
    const preexistingRef = manifest.entries.find(
      (entry) => entry.path === 'node_modules/preexisting.txt',
    )?.contentRef;
    if (preexistingRef === undefined) {
      assert.fail('pre-action persistent snapshot must include the owned file');
    }
    assert.ok(preexistingRef.startsWith('blob://'));
    rmSync(join(h.root, 'evidence', preexistingRef.slice('blob://'.length)));
    writeFileSync(installed, 'tampered to require recovery\n');

    await assert.rejects(recoverWorktree(h.executorOptions), (error: unknown) => {
      assert.ok(error instanceof EvidenceStoreError);
      assert.equal(error.code, 'missing_blob');
      return true;
    });
    assert.equal(
      readFileSync(preexisting, 'utf8'),
      'must survive unavailable evidence\n',
    );
  } finally {
    h.cleanup();
  }
});

test('crash after ignored dependency promotion restores the owned root before replay', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: injectedPromotion(),
    offlineDependencyPolicy: persistentOutputPolicy,
    failpoints: { crashAfterApply: true },
  });
  try {
    writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
    await assert.rejects(
      h.executor.execute(
        {
          type: 'RUN_COMMAND',
          actionId: 'persistent-crash-after-promotion',
          cmd: 'injected-offline-install',
          network: 'none',
        },
        'implementer',
      ),
      /crash injected: after_apply/u,
    );
    const packageRoot = join(
      h.worktree,
      'node_modules',
      'phase0-offline-dependency',
    );
    writeFileSync(join(packageRoot, 'extra.js'), 'post-crash tamper\n');

    const recovered = await recoverWorktree(h.executorOptions);

    assert.equal(recovered.action, 'replayed_intent');
    assert.equal(readFileSync(join(packageRoot, 'index.js'), 'utf8'), 'approved\n');
    assert.equal(existsSync(join(packageRoot, 'extra.js')), false);
  } finally {
    h.cleanup();
  }
});

test('public executor starts cancellation before snapshot and appends no INTENT', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    commandSignal: controller.signal,
    coreCommandExecutor: {
      environmentHash: 'd'.repeat(64),
      async execute() {
        calls += 1;
        throw new Error('cancelled operation must not reach the inner executor');
      },
    },
  });
  try {
    const outcome = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'pre-aborted-outer-snapshot',
        cmd: 'true',
        network: 'none',
      },
      'implementer',
    );

    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.rejection.reason, 'cancelled');
    assert.equal(calls, 0);
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('tiny public deadline bounds outer snapshot before INTENT', async () => {
  let calls = 0;
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: {
      environmentHash: 'e'.repeat(64),
      async execute() {
        calls += 1;
        throw new Error('expired operation must not reach the inner executor');
      },
    },
  });
  try {
    const started = performance.now();
    const outcome = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'tiny-outer-snapshot-deadline',
        cmd: 'true',
        network: 'none',
        timeoutMs: 1,
      },
      'implementer',
    );

    assert.ok(performance.now() - started < 2_000);
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.rejection.reason, 'timed_out');
    assert.equal(calls, 0);
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('abort after inner promotion prevents ACTION_APPLIED and reconciles the worktree', async () => {
  const controller = new AbortController();
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    commandSignal: controller.signal,
    coreCommandExecutor: injectedPromotion(() => controller.abort()),
    offlineDependencyPolicy: persistentOutputPolicy,
  });
  try {
    const outcome = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'abort-after-inner-promotion',
        cmd: 'injected-offline-install',
        network: 'none',
      },
      'implementer',
    );

    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.rejection.reason, 'cancelled');
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length, 0);
    assert.equal(existsSync(join(h.worktree, 'node_modules')), false);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.1/3.6: APPLY_PATCH adds an allowed text file after snapshot and ACTION_INTENT', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    const diffRef = h.executorOptions.evidence.put(
      [
        'diff --git a/src/added.txt b/src/added.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/added.txt',
        '@@ -0,0 +1 @@',
        '+added by patch',
        '',
      ].join('\n'),
    );

    const outcome = await h.executor.execute(
      { type: 'APPLY_PATCH', actionId: 'patch-add', diffRef },
      'implementer',
    );

    assert.equal(outcome.status, 'applied');
    assert.equal(readFileSync(join(h.worktree, 'src', 'added.txt'), 'utf8'), 'added by patch\n');
    const lifecycle = h.executorOptions.log
      .all({ taskId: 'T-1' })
      .filter((event) => event.type === 'ACTION_INTENT' || event.type === 'ACTION_APPLIED');
    assert.deepEqual(
      lifecycle.map((event) => event.type),
      ['ACTION_INTENT', 'ACTION_APPLIED'],
    );
    assert.match(String(lifecycle[0]?.payload['snapshotRef']), /^[0-9a-f]{40,64}$/u);
  } finally {
    h.cleanup();
  }
});

test('Task 30/REQ-3.4/3.6-3.8: WRITE_FILE rejects role-denied and excluded-root symlink aliases before intent', async (t) => {
  for (const scenario of [
    {
      name: 'role-denied docs alias',
      link: 'src/docs-link',
      target: '../docs',
      destination: 'docs/denied.txt',
    },
    {
      name: 'excluded run-state alias',
      link: 'src/run-link',
      target: '../.ai/runs',
      destination: '.ai/runs/forged.json',
    },
    {
      name: 'excluded Git alias',
      link: 'src/git-link',
      target: '../.git',
      destination: '.git/action-marker',
    },
    {
      name: 'golden alias',
      link: 'src/golden-link',
      target: '../test/golden',
      destination: 'test/golden/forged.txt',
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
      try {
        mkdirSync(join(h.worktree, 'src'), { recursive: true });
        mkdirSync(join(h.worktree, dirname(scenario.destination)), {
          recursive: true,
        });
        symlinkSync(scenario.target, join(h.worktree, scenario.link));
        const contentRef = h.executorOptions.evidence.put('forged\n');

        const outcome = await h.executor.execute(
          {
            type: 'WRITE_FILE',
            actionId: `symlink-alias-${scenario.name}`,
            path: `${scenario.link}/${scenario.destination.split('/').at(-1)}`,
            contentRef,
          },
          'implementer',
        );

        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.equal(outcome.rejection.reason, 'path_outside_allowlist');
        }
        assert.equal(existsSync(join(h.worktree, scenario.destination)), false);
        assert.equal(
          h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length,
          0,
        );
        assert.equal(
          h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length,
          0,
        );
      } finally {
        h.cleanup();
      }
    });
  }
});

test('Task 30/REQ-3.4/3.6: nested, multi-hop, absolute, and final symlink mutation paths fail closed', async (t) => {
  for (const scenario of [
    {
      name: 'nested relative multi-hop parent',
      setup(worktree: string) {
        mkdirSync(join(worktree, 'src', 'nested'), { recursive: true });
        mkdirSync(join(worktree, 'docs'), { recursive: true });
        symlinkSync('docs', join(worktree, 'root-hop'));
        symlinkSync('../../root-hop', join(worktree, 'src', 'nested', 'hop'));
        return {
          path: 'src/nested/hop/multi-hop.txt',
          target: 'docs/multi-hop.txt',
        };
      },
    },
    {
      name: 'absolute in-worktree parent',
      setup(worktree: string) {
        mkdirSync(join(worktree, 'src'), { recursive: true });
        mkdirSync(join(worktree, 'docs'), { recursive: true });
        symlinkSync(join(worktree, 'docs'), join(worktree, 'src', 'absolute'));
        return {
          path: 'src/absolute/absolute.txt',
          target: 'docs/absolute.txt',
        };
      },
    },
    {
      name: 'final symlink',
      setup(worktree: string) {
        mkdirSync(join(worktree, 'src'), { recursive: true });
        mkdirSync(join(worktree, 'docs'), { recursive: true });
        writeFileSync(join(worktree, 'docs', 'final.txt'), 'stable\n');
        symlinkSync('../docs/final.txt', join(worktree, 'src', 'final.txt'));
        return {
          path: 'src/final.txt',
          target: 'docs/final.txt',
        };
      },
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
      try {
        const fixture = scenario.setup(h.worktree);
        const before = existsSync(join(h.worktree, fixture.target))
          ? readFileSync(join(h.worktree, fixture.target))
          : undefined;
        const outcome = await h.executor.execute(
          {
            type: 'WRITE_FILE',
            actionId: `symlink-shape-${scenario.name}`,
            path: fixture.path,
            contentRef: h.executorOptions.evidence.put('forged\n'),
          },
          'implementer',
        );

        assert.equal(outcome.status, 'rejected');
        if (before === undefined) {
          assert.equal(existsSync(join(h.worktree, fixture.target)), false);
        } else {
          assert.deepEqual(readFileSync(join(h.worktree, fixture.target)), before);
        }
        assert.equal(
          h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length,
          0,
        );
        assert.equal(
          h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length,
          0,
        );
      } finally {
        h.cleanup();
      }
    });
  }
});

test('Task 30/REQ-3.6-3.8: parent swap between preflight and commit cannot redirect WRITE_FILE', async () => {
  let swapped = false;
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: {
      mutationBeforeCommit(paths) {
        if (swapped || paths[0] !== 'src/safe/raced.txt') return;
        swapped = true;
        rmSync(join(h.worktree, 'src', 'safe'), { recursive: true });
        symlinkSync('../docs', join(h.worktree, 'src', 'safe'));
      },
    },
  });
  try {
    mkdirSync(join(h.worktree, 'src', 'safe'), { recursive: true });
    writeFileSync(
      join(h.worktree, 'src', 'safe', 'original.txt'),
      'restore me\n',
    );
    mkdirSync(join(h.worktree, 'docs'), { recursive: true });
    const outcome = await h.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'write-parent-swap',
        path: 'src/safe/raced.txt',
        contentRef: h.executorOptions.evidence.put('must not escape\n'),
      },
      'implementer',
    );

    assert.equal(swapped, true);
    assert.equal(outcome.status, 'rejected');
    assert.equal(existsSync(join(h.worktree, 'docs', 'raced.txt')), false);
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'safe', 'original.txt'), 'utf8'),
      'restore me\n',
    );
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length,
      1,
    );
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length,
      0,
    );
  } finally {
    h.cleanup();
  }
});

test('Task 30/REQ-3.3-3.6: APPLY_PATCH never follows a target-controlled symlink parent', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    mkdirSync(join(h.worktree, 'docs'), { recursive: true });
    writeFileSync(join(h.worktree, 'docs', 'delete.txt'), 'stable\n');
    symlinkSync('../docs', join(h.worktree, 'src', 'docs-link'));
    commitFixture(h.worktree, 'patch symlink parent fixture');
    const patch = [
      'diff --git a/src/docs-link/delete.txt b/src/docs-link/delete.txt',
      'deleted file mode 100644',
      '--- a/src/docs-link/delete.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-stable',
      '',
    ].join('\n');

    const outcome = await h.executor.execute(
      {
        type: 'APPLY_PATCH',
        actionId: 'patch-symlink-parent-delete',
        diffRef: h.executorOptions.evidence.put(patch),
      },
      'implementer',
    );

    assert.equal(outcome.status, 'rejected');
    assert.equal(
      readFileSync(join(h.worktree, 'docs', 'delete.txt'), 'utf8'),
      'stable\n',
    );
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length,
      0,
    );
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length,
      0,
    );
  } finally {
    h.cleanup();
  }
});

test('Task 30/REQ-3.3/3.6: APPLY_PATCH batch rejects a parent swap with no partial file or APPLIED event', async () => {
  let swapped = false;
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: {
      mutationBeforeCommit(paths) {
        if (swapped || !paths.includes('src/safe/second.txt')) return;
        swapped = true;
        rmSync(join(h.worktree, 'src', 'safe'), { recursive: true });
        symlinkSync('../docs', join(h.worktree, 'src', 'safe'));
      },
    },
  });
  try {
    mkdirSync(join(h.worktree, 'src', 'safe'), { recursive: true });
    mkdirSync(join(h.worktree, 'docs'), { recursive: true });
    const patch = [
      'diff --git a/src/first.txt b/src/first.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/first.txt',
      '@@ -0,0 +1 @@',
      '+first',
      'diff --git a/src/safe/second.txt b/src/safe/second.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/safe/second.txt',
      '@@ -0,0 +1 @@',
      '+second',
      '',
    ].join('\n');

    const outcome = await h.executor.execute(
      {
        type: 'APPLY_PATCH',
        actionId: 'patch-parent-swap-batch',
        diffRef: h.executorOptions.evidence.put(patch),
      },
      'implementer',
    );

    assert.equal(swapped, true);
    assert.equal(outcome.status, 'rejected');
    assert.equal(existsSync(join(h.worktree, 'src', 'first.txt')), false);
    assert.equal(existsSync(join(h.worktree, 'docs', 'second.txt')), false);
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length,
      1,
    );
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length,
      0,
    );
  } finally {
    h.cleanup();
  }
});

test('Task 30/REQ-3.6-3.8: replay preserves a valid safe symlink artifact while reapplying regular bytes', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: { crashAfterApply: true },
  });
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    writeFileSync(join(h.worktree, 'src', 'target.txt'), 'target\n');
    symlinkSync('target.txt', join(h.worktree, 'src', 'preserved-link'));
    const action = {
      type: 'WRITE_FILE',
      actionId: 'replay-with-safe-symlink',
      path: 'src/replayed.txt',
      contentRef: h.executorOptions.evidence.put('replayed\n'),
    } as const;

    await assert.rejects(
      h.executor.execute(action, 'implementer'),
      CrashInjected,
    );
    const { failpoints: _crash, ...restartOptions } = h.executorOptions;
    const report = await recoverWorktree(restartOptions);

    assert.equal(report.action, 'replayed_intent');
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'replayed.txt'), 'utf8'),
      'replayed\n',
    );
    assert.equal(
      readlinkSync(join(h.worktree, 'src', 'preserved-link')),
      'target.txt',
    );
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'target.txt'), 'utf8'),
      'target\n',
    );
  } finally {
    h.cleanup();
  }
});

test('Task 32/REQ-3.7-3.8: recovery-prune race rolls back exactly, then restart replays once', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: { crashAfterApply: true },
  });
  const recoveredFile = join(h.worktree, 'src', 'recovered.txt');
  const unmodeledDirectory = join(h.worktree, 'src', 'unmodeled-empty');
  try {
    await assert.rejects(
      h.executor.execute(
        {
          type: 'WRITE_FILE',
          actionId: 'transaction-recovery-prune',
          path: 'src/recovered.txt',
          contentRef: h.executorOptions.evidence.put('recovered\n'),
        },
        'implementer',
      ),
      /crash injected: after_apply/u,
    );
    mkdirSync(unmodeledDirectory, { recursive: true });

    await assert.rejects(
      recoverWorktree(h.executorOptions),
      /directory changed or is not empty at operation/u,
    );
    assert.equal(readFileSync(recoveredFile, 'utf8'), 'recovered\n');
    assert.equal(statSync(unmodeledDirectory).isDirectory(), true);
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length,
      0,
    );

    rmSync(unmodeledDirectory, { recursive: true });
    const recovered = await recoverWorktree(h.executorOptions);
    const repeated = await recoverWorktree(h.executorOptions);

    assert.equal(recovered.action, 'replayed_intent');
    assert.equal(recovered.coherent, true);
    assert.equal(readFileSync(recoveredFile, 'utf8'), 'recovered\n');
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length,
      1,
    );
    assert.equal(repeated.action, 'none');
    assert.equal(repeated.coherent, true);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.1/3.3: APPLY_PATCH updates, deletes, and renames allowed text files', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    writeFileSync(join(h.worktree, 'src', 'update.txt'), 'before\n');
    writeFileSync(join(h.worktree, 'src', 'delete.txt'), 'delete me\n');
    writeFileSync(join(h.worktree, 'src', 'rename-old.txt'), 'rename me\n');
    commitFixture(h.worktree, 'patch baseline');
    const patch = captureStagedPatch(
      h.worktree,
      () => {
        writeFileSync(join(h.worktree, 'src', 'update.txt'), 'after\n');
        rmSync(join(h.worktree, 'src', 'delete.txt'));
        writeFileSync(join(h.worktree, 'src', 'rename-new.txt'), 'rename me\n');
        rmSync(join(h.worktree, 'src', 'rename-old.txt'));
      },
      () => {
        writeFileSync(join(h.worktree, 'src', 'update.txt'), 'before\n');
        writeFileSync(join(h.worktree, 'src', 'delete.txt'), 'delete me\n');
        writeFileSync(join(h.worktree, 'src', 'rename-old.txt'), 'rename me\n');
        rmSync(join(h.worktree, 'src', 'rename-new.txt'), { force: true });
      },
    );

    const outcome = await h.executor.execute(
      {
        type: 'APPLY_PATCH',
        actionId: 'patch-update-delete-rename',
        diffRef: h.executorOptions.evidence.put(patch),
      },
      'implementer',
    );

    assert.equal(outcome.status, 'applied');
    assert.equal(readFileSync(join(h.worktree, 'src', 'update.txt'), 'utf8'), 'after\n');
    assert.equal(existsSync(join(h.worktree, 'src', 'delete.txt')), false);
    assert.equal(existsSync(join(h.worktree, 'src', 'rename-old.txt')), false);
    assert.equal(readFileSync(join(h.worktree, 'src', 'rename-new.txt'), 'utf8'), 'rename me\n');
  } finally {
    h.cleanup();
  }
});

test('REQ-3.1/3.6: APPLY_PATCH never executes target-controlled Git clean, smudge, or process filters', async (t) => {
  for (const filterMode of ['clean-smudge', 'process'] as const) {
    await t.test(filterMode, async () => {
      const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
      const marker = join(h.root, `${filterMode}.marker`);
      const passthrough = join(h.root, 'filter-passthrough.sh');
      const processFilter = join(h.root, 'filter-process.sh');
      try {
        mkdirSync(join(h.worktree, 'src'), { recursive: true });
        writeFileSync(join(h.worktree, 'src', 'filtered.txt'), 'before\n');
        writeFileSync(join(h.worktree, '.gitattributes'), 'src/*.txt filter=hostile\n');
        writeFileSync(
          passthrough,
          '#!/bin/sh\nprintf "%s\\n" "$1" >> "$2"\n/bin/cat\n',
        );
        writeFileSync(
          processFilter,
          '#!/bin/sh\nprintf "process\\n" >> "$1"\nexit 1\n',
        );
        chmodSync(passthrough, 0o755);
        chmodSync(processFilter, 0o755);
        commitFixture(h.worktree, 'hostile filter baseline');
        if (filterMode === 'clean-smudge') {
          execFileSync(
            'git',
            ['config', '--local', 'filter.hostile.clean', `${passthrough} clean ${marker}`],
            { cwd: h.worktree },
          );
          execFileSync(
            'git',
            ['config', '--local', 'filter.hostile.smudge', `${passthrough} smudge ${marker}`],
            { cwd: h.worktree },
          );
        } else {
          execFileSync(
            'git',
            ['config', '--local', 'filter.hostile.process', `${processFilter} ${marker}`],
            { cwd: h.worktree },
          );
        }
        rmSync(marker, { force: true });
        const patch = [
          'diff --git a/src/filtered.txt b/src/filtered.txt',
          '--- a/src/filtered.txt',
          '+++ b/src/filtered.txt',
          '@@ -1 +1 @@',
          '-before',
          '+after',
          '',
        ].join('\n');

        const outcome = await h.executor.execute(
          {
            type: 'APPLY_PATCH',
            actionId: `filter-isolation-${filterMode}`,
            diffRef: h.executorOptions.evidence.put(patch),
          },
          'implementer',
        );

        assert.equal(outcome.status, 'applied');
        assert.equal(readFileSync(join(h.worktree, 'src', 'filtered.txt'), 'utf8'), 'after\n');
        assert.equal(existsSync(marker), false, `${filterMode} command must never execute`);
      } finally {
        h.cleanup();
      }
    });
  }
});

test('REQ-3.3/3.4: APPLY_PATCH checks every rename source and destination before mutation', async (t) => {
  for (const scenario of [
    {
      name: 'allowed source to denied destination',
      oldPath: 'test/ai-generated/source.txt',
      newPath: 'src/denied.txt',
    },
    {
      name: 'denied source to allowed destination',
      oldPath: 'src/denied.txt',
      newPath: 'test/ai-generated/source.txt',
    },
  ]) {
    await t.test(scenario.name, async () => {
      const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
      try {
        const oldAbs = join(h.worktree, scenario.oldPath);
        const newAbs = join(h.worktree, scenario.newPath);
        mkdirSync(join(oldAbs, '..'), { recursive: true });
        writeFileSync(oldAbs, 'rename policy\n');
        commitFixture(h.worktree, 'rename policy baseline');
        const patch = captureStagedPatch(
          h.worktree,
          () => {
            mkdirSync(join(newAbs, '..'), { recursive: true });
            writeFileSync(newAbs, 'rename policy\n');
            rmSync(oldAbs);
          },
          () => {
            mkdirSync(join(oldAbs, '..'), { recursive: true });
            writeFileSync(oldAbs, 'rename policy\n');
            rmSync(newAbs, { force: true });
          },
        );

        const outcome = await h.executor.execute(
          {
            type: 'APPLY_PATCH',
            actionId: `rename-policy-${scenario.name}`,
            diffRef: h.executorOptions.evidence.put(patch),
          },
          'test_designer',
        );

        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.equal(outcome.rejection.reason, 'path_outside_allowlist');
        }
        assert.equal(readFileSync(oldAbs, 'utf8'), 'rename policy\n');
        assert.equal(existsSync(newAbs), false);
        assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
      } finally {
        h.cleanup();
      }
    });
  }
});

test('REQ-3.3: Git NUL path inspection accepts quoted text paths without regex parsing', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  const relative = 'src/ยูนิโค้ด-line\nbreak\tname.txt';
  const absolute = join(h.worktree, relative);
  try {
    const patch = captureStagedPatch(
      h.worktree,
      () => {
        mkdirSync(join(absolute, '..'), { recursive: true });
        writeFileSync(absolute, 'quoted path\n');
      },
      () => {
        rmSync(absolute, { force: true });
      },
    );

    const outcome = await h.executor.execute(
      {
        type: 'APPLY_PATCH',
        actionId: 'quoted-path',
        diffRef: h.executorOptions.evidence.put(patch),
      },
      'implementer',
    );

    assert.equal(outcome.status, 'applied');
    assert.equal(readFileSync(absolute, 'utf8'), 'quoted path\n');
  } finally {
    h.cleanup();
  }
});

test('REQ-3.3/3.4: declared forbidden no-op paths reject a mixed patch before any inode or allowed-path mutation', async (t) => {
  for (const scenario of [
    {
      name: 'golden no-op plus allowed add',
      role: 'implementer',
      deniedPath: 'test/golden/expected.txt',
      allowedPath: 'src/allowed-from-mixed.txt',
      reason: 'golden_write_denied',
    },
    {
      name: 'quoted Unicode role-disallowed no-op plus allowed add',
      role: 'test_designer',
      deniedPath: 'src/ยูนิโค้ด\nrole-denied.txt',
      allowedPath: 'test/ai-generated/allowed-from-mixed.txt',
      reason: 'path_outside_allowlist',
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
      const denied = join(h.worktree, scenario.deniedPath);
      const allowed = join(h.worktree, scenario.allowedPath);
      try {
        mkdirSync(join(denied, '..'), { recursive: true });
        writeFileSync(denied, 'stable bytes\n');
        commitFixture(h.worktree, 'mixed no-op baseline');
        const deniedNoop = captureStagedPatch(
          h.worktree,
          () => writeFileSync(denied, 'changed bytes\n'),
          () => writeFileSync(denied, 'stable bytes\n'),
        )
          .toString('utf8')
          .replace('+changed bytes\n', '+stable bytes\n');
        const allowedAdd = captureStagedPatch(
          h.worktree,
          () => {
            mkdirSync(join(allowed, '..'), { recursive: true });
            writeFileSync(allowed, 'allowed mutation\n');
          },
          () => rmSync(allowed, { force: true }),
        );
        const before = statSync(denied);

        const outcome = await h.executor.execute(
          {
            type: 'APPLY_PATCH',
            actionId: `mixed-declared-${scenario.name}`,
            diffRef: h.executorOptions.evidence.put(
              Buffer.concat([Buffer.from(deniedNoop), allowedAdd]),
            ),
          },
          scenario.role,
        );

        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.equal(outcome.rejection.reason, scenario.reason);
        }
        const after = statSync(denied);
        assert.equal(after.ino, before.ino, 'forbidden no-op path inode must be untouched');
        assert.equal(readFileSync(denied, 'utf8'), 'stable bytes\n');
        assert.equal(existsSync(allowed), false);
        assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
      } finally {
        h.cleanup();
      }
    });
  }
});

test('REQ-3.4: golden, outside-role, traversal, and absolute patch paths reject before INTENT', async (t) => {
  const cases = [
    {
      name: 'golden',
      patch: [
        'diff --git a/test/golden/protected.txt b/test/golden/protected.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/test/golden/protected.txt',
        '@@ -0,0 +1 @@',
        '+forbidden',
        '',
      ].join('\n'),
      reason: 'golden_write_denied',
    },
    {
      name: 'outside role',
      patch: [
        'diff --git a/README-added.md b/README-added.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/README-added.md',
        '@@ -0,0 +1 @@',
        '+forbidden',
        '',
      ].join('\n'),
      reason: 'path_outside_allowlist',
    },
    {
      name: 'traversal',
      patch: [
        'diff --git a/../escaped.txt b/../escaped.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/../escaped.txt',
        '@@ -0,0 +1 @@',
        '+forbidden',
        '',
      ].join('\n'),
      reason: 'path_outside_allowlist',
    },
    {
      name: 'absolute',
      patch: [
        'diff --git a//tmp/absolute.txt b//tmp/absolute.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b//tmp/absolute.txt',
        '@@ -0,0 +1 @@',
        '+forbidden',
        '',
      ].join('\n'),
      reason: 'path_outside_allowlist',
    },
  ] as const;
  for (const sample of cases) {
    await t.test(sample.name, async () => {
      const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
      try {
        const outcome = await h.executor.execute(
          {
            type: 'APPLY_PATCH',
            actionId: `unsafe-${sample.name}`,
            diffRef: h.executorOptions.evidence.put(sample.patch),
          },
          'implementer',
        );
        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.equal(outcome.rejection.reason, sample.reason);
        }
        assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
      } finally {
        h.cleanup();
      }
    });
  }
});

test('REQ-3.2/3.5: missing and hash-mismatched patch evidence reject before path inspection', async (t) => {
  await t.test('missing', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    try {
      const outcome = await h.executor.execute(
        {
          type: 'APPLY_PATCH',
          actionId: 'missing-patch',
          diffRef: `blob://${'f'.repeat(64)}`,
        },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'evidence_invalid');
      }
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });

  await t.test('hash mismatch', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    try {
      const diffRef = h.executorOptions.evidence.put('verified patch bytes');
      writeFileSync(
        join(h.root, 'evidence', diffRef.slice('blob://'.length)),
        'tampered bytes',
      );
      const outcome = await h.executor.execute(
        { type: 'APPLY_PATCH', actionId: 'tampered-patch', diffRef },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'evidence_invalid');
      }
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });
});

test('REQ-3.5: malformed, binary, symlink, empty, conflicting, and no-op patches reject structurally', async (t) => {
  const literalCases = [
    {
      name: 'malformed',
      patch: [
        'diff --git a/src/file.txt b/src/file.txt',
        '--- a/src/file.txt',
        '+++ b/src/file.txt',
        '@@ -1 +1 @@',
        '',
      ].join('\n'),
      reason: 'patch_malformed',
    },
    { name: 'empty', patch: '', reason: 'patch_noop' },
  ] as const;
  for (const sample of literalCases) {
    await t.test(sample.name, async () => {
      const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
      try {
        const outcome = await h.executor.execute(
          {
            type: 'APPLY_PATCH',
            actionId: `invalid-${sample.name}`,
            diffRef: h.executorOptions.evidence.put(sample.patch),
          },
          'implementer',
        );
        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.equal(outcome.rejection.reason, sample.reason);
        }
        assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
      } finally {
        h.cleanup();
      }
    });
  }

  await t.test('valid no-op', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    try {
      mkdirSync(join(h.worktree, 'src'), { recursive: true });
      writeFileSync(join(h.worktree, 'src', 'same.txt'), 'same\n');
      commitFixture(h.worktree, 'no-op baseline');
      const patch = [
        'diff --git a/src/same.txt b/src/same.txt',
        '--- a/src/same.txt',
        '+++ b/src/same.txt',
        '@@ -1 +1 @@',
        '-same',
        '+same',
        '',
      ].join('\n');
      const outcome = await h.executor.execute(
        {
          type: 'APPLY_PATCH',
          actionId: 'valid-no-op',
          diffRef: h.executorOptions.evidence.put(patch),
        },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'patch_noop');
      }
      assert.equal(readFileSync(join(h.worktree, 'src', 'same.txt'), 'utf8'), 'same\n');
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });

  await t.test('binary', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    const binaryPath = join(h.worktree, 'src', 'binary.dat');
    try {
      mkdirSync(join(binaryPath, '..'), { recursive: true });
      writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
      commitFixture(h.worktree, 'binary baseline');
      const patch = captureStagedPatch(
        h.worktree,
        () => writeFileSync(binaryPath, Buffer.from([0, 255, 2, 3])),
        () => writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3])),
      );
      const outcome = await h.executor.execute(
        {
          type: 'APPLY_PATCH',
          actionId: 'binary-patch',
          diffRef: h.executorOptions.evidence.put(patch),
        },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'patch_unsupported');
      }
      assert.deepEqual(readFileSync(binaryPath), Buffer.from([0, 1, 2, 3]));
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });

  await t.test('symlink', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    const linkPath = join(h.worktree, 'src', 'link');
    try {
      const patch = captureStagedPatch(
        h.worktree,
        () => {
          mkdirSync(join(linkPath, '..'), { recursive: true });
          symlinkSync('target.txt', linkPath);
        },
        () => rmSync(linkPath, { force: true }),
      );
      const outcome = await h.executor.execute(
        {
          type: 'APPLY_PATCH',
          actionId: 'symlink-patch',
          diffRef: h.executorOptions.evidence.put(patch),
        },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'patch_unsupported');
      }
      assert.equal(existsSync(linkPath), false);
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });

  await t.test('copy metadata', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    try {
      mkdirSync(join(h.worktree, 'test', 'golden'), { recursive: true });
      writeFileSync(join(h.worktree, 'test', 'golden', 'protected.txt'), 'golden secret\n');
      commitFixture(h.worktree, 'copy baseline');
      const patch = [
        'diff --git a/test/golden/protected.txt b/src/copied.txt',
        'similarity index 100%',
        'copy from test/golden/protected.txt',
        'copy to src/copied.txt',
        '',
      ].join('\n');
      const outcome = await h.executor.execute(
        {
          type: 'APPLY_PATCH',
          actionId: 'copy-patch',
          diffRef: h.executorOptions.evidence.put(patch),
        },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'golden_write_denied');
      }
      assert.equal(existsSync(join(h.worktree, 'src', 'copied.txt')), false);
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });

  await t.test('conflict', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    try {
      mkdirSync(join(h.worktree, 'src'), { recursive: true });
      writeFileSync(join(h.worktree, 'src', 'conflict.txt'), 'current\n');
      commitFixture(h.worktree, 'conflict baseline');
      const patch = [
        'diff --git a/src/conflict.txt b/src/conflict.txt',
        '--- a/src/conflict.txt',
        '+++ b/src/conflict.txt',
        '@@ -1 +1 @@',
        '-expected',
        '+replacement',
        '',
      ].join('\n');
      const outcome = await h.executor.execute(
        {
          type: 'APPLY_PATCH',
          actionId: 'conflicting-patch',
          diffRef: h.executorOptions.evidence.put(patch),
        },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'patch_conflict');
      }
      assert.equal(readFileSync(join(h.worktree, 'src', 'conflict.txt'), 'utf8'), 'current\n');
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });
});

test('REQ-3.7: admission restores the last applied artifact before accepting a distinct mutation', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    const patch = (actionId: string, path: string, content: string) =>
      ({
        type: 'APPLY_PATCH',
        actionId,
        diffRef: h.executorOptions.evidence.put(
          [
            `diff --git a/${path} b/${path}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${path}`,
            '@@ -0,0 +1 @@',
            `+${content}`,
            '',
          ].join('\n'),
        ),
      }) as const;
    const actionA = patch(
      'admission-applied-a',
      'src/admission-a.txt',
      'accepted A',
    );
    const actionB = patch(
      'admission-distinct-b',
      'src/admission-b.txt',
      'accepted B',
    );

    assert.equal(
      (await h.executor.execute(actionA, 'implementer')).status,
      'applied',
    );
    writeFileSync(
      join(h.worktree, 'src', 'admission-a.txt'),
      'external tamper\n',
    );

    const acceptedB = await h.executor.execute(actionB, 'implementer');

    assert.equal(acceptedB.status, 'applied');
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'admission-a.txt'), 'utf8'),
      'accepted A\n',
      'admission must not seal external tamper into the next resultHash',
    );
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'admission-b.txt'), 'utf8'),
      'accepted B\n',
    );
    const applied = h.executorOptions.log
      .all({ type: 'ACTION_APPLIED' })
      .filter((event) => event.payload['duplicate'] !== true);
    assert.equal(applied.length, 2);
    assert.equal(
      applied[1]?.payload['actionId'],
      actionB.actionId,
    );
    const beforeRecovery = h.executorOptions.log.all().length;
    assert.equal((await recoverWorktree(h.executorOptions)).action, 'none');
    assert.equal(h.executorOptions.log.all().length, beforeRecovery);
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'admission-a.txt'), 'utf8'),
      'accepted A\n',
    );
  } finally {
    h.cleanup();
  }
});

test('Task 27/REQ-3.6-3.8: ignored writable bytes participate in result identity and admission recovery', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  const ignored = join(h.worktree, 'src', 'identity.hidden');
  try {
    writeFileSync(join(h.worktree, '.gitignore'), 'src/*.hidden\n');
    commitFixture(h.worktree, 'ignore authoritative source fixture');

    const first = await h.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'full-identity-ignored-first',
        path: 'src/identity.hidden',
        contentRef: h.executorOptions.evidence.put('accepted one\n'),
      },
      'implementer',
    );
    const second = await h.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'full-identity-ignored-second',
        path: 'src/identity.hidden',
        contentRef: h.executorOptions.evidence.put('accepted two\n'),
      },
      'implementer',
    );

    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'applied');
    if (first.status !== 'applied' || second.status !== 'applied') {
      assert.fail('ignored writes must be applied');
    }
    assert.notEqual(
      second.resultHash,
      first.resultHash,
      'changing ignored durable bytes must change ACTION_APPLIED.resultHash',
    );

    writeFileSync(ignored, 'external tamper\n');
    const third = await h.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'full-identity-after-external-tamper',
        path: 'src/after-tamper.txt',
        contentRef: h.executorOptions.evidence.put('accepted three\n'),
      },
      'implementer',
    );

    assert.equal(third.status, 'applied');
    assert.equal(
      readFileSync(ignored, 'utf8'),
      'accepted two\n',
      'distinct mutation admission must restore ignored bytes before accepting the action',
    );
    const beforeRestart = h.executorOptions.log.all().length;
    assert.equal((await recoverWorktree(h.executorOptions)).action, 'none');
    assert.equal(h.executorOptions.log.all().length, beforeRestart);
  } finally {
    h.cleanup();
  }
});

test('Task 28/REQ-3.6-3.8: every mutator reconciles the complete ignored, denied, quoted, and symlink artifact domain', async (t) => {
  const scenarios = [
    { tamper: 'mutate', nextType: 'WRITE_FILE' },
    { tamper: 'delete', nextType: 'APPLY_PATCH' },
    { tamper: 'add', nextType: 'RUN_COMMAND' },
  ] as const;
  for (const scenario of scenarios) {
    await t.test(`${scenario.tamper} before ${scenario.nextType}`, async () => {
      const h = harness({
        git: true,
        sandbox: FAKE_AVAILABLE,
        coreCommandExecutor: injectedPromotion(),
        offlineDependencyPolicy: persistentOutputPolicy,
      });
      const quoted = join(h.worktree, "src", "quoted ' artifact.hidden");
      const denied = join(h.worktree, 'docs', 'denied artifact.hidden');
      const added = join(h.worktree, 'docs', 'external added.hidden');
      const link = join(h.worktree, 'src', 'identity link.hidden');
      try {
        writeFileSync(
          join(h.worktree, '.gitignore'),
          '*.hidden\nnode_modules/\n',
        );
        mkdirSync(join(h.worktree, 'src'), { recursive: true });
        mkdirSync(join(h.worktree, 'docs'), { recursive: true });
        writeFileSync(join(h.worktree, 'src', 'link-one.txt'), 'one\n');
        writeFileSync(join(h.worktree, 'src', 'link-two.txt'), 'two\n');
        writeFileSync(denied, 'accepted denied bytes\n');
        symlinkSync('link-one.txt', link);
        commitFixture(h.worktree, 'full artifact identity fixture');

        const acceptedA = await h.executor.execute(
          {
            type: 'WRITE_FILE',
            actionId: `full-domain-a-${scenario.nextType}`,
            path: "src/quoted ' artifact.hidden",
            contentRef: h.executorOptions.evidence.put('accepted quoted bytes\n'),
          },
          'implementer',
        );
        assert.equal(acceptedA.status, 'applied');

        if (scenario.tamper === 'mutate') {
          writeFileSync(denied, 'external denied mutation\n');
          chmodSync(denied, 0o755);
          rmSync(link);
          symlinkSync('link-two.txt', link);
        } else if (scenario.tamper === 'delete') {
          rmSync(quoted);
        } else {
          writeFileSync(added, 'external residue\n');
        }

        let nextAction: Action;
        if (scenario.nextType === 'WRITE_FILE') {
          nextAction = {
            type: 'WRITE_FILE',
            actionId: 'full-domain-write-b',
            path: 'src/full-domain-write-b.txt',
            contentRef: h.executorOptions.evidence.put('B\n'),
          };
        } else if (scenario.nextType === 'APPLY_PATCH') {
          nextAction = {
            type: 'APPLY_PATCH',
            actionId: 'full-domain-patch-b',
            diffRef: h.executorOptions.evidence.put(
              [
                'diff --git a/src/full-domain-patch-b.txt b/src/full-domain-patch-b.txt',
                'new file mode 100644',
                '--- /dev/null',
                '+++ b/src/full-domain-patch-b.txt',
                '@@ -0,0 +1 @@',
                '+B',
                '',
              ].join('\n'),
            ),
          };
        } else {
          nextAction = {
            type: 'RUN_COMMAND',
            actionId: 'full-domain-run-b',
            cmd: 'injected-offline-install',
            network: 'none',
          };
        }

        assert.equal(
          (await h.executor.execute(nextAction, 'implementer')).status,
          'applied',
        );
        assert.equal(readFileSync(denied, 'utf8'), 'accepted denied bytes\n');
        assert.equal(statSync(denied).mode & 0o777, 0o644);
        assert.equal(
          readFileSync(quoted, 'utf8'),
          'accepted quoted bytes\n',
        );
        assert.equal(existsSync(added), false);
        assert.equal(readlinkSync(link), 'link-one.txt');
        const beforeRestart = h.executorOptions.log.all().length;
        assert.equal((await recoverWorktree(h.executorOptions)).action, 'none');
        assert.equal(h.executorOptions.log.all().length, beforeRestart);
      } finally {
        h.cleanup();
      }
    });
  }
});

test('Task 28/REQ-3.6: WRITE_FILE, APPLY_PATCH, and RUN_COMMAND post-effect hashes include ignored bytes outside persistent roots', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: injectedAppendCommand(() => undefined),
  });
  try {
    writeFileSync(
      join(h.worktree, '.gitignore'),
      'src/*.hidden\nsrc/run-replay.txt\n',
    );
    commitFixture(h.worktree, 'ignored post-effect identity fixture');
    const write = await h.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'ignored-post-write',
        path: 'src/post-effect.hidden',
        contentRef: h.executorOptions.evidence.put('one\n'),
      },
      'implementer',
    );
    assert.equal(write.status, 'applied');
    if (write.status !== 'applied') assert.fail('WRITE_FILE must apply');

    const patch = await h.executor.execute(
      {
        type: 'APPLY_PATCH',
        actionId: 'ignored-post-patch',
        diffRef: h.executorOptions.evidence.put(
          [
            'diff --git a/src/patch-output.hidden b/src/patch-output.hidden',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/src/patch-output.hidden',
            '@@ -0,0 +1 @@',
            '+patch output',
            '',
          ].join('\n'),
        ),
      },
      'implementer',
    );
    assert.equal(patch.status, 'applied', JSON.stringify(patch));
    if (patch.status !== 'applied') assert.fail('APPLY_PATCH must apply');
    assert.notEqual(patch.resultHash, write.resultHash);

    const command = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'ignored-post-command',
        cmd: 'injected ignored command output',
        network: 'none',
      },
      'implementer',
    );
    assert.equal(command.status, 'applied');
    if (command.status !== 'applied') assert.fail('RUN_COMMAND must apply');
    assert.notEqual(command.resultHash, patch.resultHash);
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'post-effect.hidden'), 'utf8'),
      'one\n',
    );
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'patch-output.hidden'), 'utf8'),
      'patch output\n',
    );
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'run-replay.txt'), 'utf8'),
      'B\n',
    );
  } finally {
    h.cleanup();
  }
});

test('Task 28/REQ-3.6: special filesystem nodes fail closed before intent', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    execFileSync('mkfifo', [join(h.worktree, 'src', 'unsupported.fifo')]);

    const outcome = await h.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'full-domain-special-node',
        path: 'src/must-not-exist.txt',
        contentRef: h.executorOptions.evidence.put('blocked\n'),
      },
      'implementer',
    );

    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.equal(
        outcome.rejection.reason,
        'command_artifact_unavailable',
      );
      assert.match(outcome.rejection.detail, /unsupported filesystem object/u);
    }
    assert.equal(existsSync(join(h.worktree, 'src', 'must-not-exist.txt')), false);
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('Task 28/REQ-3.6: unsafe ignored symlink targets return a structured pre-intent rejection', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    symlinkSync(
      join(h.root, 'outside.txt'),
      join(h.worktree, 'src', 'unsafe.hidden'),
    );

    const outcome = await h.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'artifact-unsafe-symlink',
        path: 'src/must-not-exist.txt',
        contentRef: h.executorOptions.evidence.put('blocked\n'),
      },
      'implementer',
    );

    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.equal(
        outcome.rejection.reason,
        'command_artifact_unavailable',
      );
      assert.match(outcome.rejection.detail, /absolute symlink target is unsafe/u);
    }
    assert.equal(existsSync(join(h.worktree, 'src', 'must-not-exist.txt')), false);
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('Task 28/REQ-3.6: ignored symlink capture rejects a parent-directory swap without following it', async () => {
  let swapped = false;
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    artifactIdentityBeforeFileOpen(relativePath) {
      if (
        relativePath !== 'docs/nested/link.hidden' ||
        swapped
      ) {
        return;
      }
      swapped = true;
      rmSync(join(h.worktree, 'docs', 'nested'), {
        recursive: true,
        force: true,
      });
      symlinkSync(join(h.root, 'outside'), join(h.worktree, 'docs', 'nested'));
    },
  });
  try {
    const outside = join(h.root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'link.hidden'), 'outside bytes\n');
    mkdirSync(join(h.worktree, 'docs', 'nested'), { recursive: true });
    symlinkSync('target.txt', join(h.worktree, 'docs', 'nested', 'link.hidden'));

    const outcome = await h.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'artifact-symlink-parent-race',
        path: 'src/must-not-be-written.txt',
        contentRef: h.executorOptions.evidence.put('blocked\n'),
      },
      'implementer',
    );

    assert.equal(swapped, true);
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.equal(
        outcome.rejection.reason,
        'command_artifact_unavailable',
      );
      assert.match(
        outcome.rejection.detail,
        /descriptor-safe symlink read rejected/u,
      );
    }
    assert.equal(
      existsSync(join(h.worktree, 'src', 'must-not-be-written.txt')),
      false,
    );
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('Task 28/REQ-3.6: artifact identity file, single-file, and total-byte bounds reject and rollback exactly', async (t) => {
  const cases: Array<{
    name: string;
    policy: ArtifactIdentityPolicy;
    expected: RegExp;
  }> = [
    {
      name: 'maxFiles',
      policy: {
        version: 1,
        maxFiles: 1,
        maxSingleFileBytes: 1024,
        maxTotalBytes: 1024,
        captureTimeoutMs: 10_000,
      },
      expected: /maxFiles=1/u,
    },
    {
      name: 'maxSingleFileBytes',
      policy: {
        version: 1,
        maxFiles: 100,
        maxSingleFileBytes: 1,
        maxTotalBytes: 1024,
        captureTimeoutMs: 10_000,
      },
      expected: /maxSingleFileBytes=1/u,
    },
    {
      name: 'maxTotalBytes',
      policy: {
        version: 1,
        maxFiles: 100,
        maxSingleFileBytes: 1024,
        maxTotalBytes: 1,
        captureTimeoutMs: 10_000,
      },
      expected: /maxTotalBytes=1/u,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const h = harness({
        git: true,
        sandbox: FAKE_AVAILABLE,
        artifactIdentityPolicy: scenario.policy,
      });
      try {
        const outcome = await h.executor.execute(
          {
            type: 'WRITE_FILE',
            actionId: `artifact-bound-${scenario.name}`,
            path: 'src/bounded.txt',
            contentRef: h.executorOptions.evidence.put('XX'),
          },
          'implementer',
        );

        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.equal(
            outcome.rejection.reason,
            'command_artifact_unavailable',
          );
          assert.match(outcome.rejection.detail, scenario.expected);
        }
        assert.equal(existsSync(join(h.worktree, 'src', 'bounded.txt')), false);
        assert.equal(
          h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length,
          0,
        );
      } finally {
        h.cleanup();
      }
    });
  }
});

test('Task 28/REQ-3.6: authoritative capture obeys cancellation and its own finite deadline', async (t) => {
  await t.test('cancellation during descriptor capture', async () => {
    const controller = new AbortController();
    const h = harness({
      git: true,
      sandbox: FAKE_AVAILABLE,
      commandSignal: controller.signal,
      artifactIdentityBeforeFileOpen: () => controller.abort(),
    });
    try {
      const outcome = await h.executor.execute(
        {
          type: 'WRITE_FILE',
          actionId: 'artifact-capture-cancelled',
          path: 'src/cancelled.txt',
          contentRef: h.executorOptions.evidence.put('blocked\n'),
        },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'cancelled');
      }
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });

  await t.test('capture deadline', async () => {
    const h = harness({
      git: true,
      sandbox: FAKE_AVAILABLE,
      artifactIdentityPolicy: {
        version: 1,
        maxFiles: 100,
        maxSingleFileBytes: 1024,
        maxTotalBytes: 1024,
        captureTimeoutMs: 1,
      },
    });
    try {
      const outcome = await h.executor.execute(
        {
          type: 'WRITE_FILE',
          actionId: 'artifact-capture-timeout',
          path: 'src/timed-out.txt',
          contentRef: h.executorOptions.evidence.put('blocked\n'),
        },
        'implementer',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'timed_out');
      }
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });
});

test('Task 28/REQ-3.7: crash/restart replays ignored writable bytes in the authoritative snapshot domain', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: { crashAfterApply: true },
  });
  try {
    writeFileSync(join(h.worktree, '.gitignore'), '*.hidden\n');
    commitFixture(h.worktree, 'ignored crash fixture');
    const action = {
      type: 'WRITE_FILE',
      actionId: 'artifact-crash-restart',
      path: 'src/crash result.hidden',
      contentRef: h.executorOptions.evidence.put('accepted after restart\n'),
    } as const;

    await assert.rejects(
      h.executor.execute(action, 'implementer'),
      CrashInjected,
    );
    assert.equal(
      readFileSync(join(h.worktree, action.path), 'utf8'),
      'accepted after restart\n',
    );
    const { failpoints: _failpoints, ...restartOptions } = h.executorOptions;
    const report = await recoverWorktree(restartOptions);

    assert.equal(report.action, 'replayed_intent');
    assert.equal(
      readFileSync(join(h.worktree, action.path), 'utf8'),
      'accepted after restart\n',
    );
    assert.equal((await recoverWorktree(restartOptions)).action, 'none');
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: admission reconciles ignored-output mutation, deletion, and addition before every mutator type', async (t) => {
  const cases = [
    { tamper: 'mutation', nextType: 'WRITE_FILE' },
    { tamper: 'deletion', nextType: 'APPLY_PATCH' },
    { tamper: 'addition', nextType: 'RUN_COMMAND' },
  ] as const;
  for (const scenario of cases) {
    await t.test(
      `${scenario.tamper} before ${scenario.nextType}`,
      async () => {
        let commandRuns = 0;
        const h = harness({
          git: true,
          sandbox: FAKE_AVAILABLE,
          coreCommandExecutor: injectedPromotion(() => {
            commandRuns += 1;
          }),
          offlineDependencyPolicy: persistentOutputPolicy,
        });
        const installed = join(
          h.worktree,
          'node_modules',
          'phase0-offline-dependency',
          'index.js',
        );
        const extra = join(installed, '..', 'extra.js');
        try {
          writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
          assert.equal(
            (
              await h.executor.execute(
                {
                  type: 'RUN_COMMAND',
                  actionId: `admission-persistent-a-${scenario.tamper}`,
                  cmd: 'injected-offline-install',
                  network: 'none',
                },
                'implementer',
              )
            ).status,
            'applied',
          );

          if (scenario.tamper === 'mutation') {
            writeFileSync(installed, 'external tamper\n');
          } else if (scenario.tamper === 'deletion') {
            rmSync(installed);
          } else {
            writeFileSync(extra, 'unexpected\n');
          }

          let nextAction: Action;
          if (scenario.nextType === 'WRITE_FILE') {
            nextAction = {
              type: 'WRITE_FILE',
              actionId: 'admission-write-b',
              path: 'src/admission-write-b.txt',
              contentRef: h.executorOptions.evidence.put('WRITE B\n'),
            };
          } else if (scenario.nextType === 'APPLY_PATCH') {
            nextAction = {
              type: 'APPLY_PATCH',
              actionId: 'admission-patch-b',
              diffRef: h.executorOptions.evidence.put(
                [
                  'diff --git a/src/admission-patch-b.txt b/src/admission-patch-b.txt',
                  'new file mode 100644',
                  '--- /dev/null',
                  '+++ b/src/admission-patch-b.txt',
                  '@@ -0,0 +1 @@',
                  '+PATCH B',
                  '',
                ].join('\n'),
              ),
            };
          } else {
            nextAction = {
              type: 'RUN_COMMAND',
              actionId: 'admission-command-b',
              cmd: 'injected-offline-install',
              network: 'none',
            };
          }

          assert.equal(
            (await h.executor.execute(nextAction, 'implementer')).status,
            'applied',
          );
          assert.equal(readFileSync(installed, 'utf8'), 'approved\n');
          assert.equal(existsSync(extra), false);
          if (scenario.nextType === 'WRITE_FILE') {
            assert.equal(
              readFileSync(
                join(h.worktree, 'src', 'admission-write-b.txt'),
                'utf8',
              ),
              'WRITE B\n',
            );
          } else if (scenario.nextType === 'APPLY_PATCH') {
            assert.equal(
              readFileSync(
                join(h.worktree, 'src', 'admission-patch-b.txt'),
                'utf8',
              ),
              'PATCH B\n',
            );
          }
          assert.equal(
            commandRuns,
            scenario.nextType === 'RUN_COMMAND' ? 3 : 2,
            'A runs originally and once during reconciliation; command B runs only for the RUN_COMMAND case',
          );
          const beforeRestart = h.executorOptions.log.all().length;
          assert.equal(
            (await recoverWorktree(h.executorOptions)).action,
            'none',
          );
          assert.equal(h.executorOptions.log.all().length, beforeRestart);
        } finally {
          h.cleanup();
        }
      },
    );
  }
});

test('REQ-3.7/3.8: no-tamper admission keeps the accepted fast path and duplicate idempotency', async () => {
  let commandRuns = 0;
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: injectedPromotion(() => {
      commandRuns += 1;
    }),
    offlineDependencyPolicy: persistentOutputPolicy,
  });
  const actionA = {
    type: 'RUN_COMMAND',
    actionId: 'admission-fast-a',
    cmd: 'injected-offline-install',
    network: 'none',
  } as const;
  try {
    writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
    assert.equal(
      (await h.executor.execute(actionA, 'implementer')).status,
      'applied',
    );
    assert.equal(
      (
        await h.executor.execute(
          {
            type: 'WRITE_FILE',
            actionId: 'admission-fast-b',
            path: 'src/admission-fast-b.txt',
            contentRef: h.executorOptions.evidence.put('B\n'),
          },
          'implementer',
        )
      ).status,
      'applied',
    );
    assert.equal(commandRuns, 1, 'coherent admission must not replay A');
    assert.equal(
      (await h.executor.execute(actionA, 'implementer')).status,
      'skipped_duplicate',
    );
    assert.equal(commandRuns, 1, 'duplicate skip must not replay A');
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: pre-cancelled admission rejects every mutator before reconciliation side effects or a new intent', async (t) => {
  for (const nextType of [
    'WRITE_FILE',
    'APPLY_PATCH',
    'RUN_COMMAND',
  ] as const) {
    await t.test(nextType, async () => {
      let commandRuns = 0;
      const h = harness({
        git: true,
        sandbox: FAKE_AVAILABLE,
        coreCommandExecutor: injectedPromotion(() => {
          commandRuns += 1;
        }),
        offlineDependencyPolicy: persistentOutputPolicy,
      });
      try {
        writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
        assert.equal(
          (
            await h.executor.execute(
              {
                type: 'RUN_COMMAND',
                actionId: `admission-cancel-a-${nextType}`,
                cmd: 'injected-offline-install',
                network: 'none',
              },
              'implementer',
            )
          ).status,
          'applied',
        );
        const controller = new AbortController();
        controller.abort();
        const cancelledExecutor = createExecutor({
          ...h.executorOptions,
          commandSignal: controller.signal,
        });
        let nextAction: Action;
        if (nextType === 'WRITE_FILE') {
          nextAction = {
            type: 'WRITE_FILE',
            actionId: 'admission-cancel-write-b',
            path: 'src/admission-cancel-write-b.txt',
            contentRef: h.executorOptions.evidence.put('B\n'),
          };
        } else if (nextType === 'APPLY_PATCH') {
          nextAction = {
            type: 'APPLY_PATCH',
            actionId: 'admission-cancel-patch-b',
            diffRef: h.executorOptions.evidence.put(
              [
                'diff --git a/src/admission-cancel-patch-b.txt b/src/admission-cancel-patch-b.txt',
                'new file mode 100644',
                '--- /dev/null',
                '+++ b/src/admission-cancel-patch-b.txt',
                '@@ -0,0 +1 @@',
                '+B',
                '',
              ].join('\n'),
            ),
          };
        } else {
          nextAction = {
            type: 'RUN_COMMAND',
            actionId: 'admission-cancel-command-b',
            cmd: 'injected-offline-install',
            network: 'none',
          };
        }
        const beforeIntents = h.executorOptions.log.all({
          type: 'ACTION_INTENT',
        }).length;

        const rejected = await cancelledExecutor.execute(
          nextAction,
          'implementer',
        );

        assert.equal(rejected.status, 'rejected');
        if (rejected.status === 'rejected') {
          assert.equal(rejected.rejection.reason, 'cancelled');
        }
        assert.equal(
          h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length,
          beforeIntents,
        );
        assert.equal(commandRuns, 1);
        const forbiddenSideEffect =
          nextType === 'WRITE_FILE'
            ? 'admission-cancel-write-b.txt'
            : nextType === 'APPLY_PATCH'
              ? 'admission-cancel-patch-b.txt'
              : undefined;
        if (forbiddenSideEffect !== undefined) {
          assert.equal(
            existsSync(join(h.worktree, 'src', forbiddenSideEffect)),
            false,
          );
        }
      } finally {
        h.cleanup();
      }
    });
  }
});

test('REQ-3.7: admission reconciliation obeys the mutating action deadline before a new intent', async () => {
  let commandRuns = 0;
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: injectedPromotion(() => {
      commandRuns += 1;
    }),
    offlineDependencyPolicy: persistentOutputPolicy,
  });
  try {
    writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
    assert.equal(
      (
        await h.executor.execute(
          {
            type: 'RUN_COMMAND',
            actionId: 'admission-timeout-a',
            cmd: 'injected-offline-install',
            network: 'none',
          },
          'implementer',
        )
      ).status,
      'applied',
    );
    writeFileSync(
      join(
        h.worktree,
        'node_modules',
        'phase0-offline-dependency',
        'index.js',
      ),
      'external tamper\n',
    );
    const beforeIntents = h.executorOptions.log.all({
      type: 'ACTION_INTENT',
    }).length;

    const rejected = await h.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'admission-timeout-b',
        cmd: 'injected-offline-install',
        network: 'none',
        timeoutMs: 1,
      },
      'implementer',
    );

    assert.equal(rejected.status, 'rejected');
    if (rejected.status === 'rejected') {
      assert.equal(rejected.rejection.reason, 'timed_out');
    }
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length,
      beforeIntents,
    );
    assert.equal(commandRuns, 1);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: failed admission reconciliation creates no new intent or side effect and becomes restart-safe', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  const contentRef = h.executorOptions.evidence.put('accepted A\n');
  const actionA = {
    type: 'WRITE_FILE',
    actionId: 'admission-failure-a',
    path: 'src/admission-failure-a.txt',
    contentRef,
  } as const;
  const actionB = {
    type: 'WRITE_FILE',
    actionId: 'admission-failure-b',
    path: 'src/admission-failure-b.txt',
    contentRef: h.executorOptions.evidence.put('B must not run\n'),
  } as const;
  try {
    assert.equal(
      (await h.executor.execute(actionA, 'implementer')).status,
      'applied',
    );
    writeFileSync(
      join(h.worktree, 'src', 'admission-failure-a.txt'),
      'external tamper\n',
    );
    rmSync(join(h.root, 'evidence', contentRef.slice('blob://'.length)));
    const beforeB = h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length;

    const rejected = await h.executor.execute(actionB, 'implementer');

    assert.equal(rejected.status, 'rejected');
    if (rejected.status === 'rejected') {
      assert.equal(
        rejected.rejection.reason,
        'command_artifact_unavailable',
      );
      assert.match(rejected.rejection.detail, /reconciliation|failed|evidence/i);
    }
    assert.equal(
      h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length,
      beforeB,
    );
    assert.equal(
      existsSync(join(h.worktree, 'src', 'admission-failure-b.txt')),
      false,
    );
    const restartOptions = { ...h.executorOptions };
    const firstRestart = await recoverWorktree(restartOptions);
    assert.equal(firstRestart.action, 'none');
    const beforeSecondRestart = h.executorOptions.log.all().length;
    assert.equal((await recoverWorktree(restartOptions)).action, 'none');
    assert.equal(
      h.executorOptions.log.all().length,
      beforeSecondRestart,
    );
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: dangling recovery replays the preceding accepted identity instead of trusting a tampered snapshot', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  const patch = (actionId: string, path: string, content: string) =>
    ({
      type: 'APPLY_PATCH',
      actionId,
      diffRef: h.executorOptions.evidence.put(
        [
          `diff --git a/${path} b/${path}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${path}`,
          '@@ -0,0 +1 @@',
          `+${content}`,
          '',
        ].join('\n'),
      ),
    }) as const;
  const actionA = patch(
    'admission-dangling-predecessor-a',
    'src/admission-dangling-a.txt',
    'accepted A',
  );
  const actionB = patch(
    'admission-dangling-successor-b',
    'src/admission-dangling-b.txt',
    'accepted B',
  );
  try {
    assert.equal(
      (await h.executor.execute(actionA, 'implementer')).status,
      'applied',
    );
    const hiddenAcceptedSeqs = new Set(
      h.executorOptions.log
        .all({ taskId: 'T-1' })
        .filter(
          (event) =>
            event.payload['actionId'] === actionA.actionId &&
            (event.type === 'ACTION_INTENT' ||
              event.type === 'ACTION_APPLIED'),
        )
        .map((event) => event.seq),
    );
    writeFileSync(
      join(h.worktree, 'src', 'admission-dangling-a.txt'),
      'external tamper before dangling intent\n',
    );
    const legacyView = {
      ...h.executorOptions.log,
      append: h.executorOptions.log.append.bind(h.executorOptions.log),
      all: (filter?: Parameters<typeof h.executorOptions.log.all>[0]) =>
        h.executorOptions.log
          .all(filter)
          .filter((event) => !hiddenAcceptedSeqs.has(event.seq)),
    };
    await assert.rejects(
      createExecutor({
        ...h.executorOptions,
        log: legacyView,
        failpoints: { crashAfterIntent: true },
      }).execute(actionB, 'implementer'),
      CrashInjected,
    );

    const recovered = await recoverWorktree(h.executorOptions);

    assert.equal(recovered.action, 'replayed_intent');
    assert.equal(recovered.source, 'dangling_intent');
    assert.equal(
      readFileSync(
        join(h.worktree, 'src', 'admission-dangling-a.txt'),
        'utf8',
      ),
      'accepted A\n',
    );
    assert.equal(
      readFileSync(
        join(h.worktree, 'src', 'admission-dangling-b.txt'),
        'utf8',
      ),
      'accepted B\n',
    );
    assert.equal((await recoverWorktree(h.executorOptions)).action, 'none');
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: a dangling patch intent is recovered before a later accepted mutation', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: { crashAfterApply: true },
  });
  try {
    const actionA = {
      type: 'APPLY_PATCH',
      actionId: 'buried-dangling-a',
      diffRef: h.executorOptions.evidence.put(
        [
          'diff --git a/src/a.txt b/src/a.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/src/a.txt',
          '@@ -0,0 +1 @@',
          '+A',
          '',
        ].join('\n'),
      ),
    } as const;
    const actionB = {
      type: 'APPLY_PATCH',
      actionId: 'later-accepted-b',
      diffRef: h.executorOptions.evidence.put(
        [
          'diff --git a/src/b.txt b/src/b.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/src/b.txt',
          '@@ -0,0 +1 @@',
          '+B',
          '',
        ].join('\n'),
      ),
    } as const;

    await assert.rejects(h.executor.execute(actionA, 'implementer'), CrashInjected);
    const { failpoints: _crashFailpoints, ...restartOptions } = h.executorOptions;
    const later = await createExecutor(restartOptions).execute(actionB, 'implementer');

    assert.equal(later.status, 'applied');
    assert.equal(readFileSync(join(h.worktree, 'src', 'a.txt'), 'utf8'), 'A\n');
    assert.equal(readFileSync(join(h.worktree, 'src', 'b.txt'), 'utf8'), 'B\n');
    const lifecycle = h.executorOptions.log
      .all({ taskId: 'T-1' })
      .filter(
        (event) =>
          event.type === 'ACTION_INTENT' || event.type === 'ACTION_APPLIED',
      );
    assert.deepEqual(
      lifecycle.map((event) => event.type),
      ['ACTION_INTENT', 'ACTION_APPLIED', 'ACTION_INTENT', 'ACTION_APPLIED'],
    );
    const intents = lifecycle.filter((event) => event.type === 'ACTION_INTENT');
    const applieds = lifecycle.filter((event) => event.type === 'ACTION_APPLIED');
    assert.equal(applieds[0]?.payload['intentSeq'], intents[0]?.seq);
    assert.equal(applieds[0]?.payload['recovered'], true);
    assert.equal(applieds[1]?.payload['intentSeq'], intents[1]?.seq);
    assert.equal((await recoverWorktree(restartOptions)).action, 'none');
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: recovery reconstructs a legacy accepted suffix after the earliest dangling intent', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: { crashAfterApply: true },
  });
  try {
    const actionA = {
      type: 'APPLY_PATCH',
      actionId: 'legacy-dangling-a',
      diffRef: h.executorOptions.evidence.put(
        [
          'diff --git a/src/legacy-a.txt b/src/legacy-a.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/src/legacy-a.txt',
          '@@ -0,0 +1 @@',
          '+A',
          '',
        ].join('\n'),
      ),
    } as const;
    const actionB = {
      type: 'APPLY_PATCH',
      actionId: 'legacy-applied-b',
      diffRef: h.executorOptions.evidence.put(
        [
          'diff --git a/src/legacy-b.txt b/src/legacy-b.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/src/legacy-b.txt',
          '@@ -0,0 +1 @@',
          '+B',
          '',
        ].join('\n'),
      ),
    } as const;

    await assert.rejects(h.executor.execute(actionA, 'implementer'), CrashInjected);
    const intentA = h.executorOptions.log.all({ type: 'ACTION_INTENT' })[0];
    if (intentA === undefined) assert.fail('crashed action must record its intent');
    const legacyView = {
      ...h.executorOptions.log,
      append: h.executorOptions.log.append.bind(h.executorOptions.log),
      all: (filter?: Parameters<typeof h.executorOptions.log.all>[0]) =>
        h.executorOptions.log
          .all(filter)
          .filter((event) => event.seq !== intentA.seq),
    };
    const { failpoints: _crashFailpoints, ...restartOptions } = h.executorOptions;
    const legacyWriter = createExecutor({ ...restartOptions, log: legacyView });
    assert.equal(
      (await legacyWriter.execute(actionB, 'implementer')).status,
      'applied',
    );
    assert.deepEqual(
      h.executorOptions.log
        .all({ taskId: 'T-1' })
        .filter(
          (event) =>
            event.type === 'ACTION_INTENT' ||
            event.type === 'ACTION_APPLIED',
        )
        .map((event) => event.type),
      ['ACTION_INTENT', 'ACTION_INTENT', 'ACTION_APPLIED'],
    );

    const report = await recoverWorktree(restartOptions);

    assert.equal(report.action, 'replayed_intent');
    assert.equal(readFileSync(join(h.worktree, 'src', 'legacy-a.txt'), 'utf8'), 'A\n');
    assert.equal(readFileSync(join(h.worktree, 'src', 'legacy-b.txt'), 'utf8'), 'B\n');
    const intents = h.executorOptions.log.all({ type: 'ACTION_INTENT' });
    const applieds = h.executorOptions.log
      .all({ type: 'ACTION_APPLIED' })
      .filter((event) => event.payload['duplicate'] !== true);
    assert.equal(applieds.length, 2);
    assert.equal(
      applieds.filter(
        (event) => event.payload['intentSeq'] === intents[0]?.seq,
      ).length,
      1,
    );
    assert.equal(
      applieds.filter(
        (event) => event.payload['intentSeq'] === intents[1]?.seq,
      ).length,
      1,
    );
    const beforeSecondRecovery = h.executorOptions.log.all().length;
    assert.equal((await recoverWorktree(restartOptions)).action, 'none');
    assert.equal(h.executorOptions.log.all().length, beforeSecondRecovery);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: recovery replays multiple dangling generations around an accepted RUN_COMMAND in causal order', async () => {
  let commandRuns = 0;
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: injectedAppendCommand(() => {
      commandRuns += 1;
    }),
    failpoints: { crashAfterApply: true },
  });
  try {
    const patch = (actionId: string, path: string, content: string) =>
      ({
        type: 'APPLY_PATCH',
        actionId,
        diffRef: h.executorOptions.evidence.put(
          [
            `diff --git a/${path} b/${path}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${path}`,
            '@@ -0,0 +1 @@',
            `+${content}`,
            '',
          ].join('\n'),
        ),
      }) as const;
    const actionA = patch('multi-dangling-a', 'src/multi-a.txt', 'A');
    const actionB = {
      type: 'RUN_COMMAND',
      actionId: 'multi-applied-run-b',
      cmd: 'injected deterministic append',
      network: 'none',
    } as const;
    const actionC = patch('multi-dangling-c', 'src/multi-c.txt', 'C');

    await assert.rejects(h.executor.execute(actionA, 'implementer'), CrashInjected);
    const intentA = h.executorOptions.log.all({ type: 'ACTION_INTENT' })[0];
    if (intentA === undefined) assert.fail('first crash must record an intent');
    const legacyView = {
      ...h.executorOptions.log,
      append: h.executorOptions.log.append.bind(h.executorOptions.log),
      all: (filter?: Parameters<typeof h.executorOptions.log.all>[0]) =>
        h.executorOptions.log
          .all(filter)
          .filter((event) => event.seq !== intentA.seq),
    };
    const { failpoints: _firstCrash, ...restartOptions } = h.executorOptions;
    assert.equal(
      (
        await createExecutor({ ...restartOptions, log: legacyView }).execute(
          actionB,
          'implementer',
        )
      ).status,
      'applied',
    );
    await assert.rejects(
      createExecutor({
        ...restartOptions,
        log: legacyView,
        failpoints: { crashAfterApply: true },
      }).execute(actionC, 'implementer'),
      CrashInjected,
    );
    const intents = h.executorOptions.log.all({ type: 'ACTION_INTENT' });
    assert.equal(intents.length, 3);
    const beforeRecoverySeq = h.executorOptions.log.all().at(-1)?.seq ?? 0;

    const report = await recoverWorktree(restartOptions);

    assert.equal(report.action, 'replayed_intent');
    assert.equal(commandRuns, 2, 'accepted command runs once originally and once after rollback');
    assert.equal(readFileSync(join(h.worktree, 'src', 'multi-a.txt'), 'utf8'), 'A\n');
    assert.equal(readFileSync(join(h.worktree, 'src', 'run-replay.txt'), 'utf8'), 'B\n');
    assert.equal(readFileSync(join(h.worktree, 'src', 'multi-c.txt'), 'utf8'), 'C\n');
    for (const intent of intents) {
      const causalTerminals = h.executorOptions.log
        .all({ taskId: 'T-1' })
        .filter(
          (event) =>
            (event.type === 'ACTION_APPLIED' ||
              event.type === 'ACTION_REJECTED') &&
            event.payload['actionId'] === intent.payload['actionId'] &&
            event.payload['intentSeq'] === intent.seq,
        );
      assert.equal(
        causalTerminals.length,
        1,
        `intentSeq=${intent.seq} must have exactly one causal terminal`,
      );
    }
    assert.deepEqual(
      h.executorOptions.log
        .all({ type: 'ACTION_APPLIED' })
        .filter((event) => event.seq > beforeRecoverySeq)
        .map((event) => event.payload['intentSeq']),
      [intents[0]?.seq, intents[2]?.seq],
      'recovered dangling terminals append in original intent order',
    );
    const beforeRestart = h.executorOptions.log.all().length;
    assert.equal((await recoverWorktree(restartOptions)).action, 'none');
    assert.equal(h.executorOptions.log.all().length, beforeRestart);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7/3.8: recovery keeps duplicate actionIds isolated by intent generation', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: { crashAfterApply: true },
  });
  try {
    const action = (path: string, content: string) =>
      ({
        type: 'APPLY_PATCH',
        actionId: 'reused-generation-id',
        diffRef: h.executorOptions.evidence.put(
          [
            `diff --git a/${path} b/${path}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${path}`,
            '@@ -0,0 +1 @@',
            `+${content}`,
            '',
          ].join('\n'),
        ),
      }) as const;
    const actionA = action('src/reused-a.txt', 'first generation');
    const actionB = action('src/reused-b.txt', 'second generation');

    await assert.rejects(h.executor.execute(actionA, 'implementer'), CrashInjected);
    const intentA = h.executorOptions.log.all({ type: 'ACTION_INTENT' })[0];
    if (intentA === undefined) assert.fail('first generation must record an intent');
    const legacyView = {
      ...h.executorOptions.log,
      append: h.executorOptions.log.append.bind(h.executorOptions.log),
      all: (filter?: Parameters<typeof h.executorOptions.log.all>[0]) =>
        h.executorOptions.log
          .all(filter)
          .filter((event) => event.seq !== intentA.seq),
    };
    const { failpoints: _crashFailpoints, ...restartOptions } = h.executorOptions;
    assert.equal(
      (
        await createExecutor({ ...restartOptions, log: legacyView }).execute(
          actionB,
          'implementer',
        )
      ).status,
      'applied',
    );

    assert.equal((await recoverWorktree(restartOptions)).action, 'replayed_intent');
    assert.equal(readFileSync(join(h.worktree, 'src', 'reused-a.txt'), 'utf8'), 'first generation\n');
    assert.equal(readFileSync(join(h.worktree, 'src', 'reused-b.txt'), 'utf8'), 'second generation\n');
    const intents = h.executorOptions.log.all({ type: 'ACTION_INTENT' });
    const applied = h.executorOptions.log
      .all({ type: 'ACTION_APPLIED' })
      .filter(
        (event) =>
          event.payload['actionId'] === 'reused-generation-id' &&
          event.payload['duplicate'] !== true,
      );
    assert.deepEqual(
      applied.map((event) => event.payload['intentSeq']).sort((a, b) => Number(a) - Number(b)),
      intents.map((event) => event.seq),
    );
    assert.equal(
      (await createExecutor(restartOptions).execute(actionB, 'implementer')).status,
      'skipped_duplicate',
    );
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: recovery preserves a causal rejection while replaying accepted mutations around it', async () => {
  let rejectedCommandRuns = 0;
  const rejectingCommand: CoreCommandExecutor = {
    environmentHash: '9'.repeat(64),
    async execute() {
      rejectedCommandRuns += 1;
      return {
        status: 'preflight_rejected',
        reason: 'command_diff_rejected',
        detail: 'injected command rejection',
        evidenceRef: `blob://${'a'.repeat(64)}`,
      };
    },
  };
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    coreCommandExecutor: rejectingCommand,
    failpoints: { crashAfterApply: true },
  });
  try {
    const patch = (actionId: string, path: string, content: string) =>
      ({
        type: 'APPLY_PATCH',
        actionId,
        diffRef: h.executorOptions.evidence.put(
          [
            `diff --git a/${path} b/${path}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${path}`,
            '@@ -0,0 +1 @@',
            `+${content}`,
            '',
          ].join('\n'),
        ),
      }) as const;
    const actionA = patch('rejection-prefix-a', 'src/rejection-a.txt', 'A');
    const rejectedB = {
      type: 'RUN_COMMAND',
      actionId: 'causally-rejected-b',
      cmd: 'injected rejection',
      network: 'none',
    } as const;
    const actionC = patch('rejection-suffix-c', 'src/rejection-c.txt', 'C');

    await assert.rejects(h.executor.execute(actionA, 'implementer'), CrashInjected);
    const intentA = h.executorOptions.log.all({ type: 'ACTION_INTENT' })[0];
    if (intentA === undefined) assert.fail('first crash must record an intent');
    const legacyView = {
      ...h.executorOptions.log,
      append: h.executorOptions.log.append.bind(h.executorOptions.log),
      all: (filter?: Parameters<typeof h.executorOptions.log.all>[0]) =>
        h.executorOptions.log
          .all(filter)
          .filter((event) => event.seq !== intentA.seq),
    };
    const { failpoints: _crashFailpoints, ...restartOptions } = h.executorOptions;
    const legacyExecutor = createExecutor({
      ...restartOptions,
      log: legacyView,
    });
    const rejected = await legacyExecutor.execute(rejectedB, 'implementer');
    assert.equal(rejected.status, 'rejected');
    assert.equal(
      (await legacyExecutor.execute(actionC, 'implementer')).status,
      'applied',
    );
    const rejectionBeforeRecovery = h.executorOptions.log
      .all({ type: 'ACTION_REJECTED' })
      .find((event) => event.payload['actionId'] === rejectedB.actionId);
    assert.equal(typeof rejectionBeforeRecovery?.payload['intentSeq'], 'number');

    assert.equal((await recoverWorktree(restartOptions)).action, 'replayed_intent');
    assert.equal(rejectedCommandRuns, 1, 'causally rejected command must not replay');
    assert.equal(readFileSync(join(h.worktree, 'src', 'rejection-a.txt'), 'utf8'), 'A\n');
    assert.equal(readFileSync(join(h.worktree, 'src', 'rejection-c.txt'), 'utf8'), 'C\n');
    assert.equal(
      h.executorOptions.log
        .all({ type: 'ACTION_REJECTED' })
        .filter((event) => event.payload['actionId'] === rejectedB.actionId)
        .length,
      1,
    );
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: unavailable replay evidence rolls back and terminally invalidates the whole accepted suffix', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: { crashAfterApply: true },
  });
  try {
    const contentRef = h.executorOptions.evidence.put('A\n');
    const actionA = {
      type: 'WRITE_FILE',
      actionId: 'missing-replay-evidence-a',
      path: 'src/missing-a.txt',
      contentRef,
    } as const;
    const actionB = {
      type: 'APPLY_PATCH',
      actionId: 'invalidated-suffix-b',
      diffRef: h.executorOptions.evidence.put(
        [
          'diff --git a/src/invalidated-b.txt b/src/invalidated-b.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/src/invalidated-b.txt',
          '@@ -0,0 +1 @@',
          '+B',
          '',
        ].join('\n'),
      ),
    } as const;

    await assert.rejects(h.executor.execute(actionA, 'implementer'), CrashInjected);
    const intentA = h.executorOptions.log.all({ type: 'ACTION_INTENT' })[0];
    if (intentA === undefined) assert.fail('crashed action must record an intent');
    const legacyView = {
      ...h.executorOptions.log,
      append: h.executorOptions.log.append.bind(h.executorOptions.log),
      all: (filter?: Parameters<typeof h.executorOptions.log.all>[0]) =>
        h.executorOptions.log
          .all(filter)
          .filter((event) => event.seq !== intentA.seq),
    };
    const { failpoints: _crashFailpoints, ...restartOptions } = h.executorOptions;
    assert.equal(
      (
        await createExecutor({ ...restartOptions, log: legacyView }).execute(
          actionB,
          'implementer',
        )
      ).status,
      'applied',
    );
    const appliedB = h.executorOptions.log
      .all({ type: 'ACTION_APPLIED' })
      .find((event) => event.payload['actionId'] === actionB.actionId);
    if (appliedB === undefined) assert.fail('accepted suffix must record ACTION_APPLIED');
    rmSync(join(h.root, 'evidence', contentRef.slice('blob://'.length)));
    const beforeFailureSeq = h.executorOptions.log.all().at(-1)?.seq ?? 0;

    const report = await recoverWorktree(restartOptions);

    assert.equal(report.action, 'rolled_back');
    assert.match(report.detail, /failed closed|evidence|ENOENT|no such file/i);
    assert.equal(existsSync(join(h.worktree, 'src', 'missing-a.txt')), false);
    assert.equal(existsSync(join(h.worktree, 'src', 'invalidated-b.txt')), false);
    const recoveryFailures = h.executorOptions.log
      .all({ type: 'ACTION_REJECTED' })
      .filter((event) => event.seq > beforeFailureSeq);
    assert.deepEqual(
      recoveryFailures.map((event) => event.payload['actionId']),
      [actionA.actionId, actionB.actionId],
      'failure terminals follow original intent order',
    );
    assert.equal(recoveryFailures[0]?.payload['intentSeq'], intentA.seq);
    assert.equal(
      recoveryFailures[1]?.payload['invalidatesAppliedSeq'],
      appliedB.seq,
    );
    const beforeRestart = h.executorOptions.log.all().length;
    assert.equal((await recoverWorktree(restartOptions)).action, 'none');
    assert.equal(h.executorOptions.log.all().length, beforeRestart);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7/3.8: a same-action retry recovers the exact older intent before duplicate admission', async () => {
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    failpoints: { crashAfterApply: true },
  });
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    writeFileSync(join(h.worktree, 'src', 'causal-recovery.txt'), 'wrong\n');
    commitFixture(h.worktree, 'causal recovery baseline');
    const action = {
      type: 'APPLY_PATCH',
      actionId: 'causal-recovery-patch',
      diffRef: h.executorOptions.evidence.put(
        [
          'diff --git a/src/causal-recovery.txt b/src/causal-recovery.txt',
          '--- a/src/causal-recovery.txt',
          '+++ b/src/causal-recovery.txt',
          '@@ -1 +1 @@',
          '-wrong',
          '+correct',
          '',
        ].join('\n'),
      ),
    } as const;

    await assert.rejects(h.executor.execute(action, 'implementer'), CrashInjected);
    assert.equal(readFileSync(join(h.worktree, 'src', 'causal-recovery.txt'), 'utf8'), 'correct\n');

    const { failpoints: _crashFailpoints, ...retryOptions } = h.executorOptions;
    const retry = await createExecutor(retryOptions).execute(action, 'implementer');
    assert.equal(retry.status, 'skipped_duplicate');

    const report = await recoverWorktree(h.executorOptions);

    assert.equal(report.action, 'none');
    assert.equal(readFileSync(join(h.worktree, 'src', 'causal-recovery.txt'), 'utf8'), 'correct\n');
    const intent = h.executorOptions.log.all({ type: 'ACTION_INTENT' })[0];
    const applied = h.executorOptions.log
      .all({ type: 'ACTION_APPLIED' })
      .filter((event) => event.payload['actionId'] === action.actionId);
    const recoveredApplied = applied.filter(
      (event) => event.payload['duplicate'] !== true,
    );
    assert.equal(recoveredApplied.length, 1);
    assert.equal(recoveredApplied[0]?.payload['intentSeq'], intent?.seq);
    assert.equal(recoveredApplied[0]?.payload['recovered'], true);
    assert.equal(
      applied.filter((event) => event.payload['duplicate'] === true).length,
      1,
    );
    assert.equal((await recoverWorktree(h.executorOptions)).action, 'none');
  } finally {
    h.cleanup();
  }
});

test('REQ-3.5/P0-02: pre-aborted APPLY_PATCH stops before evidence, Git preflight, filter, snapshot, or intent', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness({
    git: true,
    sandbox: FAKE_AVAILABLE,
    commandSignal: controller.signal,
  });
  const marker = join(h.root, 'pre-abort-filter.marker');
  const filter = join(h.root, 'pre-abort-filter.sh');
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    writeFileSync(join(h.worktree, 'src', 'pre-abort.txt'), 'before\n');
    writeFileSync(join(h.worktree, '.gitattributes'), 'src/*.txt filter=hostile\n');
    writeFileSync(
      filter,
      '#!/bin/sh\nprintf "filter-ran\\n" >> "$1"\n/bin/cat\n',
    );
    chmodSync(filter, 0o755);
    execFileSync(
      'git',
      ['config', '--local', 'filter.hostile.clean', `${filter} ${marker}`],
      { cwd: h.worktree },
    );
    commitFixture(h.worktree, 'pre-abort baseline');
    rmSync(marker, { force: true });
    const diffRef = h.executorOptions.evidence.put(
      [
        'diff --git a/src/pre-abort.txt b/src/pre-abort.txt',
        '--- a/src/pre-abort.txt',
        '+++ b/src/pre-abort.txt',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        '',
      ].join('\n'),
    );
    let evidenceReads = 0;
    const originalGet = h.executorOptions.evidence.get.bind(h.executorOptions.evidence);
    h.executorOptions.evidence.get = (ref) => {
      evidenceReads += 1;
      return originalGet(ref);
    };
    const startedAt = performance.now();

    const outcome = await h.executor.execute(
      { type: 'APPLY_PATCH', actionId: 'pre-aborted-patch', diffRef },
      'implementer',
    );

    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.rejection.reason, 'cancelled');
    assert.ok(performance.now() - startedAt < 500, 'pre-aborted patch must terminate promptly');
    assert.equal(evidenceReads, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(h.worktree, 'src', 'pre-abort.txt'), 'utf8'), 'before\n');
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_APPLIED' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.7: dangling APPLY_PATCH intents rollback and replay exactly once', async (t) => {
  for (const failpoint of ['crashAfterIntent', 'crashAfterApply'] as const) {
    await t.test(failpoint, async () => {
      const h = harness({
        git: true,
        sandbox: FAKE_AVAILABLE,
        failpoints: { [failpoint]: true },
      });
      const target = join(h.worktree, 'src', 'recovered-patch.txt');
      try {
        const diffRef = h.executorOptions.evidence.put(
          [
            'diff --git a/src/recovered-patch.txt b/src/recovered-patch.txt',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/src/recovered-patch.txt',
            '@@ -0,0 +1 @@',
            '+recovered once',
            '',
          ].join('\n'),
        );
        const action = {
          type: 'APPLY_PATCH',
          actionId: `recover-patch-${failpoint}`,
          diffRef,
        } as const;

        await assert.rejects(
          h.executor.execute(action, 'implementer'),
          /crash injected/u,
        );
        if (failpoint === 'crashAfterIntent') {
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, 'partial garbage\n');
        } else {
          assert.equal(readFileSync(target, 'utf8'), 'recovered once\n');
        }

        const report = await recoverWorktree(h.executorOptions);

        assert.equal(report.action, 'replayed_intent');
        assert.equal(readFileSync(target, 'utf8'), 'recovered once\n');
        const applied = h.executorOptions.log
          .all({ type: 'ACTION_APPLIED' })
          .filter((event) => event.payload['actionId'] === action.actionId);
        assert.equal(applied.length, 1);
        assert.equal(applied[0]?.payload['recovered'], true);
        assert.equal((await recoverWorktree(h.executorOptions)).action, 'none');
      } finally {
        h.cleanup();
      }
    });
  }
});

test('REQ-3.8: duplicate APPLY_PATCH action skips without applying the patch again', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    const action = {
      type: 'APPLY_PATCH',
      actionId: 'duplicate-patch',
      diffRef: h.executorOptions.evidence.put(
        [
          'diff --git a/src/duplicate.txt b/src/duplicate.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/src/duplicate.txt',
          '@@ -0,0 +1 @@',
          '+one application',
          '',
        ].join('\n'),
      ),
    } as const;

    assert.equal((await h.executor.execute(action, 'implementer')).status, 'applied');
    const restarted = createExecutor(h.executorOptions);
    assert.equal((await restarted.execute(action, 'implementer')).status, 'skipped_duplicate');
    assert.equal(
      readFileSync(join(h.worktree, 'src', 'duplicate.txt'), 'utf8'),
      'one application\n',
    );
    const events = h.executorOptions.log
      .all({ type: 'ACTION_APPLIED' })
      .filter((event) => event.payload['actionId'] === action.actionId);
    assert.equal(events.filter((event) => event.payload['duplicate'] !== true).length, 1);
    assert.equal(events.filter((event) => event.payload['duplicate'] === true).length, 1);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.9/3.10: READ_FILE emits content evidence without snapshot or INTENT', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    writeFileSync(join(h.worktree, 'src', 'read-me.txt'), 'evidence-backed content\n');
    const action = {
      type: 'READ_FILE',
      actionId: 'read-content',
      path: 'src/read-me.txt',
    } as const;

    const outcome = await h.executor.execute(action, 'diagnostician');

    assert.equal(outcome.status, 'applied');
    assert.ok(outcome.status === 'applied' && outcome.outputRef);
    if (outcome.status === 'applied' && outcome.outputRef !== undefined) {
      assert.equal(
        h.executorOptions.evidence.getText(outcome.outputRef),
        'evidence-backed content\n',
      );
    }
    assert.deepEqual(
      h.executorOptions.log.all({ taskId: 'T-1' }).map((event) => event.type),
      ['ACTION_APPLIED'],
    );
    const applied = h.executorOptions.log.all({ type: 'ACTION_APPLIED' })[0];
    assert.equal(applied?.payload['outputRef'], outcome.outputRef);
    assert.equal(applied?.payload['resultHash'], outcome.outputRef);

    const restarted = createExecutor(h.executorOptions);
    assert.equal(
      (await restarted.execute(action, 'diagnostician')).status,
      'skipped_duplicate',
    );
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('REQ-3.11: READ_FILE rejects traversal and symlink escape without dereference', async (t) => {
  await t.test('traversal', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    try {
      writeFileSync(join(h.root, 'outside.txt'), 'must stay unread\n');
      const outcome = await h.executor.execute(
        { type: 'READ_FILE', actionId: 'read-traversal', path: '../outside.txt' },
        'diagnostician',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'path_outside_allowlist');
      }
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });

  await t.test('symlink escape', async () => {
    const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
    try {
      const outside = join(h.root, 'outside.txt');
      writeFileSync(outside, 'must stay unread\n');
      mkdirSync(join(h.worktree, 'src'), { recursive: true });
      symlinkSync(outside, join(h.worktree, 'src', 'outside-link'));
      const outcome = await h.executor.execute(
        {
          type: 'READ_FILE',
          actionId: 'read-symlink-escape',
          path: 'src/outside-link',
        },
        'diagnostician',
      );
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'path_outside_allowlist');
      }
      assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
    } finally {
      h.cleanup();
    }
  });
});

test('AC-3/AC-4/AC-5: READ_FILE and WRITE_FILE with a non-string path are schema_violation rejections, never throws', async () => {
  // `path` is model-authored and UNTRUSTED (INV-1/INV-2). The old falsy check let
  // `42`, `true`, `[]` and `{}` reach the path layer, where isAbsolute() threw a
  // TypeError past executeOnce (which only catches LeaseFenceError /
  // FrozenTreeOperationError) and out of execute() itself.
  const badPaths: readonly unknown[] = [
    undefined,
    null,
    42,
    0,
    true,
    [],
    ['src/a.ts'],
    {},
    { path: 'src/a.ts' },
    '',
  ];
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    const contentRef = h.executorOptions.evidence.put('content\n');
    for (const [i, bad] of badPaths.entries()) {
      for (const type of ['READ_FILE', 'WRITE_FILE'] as const) {
        const label = `${type} path=${JSON.stringify(bad) ?? 'undefined'}`;
        const action = {
          type,
          actionId: `bad-path-${type}-${i}`,
          ...(type === 'WRITE_FILE' ? { contentRef } : {}),
          ...(bad === undefined ? {} : { path: bad }),
        } as unknown as Action;
        const outcome = await h.executor.execute(action, 'implementer');
        assert.equal(outcome.status, 'rejected', `${label} must be rejected`);
        if (outcome.status === 'rejected') {
          assert.equal(outcome.rejection.reason, 'schema_violation', label);
          assert.match(outcome.rejection.detail, /string path/, label);
        }
      }
    }
    // Nothing malformed ever reached a side effect.
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('AC-2: a well-formed string path still behaves exactly as before', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    mkdirSync(join(h.worktree, 'src'), { recursive: true });
    writeFileSync(join(h.worktree, 'src', 'ok.txt'), 'still readable\n');
    const outcome = await h.executor.execute(
      { type: 'READ_FILE', actionId: 'read-ok', path: 'src/ok.txt' },
      'diagnostician',
    );
    assert.equal(outcome.status, 'applied');
  } finally {
    h.cleanup();
  }
});

test('AC-9: RUN_COMMAND with an ill-typed cwd is a schema_violation rejection, never a throw', async () => {
  // Same failure class as `path`, one field over: validate() never typed `cwd`,
  // so resolveContained() -> resolve() threw a TypeError that executeOnce's catch
  // rethrows (it only handles LeaseFenceError / FrozenTreeOperationError), out of
  // execute() and past runTaskLoop, which has try/finally and no catch at all.
  const badCwds: readonly unknown[] = [null, 42, 0, true, [], ['src'], {}, { cwd: 'src' }, ''];
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    for (const [i, bad] of badCwds.entries()) {
      const label = `cwd=${JSON.stringify(bad) ?? 'undefined'}`;
      const outcome = await h.executor.execute(
        {
          type: 'RUN_COMMAND',
          actionId: `bad-cwd-${i}`,
          cmd: 'echo hi',
          network: 'none',
          cwd: bad,
        } as unknown as Action,
        'implementer',
      );
      assert.equal(outcome.status, 'rejected', `${label} must be rejected`);
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'schema_violation', label);
        assert.match(outcome.rejection.detail, /cwd must be a non-empty string/, label);
      }
    }
    // Control: no `cwd` key at all still runs exactly as before.
    const control = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'no-cwd', cmd: 'echo hi', network: 'none' },
      'implementer',
    );
    assert.equal(control.status, 'applied', 'a RUN_COMMAND without cwd is unchanged');
  } finally {
    h.cleanup();
  }
});

test('AC-10: RUN_COMMAND with a missing or ill-typed network is rejected and never defaulted', async () => {
  // The prompt never advertises `network`, so a MISSING grant is the everyday
  // case; `action.network.startsWith` threw from inside validate() itself, which
  // executeOnce calls OUTSIDE its try — nothing anywhere caught it.
  const badNetworks: readonly unknown[] = [undefined, null, 42, 0, true, [], {}, ''];
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    for (const [i, bad] of badNetworks.entries()) {
      const label = `network=${JSON.stringify(bad) ?? 'undefined'}`;
      const outcome = await h.executor.execute(
        {
          type: 'RUN_COMMAND',
          actionId: `bad-net-${i}`,
          cmd: 'echo hi',
          ...(bad === undefined ? {} : { network: bad }),
        } as unknown as Action,
        'implementer',
      );
      assert.equal(outcome.status, 'rejected', `${label} must be rejected`);
      if (outcome.status === 'rejected') {
        // Never 'applied' and never egress-blocked-as-if-'none': a missing grant
        // is a schema violation, not an implicit network: 'none'.
        assert.equal(outcome.rejection.reason, 'schema_violation', label);
        assert.match(outcome.rejection.detail, /network must be/, label);
      }
    }
    // Controls: both legal string forms keep their pre-guard outcome exactly.
    const none = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'net-none', cmd: 'echo hi', network: 'none' },
      'implementer',
    );
    assert.equal(none.status, 'applied');
    const allowlisted = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'net-allow', cmd: 'echo hi', network: 'allowlist:x' },
      'implementer',
    );
    assert.equal(allowlisted.status, 'rejected');
    if (allowlisted.status === 'rejected') {
      assert.equal(
        allowlisted.rejection.reason,
        'network_grant_unavailable',
        'an allowlist grant still passes validate() and is denied at the Phase-0 gate',
      );
    }
  } finally {
    h.cleanup();
  }
});

test('AC-14: RUN_COMMAND with an ill-typed cmd is rejected, never coerced and run', async () => {
  // The most dangerous variant of the class: an ill-typed `cmd` did not throw, it
  // was coerced to a string and EXECUTED (`['true']` -> `true` ran and came back
  // 'applied'; `42` reached the shell and came back exit 127 'command_failed').
  const badCmds: readonly unknown[] = [42, true, ['true'], {}, ['echo', 'hi'], { cmd: 'echo hi' }];
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    for (const [i, bad] of badCmds.entries()) {
      const label = `cmd=${JSON.stringify(bad) ?? 'undefined'}`;
      const outcome = await h.executor.execute(
        {
          type: 'RUN_COMMAND',
          actionId: `bad-cmd-${i}`,
          cmd: bad,
          network: 'none',
        } as unknown as Action,
        'implementer',
      );
      assert.equal(outcome.status, 'rejected', `${label} must be rejected, not run`);
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'schema_violation', label);
        assert.match(outcome.rejection.detail, /RUN_COMMAND requires cmd/, label);
      }
    }
    // The pre-existing falsy cases keep their original outcome exactly.
    for (const [i, falsy] of ([undefined, null, '', 0, false] as readonly unknown[]).entries()) {
      const outcome = await h.executor.execute(
        {
          type: 'RUN_COMMAND',
          actionId: `falsy-cmd-${i}`,
          network: 'none',
          ...(falsy === undefined ? {} : { cmd: falsy }),
        } as unknown as Action,
        'implementer',
      );
      assert.equal(outcome.status, 'rejected', `falsy cmd ${String(falsy)} still rejected`);
    }
    // Control: a normal string command is unchanged.
    const control = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'good-cmd', cmd: 'echo hi', network: 'none' },
      'implementer',
    );
    assert.equal(control.status, 'applied', 'a string cmd runs exactly as before');
  } finally {
    h.cleanup();
  }
});

test('AC-11: an action that is not an object is a schema_violation rejection, never a throw', async () => {
  // `execute()` is core's public boundary and its `Action` parameter type lies:
  // the wire normalizer forwards a non-object entry of `actionRequests` untouched
  // and the production outputSchema has no item schema for that array.
  const badActions: readonly unknown[] = [null, undefined, 42, 'READ_FILE', [], true];
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    for (const bad of badActions) {
      const label = `action=${JSON.stringify(bad) ?? 'undefined'}`;
      const outcome = await h.executor.execute(bad as unknown as Action, 'implementer');
      assert.equal(outcome.status, 'rejected', `${label} must be rejected`);
      if (outcome.status === 'rejected') {
        assert.equal(outcome.rejection.reason, 'schema_violation', label);
        assert.match(outcome.rejection.detail, /action must be an object/, label);
        assert.equal(outcome.rejection.actionId, '(missing)', label);
      }
    }
    assert.equal(h.executorOptions.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

// --- execution (darwin sandbox) ---

test('benign network:"none" RUN_COMMAND is unaffected by the offline policy', async () => {
  const h = harness({ git: true, sandbox: FAKE_AVAILABLE });
  try {
    const out = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'a', cmd: 'echo hi', network: 'none' },
      'implementer',
    );
    assert.equal(out.status, 'applied');
    if (out.status === 'applied') assert.equal(out.egressBlocked, true);
  } finally {
    h.cleanup();
  }
});

test('a real offline frozen package_install uses isolated transient roots', realMacOSOnly, async () => {
  const command =
    'pnpm install --offline --frozen-lockfile --ignore-scripts --config.node-linker=hoisted';
  const approvedRoot = mkdtempSync(join(tmpdir(), 'executor-real-approved-source-'));
  const sourceRoot = join(approvedRoot, 'phase0-offline-dependency');
  mkdirSync(sourceRoot);
  const sourcePackage = JSON.stringify({
    name: 'phase0-offline-dependency',
    version: '1.0.0',
    main: 'index.js',
  });
  const sourceModule = "module.exports = 'approved';\n";
  writeFileSync(join(sourceRoot, 'package.json'), sourcePackage);
  writeFileSync(join(sourceRoot, 'index.js'), sourceModule);
  const sourceHash = createHash('sha256')
    .update(
      JSON.stringify([
        {
          path: 'index.js',
          sha256: createHash('sha256').update(sourceModule).digest('hex'),
        },
        {
          path: 'package.json',
          sha256: createHash('sha256').update(sourcePackage).digest('hex'),
        },
      ]),
    )
    .digest('hex');
  const targetPath = '.phase0-offline-sources/phase0-offline-dependency';
  const specifier = `file:${targetPath}`;
  const manifest = JSON.stringify({
    name: 'sandbox-install-fixture',
    private: true,
    packageManager: 'pnpm@11.9.0',
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
    `    resolution: {directory: ${targetPath}, type: directory}`,
    '',
    'snapshots:',
    '',
    `  phase0-offline-dependency@${specifier}: {}`,
    '',
  ].join('\n');
  const h = harness({
    git: true,
    offlineDependencyPolicy: {
      version: 1,
      allowedRoles: ['implementer'],
      commands: [command],
      manifestPath: 'package.json',
      manifestHash: createHash('sha256').update(manifest).digest('hex'),
      lockfilePath: 'pnpm-lock.yaml',
      lockfileHash: createHash('sha256').update(lockfile).digest('hex'),
      approvedSourceHashes: [sourceHash],
      approvedSources: [{
        packageName: 'phase0-offline-dependency',
        specifier,
        targetPath,
        sourcePath: sourceRoot,
        contentHash: sourceHash,
      }],
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
    },
  });
  try {
    writeFileSync(join(h.worktree, 'package.json'), manifest);
    writeFileSync(
      join(h.worktree, 'pnpm-lock.yaml'),
      lockfile,
    );
    writeFileSync(join(h.worktree, '.gitignore'), 'node_modules/\n');
    const out = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'offline-install', cmd: command, network: 'none' },
      'implementer',
    );
    assert.equal(
      out.status,
      'applied',
      out.status === 'rejected' ? out.rejection.detail : 'expected an applied install',
    );
    if (out.status === 'applied') {
      assert.equal(out.exitCode, 0);
      assert.equal(out.egressBlocked, true);
      assert.ok(out.outputRef);
      assert.match(
        h.executorOptions.evidence.getText(out.outputRef),
        /Already up to date|Done in/,
      );
    }
    assert.equal(
      readFileSync(
        join(h.worktree, 'node_modules', 'phase0-offline-dependency', 'index.js'),
        'utf8',
      ),
      sourceModule,
      'approved package output is promoted for later commands',
    );
  } finally {
    h.cleanup();
    rmSync(approvedRoot, { recursive: true, force: true });
  }
});
